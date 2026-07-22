// #423 phase 2 — the two testable seams of the arena run-stats wiring: the commit-once guard
// (a death that then auto-returns to the garage must commit ONCE) and the pull-level hit dedupe
// (accuracy counts one hit per trigger pull no matter how many pellets connect). The rest of the
// mixin is Phaser-adjacent and exercised in play; these two are pure enough to bind to a plain
// object and drive directly.
import { describe, it, expect, beforeEach } from 'vitest';
import { RunStatsMixin } from './runStatsHooks.js';
import { createRunStats } from '../../data/runStats.js';
import { makeStatsHistory } from '../../data/statsHistory.js';

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
}

function makeCtx() {
  const storage = fakeStorage();
  const run = createRunStats({ biome: 'grassland', chassis: 'Medium', loadout: ['x'] });
  run.tick(20_000);   // long enough that even a 'manual' commit would qualify
  return {
    runStats: run,
    _statsHistory: makeStatsHistory({ storage, now: () => 1 }),
    _statsCommitted: false,
    _statHitPulls: new Set(),
    _statHitEnemyShots: new Set(),
    _statEnemyShotSeq: 0,
    time: { now: 0 },
    storage,
  };
}

describe('#423 _commitRunStats — commit-once guard', () => {
  it('commits a win exactly once even if called again (death → auto-return)', () => {
    const ctx = makeCtx();
    RunStatsMixin._commitRunStats.call(ctx, 'win');
    RunStatsMixin._commitRunStats.call(ctx, 'manual');   // the RUN_OVER_DELAY toGarage() follow-up
    const entries = JSON.parse(ctx.storage.getItem('mech-game-stats-history-v1'));
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('win');
  });

  it('discards a sub-10s manual exit but still latches (no later re-commit)', () => {
    const ctx = makeCtx();
    ctx.runStats = createRunStats({});
    ctx.runStats.tick(4000);   // < 10s
    RunStatsMixin._commitRunStats.call(ctx, 'manual');
    expect(ctx.storage.getItem('mech-game-stats-history-v1')).toBe(null);
    expect(ctx._statsCommitted).toBe(true);
  });
});

describe('#423 _statPlayerHit — pull-level accuracy dedupe', () => {
  let ctx;
  beforeEach(() => { ctx = makeCtx(); });

  it('counts one hit per trigger pull no matter how many emissions connect', () => {
    // Two pellets of the SAME pull both connect, plus a third connecting emission on another pull.
    RunStatsMixin._statPlayerHit.call(ctx, 'x', 7, 'drone', 10, false, 0);
    RunStatsMixin._statPlayerHit.call(ctx, 'x', 7, 'drone', 10, false, 0);
    RunStatsMixin._statPlayerHit.call(ctx, 'x', 8, 'drone', 10, false, 0);
    const w = ctx.runStats.reduce().weapons.x;
    expect(w.hits).toBe(2);            // two DISTINCT pulls landed
    expect(w.damageDealt).toBe(30);    // all three emissions still book damage
  });

  it('a null pull id (a DOT tick) counts every connecting emission as a hit', () => {
    RunStatsMixin._statPlayerHit.call(ctx, 'x', null, 'drone', 5, false, 0);
    RunStatsMixin._statPlayerHit.call(ctx, 'x', null, 'drone', 5, false, 0);
    expect(ctx.runStats.reduce().weapons.x.hits).toBe(2);
  });
});

describe('#423 enemy accuracy — never exceeds 1.0 (per-shot hit dedupe, bug1)', () => {
  let ctx;
  beforeEach(() => { ctx = makeCtx(); });

  it('books at most one enemy hit per enemy shot even when it connects several times', () => {
    const e = { _statKind: 'helicopter' };
    const shotId = RunStatsMixin._statEnemyFired.call(ctx, e);   // ONE enemy trigger pull
    // The same shot damages the player three times (multi-pellet spread / a beam over frames).
    RunStatsMixin._statPlayerHurt.call(ctx, 'helicopter', 'repeater', 4, shotId);
    RunStatsMixin._statPlayerHurt.call(ctx, 'helicopter', 'repeater', 4, shotId);
    RunStatsMixin._statPlayerHurt.call(ctx, 'helicopter', 'repeater', 4, shotId);
    const en = ctx.runStats.reduce().enemies.helicopter;
    expect(en.weaponAccuracy).toBeLessThanOrEqual(1);
    expect(en.weaponAccuracy).toBeCloseTo(1, 5);   // 1 hit / 1 shot, not 3/1
    expect(en.damageToYou).toBe(12);               // all three still book damage taken
  });

  it('distinct enemy shots each score independently (a genuine fraction)', () => {
    const e = { _statKind: 'infantry' };
    const s1 = RunStatsMixin._statEnemyFired.call(ctx, e);
    RunStatsMixin._statEnemyFired.call(ctx, e);   // s2 — fired but misses
    RunStatsMixin._statPlayerHurt.call(ctx, 'infantry', 'rifle', 3, s1);
    expect(ctx.runStats.reduce().enemies.infantry.weaponAccuracy).toBeCloseTo(0.5, 5);
  });
});

describe('#423 enemy TTK — first-player-hit to death, not lifetime (bug2)', () => {
  let ctx;
  beforeEach(() => { ctx = makeCtx(); });

  it('measures from the first player damage, ignoring the time alive before it', () => {
    const e = {};
    ctx.time.now = 1000;
    RunStatsMixin._statEnemySpawned.call(ctx, e, 'infantry');   // spawned at t=1000
    ctx.time.now = 30000;   // 29s just alive/aware — must NOT count toward TTK
    e._firstHitAt = 30000;  // combat.js stamps this on the first player weapon hit
    ctx.time.now = 30450;   // dies 450ms after first being hit
    RunStatsMixin._statEnemyKilled.call(ctx, e);
    expect(ctx.runStats.reduce().enemies.infantry.avgTtkMs).toBe(450);
  });

  it('excludes a unit killed without ever being player-damaged (e.g. crush)', () => {
    const e = {};
    RunStatsMixin._statEnemySpawned.call(ctx, e, 'infantry');
    ctx.time.now = 5000;
    RunStatsMixin._statEnemyKilled.call(ctx, e);   // no _firstHitAt → no TTK sample
    const en = ctx.runStats.reduce().enemies.infantry;
    expect(en.killed).toBe(1);
    expect(en.avgTtkMs).toBe(0);
  });
});
