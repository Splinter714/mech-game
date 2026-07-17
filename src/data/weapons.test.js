import { describe, it, expect } from 'vitest';
import { WEAPONS, WEAPON_IDS, catalogMaxRange, previewRangeFrac, getWeapon, resolveWeapon } from './weapons.js';

// #120: the weapon catalog card preview scales its shot/beam travel distance by each
// weapon's range relative to the rest of the catalog, instead of every card maxing out its
// own stage width. These pure helpers (src/ui/weaponCardList.js consumes them) are what make
// that scaling actually reflect real range differences — cover them directly rather than only
// through the Phaser-only UI component that isn't unit-testable in this project's node/Vitest
// setup (no DOM/`navigator`).
describe('catalogMaxRange', () => {
  it('is the farthest opt (falling back to max) range among the given ids', () => {
    const max = catalogMaxRange(WEAPON_IDS);
    const expected = Math.max(...WEAPON_IDS.map((id) => {
      const r = WEAPONS[id].range;
      return r.opt || r.max || 0;
    }));
    expect(max).toBe(expected);
  });

  it('defaults to the player-facing WEAPON_IDS set, not every shelved weapon', () => {
    // Siege Shell is shelved (enemy-only) with a much longer range than anything on the
    // player-facing catalog — it must not be allowed to flatten the visible spread among the
    // weapons players actually see side by side in the garage/weapon lab.
    expect(WEAPON_IDS).not.toContain('siegeShell');
    expect(catalogMaxRange()).toBeLessThan(WEAPONS.siegeShell.range.opt);
  });
});

describe('previewRangeFrac', () => {
  it('gives a short-range weapon a visibly smaller fraction than a long-range one', () => {
    const catalogMax = catalogMaxRange(WEAPON_IDS);
    // Repeater (opt 338) is much shorter-range than Cluster Salvo (opt 660), the farthest
    // weapon on the player-facing catalog.
    const shortFrac = previewRangeFrac(WEAPONS.machineGun, catalogMax);
    const longFrac = previewRangeFrac(WEAPONS.clusterRocket, catalogMax);
    expect(shortFrac).toBeLessThan(longFrac);
    expect(longFrac).toBeCloseTo(1, 5);
  });

  it('floors the fraction so an extremely short-range weapon stays visible', () => {
    const tinyWeapon = { range: { opt: 1, max: 1 } };
    expect(previewRangeFrac(tinyWeapon, 1000)).toBeGreaterThanOrEqual(0.15);
  });

  it('falls back to range.max when opt is absent, and to 1 with no catalog max', () => {
    expect(previewRangeFrac({ range: { max: 500 } }, 1000)).toBeCloseTo(0.5, 5);
    expect(previewRangeFrac({ range: { opt: 100 } }, 0)).toBe(1);
  });
});

// #243 (absorbing #242): per-owner weapon overrides — a partial delta shallow-merged onto the
// shared base WEAPONS entry (with the nested `delivery` also field-merged), so a unit can mount
// "the same weapon, but tuned" without forking a near-duplicate registry entry. The base entry
// must never be mutated; the player's mount always resolves the untouched original.
describe('resolveWeapon (#243)', () => {
  it('returns the base entry itself (same reference) with no override', () => {
    expect(resolveWeapon('machineGun')).toBe(WEAPONS.machineGun);
    expect(resolveWeapon('machineGun', null)).toBe(WEAPONS.machineGun);
  });

  it('returns undefined for an unknown base id (mirrors getWeapon)', () => {
    expect(resolveWeapon('noSuchWeapon', { damage: 1 })).toBeUndefined();
    expect(getWeapon('noSuchWeapon')).toBeUndefined();
  });

  it('shallow-merges top-level fields — overridden fields win, everything else passes through', () => {
    const r = resolveWeapon('machineGun', { damage: 1 });
    expect(r.damage).toBe(1);
    // Untouched fields come straight from the base entry.
    expect(r.id).toBe(WEAPONS.machineGun.id);
    expect(r.name).toBe(WEAPONS.machineGun.name);
    expect(r.category).toBe(WEAPONS.machineGun.category);
    expect(r.range).toEqual(WEAPONS.machineGun.range);
    expect(r.ammoMax).toBe(WEAPONS.machineGun.ammoMax);
  });

  it('shallow-merges the nested delivery object field by field (not wholesale replacement)', () => {
    const r = resolveWeapon('machineGun', { delivery: { fireRate: 9 } });
    expect(r.delivery.fireRate).toBe(9);
    // Every other delivery field survives from the base profile.
    expect(r.delivery.pattern).toBe('stream');
    expect(r.delivery.streams).toBe(WEAPONS.machineGun.delivery.streams);
    expect(r.delivery.velocity).toBe(WEAPONS.machineGun.delivery.velocity);
    expect(r.delivery.kind).toBe(WEAPONS.machineGun.delivery.kind);
    expect(r.delivery.hit).toBe(WEAPONS.machineGun.delivery.hit);
  });

  it('never mutates the base WEAPONS entry (or its delivery)', () => {
    const before = JSON.parse(JSON.stringify(WEAPONS.machineGun));
    const r = resolveWeapon('machineGun', { damage: 1, delivery: { fireRate: 9, streams: 1 } });
    expect(r).not.toBe(WEAPONS.machineGun);
    expect(r.delivery).not.toBe(WEAPONS.machineGun.delivery);
    expect(JSON.parse(JSON.stringify(WEAPONS.machineGun))).toEqual(before);
    // And a later plain resolve still yields the pristine base values.
    expect(resolveWeapon('machineGun').damage).toBe(before.damage);
    expect(resolveWeapon('machineGun').delivery.fireRate).toBe(before.delivery.fireRate);
  });

  it('keeps the base weapon id unless explicitly overridden (SFX/fire-cue systems key off it)', () => {
    expect(resolveWeapon('machineGun', { damage: 1 }).id).toBe('machineGun');
  });
});
