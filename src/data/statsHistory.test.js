import { describe, it, expect } from 'vitest';
import {
  makeStatsHistory, shouldCommitRun,
  HISTORY_LIMIT, MANUAL_MIN_DURATION_MS, HISTORY_STORAGE_KEY,
} from './statsHistory.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

describe('statsHistory — commit rule (#423)', () => {
  describe('shouldCommitRun', () => {
    it('death always commits', () => {
      expect(shouldCommitRun({ durationMs: 0 }, { reason: 'death' })).toBe(true);
    });
    it('win always commits', () => {
      expect(shouldCommitRun({ durationMs: 1 }, { reason: 'win' })).toBe(true);
    });
    it('manual commits only at >= MANUAL_MIN_DURATION_MS', () => {
      expect(shouldCommitRun({ durationMs: MANUAL_MIN_DURATION_MS }, { reason: 'manual' })).toBe(true);
      expect(shouldCommitRun({ durationMs: MANUAL_MIN_DURATION_MS - 1 }, { reason: 'manual' })).toBe(false);
    });
    it('unknown reason never commits', () => {
      expect(shouldCommitRun({ durationMs: 999999 }, { reason: 'quit' })).toBe(false);
      expect(shouldCommitRun({ durationMs: 999999 }, {})).toBe(false);
    });
    it('MANUAL_MIN_DURATION_MS is 10s', () => {
      expect(MANUAL_MIN_DURATION_MS).toBe(10_000);
    });
  });

  describe('commit / list / load', () => {
    it('commits an eligible run and lists it newest-first', () => {
      let t = 0;
      const h = makeStatsHistory({ storage: fakeStorage(), now: () => ++t });
      const a = h.commit({ durationMs: 5, totalDealt: 1 }, { reason: 'death' });
      const b = h.commit({ durationMs: 5, totalDealt: 2 }, { reason: 'win' });
      expect(a.committed).toBe(true);
      expect(b.committed).toBe(true);
      const list = h.list();
      expect(list).toHaveLength(2);
      expect(list[0].run.totalDealt).toBe(2);   // newest first
      expect(list[1].run.totalDealt).toBe(1);
    });
    it('skips a sub-10s manual run without touching history', () => {
      const h = makeStatsHistory({ storage: fakeStorage(), now: () => 1 });
      const res = h.commit({ durationMs: 9_000 }, { reason: 'manual' });
      expect(res.committed).toBe(false);
      expect(h.list()).toEqual([]);
    });
    it('commits a >=10s manual run', () => {
      const h = makeStatsHistory({ storage: fakeStorage(), now: () => 1 });
      expect(h.commit({ durationMs: 10_000 }, { reason: 'manual' }).committed).toBe(true);
      expect(h.list()).toHaveLength(1);
    });
    it('prunes to HISTORY_LIMIT, keeping the most recent', () => {
      let t = 0;
      const h = makeStatsHistory({ storage: fakeStorage(), now: () => ++t });
      for (let i = 0; i < HISTORY_LIMIT + 5; i++) h.commit({ durationMs: i }, { reason: 'death' });
      const list = h.list();
      expect(list).toHaveLength(HISTORY_LIMIT);
      expect(list[0].id).toBe(HISTORY_LIMIT + 5);   // newest kept
      expect(list.at(-1).id).toBe(6);               // oldest 5 dropped
    });
    it('load fetches a committed entry by id, null when missing', () => {
      const h = makeStatsHistory({ storage: fakeStorage(), now: () => 42 });
      h.commit({ durationMs: 5, biome: 'ash' }, { reason: 'win' });
      expect(h.load(42).run.biome).toBe('ash');
      expect(h.load(999)).toBeNull();
    });
    it('clear empties history', () => {
      const h = makeStatsHistory({ storage: fakeStorage(), now: () => 1 });
      h.commit({ durationMs: 5 }, { reason: 'death' });
      h.clear();
      expect(h.list()).toEqual([]);
    });
  });

  describe('robustness', () => {
    it('list returns [] on corrupt storage', () => {
      const s = fakeStorage();
      s.setItem(HISTORY_STORAGE_KEY, '{not json');
      const h = makeStatsHistory({ storage: s });
      expect(h.list()).toEqual([]);
    });
    it('never throws when storage is null', () => {
      const h = makeStatsHistory({ storage: null, now: () => 1 });
      expect(() => h.commit({ durationMs: 5 }, { reason: 'death' })).not.toThrow();
      expect(h.list()).toEqual([]);
    });
    it('uses the default HISTORY_STORAGE_KEY', () => {
      const s = fakeStorage();
      makeStatsHistory({ storage: s, now: () => 1 }).commit({ durationMs: 1 }, { reason: 'death' });
      expect(s._map.has(HISTORY_STORAGE_KEY)).toBe(true);
    });
  });
});
