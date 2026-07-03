import { describe, it, expect } from 'vitest';
import {
  STARTING_UNLOCKED, SHOPPABLE_IDS, costOf, canAfford,
  salvageAmount, SALVAGE_MIN, SALVAGE_MAX,
} from './shop.js';

describe('shop economy', () => {
  it('every starting-unlocked id is a real shoppable item', () => {
    for (const id of STARTING_UNLOCKED) expect(SHOPPABLE_IDS).toContain(id);
  });

  it('starting items cost nothing; everything else has a positive cost', () => {
    for (const id of STARTING_UNLOCKED) expect(costOf(id)).toBe(0);
    const locked = SHOPPABLE_IDS.filter((id) => !STARTING_UNLOCKED.includes(id));
    expect(locked.length).toBeGreaterThan(0);
    for (const id of locked) expect(costOf(id)).toBeGreaterThan(0);
  });

  it('an unlisted id falls back to the default cost, never free', () => {
    expect(costOf('totallyMadeUpWeapon')).toBeGreaterThan(0);
  });

  it('canAfford compares balance against cost', () => {
    const id = SHOPPABLE_IDS.find((i) => costOf(i) > 0);
    const price = costOf(id);
    expect(canAfford(id, price)).toBe(true);
    expect(canAfford(id, price - 1)).toBe(false);
  });

  it('salvageAmount stays within its band and is deterministic given an rng', () => {
    expect(salvageAmount(() => 0)).toBe(SALVAGE_MIN);
    expect(salvageAmount(() => 0.999)).toBe(SALVAGE_MAX);
    for (let i = 0; i < 20; i++) {
      const v = salvageAmount();
      expect(v).toBeGreaterThanOrEqual(SALVAGE_MIN);
      expect(v).toBeLessThanOrEqual(SALVAGE_MAX);
    }
  });
});
