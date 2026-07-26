// #493 — hold-to-charge, release-to-fire. Exercises `FiringMixin._handleChargeFire` directly
// against a minimal fake scene (mirrors abilityTrigger.test.js's pattern), with `fireWeapon`
// stubbed so these tests verify the charge STATE MACHINE and damage scaling, not the real
// projectile/hitscan spawn pipeline (which needs a live Phaser scene).
import { describe, it, expect, vi } from 'vitest';
import { FiringMixin } from './firing.js';
import { chargeConeAngleDeg } from '../../data/delivery.js';

const CHARGEABLE = { minTime: 0.4, maxTime: 1.6, minDamageMult: 0.5, maxDamageMult: 2.5 };

function makeScene() {
  const scene = {};
  Object.assign(scene, FiringMixin);
  scene.fireWeapon = vi.fn();   // stub AFTER assigning the mixin, so it isn't overwritten by the real one
  return scene;
}

function makeWeapon(chargeable = CHARGEABLE) {
  return { location: 'rightArm', weapon: { damage: 30, delivery: { chargeable } } };
}

function player() {
  return { chargeState: {} };
}

describe('#493 _handleChargeFire — accumulates charge, fires on release', () => {
  it('does nothing while held under minTime', () => {
    const scene = makeScene(), w = makeWeapon(), p = player();
    scene._handleChargeFire(w, { fire: { rightArm: true } }, 200, p, true);
    expect(scene.fireWeapon).not.toHaveBeenCalled();
    expect(p.chargeState.rightArm.charging).toBe(true);
  });

  it('releasing before minTime wastes the charge — no shot at all', () => {
    const scene = makeScene(), w = makeWeapon(), p = player();
    scene._handleChargeFire(w, { fire: { rightArm: true } }, 200, p, true);   // 0.2s charging
    scene._handleChargeFire(w, { fire: { rightArm: false } }, 16, p, true);  // released early
    expect(scene.fireWeapon).not.toHaveBeenCalled();
    expect(p.chargeState.rightArm.charging).toBe(false);
  });

  it('releasing at exactly minTime fires at minDamageMult', () => {
    const scene = makeScene(), w = makeWeapon(), p = player();
    scene._handleChargeFire(w, { fire: { rightArm: true } }, 400, p, true);   // exactly minTime
    scene._handleChargeFire(w, { fire: { rightArm: false } }, 16, p, true);
    expect(scene.fireWeapon).toHaveBeenCalledTimes(1);
    // #493 follow-up: chargeConeDeg is the cone width AT RELEASE (elapsed/maxTime = 0.4/1.6 = 0.25).
    const expectedConeDeg = chargeConeAngleDeg(0.4 / CHARGEABLE.maxTime);
    const call = scene.fireWeapon.mock.calls[0][2];
    expect(call.chargeMult).toBe(CHARGEABLE.minDamageMult);
    expect(call.chargeSpread).toBe(0);
    expect(call.chargeConeDeg).toBeCloseTo(expectedConeDeg, 5);
  });

  it('holding past maxTime does NOT auto-fire — it just holds at the cap until released', () => {
    const scene = makeScene(), w = makeWeapon(), p = player();
    scene._handleChargeFire(w, { fire: { rightArm: true } }, 2000, p, true);   // well past maxTime
    expect(scene.fireWeapon).not.toHaveBeenCalled();
    expect(p.chargeState.rightArm.elapsed).toBe(CHARGEABLE.maxTime);   // capped, not still climbing
    expect(p.chargeState.rightArm.charging).toBe(true);
    scene._handleChargeFire(w, { fire: { rightArm: false } }, 16, p, true);   // the actual release
    expect(scene.fireWeapon).toHaveBeenCalledTimes(1);
    // A full-charge release (elapsed === maxTime) narrows the cone all the way to 0° — a clean beam.
    const call = scene.fireWeapon.mock.calls[0][2];
    expect(call.chargeMult).toBe(CHARGEABLE.maxDamageMult);
    expect(call.chargeSpread).toBe(0);
    expect(call.chargeConeDeg).toBe(0);
  });

  it('a release halfway between minTime and maxTime scales linearly', () => {
    const scene = makeScene(), w = makeWeapon(), p = player();
    const mid = (CHARGEABLE.minTime + CHARGEABLE.maxTime) / 2;
    scene._handleChargeFire(w, { fire: { rightArm: true } }, mid * 1000, p, true);
    scene._handleChargeFire(w, { fire: { rightArm: false } }, 16, p, true);
    const expectedMult = (CHARGEABLE.minDamageMult + CHARGEABLE.maxDamageMult) / 2;
    expect(scene.fireWeapon.mock.calls[0][2].chargeMult).toBeCloseTo(expectedMult, 5);
  });

  it('a shot released before full charge bursts as the cone it actually was — earlier release = wider burst cone', () => {
    const scene = makeScene(), w = makeWeapon(), p = player();
    scene._handleChargeFire(w, { fire: { rightArm: true } }, 600, p, true);    // 0.6s, well past minTime
    scene._handleChargeFire(w, { fire: { rightArm: false } }, 16, p, true);
    const early = scene.fireWeapon.mock.calls[0][2].chargeConeDeg;

    scene.fireWeapon.mockClear();
    scene._handleChargeFire(w, { fire: { rightArm: true } }, 1400, p, true);   // 1.4s, close to maxTime
    scene._handleChargeFire(w, { fire: { rightArm: false } }, 16, p, true);
    const late = scene.fireWeapon.mock.calls[0][2].chargeConeDeg;

    expect(early).toBeGreaterThan(late);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
  });

  it('running out of ammo mid-charge (fireReady goes false) resolves the charge same as a release', () => {
    const scene = makeScene(), w = makeWeapon(), p = player();
    scene._handleChargeFire(w, { fire: { rightArm: true } }, 1000, p, true);    // charging, past minTime
    scene._handleChargeFire(w, { fire: { rightArm: true } }, 16, p, false);     // still held, but not fireReady
    expect(scene.fireWeapon).toHaveBeenCalledTimes(1);
  });

  it('resets cleanly after firing — a fresh press starts a new charge from zero', () => {
    const scene = makeScene(), w = makeWeapon(), p = player();
    scene._handleChargeFire(w, { fire: { rightArm: true } }, 400, p, true);
    scene._handleChargeFire(w, { fire: { rightArm: false } }, 16, p, true);
    expect(p.chargeState.rightArm.elapsed).toBe(0);
    expect(p.chargeState.rightArm.charging).toBe(false);
  });
});
