import { describe, it, expect } from 'vitest';
import { enemyCountFactor, scaleEnemyCount, scaleComposition } from './playerScaling.js';
import { TOWER_PATROL_TIERS, DOCK_SWARM_COUNT, dockCountFor } from './worldgen.js';

// #350 — the merge gate for co-op difficulty: solo must be EXACTLY unchanged, and two players
// must get exactly 2x the enemy COUNT.
describe('playerScaling (#350)', () => {
  describe('enemyCountFactor', () => {
    it('is 1x solo and 2x at two players', () => {
      expect(enemyCountFactor(1)).toBe(1);
      expect(enemyCountFactor(2)).toBe(2);
    });

    it('keeps going per player rather than being a two-player boolean', () => {
      expect(enemyCountFactor(3)).toBe(3);
      expect(enemyCountFactor(4)).toBe(4);
    });

    it('never drops below 1x for a missing or nonsense player count', () => {
      for (const bad of [0, -3, undefined, null, NaN]) expect(enemyCountFactor(bad)).toBe(1);
    });
  });

  describe('scaleEnemyCount', () => {
    it('is the identity at one player — solo is untouched', () => {
      for (const n of [1, 2, 3, 5, DOCK_SWARM_COUNT, 37]) expect(scaleEnemyCount(n, 1)).toBe(n);
    });

    it('exactly doubles at two players', () => {
      for (const n of [1, 2, 3, 5, DOCK_SWARM_COUNT, 37]) expect(scaleEnemyCount(n, 2)).toBe(n * 2);
    });

    it('scales per player beyond two', () => {
      expect(scaleEnemyCount(4, 3)).toBe(12);
    });

    it('never erases a population', () => {
      expect(scaleEnemyCount(1, 1)).toBe(1);
      expect(scaleEnemyCount(0, 2)).toBe(0);   // nothing to scale stays nothing
    });
  });

  describe('scaleComposition', () => {
    it('returns an equal copy at one player — solo patrols are untouched, order included', () => {
      for (const tier of TOWER_PATROL_TIERS) {
        expect(scaleComposition(tier, 1)).toEqual(tier);
      }
    });

    it('does not hand back the shared tier array', () => {
      const out = scaleComposition(TOWER_PATROL_TIERS[0], 1);
      out.push('tank');
      expect(TOWER_PATROL_TIERS[0]).toHaveLength(5);
    });

    it('doubles every patrol tier at two players', () => {
      for (const tier of TOWER_PATROL_TIERS) {
        expect(scaleComposition(tier, 2)).toHaveLength(tier.length * 2);
      }
    });

    it('preserves the tier MIX exactly, not just the total', () => {
      const tally = (list) => list.reduce((m, id) => ({ ...m, [id]: (m[id] ?? 0) + 1 }), {});
      for (const tier of TOWER_PATROL_TIERS) {
        const solo = tally(tier);
        const coop = tally(scaleComposition(tier, 2));
        for (const id of Object.keys(solo)) expect(coop[id]).toBe(solo[id] * 2);
        expect(Object.keys(coop).sort()).toEqual(Object.keys(solo).sort());
      }
    });

    it('handles a missing list without throwing', () => {
      expect(scaleComposition(undefined, 2)).toEqual([]);
    });
  });

  // The two real populations this feeds, checked against their actual source tables rather than
  // hand-written numbers, so a later retune of either table can't silently invalidate the rule.
  describe('the populations it drives', () => {
    it('doubles a swarm dock burst and leaves the solo burst alone', () => {
      const swarm = dockCountFor('drone', Math.random);
      expect(swarm).toBe(DOCK_SWARM_COUNT);
      expect(scaleEnemyCount(swarm, 1)).toBe(DOCK_SWARM_COUNT);
      expect(scaleEnemyCount(swarm, 2)).toBe(DOCK_SWARM_COUNT * 2);
    });

    it('gives a solo lone-tank dock one tank and a two-player one two', () => {
      const tank = dockCountFor('tank', Math.random);
      expect(scaleEnemyCount(tank, 1)).toBe(1);
      expect(scaleEnemyCount(tank, 2)).toBe(2);
    });
  });
});
