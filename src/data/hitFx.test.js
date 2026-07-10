import { describe, it, expect } from 'vitest';
import {
  FLOAT_COALESCE_MS, IMPACT_BURST_MS, IMPACT_MERGE_DIST, SOUND_THROTTLE_MS,
  allowByKey, shouldMergeFloat, skipImpactBurst,
} from './hitFx.js';

describe('allowByKey — per-id sound rate limiter', () => {
  it('allows the first call for an id and records the time', () => {
    const last = {};
    expect(allowByKey(last, 'machineGun', 1000, SOUND_THROTTLE_MS)).toBe(true);
    expect(last.machineGun).toBe(1000);
  });

  it('blocks a second call inside the gap and leaves the timestamp untouched', () => {
    const last = { machineGun: 1000 };
    expect(allowByKey(last, 'machineGun', 1000 + SOUND_THROTTLE_MS - 1, SOUND_THROTTLE_MS)).toBe(false);
    expect(last.machineGun).toBe(1000); // not advanced — so the window is measured from the last ACCEPT
  });

  it('allows again once the gap has fully elapsed', () => {
    const last = { machineGun: 1000 };
    expect(allowByKey(last, 'machineGun', 1000 + SOUND_THROTTLE_MS, SOUND_THROTTLE_MS)).toBe(true);
    expect(last.machineGun).toBe(1000 + SOUND_THROTTLE_MS);
  });

  it('throttles distinct ids independently', () => {
    const last = {};
    expect(allowByKey(last, 'a', 1000, SOUND_THROTTLE_MS)).toBe(true);
    expect(allowByKey(last, 'b', 1000, SOUND_THROTTLE_MS)).toBe(true); // different weapon still sounds
    expect(allowByKey(last, 'a', 1010, SOUND_THROTTLE_MS)).toBe(false);
  });

  it('bounds a burst of same-id hits to ~one per gap', () => {
    const last = {};
    let sounds = 0;
    // 100 hits over 1000ms (one every 10ms) from a single weapon.
    for (let t = 0; t < 1000; t += 10) if (allowByKey(last, 'gun', t, SOUND_THROTTLE_MS)) sounds++;
    expect(sounds).toBeLessThanOrEqual(Math.ceil(1000 / SOUND_THROTTLE_MS) + 1);
    expect(sounds).toBeLessThan(100); // massively fewer than the raw hit count
  });
});

describe('shouldMergeFloat — coalescing damage numbers', () => {
  it('does not merge when there is no active float', () => {
    expect(shouldMergeFloat(null, 500)).toBe(false);
    expect(shouldMergeFloat(undefined, 500)).toBe(false);
  });

  it('merges when the last hit was within the window', () => {
    expect(shouldMergeFloat({ lastHit: 500 }, 500 + FLOAT_COALESCE_MS - 1)).toBe(true);
  });

  it('does not merge once the window has elapsed (fresh number pops)', () => {
    expect(shouldMergeFloat({ lastHit: 500 }, 500 + FLOAT_COALESCE_MS)).toBe(false);
  });

  it('accepts a custom window', () => {
    expect(shouldMergeFloat({ lastHit: 0 }, 50, 40)).toBe(false);
    expect(shouldMergeFloat({ lastHit: 0 }, 30, 40)).toBe(true);
  });
});

describe('skipImpactBurst — merging near-simultaneous bursts at a point', () => {
  it('never skips when there is no prior burst', () => {
    expect(skipImpactBurst(null, 100, 100, 0)).toBe(false);
  });

  it('skips a burst at the same point within the time window', () => {
    const last = { x: 100, y: 100, t: 0 };
    expect(skipImpactBurst(last, 100, 100, IMPACT_BURST_MS - 1)).toBe(true);
  });

  it('does NOT skip once the time window has passed', () => {
    const last = { x: 100, y: 100, t: 0 };
    expect(skipImpactBurst(last, 100, 100, IMPACT_BURST_MS)).toBe(false);
  });

  it('does NOT skip a burst far enough away, even in-window (distinct impacts)', () => {
    const last = { x: 100, y: 100, t: 0 };
    expect(skipImpactBurst(last, 100 + IMPACT_MERGE_DIST + 1, 100, 1)).toBe(false);
  });

  it('skips within the merge radius (uses true 2D distance)', () => {
    const last = { x: 100, y: 100, t: 0 };
    const off = IMPACT_MERGE_DIST / Math.SQRT2 - 0.1; // just inside the radius diagonally
    expect(skipImpactBurst(last, 100 + off, 100 + off, 1)).toBe(true);
  });
});
