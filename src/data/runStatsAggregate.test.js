// #432 — ALL RUNS pooled aggregate. Verifies aggregateRuns POOLS RAW COUNTS across runs and
// recomputes every ratio from the summed counters (never averages per-run metrics), handles the
// empty history, weapons/enemies present in only some runs, and never divides by zero. Also checks
// the reduced run shape from the real reducer carries the raw pooling counters.
import { describe, it, expect } from 'vitest';
import { createRunStats, reduceRun, aggregateRuns } from './runStats.js';
import { runReportText } from './runStatsText.js';
import { getWeapon } from './weapons.js';
import { burstDps, sustainedDps } from './weaponStats.js';

const WID = 'pulseLaser';   // a real catalog weapon (static theoretical DPS)

// A reduced-run stub carrying just the fields aggregateRuns reads.
function run({ global = {}, weapons = [], enemies = [] } = {}) {
  const w = {};
  for (const x of weapons) w[x.id] = { overkill: 0, reloads: 0, reloadTimeMs: 0, ...x };
  const e = {};
  for (const x of enemies) {
    e[x.kind] = {
      spawned: 0, killed: 0, damageToYou: 0, damageToKind: 0, overkill: 0,
      engagedMs: 0, ttkSumMs: 0, ttkCount: 0, shotsFired: 0, hits: 0, ...x,
    };
  }
  return {
    durationMs: 0, combatTimeMs: 0, totalDealt: 0, totalTaken: 0,
    shotsFired: 0, hits: 0, deaths: 0, respawns: 0, powerups: {},
    ...global, weapons: w, enemies: e,
  };
}

describe('aggregateRuns — pooled ALL RUNS view (#432)', () => {
  it('empty history → zeroed report, no divide-by-zero', () => {
    const agg = aggregateRuns([]);
    expect(agg.runCount).toBe(0);
    expect(agg.accuracy).toBe(0);
    expect(agg.totalDealt).toBe(0);
    expect(agg.weapons).toEqual({});
    expect(agg.enemies).toEqual({});
    // renders without throwing
    expect(runReportText(agg)).toContain('ALL RUNS (0)');
  });

  it('tolerates null / junk input', () => {
    expect(aggregateRuns(null).runCount).toBe(0);
    expect(aggregateRuns([null, undefined, 5]).runCount).toBe(0);
  });

  it('pools global counts and recomputes overall accuracy from the sums', () => {
    const a = run({ global: { durationMs: 1000, combatTimeMs: 800, totalDealt: 50, totalTaken: 20, shotsFired: 10, hits: 4, deaths: 1, respawns: 1, powerups: { heal: 2 } } });
    const b = run({ global: { durationMs: 3000, combatTimeMs: 1200, totalDealt: 70, totalTaken: 30, shotsFired: 30, hits: 11, deaths: 0, respawns: 0, powerups: { heal: 1, ammo: 3 } } });
    const agg = aggregateRuns([a, b]);
    expect(agg.runCount).toBe(2);
    expect(agg.durationMs).toBe(4000);
    expect(agg.combatTimeMs).toBe(2000);
    expect(agg.totalDealt).toBe(120);
    expect(agg.totalTaken).toBe(50);
    expect(agg.shotsFired).toBe(40);
    expect(agg.hits).toBe(15);
    // recomputed from pooled sums — NOT (0.4 + 0.3667)/2
    expect(agg.accuracy).toBeCloseTo(15 / 40, 10);
    expect(agg.deaths).toBe(1);
    expect(agg.respawns).toBe(1);
    expect(agg.powerups).toEqual({ heal: 3, ammo: 3 });
  });

  it('pools per-weapon counts and recomputes DPS from summed damage/time', () => {
    const a = run({ global: { combatTimeMs: 1000 }, weapons: [{ id: WID, shotsFired: 10, hits: 6, damageDealt: 60, firingTimeMs: 2000, reloadTimeMs: 500, reloads: 1 }] });
    const b = run({ global: { combatTimeMs: 3000 }, weapons: [{ id: WID, shotsFired: 30, hits: 12, damageDealt: 140, firingTimeMs: 2000, reloadTimeMs: 1500, reloads: 2 }] });
    const w = aggregateRuns([a, b]).weapons[WID];
    expect(w.shotsFired).toBe(40);
    expect(w.hits).toBe(18);
    expect(w.damageDealt).toBe(200);
    expect(w.firingTimeMs).toBe(4000);
    expect(w.reloadTimeMs).toBe(2000);
    expect(w.reloads).toBe(3);
    expect(w.accuracy).toBeCloseTo(18 / 40, 10);
    // eBurst = Σdamage / Σfiring(s) = 200 / 4 = 50
    expect(w.effectiveBurstDps).toBeCloseTo(200 / (4000 / 1000), 10);
    // eSustained = Σdamage / Σ(firing+reload)(s) = 200 / 6
    expect(w.effectiveSustainedDps).toBeCloseTo(200 / (6000 / 1000), 10);
    // eCombat = Σdamage / Σcombat(s) = 200 / 4
    expect(w.effectiveCombatDps).toBeCloseTo(200 / (4000 / 1000), 10);
    // Theoretical is STATIC from weaponStats — unchanged by pooling.
    const gw = getWeapon(WID);
    expect(w.theoreticalBurstDps).toBeCloseTo(burstDps(gw), 10);
    expect(w.theoreticalSustainedDps).toBeCloseTo(sustainedDps(gw), 10);
    // Landing ratio recomputes from pooled effective / static theoretical.
    expect(w.landingRatio).toBeCloseTo(w.effectiveSustainedDps / sustainedDps(gw), 10);
  });

  it('#440: pooled DPS is recomputed from Σ(damageDealt - overkill), not ΣdamageDealt', () => {
    const a = run({ global: { combatTimeMs: 1000 }, weapons: [{ id: WID, shotsFired: 10, hits: 6, damageDealt: 60, overkill: 20, firingTimeMs: 2000, reloadTimeMs: 500, reloads: 1 }] });
    const b = run({ global: { combatTimeMs: 3000 }, weapons: [{ id: WID, shotsFired: 30, hits: 12, damageDealt: 140, overkill: 30, firingTimeMs: 2000, reloadTimeMs: 1500, reloads: 2 }] });
    const w = aggregateRuns([a, b]).weapons[WID];
    expect(w.damageDealt).toBe(200);   // raw total column stays raw
    expect(w.overkill).toBe(50);
    // useful = 200 - 50 = 150
    expect(w.effectiveBurstDps).toBeCloseTo(150 / (4000 / 1000), 10);
    expect(w.effectiveSustainedDps).toBeCloseTo(150 / (6000 / 1000), 10);
    expect(w.effectiveCombatDps).toBeCloseTo(150 / (4000 / 1000), 10);
  });

  it('weapon present in only some runs still pools correctly', () => {
    const a = run({ weapons: [{ id: WID, shotsFired: 5, hits: 5, damageDealt: 50, firingTimeMs: 1000 }] });
    const b = run({ weapons: [] });
    const w = aggregateRuns([a, b]).weapons[WID];
    expect(w.shotsFired).toBe(5);
    expect(w.damageDealt).toBe(50);
    expect(w.accuracy).toBe(1);
  });

  it('pools enemy TTK from the raw sum/count pair, not pre-averaged avgTtkMs', () => {
    // Run A: 2 kills totalling 4000ms (avg 2000). Run B: 1 kill of 400ms (avg 400).
    // Correct pooled TTK = (4000+400)/(2+1) = 1466.7 — NOT (2000+400)/2 = 1200.
    const a = run({ global: { totalTaken: 100 }, enemies: [{ kind: 'drone', spawned: 3, killed: 2, damageToYou: 40, damageToKind: 80, engagedMs: 4000, ttkSumMs: 4000, ttkCount: 2, shotsFired: 10, hits: 4 }] });
    const b = run({ global: { totalTaken: 100 }, enemies: [{ kind: 'drone', spawned: 1, killed: 1, damageToYou: 20, damageToKind: 30, engagedMs: 1000, ttkSumMs: 400, ttkCount: 1, shotsFired: 6, hits: 3 }] });
    const e = aggregateRuns([a, b]).enemies.drone;
    expect(e.spawned).toBe(4);
    expect(e.killed).toBe(3);
    expect(e.avgTtkMs).toBeCloseTo(4400 / 3, 6);
    expect(e.effectiveDps).toBeCloseTo(60 / (5000 / 1000), 10);   // Σtoyou / Σengaged(s)
    expect(e.effectiveHp).toBeCloseTo(110 / 3, 10);               // Σtokind / Σkilled
    expect(e.weaponAccuracy).toBeCloseTo(7 / 16, 10);
    expect(e.threatShare).toBeCloseTo(60 / 200, 10);              // Σtoyou / Σtaken
  });

  it('enemy present in only some runs, and zero-count fields never divide by zero', () => {
    const a = run({ enemies: [{ kind: 'turret', spawned: 2, killed: 0, damageToYou: 0, damageToKind: 0, engagedMs: 0, ttkSumMs: 0, ttkCount: 0, shotsFired: 0, hits: 0 }] });
    const b = run({ enemies: [{ kind: 'drone', spawned: 1, killed: 1, ttkSumMs: 500, ttkCount: 1 }] });
    const agg = aggregateRuns([a, b]);
    const t = agg.enemies.turret;
    expect(t.avgTtkMs).toBe(0);
    expect(t.effectiveDps).toBe(0);
    expect(t.effectiveHp).toBe(0);
    expect(t.weaponAccuracy).toBe(0);
    expect(t.threatShare).toBe(0);
    expect(agg.enemies.drone.avgTtkMs).toBe(500);
  });

  it('reduced run shape carries the raw pooling counters (regression guard)', () => {
    const r = createRunStats();
    r.enemySpawned('drone');
    r.enemyShotFired('drone'); r.enemyShotHit('drone');
    r.enemyEngaged('drone', 1200);
    r.enemyKill('drone', 800);
    const reduced = r.reduce();
    const e = reduced.enemies.drone;
    // The fields aggregateRuns depends on must survive reduce().
    expect(e.ttkSumMs).toBe(800);
    expect(e.ttkCount).toBe(1);
    expect(e.engagedMs).toBe(1200);
    expect(e.shotsFired).toBe(1);
    expect(e.hits).toBe(1);
    // And it must actually pool through aggregate.
    expect(aggregateRuns([reduced]).enemies.drone.avgTtkMs).toBe(800);
  });

  it('#440: pools byWeapon per enemy kind, summing damageToYou across runs', () => {
    const a = run({ global: { totalTaken: 100 }, enemies: [{ kind: 'turret', spawned: 2, damageToYou: 40, byWeapon: { autocannon: { damageToYou: 30 }, machineGun: { damageToYou: 10 } } }] });
    const b = run({ global: { totalTaken: 100 }, enemies: [{ kind: 'turret', spawned: 1, damageToYou: 20, byWeapon: { autocannon: { damageToYou: 20 } } }] });
    const e = aggregateRuns([a, b]).enemies.turret;
    expect(e.byWeapon.autocannon.damageToYou).toBe(50);   // 30 + 20
    expect(e.byWeapon.machineGun.damageToYou).toBe(10);
    expect(e.damageToYou).toBe(60);   // parent unchanged
  });

  it('aggregate renders as copyable ALL RUNS text', () => {
    const a = run({ global: { totalDealt: 10, shotsFired: 4, hits: 2 }, weapons: [{ id: WID, shotsFired: 4, hits: 2, damageDealt: 10, firingTimeMs: 1000 }], enemies: [{ kind: 'drone', spawned: 1, killed: 1, ttkSumMs: 300, ttkCount: 1 }] });
    const text = runReportText(aggregateRuns([a, a]));
    expect(text).toContain('ALL RUNS (2)');
    expect(text).toContain('Runs pooled:       2');
    expect(text).toContain('WEAPONS');
    expect(text).toContain('ENEMIES');
  });
});

// keep reduceRun import used (shape-parity sanity)
void reduceRun;
