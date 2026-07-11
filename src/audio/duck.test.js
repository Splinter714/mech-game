import { describe, it, expect } from 'vitest';
import { duckGainAt, DUCK_DEFAULTS } from './duck.js';

const cfg = DUCK_DEFAULTS;

describe('duckGainAt (combat music ducking, #108)', () => {
  it('is full volume (1) with no triggers', () => {
    expect(duckGainAt([], 5)).toBe(1);
  });

  it('is full volume before the first trigger happens', () => {
    expect(duckGainAt([2.0], 1.0)).toBe(1);
  });

  it('eases down toward depth right after a trigger, but not instantly to depth', () => {
    const justAfter = duckGainAt([1.0], 1.0 + cfg.attack * 0.25, cfg);
    expect(justAfter).toBeLessThan(1);
    expect(justAfter).toBeGreaterThan(cfg.depth);
  });

  it('settles close to depth by the end of the hold window, and holds there', () => {
    const nearWindowEnd = duckGainAt([1.0], 1.0 + cfg.hold * 0.99, cfg);
    expect(nearWindowEnd).toBeCloseTo(cfg.depth, 1);
    // still within the hold window — stays pinned near depth, doesn't creep back up
    const laterInHold = duckGainAt([1.0], 1.0 + cfg.hold * 0.9, cfg);
    expect(laterInHold).toBeGreaterThanOrEqual(cfg.depth - 0.01);
    expect(laterInHold).toBeLessThan(nearWindowEnd + 0.01);
  });

  it('recovers toward 1 once the hold window has elapsed with no further trigger', () => {
    const windowEnd = 1.0 + cfg.hold;
    const atEnd = duckGainAt([1.0], windowEnd, cfg);
    const later = duckGainAt([1.0], windowEnd + cfg.release, cfg);
    const muchLater = duckGainAt([1.0], windowEnd + cfg.release * 6, cfg);
    expect(later).toBeGreaterThan(atEnd);
    expect(muchLater).toBeCloseTo(1, 2);
  });

  it('is continuous at the hold/release boundary (no audible jump)', () => {
    const windowEnd = 1.0 + cfg.hold;
    const justBefore = duckGainAt([1.0], windowEnd - 0.0001, cfg);
    const justAfter = duckGainAt([1.0], windowEnd + 0.0001, cfg);
    expect(Math.abs(justAfter - justBefore)).toBeLessThan(0.01);
  });

  it('sustained rapid fire pins the duck at depth instead of bouncing back toward 1 between shots', () => {
    // Shots every 0.1s, well inside the 0.15s hold — a firefight.
    const triggers = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
    for (const t of [0.35, 0.4, 0.45, 0.5, 0.55]) {
      const g = duckGainAt(triggers, t, cfg);
      expect(g).toBeCloseTo(cfg.depth, 2);
    }
  });

  it('recovers after sustained fire stops', () => {
    const triggers = [0, 0.1, 0.2, 0.3];
    const lastWindowEnd = 0.3 + cfg.hold;
    const recovered = duckGainAt(triggers, lastWindowEnd + cfg.release * 6, cfg);
    expect(recovered).toBeCloseTo(1, 2);
  });

  it('a second burst after full recovery re-engages the duck from near 1', () => {
    const firstBurst = [0, 0.05];
    const longAfter = 0 + cfg.hold + cfg.release * 6;      // fully recovered
    const secondShot = longAfter + 2;                       // a fresh, later shot
    const triggers = [...firstBurst, secondShot];
    const justAfterSecond = duckGainAt(triggers, secondShot + cfg.hold * 0.99, cfg);
    expect(justAfterSecond).toBeCloseTo(cfg.depth, 1);
  });

  it('never dips below the configured depth or rises above 1', () => {
    const triggers = [0, 0.05, 0.1, 0.5, 0.9, 1.4];
    for (let t = 0; t < 3; t += 0.05) {
      const g = duckGainAt(triggers, t, cfg);
      expect(g).toBeGreaterThanOrEqual(cfg.depth - 1e-9);
      expect(g).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
