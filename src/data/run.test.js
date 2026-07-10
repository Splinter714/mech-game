import { describe, it, expect } from 'vitest';
import {
  makeRun, advanceStage, endRunOnDeath, isRunOver,
  stageDescriptor, squadForStage, currencyForStage, STAGE_COUNT,
  EARLY_POOL, LATE_POOL,
} from './run.js';

describe('run model', () => {
  it('starts fresh: stage 0, no currency, active', () => {
    const r = makeRun();
    expect(r.stageIndex).toBe(0);
    expect(r.currency).toBe(0);
    expect(r.status).toBe('active');
  });

  it('advancing a stage banks currency and moves to the next stage', () => {
    const r = makeRun();
    const r1 = advanceStage(r);
    expect(r1.stageIndex).toBe(1);
    expect(r1.status).toBe('active');
    expect(r1.currency).toBe(currencyForStage(0));
  });

  it('currency accrues across multiple stage clears', () => {
    let r = makeRun();
    let total = 0;
    for (let i = 0; i < STAGE_COUNT - 1; i++) {
      total += currencyForStage(r.stageIndex);
      r = advanceStage(r);
    }
    expect(r.currency).toBe(total);
    expect(r.status).toBe('active');
    expect(r.stageIndex).toBe(STAGE_COUNT - 1);
  });

  it('clearing the final stage WINS the run', () => {
    let r = makeRun();
    for (let i = 0; i < STAGE_COUNT; i++) r = advanceStage(r);
    expect(r.status).toBe('won');
    expect(isRunOver(r)).toBe(true);
  });

  it('a terminal (won) run is sticky — advanceStage no-ops', () => {
    let r = makeRun();
    for (let i = 0; i < STAGE_COUNT; i++) r = advanceStage(r);
    const won = r;
    const again = advanceStage(won);
    expect(again).toEqual(won);
  });

  it('death ends the run regardless of stage/currency', () => {
    let r = makeRun();
    r = advanceStage(r);   // stage 1, some currency banked
    const dead = endRunOnDeath(r);
    expect(dead.status).toBe('dead');
    expect(dead.currency).toBe(r.currency);   // currency earned so far is preserved
    expect(isRunOver(dead)).toBe(true);
  });

  it('death is sticky — endRunOnDeath no-ops on an already-terminal run', () => {
    let r = makeRun();
    r = endRunOnDeath(r);
    const again = endRunOnDeath(r);
    expect(again).toEqual(r);
    // Also can't advance a dead run into 'won'.
    const advanced = advanceStage(r);
    expect(advanced).toEqual(r);
  });

  it('squad size grows with stage index (more enemies later)', () => {
    const sizes = Array.from({ length: STAGE_COUNT }, (_, i) => squadForStage(i).length);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    expect(sizes[0]).toBeLessThan(sizes[sizes.length - 1]);
  });

  it('every squad entry is a non-empty type id string', () => {
    for (let i = 0; i < STAGE_COUNT; i++) {
      for (const id of squadForStage(i)) expect(typeof id).toBe('string');
    }
  });

  it('later stages skew toward the tougher unit pool (statistically)', () => {
    // #75: helicopter is now in BOTH pools, so it can't discriminate the skew. Test each pool's
    // EXCLUSIVE ids instead: at stage 0 (all EARLY_POOL) the LATE-exclusive ids never appear; at
    // the final stage (all LATE_POOL) the EARLY-exclusive ids never appear.
    const EARLY_EXCLUSIVE = new Set(EARLY_POOL.filter((id) => !LATE_POOL.includes(id)));
    const LATE_EXCLUSIVE = new Set(LATE_POOL.filter((id) => !EARLY_POOL.includes(id)));
    const fracIn = (stageIndex, set, trials) => {
      let count = 0, total = 0;
      for (let t = 0; t < trials; t++) {
        for (const id of squadForStage(stageIndex)) { total++; if (set.has(id)) count++; }
      }
      return count / total;
    };
    // Stage 0 draws only EARLY_POOL → zero late-exclusive ids; final stage draws only LATE_POOL
    // → zero early-exclusive ids. (Helicopter, the shared id, is excluded from both sets.)
    expect(fracIn(0, LATE_EXCLUSIVE, 60)).toBeLessThan(0.05);
    expect(fracIn(STAGE_COUNT - 1, EARLY_EXCLUSIVE, 60)).toBeLessThan(0.05);
    // And the composition really does flip: early-exclusive dominates stage 0; late-exclusive the last.
    expect(fracIn(0, EARLY_EXCLUSIVE, 60)).toBeGreaterThan(0.5);
    expect(fracIn(STAGE_COUNT - 1, LATE_EXCLUSIVE, 60)).toBeGreaterThan(0.5);
  });

  it('#75: helicopters are in both stage pools so gunships appear across a whole run', () => {
    expect(EARLY_POOL).toContain('helicopter');
    expect(LATE_POOL).toContain('helicopter');
    // Weighted heavier among the hard kinds (listed more than once in LATE_POOL).
    expect(LATE_POOL.filter((id) => id === 'helicopter').length).toBeGreaterThan(1);
  });

  it('stageDescriptor bundles mission type, squad, and a display label', () => {
    const d = stageDescriptor(2);
    expect(d.stageIndex).toBe(2);
    expect(d.missionTypeId).toBe('assault');
    expect(Array.isArray(d.squad)).toBe(true);
    expect(d.squad.length).toBeGreaterThan(0);
    expect(d.label).toBe('STAGE 3/5');
  });

  it('currencyForStage increases with stage index', () => {
    for (let i = 1; i < STAGE_COUNT; i++) {
      expect(currencyForStage(i)).toBeGreaterThan(currencyForStage(i - 1));
    }
  });
});
