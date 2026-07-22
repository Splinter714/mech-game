import { describe, it, expect } from 'vitest';
import {
  tickUnstick, unstickBend, bendHeading,
  UNSTICK_SAMPLE_MS, UNSTICK_MIN_PROGRESS_PX, UNSTICK_GRACE_MS, UNSTICK_RAMP_MS, UNSTICK_MAX_BEND,
} from './groundUnstick.js';

describe('tickUnstick', () => {
  it('never accrues stuck time for a unit steadily covering ground', () => {
    let state = null;
    let x = 0;
    for (let i = 0; i < 50; i++) {
      x += 20; // well above UNSTICK_MIN_PROGRESS_PX per sample
      state = tickUnstick(state, x, 0, UNSTICK_SAMPLE_MS);
    }
    expect(state.ms).toBe(0);
  });

  it('accrues stuck time for a unit that never moves', () => {
    let state = null;
    for (let i = 0; i < 5; i++) state = tickUnstick(state, 100, 100, UNSTICK_SAMPLE_MS);
    expect(state.ms).toBeGreaterThan(0);
    expect(state.ms).toBe(UNSTICK_SAMPLE_MS * 5); // each 400ms sample beyond the anchor accrues
  });

  it('resets the instant the unit makes real progress again', () => {
    let state = null;
    for (let i = 0; i < 5; i++) state = tickUnstick(state, 100, 100, UNSTICK_SAMPLE_MS);
    expect(state.ms).toBeGreaterThan(0);
    state = tickUnstick(state, 100 + UNSTICK_MIN_PROGRESS_PX + 1, 100, UNSTICK_SAMPLE_MS);
    expect(state.ms).toBe(0);
  });

  it('does not sample more often than UNSTICK_SAMPLE_MS — a burst of small frames is not "stuck"', () => {
    let state = null;
    // Ten frames of 16ms each (a normal 60fps tick), moving steadily — never crosses a sample
    // boundary fast enough to be misread.
    let x = 0;
    for (let i = 0; i < 10; i++) { x += 1; state = tickUnstick(state, x, 0, 16); }
    expect(state.ms).toBe(0);
    expect(state.sampleMs).toBeLessThan(UNSTICK_SAMPLE_MS);
  });
});

describe('unstickBend', () => {
  it('is zero within the grace window', () => {
    expect(unstickBend(0)).toBe(0);
    expect(unstickBend(UNSTICK_GRACE_MS)).toBe(0);
    expect(unstickBend(UNSTICK_GRACE_MS - 1)).toBe(0);
  });

  it('ramps up past the grace window and caps at UNSTICK_MAX_BEND', () => {
    const half = unstickBend(UNSTICK_GRACE_MS + UNSTICK_RAMP_MS / 2);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(UNSTICK_MAX_BEND);
    expect(unstickBend(UNSTICK_GRACE_MS + UNSTICK_RAMP_MS)).toBeCloseTo(UNSTICK_MAX_BEND, 5);
    expect(unstickBend(UNSTICK_GRACE_MS + UNSTICK_RAMP_MS * 10)).toBeCloseTo(UNSTICK_MAX_BEND, 5);
  });

  it('sign follows the unit\'s own handedness, not a coin flip', () => {
    const ms = UNSTICK_GRACE_MS + UNSTICK_RAMP_MS;
    expect(unstickBend(ms, 1)).toBeGreaterThan(0);
    expect(unstickBend(ms, -1)).toBeLessThan(0);
  });
});

describe('bendHeading', () => {
  it('is a no-op at zero bend', () => {
    expect(bendHeading(1, 0, 0)).toEqual({ tux: 1, tuy: 0 });
  });

  it('rotates the heading and preserves its length (unit vector stays a unit vector)', () => {
    const { tux, tuy } = bendHeading(1, 0, Math.PI / 2);
    expect(tux).toBeCloseTo(0, 6);
    expect(tuy).toBeCloseTo(1, 6);
    expect(Math.hypot(tux, tuy)).toBeCloseTo(1, 6);
  });
});

// ── The actual anti-stall property, proven end to end on the pure module ─────────────────────
describe('#361 follow-up: a unit pinned at a wall by a symmetric standoff eventually breaks free', () => {
  it('a stuck unit\'s bent heading carries a real lateral component after enough stuck time', () => {
    // Simulate a unit sitting dead still (a symmetric chokepoint standoff) for well past the
    // ramp, wanting to travel straight along +x (dead toward a gate it cannot yet squeeze through).
    let state = null;
    const x = 100, y = 0;
    for (let i = 0; i < 20; i++) state = tickUnstick(state, x, y, UNSTICK_SAMPLE_MS); // ~8s stuck
    const bend = unstickBend(state.ms, 1);
    expect(bend).toBeCloseTo(UNSTICK_MAX_BEND, 5);
    const { tux, tuy } = bendHeading(1, 0, bend);
    // The heading is no longer purely +x — it now has a real sideways component, which is exactly
    // what lets the unit find a gap a dead-straight approach never would.
    expect(Math.abs(tuy)).toBeGreaterThan(0.5);
    expect(Math.hypot(tux, tuy)).toBeCloseTo(1, 6);
  });
});
