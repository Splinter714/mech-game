import { describe, it, expect } from 'vitest';
import {
  damagePerPull, pullIntervalMs, burstDps, sustainedDps, weaponTheory, allWeaponTheory,
  RELOAD_MS,
} from './weaponStats.js';
import { WEAPONS, getWeapon } from './weapons.js';
import { RELOAD_SECONDS } from './Mech.js';

describe('weaponStats — DPS helpers (#423)', () => {
  it('RELOAD_MS mirrors Mech.RELOAD_SECONDS', () => {
    expect(RELOAD_MS).toBe(RELOAD_SECONDS * 1000);
  });

  describe('damagePerPull = damage × count', () => {
    it('single-count weapon = its damage', () => {
      expect(damagePerPull(getWeapon('autocannon'))).toBeCloseTo(36, 5);
    });
    it('spread weapon multiplies by count (shotgun 7 pellets)', () => {
      expect(damagePerPull(getWeapon('shotgun'))).toBeCloseTo(5.5 * 7, 5);
    });
    it('burst weapon uses per-sub-shot damage × count (pulseLaser)', () => {
      // w() split totalDamage 60 across count 5 → 12 each; pull emits all 5.
      expect(damagePerPull(getWeapon('pulseLaser'))).toBeCloseTo(60, 5);
    });
  });

  describe('pullIntervalMs mirrors firing.js _fireInterval', () => {
    it('stream weapon → 1000/fireRate (not cycleTime)', () => {
      expect(pullIntervalMs(getWeapon('beamLaser'))).toBeCloseTo(50, 5);    // 1000/20
      expect(pullIntervalMs(getWeapon('machineGun'))).toBeCloseTo(1000 / 18, 5);
    });
    it('non-stream weapon → max(120, cycleTime)', () => {
      expect(pullIntervalMs(getWeapon('autocannon'))).toBe(1100);
    });
    it('floors at 120ms', () => {
      expect(pullIntervalMs({ delivery: {}, cycleTime: 0 })).toBe(120);
    });
  });

  describe('burstDps matches the weapons.js DPS comments', () => {
    const cases = [
      ['autocannon', 33], ['railLance', 31.5], ['plasmaCannon', 50], ['shotgun', 32],
      ['beamLaser', 32], ['machineGun', 32], ['pulseLaser', 33],
    ];
    for (const [id, dps] of cases) {
      it(`${id} ≈ ${dps} dps`, () => {
        expect(burstDps(getWeapon(id))).toBeCloseTo(dps, 0);
      });
    }
  });

  describe('sustainedDps', () => {
    it('formula = (mag*dmg) / (mag*interval + reload) in seconds (autocannon)', () => {
      const w = getWeapon('autocannon');
      const expected = (5 * 36) / ((5 * 1100 + RELOAD_MS) / 1000);
      expect(sustainedDps(w)).toBeCloseTo(expected, 5);
    });
    it('is strictly below burst for a reloading weapon', () => {
      const w = getWeapon('autocannon');
      expect(sustainedDps(w)).toBeLessThan(burstDps(w));
    });
    it('ammoMax null (unlimited) → sustained equals burst (no reload)', () => {
      const melee = { id: 'x', damage: 10, ammoMax: null, cycleTime: 500, delivery: {} };
      expect(sustainedDps(melee)).toBe(burstDps(melee));
    });
    it('swarmRack big mag keeps sustained close to burst', () => {
      const w = getWeapon('swarmRack');
      expect(sustainedDps(w) / burstDps(w)).toBeGreaterThan(0.85);   // 14-round mag ~15.4s burst vs 2s reload
    });
  });

  describe('weaponTheory', () => {
    it('accepts an id or a resolved entry, same result', () => {
      expect(weaponTheory('shotgun')).toEqual(weaponTheory(getWeapon('shotgun')));
    });
    it('returns null for an unknown id', () => {
      expect(weaponTheory('nope')).toBeNull();
    });
    it('reloadMs is 0 for unlimited weapons, RELOAD_MS otherwise', () => {
      expect(weaponTheory('autocannon').reloadMs).toBe(RELOAD_MS);
      expect(weaponTheory({ id: 'm', damage: 1, ammoMax: null, delivery: {} }).reloadMs).toBe(0);
    });
    it('carries id/name/category through', () => {
      const t = weaponTheory('machineGun');
      expect(t).toMatchObject({ id: 'machineGun', name: 'Repeater', category: 'ballistic' });
    });
  });

  it('allWeaponTheory covers every catalog weapon', () => {
    const all = allWeaponTheory();
    expect(Object.keys(all).sort()).toEqual(Object.keys(WEAPONS).sort());
    for (const t of Object.values(all)) expect(t.sustainedDps).toBeGreaterThan(0);
  });
});
