import { describe, it, expect } from 'vitest';
import {
  damagePerPull, pullIntervalMs, burstDps, sustainedDps, weaponTheory, allWeaponTheory,
  RELOAD_MS, projectilesPerRound, magazineReadout,
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

// ── #451: the ammo readout counts PROJECTILES, not trigger pulls ─────────────────────────────
// Jackson: "missile ammo/reload should be the projectile count, not just the 'shot' count" —
// a 4-round magazine firing 5 missiles a pull reads as 20 and falls by 5 a pull.
describe('#451 magazine readout — projectiles remaining', () => {
  const w = (ammoMax, delivery = {}) => ({ ammoMax, delivery });

  it('a single-shot weapon is unchanged: one round, one projectile', () => {
    expect(projectilesPerRound(w(12))).toBe(1);
    const m = magazineReadout(w(12), 12);
    expect([m.left, m.max]).toEqual([12, 12]);
  });

  it('the issue\'s own example: a 4-round rack of 5-missile salvoes reads 20', () => {
    const rack = w(4, { count: 5 });
    expect(projectilesPerRound(rack)).toBe(5);
    expect(magazineReadout(rack, 4).max).toBe(20);
    expect(magazineReadout(rack, 4).left).toBe(20);
    // ...and drops by FIVE per trigger pull, not one.
    expect(magazineReadout(rack, 3).left).toBe(15);
    expect(magazineReadout(rack, 1).left).toBe(5);
    expect(magazineReadout(rack, 0).left).toBe(0);
  });

  it('is generic — every multi-projectile weapon counts the same way, not just the missiles', () => {
    for (const count of [2, 3, 6, 7]) {
      expect(magazineReadout(w(10, { count }), 10).max).toBe(10 * count);
    }
  });

  it('a per-bolt-ammo volley (delivery.ammoPerShot) already spends a round per bolt, so it is 1:1', () => {
    const arc = w(30, { count: 5, ammoPerShot: true });
    expect(projectilesPerRound(arc)).toBe(1);
    expect(magazineReadout(arc, 30).max).toBe(30);
    expect(magazineReadout(arc, 25).left).toBe(25);
  });

  it('never advertises a pull the magazine cannot afford (fractional ammo from Overdrive)', () => {
    // 0.5 of a round left on a 5-missile rack is not 2 missiles you can fire.
    expect(magazineReadout(w(4, { count: 5 }), 0.5).left).toBe(2);
    expect(magazineReadout(w(4, { count: 5 }), 0.9).left).toBe(4);
    expect(magazineReadout(w(12), 0.5).left).toBe(0);
  });

  it('keeps the ammo BAR reading as a fraction of the magazine either way', () => {
    expect(magazineReadout(w(4, { count: 5 }), 2).frac).toBeCloseTo(0.5, 6);
    expect(magazineReadout(w(12), 6).frac).toBeCloseTo(0.5, 6);
  });

  it('has nothing to report for an unlimited weapon (melee)', () => {
    expect(magazineReadout(w(null), null)).toBeNull();
    expect(magazineReadout(w(null), 5)).toBeNull();
  });

  it('every real catalog weapon reports a whole, positive projectile magazine', () => {
    for (const id of Object.keys(WEAPONS)) {
      const weapon = getWeapon(id);
      const m = magazineReadout(weapon, weapon.ammoMax);
      if (weapon.ammoMax == null) { expect(m).toBeNull(); continue; }
      expect(Number.isInteger(m.max)).toBe(true);
      expect(m.max).toBeGreaterThanOrEqual(weapon.ammoMax);
      expect(m.left).toBe(m.max);
    }
  });
});
