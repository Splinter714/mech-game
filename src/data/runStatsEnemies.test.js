// #440 — brood/base pooling: the PARENT row must equal base+brood pooled in every column, and the
// brood subset must be <= the parent everywhere (a genuine subset, never exceeding it).
import { describe, it, expect } from 'vitest';
import { createRunStats } from './runStats.js';
import { splitBroodSubsets, displayName } from './runStatsEnemies.js';

// The columns the tables display; each must hold parent = base+brood (for additive raw counts) or
// be a correctly re-derived ratio, and brood <= parent.
const ADDITIVE = ['spawned', 'killed', 'damageToYou', 'damageToKind', 'overkill',
  'engagedMs', 'ttkSumMs', 'ttkCount', 'shotsFired', 'hits', 'threatShare', 'spawnedDamage'];

// Build a reduced-run enemies map with a base `drone` and a `droneBrood` twin, matching the shape
// reduceRun emits (raw counters + derived metrics). Uses the real reducer so the fields are honest.
function droneRun() {
  const r = createRunStats();
  r.tick(1000, { inCombat: true });
  // base drones: 18 seen, damage to you 54, engaged 6000ms, 3 kills (ttk 500+700+900), your dmg 220
  r.enemySpawned('drone'); r.enemySpawned('drone'); r.enemySpawned('drone');
  r.enemyShotFired('drone'); r.enemyShotFired('drone'); r.enemyShotHit('drone');
  r.damageTaken({ enemyKind: 'drone', amount: 54 });
  r.enemyEngaged('drone', 6000);
  r.damageDealt({ targetKind: 'drone', amount: 220, overkill: 15 });
  r.enemyKill('drone', 500); r.enemyKill('drone', 700); r.enemyKill('drone', 900);
  // brood drones: 21 seen, damage to you 128, engaged 9000ms, 2 kills, your dmg 300
  r.enemySpawned('droneBrood'); r.enemySpawned('droneBrood');
  r.enemyShotFired('droneBrood'); r.enemyShotFired('droneBrood');
  r.enemyShotFired('droneBrood'); r.enemyShotHit('droneBrood');
  r.damageTaken({ enemyKind: 'droneBrood', amount: 128 });
  r.enemyEngaged('droneBrood', 9000);
  r.damageDealt({ targetKind: 'droneBrood', amount: 300, overkill: 40 });
  r.enemyKill('droneBrood', 400); r.enemyKill('droneBrood', 600);
  return r.reduce();
}

describe('runStatsEnemies — brood/base pooling (#440)', () => {
  it('parent = base + brood pooled in every additive column', () => {
    const reduced = droneRun();
    const baseOnly = reduced.enemies.drone;
    const broodOnly = reduced.enemies.droneBrood;
    const { base, brood } = splitBroodSubsets(reduced.enemies);
    const parent = base.drone;
    for (const k of ADDITIVE) {
      expect(parent[k]).toBeCloseTo((baseOnly[k] ?? 0) + (broodOnly[k] ?? 0), 6);
    }
    // The brood subset carries exactly the brood-only raw counts.
    for (const k of ADDITIVE) {
      expect(brood.drone[k]).toBeCloseTo(broodOnly[k] ?? 0, 6);
    }
  });

  it('#440: pooling sums spawnedDamage onto the parent (carrier with 0 direct dmg, drones dealt X)', () => {
    const r = createRunStats();
    // A carrier that only spawns, plus its brood twin drones dealing damage cross-attributed to it.
    r.enemySpawned('carrier');
    r.enemySpawned('droneBrood');
    r.damageTaken({ enemyKind: 'droneBrood', amount: 40, spawnerKind: 'carrier' });
    r.damageTaken({ enemyKind: 'droneBrood', amount: 25, spawnerKind: 'carrier' });
    const { base } = splitBroodSubsets(r.reduce().enemies);
    expect(base.carrier.spawnedDamage).toBe(65);
    expect(base.carrier.damageToYou).toBe(0);    // still zero direct damage
    expect(base.carrier.threatShare).toBe(0);    // spawnedDamage is NOT folded into threat share
  });

  it('parent ratios are RE-DERIVED from the pooled raw counts, not base-only', () => {
    const { base } = splitBroodSubsets(droneRun().enemies);
    const p = base.drone;
    // avgTtkMs = Σttk / Σcount = (500+700+900+400+600) / 5 = 620
    expect(p.avgTtkMs).toBeCloseTo(3100 / 5, 6);
    // effectiveDps = Σdmg-to-you / Σengaged(s) = (54+128) / 15
    expect(p.effectiveDps).toBeCloseTo(182 / 15, 6);
    // effectiveHp = Σdmg-to-them / Σkilled = (220+300) / 5
    expect(p.effectiveHp).toBeCloseTo(520 / 5, 6);
    // damage to you pooled = 182 (base 54, so the old base-only bug would have shown 54)
    expect(p.damageToYou).toBe(182);
  });

  it('the brood subset is <= the parent in every additive/count column (a true subset)', () => {
    // Additive columns (totals + counts) can never let a subset exceed its parent — that was the
    // #440 bug (brood damage 128 > displayed parent 54). Rate columns (DPS/HP/TTK/accuracy) are
    // pooled averages, so a subset CAN legitimately be higher; those are covered by the
    // re-derivation test above, not this ordering invariant.
    const { base, brood } = splitBroodSubsets(droneRun().enemies);
    const p = base.drone;
    const b = brood.drone;
    for (const k of ADDITIVE) {
      expect(b[k]).toBeLessThanOrEqual(p[k] + 1e-9);
    }
    // And specifically: brood damage-to-you no longer exceeds the parent (the reported bug).
    expect(b.damageToYou).toBeLessThanOrEqual(p.damageToYou);
    expect(b.damageToKind).toBeLessThanOrEqual(p.damageToKind);
  });

  it('a base kind with no brood twin is passed through unchanged (plus threatPerUnit)', () => {
    const r = createRunStats();
    r.enemySpawned('turret'); r.damageTaken({ enemyKind: 'turret', amount: 10 });
    r.enemyKill('turret', 800);
    const reduced = r.reduce();
    const { base, brood } = splitBroodSubsets(reduced.enemies);
    // Same values as the original entry (never mutates the caller's data) — but a NEW object,
    // since threatPerUnit is added post-hoc once every parent row's dmgPerUnit is known.
    expect(base.turret).not.toBe(reduced.enemies.turret);
    for (const k of Object.keys(reduced.enemies.turret)) {
      expect(base.turret[k]).toBe(reduced.enemies.turret[k]);
    }
    expect(reduced.enemies.turret.threatPerUnit).toBeUndefined();  // input untouched
    expect(brood.turret).toBeUndefined();
  });

  it('a brood-only kind (base never seen alone) is promoted to a top-level row with no subset', () => {
    const r = createRunStats();
    r.enemySpawned('waspBrood'); r.damageTaken({ enemyKind: 'waspBrood', amount: 7 });
    r.enemyKill('waspBrood', 300);
    const { base, brood } = splitBroodSubsets(r.reduce().enemies);
    expect(base.wasp).toBeDefined();
    expect(base.wasp.damageToYou).toBe(7);
    expect(brood.wasp).toBeUndefined();
  });

  it('threatPerUnit is a distribution across parent kinds that sums to 100%', () => {
    const r = createRunStats();
    // Two parent kinds: drone (rare, deadly) and wallTurret (numerous, weak).
    r.enemySpawned('drone'); r.damageTaken({ enemyKind: 'drone', amount: 100 });
    r.enemyKill('drone', 500);
    for (let i = 0; i < 10; i++) r.enemySpawned('wallTurret');
    r.damageTaken({ enemyKind: 'wallTurret', amount: 100 });
    r.enemyKill('wallTurret', 500);
    const { base } = splitBroodSubsets(r.reduce().enemies);
    // dmgPerUnit: drone = 100/1 = 100, wallTurret = 100/10 = 10. sumDpu = 110.
    expect(base.drone.threatPerUnit).toBeCloseTo(100 / 110, 6);
    expect(base.wallTurret.threatPerUnit).toBeCloseTo(10 / 110, 6);
    // The rare-but-deadly kind reads higher per-unit despite equal aggregate Threat Share.
    expect(base.drone.threatPerUnit).toBeGreaterThan(base.wallTurret.threatPerUnit);
    // Sums to 100% across every parent kind.
    const sum = Object.values(base).reduce((s, e) => s + e.threatPerUnit, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('threatPerUnit guards spawned=0 and sumDpu=0 to 0 (never NaN)', () => {
    const oldShape = { drone: { kind: 'drone', spawned: 0, damageToYou: 0 } };
    const { base } = splitBroodSubsets(oldShape);
    expect(base.drone.threatPerUnit).toBe(0);
  });

  it('the brood subset gets its OWN threatPerUnit over the same denominator (not copied from the parent)', () => {
    const { base, brood } = splitBroodSubsets(droneRun().enemies);
    // Pooled parent: spawned 3+2=5, damageToYou 54+128=182 → dmgPerUnit = 182/5 = 36.4.
    // drone is the only kind here, so sumDpu = the parent's own dmgPerUnit.
    const sumDpu = 182 / 5;
    // Brood-only: spawned 2, damageToYou 128 → dmgPerUnit = 64, over the SAME sumDpu.
    expect(brood.drone.threatPerUnit).toBeCloseTo((128 / 2) / sumDpu, 6);
    expect(brood.drone.threatPerUnit).not.toBeCloseTo(base.drone.threatPerUnit, 6);
  });

  // #440 — SPAWNER SUB-ROWS: a spawner's menace (its spawned units' attributed stats) shows as an
  // indented sub-row under the spawner, without being folded into any threat total.
  describe('spawner sub-rows (#440)', () => {
    // A carrier that deals 0 direct damage but spawns brood drones that hit you, plus an unrelated
    // wallTurret so the threat-share/threat-unit distribution has more than one parent.
    function carrierRun() {
      const r = createRunStats();
      r.enemySpawned('carrier');
      r.enemySpawned('droneBrood', 'carrier');
      r.enemySpawned('droneBrood', 'carrier');
      r.damageTaken({ enemyKind: 'droneBrood', amount: 40, spawnerKind: 'carrier' });
      r.damageTaken({ enemyKind: 'droneBrood', amount: 20, spawnerKind: 'carrier' });
      r.enemyKill('droneBrood', 300);
      for (let i = 0; i < 4; i++) r.enemySpawned('wallTurret');
      r.damageTaken({ enemyKind: 'wallTurret', amount: 60 });
      r.enemyKill('wallTurret', 500);
      return r.reduce();
    }

    it('the spawner parent gets a spawnedChildren sub-row with the spawned kind attributed stats', () => {
      const { base } = splitBroodSubsets(carrierRun().enemies);
      const kids = base.carrier.spawnedChildren;
      expect(Array.isArray(kids)).toBe(true);
      expect(kids).toHaveLength(1);
      const drones = kids[0];
      expect(drones.spawnedKind).toBe('drone');   // Brood suffix stripped for the label
      expect(drones.spawned).toBe(2);             // the two brood drones
      expect(drones.damageToYou).toBe(60);        // 40 + 20 dealt to you by the brood
      expect(drones.killed).toBe(1);
    });

    it("the spawner's OWN row stays direct (0 threat) — sub-rows never touch its totals", () => {
      const { base } = splitBroodSubsets(carrierRun().enemies);
      expect(base.carrier.damageToYou).toBe(0);
      expect(base.carrier.threatShare).toBe(0);
      expect(base.carrier.threatPerUnit).toBe(0);   // 0 direct dmg/unit → 0 share of the distribution
    });

    it('a non-spawner kind has no spawnedChildren', () => {
      const { base } = splitBroodSubsets(carrierRun().enemies);
      expect(base.wallTurret.spawnedChildren).toBeUndefined();
    });

    it('sub-rows do NOT affect the parent threat/unit 100% distribution (still sums to 1)', () => {
      const { base } = splitBroodSubsets(carrierRun().enemies);
      const sum = Object.values(base).reduce((s, e) => s + e.threatPerUnit, 0);
      expect(sum).toBeCloseTo(1, 6);
      // Only the two DIRECT-damage parents (droneBrood-promoted `drone`, wallTurret) carry the
      // distribution; the carrier (0 direct dmg) contributes 0, and the sub-row is excluded.
      expect(base.carrier.threatPerUnit).toBe(0);
    });

    it("the sub-row's threat/unit uses the SAME denominator as the parent kinds", () => {
      const reduced = carrierRun().enemies;
      const { base } = splitBroodSubsets(reduced);
      // Parents' dmgPerUnit: drone(=droneBrood promoted) = 60/2 = 30; wallTurret = 60/4 = 15.
      // carrier = 0. sumDpu = 45. The drones sub-row = its own dmgPerUnit (30) / 45.
      const drones = base.carrier.spawnedChildren[0];
      expect(drones.threatPerUnit).toBeCloseTo(30 / 45, 6);
      // Same scale as the promoted top-level drone row.
      expect(drones.threatPerUnit).toBeCloseTo(base.drone.threatPerUnit, 6);
    });
  });

  it('displayName splits camelCase and title-cases', () => {
    expect(displayName('drone')).toBe('Drone');
    expect(displayName('wallTurret')).toBe('Wall Turret');
  });

  // #440 — OLD/partial-shape runs (recorded before the #432 raw pooling counters landed) are
  // MISSING ttkSumMs/ttkCount/engagedMs/shotsFired/hits. Pooling must default them to 0 and never
  // throw or produce NaN, so the stats screen still renders these stored runs.
  it('tolerates an OLD/partial-shape enemy entry (missing raw counters) without throwing', () => {
    const oldShape = {
      drone: { kind: 'drone', spawned: 18, killed: 12, avgTtkMs: 3000, damageToYou: 54, damageToKind: 300, overkill: 10 },
      droneBrood: { kind: 'droneBrood', spawned: 21, killed: 8, avgTtkMs: 2500, damageToYou: 128, damageToKind: 200, overkill: 5 },
    };
    let result;
    expect(() => { result = splitBroodSubsets(oldShape); }).not.toThrow();
    const p = result.base.drone;
    const b = result.brood.drone;
    // Additive columns still pool cleanly from the present fields.
    expect(p.spawned).toBe(39);
    expect(p.damageToYou).toBe(182);
    // Missing raw counters default to 0 → derived ratios are finite (0, never NaN).
    for (const v of [p.avgTtkMs, p.weaponAccuracy, p.effectiveDps, p.ttkCount, p.shotsFired, p.hits]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(p.avgTtkMs).toBe(0);      // no ttkCount → div guards to 0
    expect(b.damageToYou).toBe(128);
  });
});
