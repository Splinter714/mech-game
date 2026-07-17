import { describe, it, expect } from 'vitest';
import { explosionCategoryFor, deathScaleFor, nearestLocation, resolveHitLocation, pickLiveWeighted } from './shared.js';
import { Mech } from '../../data/Mech.js';

// #107: which discrete destruction-explosion-SOUND category a dying enemy falls into, bucketed
// off `.maxHp` (uniform across Mech/HpBody per #90) — calibrated against the real roster: drone
// 14 hp, turret 90 hp, tank 160 hp, helicopter 70 hp, light mech ≈266 hp, medium mech ≈416 hp,
// heavy mech ≈616 hp (see enemyKinds.js + chassis maxHp comment in data/Mech.js).
function enemyWithHp(hp) {
  return { mech: { maxHp: hp } };
}

describe('explosionCategoryFor (#107 — Weapon Lab destruction-explosion size categories)', () => {
  it('buckets a drone (14 hp) as small', () => {
    expect(explosionCategoryFor(enemyWithHp(14))).toBe('small');
  });

  it('buckets turret (90 hp), tank (160 hp), helicopter (70 hp), and light mech (~266 hp) as medium', () => {
    expect(explosionCategoryFor(enemyWithHp(90))).toBe('medium');
    expect(explosionCategoryFor(enemyWithHp(160))).toBe('medium');
    expect(explosionCategoryFor(enemyWithHp(70))).toBe('medium');
    expect(explosionCategoryFor(enemyWithHp(266))).toBe('medium');
  });

  it('buckets a medium mech (~416 hp) as large', () => {
    expect(explosionCategoryFor(enemyWithHp(416))).toBe('large');
  });

  it('buckets a heavy mech (~616 hp) as massive', () => {
    expect(explosionCategoryFor(enemyWithHp(616))).toBe('massive');
  });

  it('is monotonic across the small/medium/large/massive boundaries', () => {
    const order = ['small', 'medium', 'large', 'massive'];
    const hps = [10, 49, 50, 299, 300, 549, 550, 1000];
    let lastIdx = -1;
    for (const hp of hps) {
      const idx = order.indexOf(explosionCategoryFor(enemyWithHp(hp)));
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx;
    }
  });
});

describe('deathScaleFor (unchanged by #107 — still drives the visual burst size)', () => {
  it('scales with maxHp toughness, drone (14 hp) at the floor and heavy mech (616 hp) at the ceiling', () => {
    expect(deathScaleFor(enemyWithHp(14))).toBeCloseTo(0.5, 5);
    expect(deathScaleFor(enemyWithHp(616))).toBeCloseTo(1.3, 5);
  });

  it('is monotonically increasing with maxHp', () => {
    expect(deathScaleFor(enemyWithHp(90))).toBeGreaterThan(deathScaleFor(enemyWithHp(14)));
    expect(deathScaleFor(enemyWithHp(416))).toBeGreaterThan(deathScaleFor(enemyWithHp(160)));
  });
});

// #231 — "enemy mechs take damage strangely, like it feels easy to destroy one side torso,
// and then waaaaaay harder to destroy the second side." Root cause: a hit maps to the part
// nearest the world hit point, with no check that the nearest part isn't already destroyed
// (armor+structure zeroed, either hit down directly or cascaded — a side torso takes its arm
// with it, DESTROY_CASCADE in anatomy.js). Since a kill needs BOTH side torsos destroyed
// (LETHAL_GROUPS), every hit that geometrically lands on the already-dead side was silently
// wasted instead of redirecting, making the second side (the actual kill) feel far tankier.
describe('nearestLocation (#231 — pure nearest-part geometry, factored out of combat.js)', () => {
  const lay = {
    leftTorso: { x: -10, y: 0 },
    rightTorso: { x: 10, y: 0 },
    leftArm: { x: -20, y: 0 },
    rightArm: { x: 20, y: 0 },
  };

  it('picks the part whose layout position is closest to the local hit point', () => {
    expect(nearestLocation(lay, Object.keys(lay), -10, 0, 1)).toBe('leftTorso');
    expect(nearestLocation(lay, Object.keys(lay), 19, 1, 1)).toBe('rightArm');
  });

  it('only considers locations passed in `locs`, even if something closer exists in `lay`', () => {
    // Hit point is right on top of leftTorso, but leftTorso is excluded from the candidate list.
    expect(nearestLocation(lay, ['rightTorso', 'leftArm', 'rightArm'], -10, 0, 1)).toBe('leftArm');
  });
});

describe('resolveHitLocation (#231 — redirect a hit off an already-destroyed part)', () => {
  const lay = {
    leftTorso: { x: -10, y: 0 },
    rightTorso: { x: 10, y: 0 },
    leftArm: { x: -20, y: 0 },
    rightArm: { x: 20, y: 0 },
  };
  const locs = ['leftTorso', 'rightTorso', 'leftArm', 'rightArm'];

  it('leaves a hit on a live part unchanged (normal-case behavior is unaffected)', () => {
    const isPartDestroyed = () => false;
    expect(resolveHitLocation(lay, locs, -10, 0, 1, isPartDestroyed)).toBe('leftTorso');
    expect(resolveHitLocation(lay, locs, 19, 1, 1, isPartDestroyed)).toBe('rightArm');
  });

  it('redirects to the nearest LIVE part when the geometrically-nearest one is destroyed', () => {
    // Hit lands nearest leftTorso, but leftTorso (and its cascaded leftArm) are already dead —
    // the real #231 scenario. Must redirect to a live part (rightTorso/rightArm), never
    // silently return the dead leftTorso.
    const destroyed = new Set(['leftTorso', 'leftArm']);
    const isPartDestroyed = (loc) => destroyed.has(loc);
    const got = resolveHitLocation(lay, locs, -10, 0, 1, isPartDestroyed);
    expect(destroyed.has(got)).toBe(false);
    expect(got).toBe('rightTorso'); // nearest of the remaining live parts to (-10, 0)
  });

  it('exercises the real Mech model end to end: killing one side torso then hitting that '
    + 'side again applies real damage to the surviving side instead of wasting the hit', () => {
    const m = new Mech({ chassisId: 'light' });
    // Overkill the left torso (cascades the left arm too, per DESTROY_CASCADE).
    m.applyDamage('leftTorso', m.parts.leftTorso.maxArmor + m.parts.leftTorso.maxHp + 999);
    expect(m.isPartDestroyed('leftTorso')).toBe(true);
    expect(m.isPartDestroyed('leftArm')).toBe(true);
    expect(m.isDestroyed()).toBe(false); // needs BOTH side torsos, not just one

    // Hit point is right on top of the now-dead leftTorso.
    const loc = resolveHitLocation(lay, locs, -10, 0, 1, (l) => m.isPartDestroyed(l));
    expect(m.isPartDestroyed(loc)).toBe(false);
    expect(loc === 'rightTorso' || loc === 'rightArm').toBe(true);
    const before = m.parts[loc].hp + m.parts[loc].armor;
    const res = m.applyDamage(loc, 15);
    expect(res.applied).toBe(15); // damage actually applied, not wasted on the dead leftTorso
    const after = m.parts[loc].hp + m.parts[loc].armor;
    expect(after).toBe(before - 15);
  });

  it('falls back to the originally-nearest part if every candidate is already destroyed '
    + '(defensive — should be unreachable while the unit is alive)', () => {
    const isPartDestroyed = () => true;
    expect(resolveHitLocation(lay, locs, -10, 0, 1, isPartDestroyed)).toBe('leftTorso');
  });
});

describe('pickLiveWeighted (#231 — player weighted-random hit-location redirect)', () => {
  const pool = ['leftTorso', 'leftTorso', 'rightTorso', 'rightTorso', 'leftArm', 'rightArm'];

  it('returns the rolled location unchanged when it is still live', () => {
    // rng() = 0 -> index 0 -> 'leftTorso'
    expect(pickLiveWeighted(pool, () => false, () => 0)).toBe('leftTorso');
  });

  it('rerolls among only the LIVE entries when the roll lands on an already-destroyed part', () => {
    const destroyed = new Set(['leftTorso', 'leftArm']);
    const isPartDestroyed = (loc) => destroyed.has(loc);
    // First rng() call (the initial roll) picks index 0 -> 'leftTorso', which is destroyed.
    // Second rng() call (the reroll) picks index 0 of the live-filtered pool
    // (['rightTorso','rightTorso','rightArm']) -> 'rightTorso'.
    let call = 0;
    const rng = () => (call++ === 0 ? 0 : 0);
    expect(pickLiveWeighted(pool, isPartDestroyed, rng)).toBe('rightTorso');
  });

  it('never returns an already-destroyed location when at least one live entry exists', () => {
    const destroyed = new Set(['leftTorso']);
    const isPartDestroyed = (loc) => destroyed.has(loc);
    // Sweep the rng space broadly to make sure no reachable path returns the dead location.
    for (let i = 0; i < 20; i++) {
      const rng = () => i / 20;
      expect(pickLiveWeighted(pool, isPartDestroyed, rng)).not.toBe('leftTorso');
    }
  });

  it('falls back to the rolled (destroyed) location if the entire pool is destroyed '
    + '(defensive fallback, mirrors resolveHitLocation)', () => {
    expect(pickLiveWeighted(pool, () => true, () => 0)).toBe('leftTorso');
  });
});
