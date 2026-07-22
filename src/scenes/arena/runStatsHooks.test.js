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
