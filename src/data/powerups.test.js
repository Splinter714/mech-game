import { describe, it, expect } from 'vitest';
import {
  POWERUPS, POWERUP_IDS, POWERUP_POOL_IDS, pickPowerupType, isInstant, durationMs, buffModifiers, armorRepairPlan,
  powerupSpotColors,
  dropChanceForToughness, dropChanceForKill, dropBounds, dropBoundsForRoster,
  MIN_DROP_CHANCE, MAX_DROP_CHANCE, CRUSH_KILL_DROP_CHANCE,
  stackedRemainingMs, maxStackedMs, MAX_STACK_MULT,
} from './powerups.js';
import { Mech } from './Mech.js';
import { HpBody } from './HpBody.js';
import { ENEMY_KINDS } from './enemyKinds.js';
import { ENEMIES } from './enemies.js';

describe('powerup catalog', () => {
  it('#409: INFINITE FIRE joins the roster; Overcharge stays folded out', () => {
    expect(POWERUP_IDS.sort()).toEqual(
      ['armorPatch', 'overclock', 'overdrive', 'shield', 'barrage', 'infiniteFire'].sort(),
    );
    expect(POWERUPS.overcharge).toBeUndefined();   // #381: no longer a separate pickup
    expect(POWERUPS.surge).toBeUndefined();
    expect(POWERUPS.doubleShot).toBeUndefined();   // #137's Barrage is the shot-count buff now
    expect(POWERUPS.targetPaint).toBeUndefined();
  });

  it('#409: every TIMED (overlay) powerup runs a UNIFORM 10-second window', () => {
    for (const id of ['overdrive', 'overclock', 'barrage', 'infiniteFire']) {
      expect(POWERUPS[id].duration).toBe(10);
      expect(durationMs(id)).toBe(10000);
    }
  });

  it('#409: Armor Patch and Shield are purely INSTANT now — no duration/overlay window', () => {
    for (const id of ['armorPatch', 'shield']) {
      expect(isInstant(id)).toBe(true);
      expect(POWERUPS[id].duration).toBeUndefined();
      expect(durationMs(id)).toBe(0);   // no free-ammo window anymore (#409)
    }
    for (const id of ['overdrive', 'overclock']) {
      expect(isInstant(id)).toBe(false);
      expect(durationMs(id)).toBeGreaterThan(0);
    }
  });

  it('#409/#417: Shield grants a temporary POOL (not a capacity/regen multiplier), instant, no boostMult', () => {
    expect(isInstant('shield')).toBe(true);
    expect(POWERUPS.shield.tempPool).toBeGreaterThan(0);
    expect(POWERUPS.shield.boostMult).toBeUndefined();
  });

  it('#409: INFINITE FIRE is a timed cyan buff whose effect is free-ammo + no-reload', () => {
    expect(isInstant('infiniteFire')).toBe(false);
    expect(durationMs('infiniteFire')).toBe(10000);
    expect(POWERUPS.infiniteFire.effect).toBe('infiniteFire');
    expect(POWERUPS.infiniteFire.color).toBe(0x28e0d8);
    const m = buffModifiers({ infiniteFire: 500 });
    expect(m.freeAmmo).toBe(true);
    expect(m.noReload).toBe(true);
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
    expect(pickPowerupType(() => 0)).toBe(POWERUP_POOL_IDS[0]);
    // rng≈1 lands on the last weighted bucket.
    expect(POWERUP_POOL_IDS).toContain(pickPowerupType(() => 0.999999));
  });

  it('covers every POOLED type across the 0..1 range', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(pickPowerupType(() => i / 1000));
    for (const id of POWERUP_POOL_IDS) expect(seen.has(id)).toBe(true);
  });
});

// #315: Armor Patch left the random pool entirely — it is now the guaranteed reward for
// destroying a base objective (scenes/arena/bases.js `_onTerrainCollapsed`), not a roll.
describe('#315: armorPatch is absent from the weighted random pool', () => {
  it('carries zero weight and is flagged objectiveOnly', () => {
    expect(POWERUPS.armorPatch.weight).toBe(0);
    expect(POWERUPS.armorPatch.objectiveOnly).toBe(true);
  });

  it('is excluded from POWERUP_POOL_IDS but still a real catalog entry', () => {
    expect(POWERUP_POOL_IDS).not.toContain('armorPatch');
    expect(POWERUP_IDS).toContain('armorPatch');
    expect(POWERUP_POOL_IDS.sort())
      .toEqual(['overdrive', 'overclock', 'shield', 'barrage', 'infiniteFire'].sort());
  });

  it('can NEVER come out of pickPowerupType, at any rng value including the fallback edges', () => {
    for (let i = 0; i <= 20000; i++) {
      expect(pickPowerupType(() => i / 20000)).not.toBe('armorPatch');
    }
    // The loop's own fallback return (rng exactly 1, and a degenerate rng past the end).
    expect(pickPowerupType(() => 1)).not.toBe('armorPatch');
    expect(pickPowerupType(() => 5)).not.toBe('armorPatch');
    // 20k random draws for good measure.
    for (let i = 0; i < 20000; i++) expect(pickPowerupType()).not.toBe('armorPatch');
  });

  it('the remaining five share the pool evenly — each is exactly 20%, since all carry weight 1 (#409: Infinite Fire added)', () => {
    const counts = {};
    const N = 100000;
    for (let i = 0; i < N; i++) {
      const id = pickPowerupType(() => i / N);
      counts[id] = (counts[id] || 0) + 1;
    }
    expect(POWERUP_POOL_IDS).toHaveLength(5);
    expect(Object.keys(counts).sort()).toEqual(POWERUP_POOL_IDS.slice().sort());
    for (const id of POWERUP_POOL_IDS) {
      expect(counts[id] / N).toBeCloseTo(0.2, 2);
    }
  });

  it('#409: its repair is purely INSTANT with no overlay window — it never contributes any buff modifier', () => {
    expect(isInstant('armorPatch')).toBe(true);
    expect(durationMs('armorPatch')).toBe(0);
    // Even if it somehow appeared in the active set, its effect adds nothing (no free ammo now).
    expect(buffModifiers({ armorPatch: 5000 }))
      .toEqual({ freeAmmo: false, noReload: false, cycleMult: 1, countMult: 1, overclockActive: false });
  });

  // #315 part 2: the palette's only ACHROMATIC entry, so it can't be confused with Shield's
  // cyan (the reported problem) or any other coloured pickup.
  it('is achromatic (r≈g≈b) and clearly separated from Shield in colour', () => {
    const c = POWERUPS.armorPatch.color;
    const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(24);  // near-neutral
    expect(c).not.toBe(0xffffff);   // not pure white — would wash out on arctic snow (0xd9e6ef)
    // Every OTHER powerup is strongly chromatic, so "the grey one" is unambiguous.
    for (const id of POWERUP_IDS) {
      if (id === 'armorPatch') continue;
      const o = POWERUPS[id].color;
      const or = (o >> 16) & 0xff, og = (o >> 8) & 0xff, ob = o & 0xff;
      expect(Math.max(or, og, ob) - Math.min(or, og, ob)).toBeGreaterThan(40);
    }
    // ...and specifically far from Shield's cyan in raw channel distance.
    const s = POWERUPS.shield.color;
    const dist = Math.abs(r - ((s >> 16) & 0xff)) + Math.abs(g - ((s >> 8) & 0xff)) + Math.abs(b - (s & 0xff));
    expect(dist).toBeGreaterThan(100);
  });
});

describe('buffModifiers — collapsing the active overlay', () => {
  it('returns the identity when nothing is active', () => {
    const m = buffModifiers({});
    expect(m).toEqual({ freeAmmo: false, noReload: false, cycleMult: 1, countMult: 1, overclockActive: false });
  });

  it('ignores expired (non-positive remaining) entries', () => {
    const m = buffModifiers({ infiniteFire: 0, overdrive: -5 });
    expect(m.freeAmmo).toBe(false);
    expect(m.noReload).toBe(false);
    expect(m.cycleMult).toBe(1);
  });

  it('#409: ONLY Infinite Fire grants free ammo (and no-reload); no other powerup does', () => {
    expect(buffModifiers({ infiniteFire: 500 }).freeAmmo).toBe(true);
    expect(buffModifiers({ infiniteFire: 500 }).noReload).toBe(true);
    for (const id of ['overdrive', 'overclock', 'barrage', 'shield', 'armorPatch']) {
      expect(buffModifiers({ [id]: 500 }).freeAmmo).toBe(false);
      expect(buffModifiers({ [id]: 500 }).noReload).toBe(false);
    }
    expect(buffModifiers({ overdrive: 500 }).cycleMult).toBe(POWERUPS.overdrive.cycleMult);
    expect(buffModifiers({ overclock: 500 }).overclockActive).toBe(true);
  });

  it('stacks DIFFERENT types simultaneously (one-per-type overlay)', () => {
    const m = buffModifiers({ overdrive: 500, overclock: 500, barrage: 500, infiniteFire: 500 });
    expect(m.freeAmmo).toBe(true);
    expect(m.noReload).toBe(true);
    expect(m.cycleMult).toBe(POWERUPS.overdrive.cycleMult);
    expect(m.countMult).toBe(POWERUPS.barrage.countMult);
    expect(m.overclockActive).toBe(true);
  });

  // #137 Barrage: a timed shot-COUNT multiplier, the complement to Overdrive's fire-RATE one.
  // The two are independent fields, so having both up multiplies neither into the other.
  describe('#137 Barrage — countMult', () => {
    it('is a real doubling on its own field, and the identity when inactive', () => {
      expect(POWERUPS.barrage.effect).toBe('shotCount');
      expect(POWERUPS.barrage.countMult).toBe(2);
      expect(buffModifiers({ barrage: 500 }).countMult).toBe(2);
      expect(buffModifiers({ barrage: 500 }).cycleMult).toBe(1);   // does NOT touch fire rate
      expect(buffModifiers({}).countMult).toBe(1);
      expect(buffModifiers({ barrage: 0 }).countMult).toBe(1);     // expired ⇒ identity
    });

    it('is a timed buff (not instant) in the same 9-12s band as the others', () => {
      expect(isInstant('barrage')).toBe(false);
      expect(POWERUPS.barrage.duration).toBeGreaterThanOrEqual(9);
      expect(POWERUPS.barrage.duration).toBeLessThanOrEqual(12);
    });

    it('a duplicate pickup REFRESHES rather than stacks — one entry per type can only ever contribute once', () => {
      // The active overlay is a map keyed by type id, so a second Barrage pickup overwrites the
      // same key's remaining time (the arena's `_activatePowerup` does `active[id] = duration`).
      // buffModifiers can therefore never see the same type twice: countMult stays exactly 2x,
      // never 4x, no matter how many are picked up.
      const active = {};
      active.barrage = 5000;
      active.barrage = 10000;                                       // duplicate pickup = refresh
      expect(Object.keys(active)).toEqual(['barrage']);
      expect(buffModifiers(active).countMult).toBe(2);
      expect(buffModifiers({ barrage: 10000, overdrive: 500 }).countMult).toBe(2);
    });

    it('a distinct color from every other powerup (readable at a glance on the ground)', () => {
      const colors = POWERUP_IDS.map((id) => POWERUPS[id].color);
      expect(new Set(colors).size).toBe(colors.length);
    });
  });

  it('#409: Shield contributes NOTHING to buffModifiers — it is instant, its temp POOL lives on the mech', () => {
    const m = buffModifiers({ shield: 500 });
    expect(m).toEqual({ freeAmmo: false, noReload: false, cycleMult: 1, countMult: 1, overclockActive: false });
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
    expect(tank.maxHp).toBe(50);         // structure only — unchanged meaning (#299: 160 -> 50)
    expect(tank.toughness).toBe(80);     // + its 30-point armor pool (#299)
  });

  it('counts a vehicle\'s SHIELD pool too (helicopter: hp + shield, no armor)', () => {
    const heli = new HpBody(ENEMY_KINDS.helicopter);
    expect(heli.maxHp).toBe(35);         // #299: 70 -> 35
    expect(heli.toughness).toBe(50);     // + its 15-point shield (#299)
  });

  it('counts both remaining layers (carrier: 50 hp + 100 armor, no shield since #436)', () => {
    expect(new HpBody(ENEMY_KINDS.carrier).toughness).toBe(150);
  });

  it('leaves maxHp alone on both body types (other consumers rely on its current meaning)', () => {
    expect(new HpBody(ENEMY_KINDS.carrier).maxHp).toBe(50);
    expect(new Mech({ chassisId: 'heavy' }).maxHp).toBe(425);
  });

  it('for a shieldless mech, toughness equals its armor+structure maxHp', () => {
    for (const c of ['light', 'medium', 'heavy']) {
      const m = new Mech({ chassisId: c });
      expect(m.toughness).toBe(m.maxHp);
    }
  });

  it('a live Shield powerup does not inflate a mech\'s rated toughness', () => {
    const m = new Mech({ chassisId: 'medium', shield: { max: 40 } });
    const before = m.toughness;
    expect(before).toBe(m.maxHp + 40);
    m.grantTempShield(150, 5000);        // #381: a big temporary pool on top
    expect(m.toughness).toBe(before);    // still reads base capacity only, never the temp pool
  });
});

describe('#106: drop-curve bounds are DERIVED from the live roster, not hardcoded', () => {
  // #299 re-tiered the whole roster and this test needed NO structural change — only the two
  // literals below, which exist purely to pin what the derivation currently produces. The floor
  // is now infantry/drone (both 3) and the ceiling the artillery mech (500). Note the PLAYER's
  // mech (600) is deliberately NOT in this range: rosterBounds reads ENEMIES + ENEMY_KINDS, and
  // the player is neither, so the ceiling tracks the toughest thing you FIGHT.
  it('derives floor = the weakest unit (infantry, 3) and ceil = the toughest (heavy mech, 500)', () => {
    const { floor, ceil } = dropBounds();
    expect(floor).toBe(kindToughness('infantry'));
    expect(ceil).toBe(mechToughness('artillery'));
    expect(floor).toBe(3);
    expect(ceil).toBe(500);
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
  // #299 re-tuned every toughness in the roster; the curve itself was NOT touched, and the
  // chances below simply follow from the new 3..500 derived span. That's the property this file
  // is really asserting — see the "endpoints MOVE when the roster does" test above.
  const TABLE = [
    ['infantry', kindToughness('infantry'), 3, 0.05],
    // #370: drone 3 -> 10 (5 structure + 5 shield). Infantry still holds the roster floor at 3,
    // so the derived span is unchanged (3..500) and only the drone's own point on the curve moves.
    ['drone', kindToughness('drone'), 10, 0.05],
    ['turret', kindToughness('turret'), 50, 0.08],
    ['helicopter', kindToughness('helicopter'), 50, 0.08],
    ['tank', kindToughness('tank'), 80, 0.10],
    ['carrier', kindToughness('carrier'), 150, 0.19],
    ['light mech', mechToughness('raider'), 200, 0.27],
    ['medium mech', mechToughness('sniper'), 350, 0.58],
    ['heavy mech', mechToughness('artillery'), 500, 0.95],
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

// ── #339: duplicate pickups stack DURATION, never magnitude ────────────────────────────────
// Jackson: "duration stacks, magnitude does not... A second Overdrive means you keep the same
// fire-rate multiplier for longer, not a faster one." The magnitude half of that is enforced by
// buffModifiers being a function of WHICH types are active, not of how many were picked up —
// `activePowerups` is a map keyed by type, so there is structurally nowhere for a second
// Overdrive to live. These tests pin both halves.
describe('#339: duplicate pickups extend duration', () => {
  const TIMED = POWERUP_IDS.filter((id) => !isInstant(id));

  it('a fresh pickup is just its own catalog duration', () => {
    for (const id of TIMED) {
      expect(stackedRemainingMs(id, 0)).toBe(durationMs(id));
      expect(stackedRemainingMs(id)).toBe(durationMs(id));
      expect(stackedRemainingMs(id, undefined)).toBe(durationMs(id));
    }
  });

  it('picking up a duplicate mid-buff ADDS a full duration instead of merely refreshing', () => {
    for (const id of TIMED) {
      const d = durationMs(id);
      // Half-spent buff: the old behaviour would reset this to exactly `d`; stacking gives d*1.5.
      expect(stackedRemainingMs(id, d / 2)).toBe(d * 1.5);
      expect(stackedRemainingMs(id, d / 2)).toBeGreaterThan(d);
      // Untouched buff: two back-to-back pickups are worth two full durations.
      expect(stackedRemainingMs(id, d)).toBe(d * 2);
    }
  });

  it('accumulates across repeated pickups, monotonically, up to the cap', () => {
    const id = 'overdrive';
    const d = durationMs(id);
    let remaining = 0;
    const seen = [];
    for (let i = 0; i < 10; i++) {
      const next = stackedRemainingMs(id, remaining);
      expect(next).toBeGreaterThanOrEqual(remaining);   // a pickup NEVER shortens the buff
      remaining = next;
      seen.push(remaining);
    }
    expect(seen[0]).toBe(d);
    expect(seen[1]).toBe(d * 2);
    expect(seen[2]).toBe(d * MAX_STACK_MULT);
    expect(remaining).toBe(maxStackedMs(id));           // and it plateaus there forever
  });

  it('caps total accumulated time at MAX_STACK_MULT x the base duration', () => {
    expect(MAX_STACK_MULT).toBeGreaterThan(1);          // 1 would be the old pure-refresh rule
    for (const id of TIMED) {
      expect(maxStackedMs(id)).toBe(durationMs(id) * MAX_STACK_MULT);
      // Way past the cap in one go: clamped, not unbounded.
      expect(stackedRemainingMs(id, durationMs(id) * 50)).toBeLessThanOrEqual(
        Math.max(maxStackedMs(id), durationMs(id) * 50),
      );
      expect(stackedRemainingMs(id, maxStackedMs(id) - 1)).toBe(maxStackedMs(id));
    }
  });

  it('a pickup just under the cap still nudges up to it rather than being wasted', () => {
    const id = 'barrage';
    const nearCap = maxStackedMs(id) - 500;
    expect(stackedRemainingMs(id, nearCap)).toBe(maxStackedMs(id));
    expect(stackedRemainingMs(id, nearCap)).toBeGreaterThan(nearCap);
  });

  it('never REDUCES an already-over-cap remaining time', () => {
    const id = 'overdrive';
    const over = maxStackedMs(id) + 5000;
    expect(stackedRemainingMs(id, over)).toBe(over);
  });

  it('#409: instant types (Armor Patch, Shield) have no window to stack; unknown types are no-ops too', () => {
    for (const id of ['armorPatch', 'shield']) {
      expect(durationMs(id)).toBe(0);
      expect(stackedRemainingMs(id, 0)).toBe(0);
      expect(stackedRemainingMs(id, 5000)).toBe(0);
      expect(maxStackedMs(id)).toBe(0);
    }
    expect(stackedRemainingMs('nope', 1000)).toBe(0);
    expect(maxStackedMs('nope')).toBe(0);
  });

  it('MAGNITUDE does not compound: a longer-stacked buff has exactly the same modifiers', () => {
    const id = 'overdrive';
    const once = buffModifiers({ [id]: durationMs(id) });
    const stacked = buffModifiers({ [id]: maxStackedMs(id) });
    expect(stacked).toEqual(once);
    expect(stacked.cycleMult).toBe(POWERUPS.overdrive.cycleMult);
    // Barrage likewise stays x2, never x4.
    expect(buffModifiers({ barrage: maxStackedMs('barrage') }).countMult)
      .toBe(POWERUPS.barrage.countMult);
  });

  it('different types still stack independently (this changes nothing about cross-type stacking)', () => {
    const mods = buffModifiers({ overdrive: 1, barrage: 1, infiniteFire: 1, overclock: 1 });
    expect(mods.cycleMult).toBe(POWERUPS.overdrive.cycleMult);
    expect(mods.countMult).toBe(POWERUPS.barrage.countMult);
    expect(mods.freeAmmo).toBe(true);          // #409: from Infinite Fire
    expect(mods.overclockActive).toBe(true);
  });
});

describe('#339: Armor Patch (instant) simply applies again', () => {
  it('a second patch repairs again off the new, less-damaged state — no timer involved', () => {
    const mech = new Mech({ chassisId: 'medium' });
    mech.applyDamage('leftArm', 500);
    mech.applyDamage('rightTorso', 500);
    const frac = POWERUPS.armorPatch.repairFrac;

    const first = mech.repairArmor(frac);
    expect(first).toBeGreaterThan(0);
    const second = mech.repairArmor(frac);
    expect(second).toBeGreaterThan(0);            // it DOES do something the second time
    expect(second).toBeLessThan(first);           // …on the smaller remaining deficit
    // #409: purely instant now — no timer/window at all.
    expect(isInstant('armorPatch')).toBe(true);
    expect(durationMs('armorPatch')).toBe(0);
  });
});

describe('#417: sequential Shield pickups stack the temp pool UNCAPPED (matching the arena grant)', () => {
  const shieldMech = () => new Mech({ chassisId: 'medium', shield: { max: 50 } });
  const pool = POWERUPS.shield.tempPool;

  it('is 0 with no pool, and reports the live (permanent) window once one is granted', () => {
    const mech = shieldMech();
    expect(mech.tempShieldRemainingMs).toBe(0);
    mech.grantTempShield(pool);                    // arena path: no durationMs
    expect(mech.shield.temp).toBe(pool);
    expect(mech.tempShieldRemainingMs).toBe(Infinity);
  });

  it('a second Shield ADDS its full pool on top (not the max), base untouched', () => {
    const mech = shieldMech();
    mech.grantTempShield(pool);
    expect(mech.shield.temp).toBe(pool);
    expect(mech.shield.max).toBe(50);              // base never changes

    mech.grantTempShield(pool);                    // #417: +pool again
    expect(mech.shield.temp).toBe(pool * 2);
    expect(mech.shield.max).toBe(50);
  });

  it('the pool keeps growing without a ceiling as more Shields are collected', () => {
    const mech = shieldMech();
    for (let i = 1; i <= 8; i++) {
      mech.grantTempShield(pool);
      expect(mech.shield.temp).toBe(pool * i);     // linear, uncapped
      expect(mech.shield.max).toBe(50);
    }
  });
});

describe('powerupSpotColors (#400: the center-torso status spot in single-player)', () => {
  it('no active powerups → no colours (the arena renders that as black)', () => {
    expect(powerupSpotColors([])).toEqual([]);
    expect(powerupSpotColors(undefined)).toEqual([]);
  });

  it('one active powerup → that powerup’s own colour', () => {
    expect(powerupSpotColors(['overdrive'])).toEqual([POWERUPS.overdrive.color]);
  });

  it('several active → one section colour per powerup, in stable POWERUPS order (not pickup order)', () => {
    const colors = powerupSpotColors(['barrage', 'overdrive', 'shield']);
    const expected = POWERUP_IDS.filter((id) => ['barrage', 'overdrive', 'shield'].includes(id))
      .map((id) => POWERUPS[id].color);
    expect(colors).toEqual(expected);
    // Order is independent of the input order — same set in → same list out.
    expect(powerupSpotColors(['shield', 'overdrive', 'barrage'])).toEqual(colors);
  });

  it('ignores unknown ids', () => {
    expect(powerupSpotColors(['overdrive', 'notAThing'])).toEqual([POWERUPS.overdrive.color]);
  });
});
