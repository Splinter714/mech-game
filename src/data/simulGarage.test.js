import { describe, it, expect } from 'vitest';
import { MAX_GARAGE_PLAYERS } from './coopGarage.js';
import {
  makeSimulSession, simulPlayerCount, joinSimulPlayer, toggleReady, allReady, activeIndices,
} from './simulGarage.js';

describe('makeSimulSession', () => {
  it('defaults to one not-ready player', () => {
    expect(makeSimulSession()).toEqual({ count: 1, ready: [false] });
  });

  it('clamps count into [1, MAX_GARAGE_PLAYERS]', () => {
    expect(makeSimulSession({ count: 0 }).count).toBe(1);
    expect(makeSimulSession({ count: 99 }).count).toBe(MAX_GARAGE_PLAYERS);
  });

  it('trims/pads ready to exactly count entries', () => {
    expect(makeSimulSession({ count: 3, ready: [true] })).toEqual({ count: 3, ready: [true, false, false] });
    expect(makeSimulSession({ count: 1, ready: [true, true, true] })).toEqual({ count: 1, ready: [true] });
  });
});

describe('simulPlayerCount', () => {
  it('reads the count', () => {
    expect(simulPlayerCount({ count: 2 })).toBe(2);
  });
});

describe('joinSimulPlayer', () => {
  it('grows the count by one, not-ready', () => {
    const s = joinSimulPlayer(makeSimulSession());
    expect(s).toEqual({ count: 2, ready: [false, false] });
  });

  it('preserves existing ready flags across a join', () => {
    let s = toggleReady(makeSimulSession(), 0);
    s = joinSimulPlayer(s);
    expect(s).toEqual({ count: 2, ready: [true, false] });
  });

  it('is a no-op once every slot is seated', () => {
    let s = makeSimulSession({ count: MAX_GARAGE_PLAYERS });
    expect(joinSimulPlayer(s)).toEqual(s);
  });
});

describe('toggleReady', () => {
  it('flips the given player only', () => {
    let s = makeSimulSession({ count: 2 });
    s = toggleReady(s, 1);
    expect(s.ready).toEqual([false, true]);
    s = toggleReady(s, 1);
    expect(s.ready).toEqual([false, false]);
  });

  it('ignores an out-of-range index', () => {
    const s = makeSimulSession({ count: 2 });
    expect(toggleReady(s, 5)).toEqual(s);
    expect(toggleReady(s, -1)).toEqual(s);
  });
});

describe('allReady', () => {
  it('false until every joined player is ready', () => {
    let s = makeSimulSession({ count: 2 });
    expect(allReady(s)).toBe(false);
    s = toggleReady(s, 0);
    expect(allReady(s)).toBe(false);
    s = toggleReady(s, 1);
    expect(allReady(s)).toBe(true);
  });

  it('true for a lone ready player', () => {
    expect(allReady(toggleReady(makeSimulSession(), 0))).toBe(true);
  });
});

describe('activeIndices', () => {
  it('lists 0..count-1', () => {
    expect(activeIndices(makeSimulSession({ count: 3 }))).toEqual([0, 1, 2]);
    expect(activeIndices(makeSimulSession())).toEqual([0]);
  });
});
