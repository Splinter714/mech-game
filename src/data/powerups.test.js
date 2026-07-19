import { describe, it, expect } from 'vitest';
import {
  POWERUPS, POWERUP_IDS, pickPowerupType, isInstant, durationMs, buffModifiers, armorRepairPlan,
  dropChanceForToughness, dropChanceForKill, dropBounds, dropBoundsForRoster,
  MIN_DROP_CHANCE, MAX_DROP_CHANCE, CRUSH_KILL_DROP_CHANCE,
} from './powerups.js';
import { Mech } from './Mech.js';
import { HpBody } from './HpBody.js';
import { ENEMY_KINDS } from './enemyKinds.js';
import { ENEMIES } from './enemies.js';

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


// ── #106: the toughness-scaled drop curve ────────────────────────────────────────────────
// Three things changed here in #106 and each is pinned below:
//   1) the floor/ceiling are DERIVED from the live roster, not hardcoded;
//   2) the curve is CONVEX (exp 1.5), so easy kills stay near the floor much longer;
//   3) toughness = structure + armor + shield for EVERY body type (armor/shields used to be
//      invisible on non-mech kinds, under-rating vehicles).
// Plus the crush/stomp kill path, which bypasses the curve entirely.

// The real toughness of one roster entry, read through the same accessors the game uses.
const kindToughness = (id) => new HpBody(ENEMY_KINDS[id]).toughness;
const mechToughness = (id) => new Mech(ENEMIES[id]).toughness;

describe('#106: toughness = structure + armor + shield, uniformly across body types', () => {
  it('counts a vehicle\'s ARMOR pool, which the old maxHp signal ignored', () => {
    const tank = new HpBody(ENEMY_KINDS.tank);
    expect(tank.maxHp).toBe(160);        // structure only — unchanged meaning
    expect(tank.toughness).toBe(200);    // + its 40-point armor pool
  });

  it('counts a vehicle\'s SHIELD pool too (helicopter: hp + shield, no armor)', () => {
    const heli = new HpBody(ENEMY_KINDS.helicopter);
    expect(heli.maxHp).toBe(70);
    expect(heli.toughness).toBe(100);    // + its 30-point shield
  });

  it('counts all three layers at once (quadruped: 260 hp + 60 armor + 50 shield)', () => {
    expect(new HpBody(ENEMY_KINDS.quadruped).toughness).toBe(370);
  });

  it('leaves maxHp alone on both body types (other consumers rely on its current meaning)', () => {
    expect(new HpBody(ENEMY_KINDS.quadruped).maxHp).toBe(260);
    expect(new Mech({ chassisId: 'heavy' }).maxHp).toBe(430);
  });

  it('for a shieldless mech, toughness equals its armor+structure maxHp', () => {
    for (const c of ['light', 'medium', 'heavy']) {
      const m = new Mech({ chassisId: c });
      expect(m.toughness).toBe(m.maxHp);
    }
  });

  it('a live Shield powerup does not inflate a mech\'s rated toughness', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 40, regenPerSec: 2, pauseMs: 500 } });
    const before = m.toughness;
    expect(before).toBe(m.maxHp + 40);
    m.boostShield(2.5, 5000);
    expect(m.toughness).toBe(before);    // reads the PRE-boost capacity
  });
});

describe('#106: drop-curve bounds are DERIVED from the live roster, not hardcoded', () => {
  it('derives floor = the weakest unit (infantry, 6) and ceil = the toughest (heavy mech, 430)', () => {
    const { floor, ceil } = dropBounds();
    expect(floor).toBe(kindToughness('infantry'));
    expect(ceil).toBe(mechToughness('artillery'));
    expect(floor).toBe(6);
    expect(ceil).toBe(430);
  });

  it('the endpoints MOVE when the roster does (proving they are derived, not typed in)', () => {
    const stubKinds = {
      pebble: { name: 'Pebble', hp: 3 },
      brick: { name: 'Brick', hp: 100, armor: 50, shield: { max: 50 } },
    };
    const bounds = dropBoundsForRoster({}, stubKinds);
    expect(bounds).toEqual({ floor: 3, ceil: 200 });
    // …and the curve honours the injected bounds end to end.
    expect(dropChanceForToughness(3, bounds)).toBeCloseTo(MIN_DROP_CHANCE, 5);
    expect(dropChanceForToughness(200, bounds)).toBeCloseTo(MAX_DROP_CHANCE, 5);
    // A roster retune (#299) needs no edit in powerups.js: halve everything, endpoints follow.
    const halved = dropBoundsForRoster({}, {
      pebble: { hp: 1.5 }, brick: { hp: 50, armor: 25, shield: { max: 25 } },
    });
    expect(halved).toEqual({ floor: 1.5, ceil: 100 });
  });

  it('degrades gracefully on an empty roster instead of producing NaN', () => {
    const bounds = dropBoundsForRoster({}, {});
    expect(Number.isFinite(dropChanceForToughness(50, bounds))).toBe(true);
  });
});

describe('#106: the convex drop curve over the current roster', () => {
  // The confirmed target table (Jackson, 2026-07-18). Computed from DERIVED bounds — nothing
  // here is a hand-typed floor/ceiling.
  const TABLE = [
    ['infantry', kindToughness('infantry'), 6, 0.05],
    ['drone', kindToughness('drone'), 14, 0.05],
    ['turret', kindToughness('turret'), 90, 0.13],
    ['helicopter', kindToughness('helicopter'), 100, 0.14],
    ['light mech', mechToughness('raider'), 184, 0.29],
    ['tank', kindToughness('tank'), 200, 0.33],
    ['medium mech', mechToughness('sniper'), 290, 0.54],
    ['quadruped', kindToughness('quadruped'), 370, 0.77],
    ['heavy mech', mechToughness('artillery'), 430, 0.95],
  ];

  for (const [label, toughness, expectedToughness, expectedChance] of TABLE) {
    it(`${label}: toughness ${expectedToughness} → ~${Math.round(expectedChance * 100)}%`, () => {
      expect(toughness).toBe(expectedToughness);
      expect(dropChanceForToughness(toughness)).toBeCloseTo(expectedChance, 2);
    });
  }

  it('is CONVEX — the midpoint sits BELOW a straight line (was above, pre-#106)', () => {
    const { floor, ceil } = dropBounds();
    const mid = (floor + ceil) / 2;
    const linearMid = (MIN_DROP_CHANCE + MAX_DROP_CHANCE) / 2;
    expect(dropChanceForToughness(mid)).toBeLessThan(linearMid);
  });

  it('still hits exactly MIN at the floor and MAX at the ceiling', () => {
    const { floor, ceil } = dropBounds();
    expect(dropChanceForToughness(floor)).toBeCloseTo(MIN_DROP_CHANCE, 5);
    expect(dropChanceForToughness(ceil)).toBeCloseTo(MAX_DROP_CHANCE, 5);
  });

  it('clamps outside the bounds and never returns NaN for junk input', () => {
    expect(dropChanceForToughness(0)).toBe(MIN_DROP_CHANCE);
    expect(dropChanceForToughness(-50)).toBe(MIN_DROP_CHANCE);
    expect(dropChanceForToughness(undefined)).toBe(MIN_DROP_CHANCE);
    expect(dropChanceForToughness(null)).toBe(MIN_DROP_CHANCE);
    expect(dropChanceForToughness(10000)).toBe(MAX_DROP_CHANCE);
  });

  it('is strictly monotonic across the roster', () => {
    const spread = TABLE.map(([, t]) => t).filter((t, i, a) => i === 0 || t > a[i - 1]);
    const chances = spread.map((t) => dropChanceForToughness(t));
    for (let i = 1; i < chances.length; i++) {
      expect(chances[i]).toBeGreaterThanOrEqual(chances[i - 1]);
    }
  });
});

describe('#106: crush/stomp kills use a fixed, extremely low chance', () => {
  it('is extremely low (a few percent) and well under even the floor of the curve', () => {
    expect(CRUSH_KILL_DROP_CHANCE).toBeGreaterThan(0);
    expect(CRUSH_KILL_DROP_CHANCE).toBeLessThanOrEqual(0.05);
    expect(CRUSH_KILL_DROP_CHANCE).toBeLessThan(MIN_DROP_CHANCE);
  });

  it('a stomped tank and a stomped trooper roll the SAME chance despite wildly different toughness', () => {
    const tank = kindToughness('tank');        // 200
    const trooper = kindToughness('infantry'); // 6
    expect(tank).not.toBe(trooper);
    expect(dropChanceForKill(tank, true)).toBe(CRUSH_KILL_DROP_CHANCE);
    expect(dropChanceForKill(trooper, true)).toBe(CRUSH_KILL_DROP_CHANCE);
    // …and the stomped tank pays out far less than a tank you actually fought.
    expect(dropChanceForKill(tank, true)).toBeLessThan(dropChanceForKill(tank, false));
  });

  it('leaves weapon kills on the curve, completely unchanged', () => {
    for (const [, t] of [['tank', kindToughness('tank')], ['heavy', mechToughness('artillery')]]) {
      expect(dropChanceForKill(t)).toBe(dropChanceForToughness(t));
      expect(dropChanceForKill(t, false)).toBe(dropChanceForToughness(t));
    }
  });
});
