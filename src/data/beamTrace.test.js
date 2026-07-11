import { describe, it, expect } from 'vitest';
import { traceHitscan } from './beamTrace.js';

describe('traceHitscan', () => {
  it('resolves to max reach when nothing is in the way', () => {
    const r = traceHitscan(0, 0, 0, 900, []);
    expect(r.target).toBeNull();
    expect(r.endDist).toBe(600); // clamped to the visual cap, not the full 900 hitscan reach
    expect(r.endX).toBeCloseTo(600);
    expect(r.endY).toBeCloseTo(0);
  });

  it('hits the nearest living enemy on the ray, ignoring destroyed ones and misses', () => {
    const enemies = [
      { x: 300, y: 0, destroyed: false },   // on-ray, farther
      { x: 100, y: 0, destroyed: false },   // on-ray, nearest — should win
      { x: 50, y: 0, destroyed: true },     // on-ray but destroyed — ignored
      { x: 60, y: 60, destroyed: false },   // way off the ray — perpendicular miss
    ];
    const r = traceHitscan(0, 0, 0, 900, enemies);
    expect(r.target).toBe(enemies[1]);
    expect(r.t).toBeCloseTo(100);
    expect(r.endX).toBeCloseTo(100);
    expect(r.endY).toBeCloseTo(0);
  });

  it('does not target something behind the muzzle', () => {
    const enemies = [{ x: -100, y: 0, destroyed: false }];
    const r = traceHitscan(0, 0, 0, 900, enemies);
    expect(r.target).toBeNull();
  });

  it('tracks a rotating angle smoothly — endpoint sweeps proportionally, not in steps', () => {
    // Sampling the same trace at several angles (as a per-frame reposition would while the
    // turret sweeps) should move the endpoint continuously, one small increment at a time —
    // this is the geometry the #86 fix leans on to keep a held beam's line smooth.
    const reach = 900;
    const angles = [0, 0.05, 0.1, 0.15, 0.2];
    const endpoints = angles.map((a) => traceHitscan(0, 0, a, reach, []));
    for (let i = 1; i < endpoints.length; i++) {
      const dx = endpoints[i].endX - endpoints[i - 1].endX;
      const dy = endpoints[i].endY - endpoints[i - 1].endY;
      const step = Math.hypot(dx, dy);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(60); // small, continuous steps — never a big snap
    }
  });
});
