// #300: enemy ARMOR visuals for non-mech units. The pure parts of that feature are (a) the
// "is this unit still plated?" predicate on HpBody, (b) the texture-set resolver that turns that
// predicate into which pre-built texture set a unit renders from, and (c) the registry building
// BOTH sets for an armored kind. All three are Phaser-free and tested here; the scene-side
// re-point is a two-line setTexture call driven entirely by (b).
import { describe, it, expect } from 'vitest';
import { vehicleTextureSet, vehicleHasArmorArt, buildVehicleTextures, ARMORED_SUFFIX, VEHICLE_ART } from './index.js';
import { HpBody } from '../../data/HpBody.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';

describe('HpBody.hasArmor (the flat-pool analogue of Mech.hasArmor)', () => {
  it('is true while the unit-wide armor pool holds and false once it empties', () => {
    const body = new HpBody({ hp: 50, armor: 40, parts: { core: { x: 0, y: 0, w: 20, h: 20 } } });
    expect(body.hasArmor()).toBe(true);
    body.applyDamage('core', 39);
    expect(body.hasArmor()).toBe(true);   // 1 armor left — still plated
    const res = body.applyDamage('core', 1);
    expect(res.armorBrokeNow).toBe(true);
    expect(body.hasArmor()).toBe(false);
  });

  it('is false from the start for a kind with no armor at all', () => {
    expect(new HpBody({ hp: 30 }).hasArmor()).toBe(false);
  });

  it('comes back after repairAll (the arena reset restores the plating)', () => {
    const body = new HpBody({ hp: 50, armor: 10 });
    body.applyDamage('core', 999);
    expect(body.hasArmor()).toBe(false);
    body.repairAll();
    expect(body.hasArmor()).toBe(true);
  });
});

describe('vehicleTextureSet', () => {
  it('resolves to the armored set while the body is plated, the bare set once it breaks', () => {
    const body = new HpBody({ hp: 50, armor: 10 });
    expect(vehicleTextureSet('vehicle_tank_0', body)).toBe(`vehicle_tank_0${ARMORED_SUFFIX}`);
    body.applyDamage('core', 999);
    expect(vehicleTextureSet('vehicle_tank_0', body)).toBe('vehicle_tank_0');
  });

  it('resolves to the bare set for an unarmored body, or no body at all', () => {
    expect(vehicleTextureSet('k', new HpBody({ hp: 30 }))).toBe('k');
    expect(vehicleTextureSet('k', null)).toBe('k');
    expect(vehicleTextureSet('k', {})).toBe('k');
  });
});

describe('buildVehicleTextures armored variants', () => {
  const fakeScene = () => ({});

  it('builds ONLY the bare set for an unarmored kind', () => {
    const calls = [];
    const orig = VEHICLE_ART.tank;
    VEHICLE_ART.tank = (scene, key, def, opts) => calls.push([key, !!opts?.armored]);
    try {
      buildVehicleTextures(fakeScene(), 'k', { art: 'tank', armor: 0 });
      expect(calls).toEqual([['k', false]]);
    } finally { VEHICLE_ART.tank = orig; }
  });

  it('builds BOTH the bare and the plated set for an armored kind', () => {
    const calls = [];
    const orig = VEHICLE_ART.tank;
    VEHICLE_ART.tank = (scene, key, def, opts) => calls.push([key, !!opts?.armored]);
    try {
      buildVehicleTextures(fakeScene(), 'k', { art: 'tank', armor: 40 });
      expect(calls).toEqual([['k', false], [`k${ARMORED_SUFFIX}`, true]]);
    } finally { VEHICLE_ART.tank = orig; }
  });

  it('throws clearly on an unknown art key (unchanged behavior)', () => {
    expect(() => buildVehicleTextures(fakeScene(), 'k', { art: 'nope' })).toThrow(/unknown vehicle art/);
  });
});

describe('the live armored kinds get armored art', () => {
  it('every ENEMY_KINDS entry with an armor pool resolves as needing a plated variant', () => {
    const armored = Object.entries(ENEMY_KINDS).filter(([, d]) => (d.armor ?? 0) > 0);
    expect(armored.length).toBeGreaterThan(0);
    for (const [, def] of armored) expect(vehicleHasArmorArt(def)).toBe(true);
  });

  it('the tank and the quadruped are among them (the two units #300 was filed for)', () => {
    expect(vehicleHasArmorArt(ENEMY_KINDS.tank)).toBe(true);
    expect(vehicleHasArmorArt(ENEMY_KINDS.quadruped)).toBe(true);
  });
});
