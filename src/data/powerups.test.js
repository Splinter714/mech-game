import { describe, it, expect } from 'vitest';
import {
  POWERUPS, POWERUP_IDS, pickPowerupType, isInstant, durationMs, buffModifiers, armorRepairPlan,
  dropChanceForMaxHp, MIN_DROP_CHANCE, MAX_DROP_CHANCE,
} from './powerups.js';
import { Mech } from './Mech.js';

describe('powerup catalog', () => {
  it('has the #187 owner-approved roster (Surge + Double Shot cut, Shield added) and NO Target Paint', () => {
    expect(POWERUP_IDS.sort()).toEqual(
      ['armorPatch', 'overcharge', 'overclock', 'overdrive', 'shield'].sort(),
    );
    expect(POWERUPS.surge).toBeUndefined();
    expect(POWERUPS.doubleShot).toBeUndefined();
    expect(POWERUPS.targetPaint).toBeUndefined();
  });

  it('marks Armor Patch as instant (no timer); Overcharge/Overdrive/Overclock are timed', () => {
    expect(isInstant('armorPatch')).toBe(true);
    for (const id of ['overcharge', 'overdrive', 'overclock']) {
      expect(isInstant(id)).toBe(false);
      expect(durationMs(id)).toBeGreaterThan(0);
    }
    expect(durationMs('armorPatch')).toBe(0);
  });

  it('#246: Shield is a timed boost (not instant) on top of its instant full-fill — has a real duration and a boostMult', () => {
    expect(isInstant('shield')).toBe(false);
    expect(durationMs('shield')).toBeGreaterThan(0);
    expect(POWERUPS.shield.boostMult).toBeGreaterThan(1);
  });

  it('#189: Overclock carries no numeric magnitude fields — its effect is force-Sprint, not a multiplier', () => {
    expect(POWERUPS.overclock.moveMult).toBeUndefined();
    expect(POWERUPS.overclock.slewMult).toBeUndefined();
    expect(POWERUPS.overclock.effect).toBe('overclock');
    expect(POWERUPS.overclock.duration).toBeGreaterThan(0);
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
    expect(m).toEqual({ freeAmmo: false, cycleMult: 1, overclockActive: false });
  });

  it('ignores expired (non-positive remaining) entries', () => {
    const m = buffModifiers({ overcharge: 0, overdrive: -5 });
    expect(m.freeAmmo).toBe(false);
    expect(m.cycleMult).toBe(1);
  });

  it('applies each timed buff to its own field', () => {
    expect(buffModifiers({ overcharge: 500 }).freeAmmo).toBe(true);
    expect(buffModifiers({ overdrive: 500 }).cycleMult).toBe(POWERUPS.overdrive.cycleMult);
    const oc = buffModifiers({ overclock: 500 });
    expect(oc.overclockActive).toBe(true);
  });

  it('stacks DIFFERENT types simultaneously (one-per-type overlay)', () => {
    const m = buffModifiers({ overcharge: 500, overdrive: 500, overclock: 500 });
    expect(m.freeAmmo).toBe(true);
    expect(m.cycleMult).toBe(POWERUPS.overdrive.cycleMult);
    expect(m.overclockActive).toBe(true);
  });

  it('Shield never contributes to buffModifiers even when "active" would include it — it is tracked out-of-band', () => {
    const m = buffModifiers({ shield: 500 });
    expect(m).toEqual({ freeAmmo: false, cycleMult: 1, overclockActive: false });
  });
});

// #246: the old fixed damage-pool shield math (`absorbShieldDamage`) moved to data/shield.js —
// see shield.test.js for its coverage (damageShield/tickShield/fillShield/boost lifecycle).

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

describe('dropChanceForMaxHp — #90/#106 difficulty-scaled powerup drop odds', () => {
  it('gives the weakest real enemy (drone, hp 14) the MIN chance', () => {
    expect(dropChanceForMaxHp(14)).toBeCloseTo(MIN_DROP_CHANCE, 5);
  });

  it('#106: the floor reads as appropriately rare (low single digits), not a coin flip', () => {
    expect(MIN_DROP_CHANCE).toBeLessThanOrEqual(0.08);
    expect(MIN_DROP_CHANCE).toBeGreaterThan(0);
  });

  it('gives the toughest real enemy (base heavy mech, maxHp 400) the MAX chance', () => {
    expect(dropChanceForMaxHp(400)).toBeCloseTo(MAX_DROP_CHANCE, 5);
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
    // #128: light/medium/heavy dropped to 172/270/400 when head/cockpit/centerTorso left the
    // tracked damage locations (was 266/416/616).
    const roster = [14, 70, 90, 160, 172, 270, 400]; // drone, heli, turret, tank, light, medium, heavy
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

  it('#106: weak/moderate kills (drone/heli/turret) drop meaningfully less than the old floor', () => {
    // Old flat-linear floor was 0.35 — every one of these trivial-to-moderate kills should now
    // sit well under that, with the drone (true floor) reading as low single digits.
    expect(dropChanceForMaxHp(14)).toBeLessThan(0.1);   // drone
    expect(dropChanceForMaxHp(70)).toBeLessThan(0.35);  // helicopter
    expect(dropChanceForMaxHp(90)).toBeLessThan(0.35);  // turret
  });

  it('lands a medium mech (the likely most-common kill) close to the old flat 0.75 rate', () => {
    // #106 bent the curve concave specifically so this "typical kill" sanity check from #90
    // still holds even though the floor dropped from 0.35 to 0.05. #128 later moved the medium
    // mech's real maxHp to 270 (was 416), and #230's torso-HP bump (see chassis/index.js
    // FACTORS) moved it again to 290, but the floor/ceiling moved down in near-identical
    // proportion each time, so this still lands in the same 0.7-0.8 band.
    expect(dropChanceForMaxHp(290)).toBeGreaterThan(0.7);
    expect(dropChanceForMaxHp(290)).toBeLessThan(0.8);
  });

  it('agrees with the real Mech.maxHp getter for each chassis', () => {
    const light = new Mech({ chassisId: 'light' }).maxHp;
    const medium = new Mech({ chassisId: 'medium' }).maxHp;
    const heavy = new Mech({ chassisId: 'heavy' }).maxHp;
    // #128: head/cockpit/centerTorso no longer contribute armor/structure to maxHp, so these
    // are lower than the pre-#128 values (266/416/616). #230: side-torso FACTORS bumped
    // 0.75 -> 0.85 (arms unchanged at 0.6) to close the gap between a torso's health and how
    // much more often it gets hit, raising these from 172/270/400 to 184/290/430.
    expect(light).toBe(184);
    expect(medium).toBe(290);
    expect(heavy).toBe(430);
    expect(dropChanceForMaxHp(heavy)).toBeGreaterThan(dropChanceForMaxHp(medium));
    expect(dropChanceForMaxHp(medium)).toBeGreaterThan(dropChanceForMaxHp(light));
  });
});
