import { describe, it, expect } from 'vitest';
import { damageInRadius } from './aoe.js';

describe('damageInRadius', () => {
  it('includes only candidates strictly inside the radius', () => {
    const candidates = [{ id: 'in', x: 10, y: 0 }, { id: 'edge', x: 50, y: 0 }, { id: 'out', x: 100, y: 0 }];
    const hits = damageInRadius(0, 0, 50, 20, candidates);
    expect(hits.map((h) => h.target.id)).toEqual(['in']);
  });

  it('flat damage (no falloff) by default', () => {
    const candidates = [{ x: 5, y: 0 }, { x: 40, y: 0 }];
    const hits = damageInRadius(0, 0, 50, 20, candidates);
    expect(hits.map((h) => h.amount)).toEqual([20, 20]);
  });

  it('linear falloff to the edge when opted in, floored at 1', () => {
    const candidates = [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 49, y: 0 }];
    const hits = damageInRadius(0, 0, 50, 20, candidates, { falloff: true });
    expect(hits[0].amount).toBe(20);          // at the center: full damage
    expect(hits[1].amount).toBe(10);           // halfway: half damage
    expect(hits[2].amount).toBeGreaterThanOrEqual(1);   // near the edge: never rounds to 0
  });

  it('returns an empty array with no candidates in range', () => {
    expect(damageInRadius(0, 0, 10, 5, [{ x: 100, y: 100 }])).toEqual([]);
  });
});
