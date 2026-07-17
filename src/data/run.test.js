import { describe, it, expect } from 'vitest';
import {
  makeRun, advanceObjective, winRun, endRunOnDeath, isRunOver, currencyForObjective,
} from './run.js';

describe('run model (#269: retired stage/squad system — objectives + base-clear/death only)', () => {
  it('starts fresh: no objectives cleared, no currency, active', () => {
    const r = makeRun();
    expect(r.objectivesCleared).toBe(0);
    expect(r.currency).toBe(0);
    expect(r.status).toBe('active');
  });

  it('clearing an objective banks currency and counts it, staying active', () => {
    const r = makeRun();
    const r1 = advanceObjective(r);
    expect(r1.objectivesCleared).toBe(1);
    expect(r1.status).toBe('active');
    expect(r1.currency).toBe(currencyForObjective(0));
  });

  it('currency accrues across multiple objectives cleared', () => {
    let r = makeRun();
    let total = 0;
    for (let i = 0; i < 4; i++) {
      total += currencyForObjective(r.objectivesCleared);
      r = advanceObjective(r);
    }
    expect(r.currency).toBe(total);
    expect(r.status).toBe('active');
    expect(r.objectivesCleared).toBe(4);
  });

  it('clearing objectives alone never ends the run (only winRun/endRunOnDeath do)', () => {
    let r = makeRun();
    for (let i = 0; i < 20; i++) r = advanceObjective(r);
    expect(r.status).toBe('active');
    expect(isRunOver(r)).toBe(false);
  });

  it('winRun ends the run as won', () => {
    let r = makeRun();
    r = advanceObjective(r);
    const won = winRun(r);
    expect(won.status).toBe('won');
    expect(won.currency).toBe(r.currency);   // currency earned so far is preserved
    expect(isRunOver(won)).toBe(true);
  });

  it('a terminal (won) run is sticky — advanceObjective and winRun both no-op', () => {
    let r = makeRun();
    r = winRun(r);
    expect(advanceObjective(r)).toEqual(r);
    expect(winRun(r)).toEqual(r);
  });

  it('death ends the run regardless of objectives/currency', () => {
    let r = makeRun();
    r = advanceObjective(r);   // some currency banked
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
    // Also can't advance a dead run, or win it after the fact.
    expect(advanceObjective(r)).toEqual(r);
    expect(winRun(r)).toEqual(r);
  });

  it('currencyForObjective increases with objectives already cleared', () => {
    for (let i = 1; i < 6; i++) {
      expect(currencyForObjective(i)).toBeGreaterThan(currencyForObjective(i - 1));
    }
  });
});
