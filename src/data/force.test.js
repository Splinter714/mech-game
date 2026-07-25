import { describe, it, expect } from 'vitest';
import { computeImpulse } from './force.js';

describe('computeImpulse', () => {
  it('a negative sign pulls the target TOWARD the center', () => {
    const { dx, dy } = computeImpulse(0, 0, 100, 200, -1, 50, 0, 1, { falloff: false });
    expect(dx).toBeLessThan(0);   // target is at +x, pull moves it toward 0 (negative x)
    expect(dy).toBeCloseTo(0, 10);
  });

  it('a positive sign pushes the target AWAY from the center', () => {
    const { dx, dy } = computeImpulse(0, 0, 100, 200, 1, 50, 0, 1, { falloff: false });
    expect(dx).toBeGreaterThan(0);   // target is at +x, push moves it further out (positive x)
    expect(dy).toBeCloseTo(0, 10);
  });

  it('is zero at or beyond the radius', () => {
    expect(computeImpulse(0, 0, 100, 200, 1, 100, 0, 1)).toEqual({ dx: 0, dy: 0 });
    expect(computeImpulse(0, 0, 100, 200, 1, 500, 0, 1)).toEqual({ dx: 0, dy: 0 });
  });

  it('is zero at the exact center (no direction to push/pull along)', () => {
    expect(computeImpulse(0, 0, 100, 200, 1, 0, 0, 1)).toEqual({ dx: 0, dy: 0 });
  });

  it('scales with dt — half the time, half the displacement', () => {
    const full = computeImpulse(0, 0, 100, 200, 1, 50, 0, 1, { falloff: false });
    const half = computeImpulse(0, 0, 100, 200, 1, 50, 0, 0.5, { falloff: false });
    expect(half.dx).toBeCloseTo(full.dx / 2, 5);
  });

  it('linear falloff to the edge when opted in (default)', () => {
    const center = computeImpulse(0, 0, 100, 200, 1, 1, 0, 1);      // essentially at the center
    const edge = computeImpulse(0, 0, 100, 200, 1, 99, 0, 1);       // near the edge
    expect(Math.abs(center.dx)).toBeGreaterThan(Math.abs(edge.dx));
  });
});
