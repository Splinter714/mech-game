import { describe, it, expect } from 'vitest';
import {
  POWERUPS, POWERUP_IDS, pickPowerupType, isInstant, durationMs, buffModifiers, armorRepairPlan,
  dropChanceForMaxHp, MIN_DROP_CHANCE, MAX_DROP_CHANCE,
} from './powerups.js';
import { Mech } from './Mech.js';

describe('powerup catalog', () => {
  it('has the six owner-approved powerups and NO Target Paint (it was cut)', () => {
    expect(POWERUP_IDS.sort()).toEqual(
      ['armorPatch', 'doubleShot', 'overcharge', 'overclock', 'overdrive', 'surge'].sort(),
    );
    expect(POWERUPS.targetPaint).toBeUndefined();
  });

  it('marks only Armor Patch as instant (no timer); the rest are timed', () => {
    expect(isInstant('armorPatch')).toBe(true);
    for (const id of ['overcharge', 'surge', 'overdrive', 'doubleShot', 'overclock']) {
      expect(isInstant(id)).toBe(false);
      expect(durationMs(id)).toBeGreaterThan(0);
    }
    expect(durationMs('armorPatch')).toBe(0);
  });
});

describe('pickPowerupType — weighted selection', () => {
  it('is deterministic under a fixed rng and returns a real id', () => {
    expect(pickPowerupType(() => 0)).toBe(POWERUP_IDS[0]);
    // rng≈1 lands on the last weighted bucket.
    expect(POWERUP_IDS).toContain(pickPowerupType(() => 0.999999));
  });

  it('covers every type across the 0..1 range', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(pickPowerupType(() => i / 1000));
    for (const id of POWERUP_IDS) expect(seen.has(id)).toBe(true);
  });
});

describe('buffModifiers — collapsing the active overlay', () => {
  it('returns the identity when nothing is active', () => {
    const m = buffModifiers({});
    expect(m).toEqual({
      freeAmmo: false, ammoRegenMult: 1, cycleMult: 1,
      doubleShot: false, spreadTighten: 1, moveMult: 1, slewMult: 1,
    });
  });

  it('ignores expired (non-positive remaining) entries', () => {
    const m = buffModifiers({ overcharge: 0, surge: -5 });
    expect(m.freeAmmo).toBe(false);
    expect(m.ammoRegenMult).toBe(1);
  });

  it('applies each timed buff to its own field', () => {
    expect(buffModifiers({ overcharge: 500 }).freeAmmo).toBe(true);
    expect(buffModifiers({ surge: 500 }).ammoRegenMult).toBe(POWERUPS.surge.ammoRegenMult);
    expect(buffModifiers({ overdrive: 500 }).cycleMult).toBe(POWERUPS.overdrive.cycleMult);
    const ds = buffModifiers({ doubleShot: 500 });
    expect(ds.doubleShot).toBe(true);
    expect(ds.spreadTighten).toBe(POWERUPS.doubleShot.spreadTighten);
    const oc = buffModifiers({ overclock: 500 });
    expect(oc.moveMult).toBe(POWERUPS.overclock.moveMult);
    expect(oc.slewMult).toBe(POWERUPS.overclock.slewMult);
  });

  it('stacks DIFFERENT types simultaneously (one-per-type overlay)', () => {
    const m = buffModifiers({ overcharge: 500, overdrive: 500, overclock: 500 });
    expect(m.freeAmmo).toBe(true);
    expect(m.cycleMult).toBe(POWERUPS.overdrive.cycleMult);
    expect(m.moveMult).toBe(POWERUPS.overclock.moveMult);
  });
});

describe('armorRepairPlan — whole-mech proportional repair (Armor Patch rework)', () => {
  it('restores a fraction of EACH damaged location\'s missing armor, skipping full ones', () => {
    const parts = {
      head: { armor: 10, maxArmor: 10 },        // undamaged → no repair
      centerTorso: { armor: 0, maxArmor: 40 },  // missing 40
      leftArm: { armor: 15, maxArmor: 25 },     // missing 10
    };
    const plan = armorRepairPlan(parts, 0.5);
    expect(plan.head).toBeUndefined();
    expect(plan.centerTorso).toBe(20);          // 0.5 * 40
    expect(plan.leftArm).toBe(5);               // 0.5 * 10
  });

  it('returns an empty plan for a pristine mech', () => {
    const parts = { head: { armor: 10, maxArmor: 10 }, centerTorso: { armor: 40, maxArmor: 40 } };
    expect(armorRepairPlan(parts, 0.5)).toEqual({});
  });
});

describe('dropChanceForMaxHp — #90 difficulty-scaled powerup drop odds', () => {
  it('gives the weakest real enemy (drone, hp 14) the MIN chance', () => {
    expect(dropChanceForMaxHp(14)).toBeCloseTo(MIN_DROP_CHANCE, 5);
  });

  it('gives the toughest real enemy (base heavy mech, maxHp 616) the MAX chance', () => {
    expect(dropChanceForMaxHp(616)).toBeCloseTo(MAX_DROP_CHANCE, 5);
  });

  it('clamps below the floor and above the ceiling instead of extrapolating', () => {
    expect(dropChanceForMaxHp(0)).toBe(MIN_DROP_CHANCE);
    expect(dropChanceForMaxHp(1)).toBe(MIN_DROP_CHANCE);
    expect(dropChanceForMaxHp(10000)).toBe(MAX_DROP_CHANCE);
  });

  it('treats missing/falsy input as zero hp (MIN chance), never NaN or negative', () => {
    expect(dropChanceForMaxHp(undefined)).toBe(MIN_DROP_CHANCE);
    expect(dropChanceForMaxHp(null)).toBe(MIN_DROP_CHANCE);
    expect(dropChanceForMaxHp(-50)).toBe(MIN_DROP_CHANCE);
  });

  it('is monotonic — a tougher enemy never yields a LOWER chance than a weaker one', () => {
    // The actual roster's maxHp spread, weakest to toughest (see enemyKinds.js + Mech.maxHp).
    const roster = [14, 70, 90, 160, 266, 416, 616]; // drone, heli, turret, tank, light, medium, heavy
    let prev = -Infinity;
    for (const hp of roster) {
      const chance = dropChanceForMaxHp(hp);
      expect(chance).toBeGreaterThanOrEqual(prev);
      prev = chance;
    }
    // Strictly increasing across this spread (no two tiers tie).
    const chances = roster.map(dropChanceForMaxHp);
    for (let i = 1; i < chances.length; i++) expect(chances[i]).toBeGreaterThan(chances[i - 1]);
  });

  it('lands a medium mech (the likely most-common kill) close to the old flat 0.75 rate', () => {
    expect(dropChanceForMaxHp(416)).toBeGreaterThan(0.7);
    expect(dropChanceForMaxHp(416)).toBeLessThan(0.8);
  });

  it('agrees with the real Mech.maxHp getter for each chassis', () => {
    const light = new Mech({ chassisId: 'light' }).maxHp;
    const medium = new Mech({ chassisId: 'medium' }).maxHp;
    const heavy = new Mech({ chassisId: 'heavy' }).maxHp;
    expect(light).toBe(266);
    expect(medium).toBe(416);
    expect(heavy).toBe(616);
    expect(dropChanceForMaxHp(heavy)).toBeGreaterThan(dropChanceForMaxHp(medium));
    expect(dropChanceForMaxHp(medium)).toBeGreaterThan(dropChanceForMaxHp(light));
  });
});
