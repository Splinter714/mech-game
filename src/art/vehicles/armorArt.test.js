// #472: ENEMIES no longer wear their armor state on the sprite. #300 gave every armored non-mech
// kind a SECOND, "plated" texture set that a unit re-pointed at until its armor pool emptied, and
// #401 gave an armor-stripped mech location a torn-open panel; the owner's read was that the
// visual "looks so dumb on enemies", and #452 gave an enemy's armor a home in the HUD's
// locked-enemy disc instead. So: one texture set per enemy kind, one body look per enemy mech.
// The armor MODEL is untouched — `HpBody.hasArmor()` still answers, armor still absorbs damage —
// which is what the first block below pins.
import { describe, it, expect } from 'vitest';
import { buildVehicleTextures, VEHICLE_ART } from './index.js';
import * as vehiclesIndex from './index.js';
import { HpBody } from '../../data/HpBody.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { themeFor } from '../mechPrims.js';

describe('HpBody.hasArmor (the flat-pool analogue of Mech.hasArmor) — the MODEL, still intact', () => {
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

  it('comes back after repairAll (the arena reset restores the pool)', () => {
    const body = new HpBody({ hp: 50, armor: 10 });
    body.applyDamage('core', 999);
    expect(body.hasArmor()).toBe(false);
    body.repairAll();
    expect(body.hasArmor()).toBe(true);
  });
});

describe('buildVehicleTextures builds ONE look per kind (#472)', () => {
  const fakeScene = () => ({});
  const record = (art = 'tank') => {
    const calls = [];
    const orig = VEHICLE_ART[art];
    VEHICLE_ART[art] = (scene, key, def, opts) => calls.push([key, opts]);
    return { calls, restore: () => { VEHICLE_ART[art] = orig; } };
  };

  it('builds a single set for an UNARMORED kind, with no armored option', () => {
    const r = record();
    try {
      buildVehicleTextures(fakeScene(), 'k', { art: 'tank', armor: 0 });
      expect(r.calls).toEqual([['k', undefined]]);
    } finally { r.restore(); }
  });

  it('builds the SAME single set for an ARMORED kind — no `_armored` variant any more', () => {
    const r = record();
    try {
      buildVehicleTextures(fakeScene(), 'k', { art: 'tank', armor: 40 });
      expect(r.calls).toEqual([['k', undefined]]);
      expect(r.calls.some(([key]) => key.includes('armored'))).toBe(false);
    } finally { r.restore(); }
  });

  it('the live armored kinds (tank, carrier) are built exactly like every other kind', () => {
    for (const id of ['tank', 'carrier']) {
      expect((ENEMY_KINDS[id].armor ?? 0)).toBeGreaterThan(0);   // still armored in the MODEL
      const r = record(ENEMY_KINDS[id].art);
      try {
        buildVehicleTextures(fakeScene(), `v_${id}`, ENEMY_KINDS[id]);
        expect(r.calls).toEqual([[`v_${id}`, undefined]]);
      } finally { r.restore(); }
    }
  });

  it('throws clearly on an unknown art key (unchanged behavior)', () => {
    expect(() => buildVehicleTextures(fakeScene(), 'k', { art: 'nope' })).toThrow(/unknown vehicle art/);
  });

  it('exports no armored-variant machinery at all — removed, not flagged off', () => {
    expect(vehiclesIndex.ARMORED_SUFFIX).toBeUndefined();
    expect(vehiclesIndex.vehicleTextureSet).toBeUndefined();
    expect(vehiclesIndex.vehicleHasArmorArt).toBeUndefined();
  });
});

describe('the mech THEMES decide who shows armor on the body (#472)', () => {
  it('the player still does (that look is #401\'s), the enemy does not', () => {
    expect(themeFor({ theme: 'player' }).armorArt).toBe(true);
    expect(themeFor({ theme: 'enemy' }).armorArt).toBe(false);
  });
});
