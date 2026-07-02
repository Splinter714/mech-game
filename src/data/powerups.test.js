import { describe, it, expect } from 'vitest';
import {
  POWERUPS, POWERUP_IDS, pickPowerupType, isInstant, durationMs, buffModifiers, armorRepairPlan,
} from './powerups.js';

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
