// #440 — brood/base pooling: the PARENT row must equal base+brood pooled in every column, and the
// brood subset must be <= the parent everywhere (a genuine subset, never exceeding it).
import { describe, it, expect } from 'vitest';
import { createRunStats } from './runStats.js';
import { splitBroodSubsets, displayName } from './runStatsEnemies.js';

// The columns the tables display; each must hold parent = base+brood (for additive raw counts) or
// be a correctly re-derived ratio, and brood <= parent.
const ADDITIVE = ['spawned', 'killed', 'damageToYou', 'damageToKind', 'overkill',
  'engagedMs', 'ttkSumMs', 'ttkCount', 'shotsFired', 'hits', 'threatShare'];

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

  it('a base kind with no brood twin is passed through unchanged', () => {
    const r = createRunStats();
    r.enemySpawned('turret'); r.damageTaken({ enemyKind: 'turret', amount: 10 });
    r.enemyKill('turret', 800);
    const reduced = r.reduce();
    const { base, brood } = splitBroodSubsets(reduced.enemies);
    expect(base.turret).toBe(reduced.enemies.turret);   // same object, untouched
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

  it('displayName splits camelCase and title-cases', () => {
    expect(displayName('drone')).toBe('Drone');
    expect(displayName('wallTurret')).toBe('Wall Turret');
  });
});
