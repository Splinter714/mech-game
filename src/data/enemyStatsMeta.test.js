import { describe, it, expect } from 'vitest';
import {
  baseKind, enemyWeaponInfo, enemyOverrideSummary, enemyRealHp,
} from './enemyStatsMeta.js';
import { WEAPONS } from './weapons.js';

describe('baseKind', () => {
  it('maps the carrier-brood stat kind back onto the drone kind', () => {
    expect(baseKind('droneBrood')).toBe('drone');
    expect(baseKind('drone')).toBe('drone');
    expect(baseKind('tank')).toBe('tank');
    // "Brood" alone is not a suffix-stripped kind (guard against slicing to empty).
    expect(baseKind('Brood')).toBe('Brood');
  });
});

describe('enemyWeaponInfo — overrides', () => {
  it('flags a single-weapon kind with a real override and diffs the changed field', () => {
    // Tank mounts the autocannon but slows its cadence: cycleTime 1100 -> 1500.
    const info = enemyWeaponInfo('tank');
    expect(info.hasOverride).toBe(true);
    expect(info.weapons).toHaveLength(1);
    const w = info.weapons[0];
    expect(w.weaponId).toBe('autocannon');
    expect(w.weaponName).toBe(WEAPONS.autocannon.name);
    expect(w.slot).toBeNull();
    expect(w.diffs).toContain('cycleTime: 1100 → 1500');
  });

  it('diffs a nested delivery field (infantry Repeater fireRate)', () => {
    const info = enemyWeaponInfo('infantry');
    expect(info.hasOverride).toBe(true);
    const w = info.weapons[0];
    expect(w.weaponId).toBe('machineGun');
    // base fireRate 18 -> 10/7 ≈ 1.43
    expect(w.diffs.some((d) => d.startsWith('delivery.fireRate:'))).toBe(true);
    expect(w.diffs[0]).toContain('18 →');
  });

  it('maps droneBrood → drone and reports NO override (drone fires the base weapon)', () => {
    const brood = enemyWeaponInfo('droneBrood');
    const drone = enemyWeaponInfo('drone');
    expect(brood.kind).toBe('drone');
    expect(brood.hasOverride).toBe(false);
    expect(drone.hasOverride).toBe(false);
    expect(brood).toEqual(drone);
    expect(brood.weapons[0].weaponId).toBe('plasmaLance');
  });

  it('handles a multi-slot kind (gunship): lists every slot', () => {
    const info = enemyWeaponInfo('helicopter');
    const slots = info.weapons.map((w) => w.slot);
    expect(slots).toContain('nose');
    expect(slots).toContain('flank');
    // Each slot names its base weapon.
    const nose = info.weapons.find((w) => w.slot === 'nose');
    const flank = info.weapons.find((w) => w.slot === 'flank');
    expect(nose.weaponId).toBe('clusterRocket');
    expect(flank.weaponId).toBe('machineGun');
    // The flank override restates Repeater's own count: 2 — a no-op, so NOT flagged as a change.
    expect(flank.hasOverride).toBe(false);
    expect(nose.hasOverride).toBe(false);
    expect(info.hasOverride).toBe(false);
  });

  it('reports no override and no fixed weapons for a mech chassis kind (rolled per spawn, #474)', () => {
    // #474: enemy mechs roll their loadout at spawn, so a chassis kind has no fixed designed
    // weapon to report — the weapon list is empty and nothing is flagged as an override.
    const info = enemyWeaponInfo('light');
    expect(info.hasOverride).toBe(false);
    expect(info.weapons).toEqual([]);
  });

  it('flags the wall turret (rail lance range override)', () => {
    const info = enemyWeaponInfo('wallTurret');
    expect(info.hasOverride).toBe(true);
    const w = info.weapons[0];
    expect(w.weaponId).toBe('railLance');
    expect(w.diffs.some((d) => d.startsWith('range.'))).toBe(true);
  });

  it('returns an empty, no-override result for an unknown kind', () => {
    const info = enemyWeaponInfo('nope');
    expect(info.hasOverride).toBe(false);
    expect(info.weapons).toEqual([]);
  });
});

describe('enemyOverrideSummary', () => {
  it('formats a single-weapon override as "<name> (enemy variant) — <diffs>"', () => {
    const s = enemyOverrideSummary('tank');
    expect(s).toContain('Autocannon (enemy variant)');
    expect(s).toContain('cycleTime: 1100 → 1500');
  });

  it('returns empty string when there is no override', () => {
    expect(enemyOverrideSummary('drone')).toBe('');
    expect(enemyOverrideSummary('light')).toBe('');
  });
});

describe('enemyRealHp — designed durability', () => {
  it('sums a non-mech HpBody kind: structure + armor + shield', () => {
    expect(enemyRealHp('wallTurret')).toBe(50);   // 35 + 15 + 0
    expect(enemyRealHp('tank')).toBe(80);          // 50 + 30 + 0
    expect(enemyRealHp('drone')).toBe(10);         // 5 + 0 + shield 5
    expect(enemyRealHp('carrier')).toBe(150);      // 50 + 100 + 0
    expect(enemyRealHp('helicopter')).toBe(50);    // 35 + 0 + shield 15
  });

  it('maps droneBrood → drone', () => {
    expect(enemyRealHp('droneBrood')).toBe(enemyRealHp('drone'));
  });

  it('sums a mech chassis kind: chassis armor+structure across locations + shield', () => {
    // Light mech = light chassis (75 armor + 100 structure) + 25 shield = 200.
    expect(enemyRealHp('light')).toBe(200);
    // Heavy mech = heavy chassis (225 + 200) + 75 shield = 500.
    expect(enemyRealHp('heavy')).toBe(500);
  });

  it('returns null for an unknown kind', () => {
    expect(enemyRealHp('nope')).toBeNull();
  });
});
