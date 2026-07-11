import { describe, it, expect } from 'vitest';
import {
  shouldBecomeAware, detectionRangeFor, UNAWARE, AWARE,
  DETECTION_RANGE_MULT, NOISE_AGGRO_RANGE,
} from './awareness.js';

describe('#103 enemy awareness — detection + one-way aggro transition', () => {
  it('detectionRangeFor widens the base range by the tuned multiplier', () => {
    expect(detectionRangeFor(300)).toBeCloseTo(300 * DETECTION_RANGE_MULT);
    expect(detectionRangeFor(0)).toBeCloseTo(300 * DETECTION_RANGE_MULT);   // falls back to 300
    expect(detectionRangeFor(null)).toBeCloseTo(300 * DETECTION_RANGE_MULT);
  });

  it('an AWARE enemy always stays AWARE regardless of the situation', () => {
    expect(shouldBecomeAware(AWARE, { dist: 99999, detectRange: 1, hasLos: false, noiseDist: null })).toBe(true);
  });

  it('UNAWARE + out of range + no LOS + no noise stays UNAWARE', () => {
    const aware = shouldBecomeAware(UNAWARE, { dist: 1000, detectRange: 400, hasLos: true, noiseDist: null });
    expect(aware).toBe(false);
  });

  it('UNAWARE + within detection range + LOS becomes AWARE ("seen")', () => {
    const aware = shouldBecomeAware(UNAWARE, { dist: 300, detectRange: 400, hasLos: true, noiseDist: null });
    expect(aware).toBe(true);
  });

  it('UNAWARE + within range but LOS blocked stays UNAWARE (no line of sight, no noise)', () => {
    const aware = shouldBecomeAware(UNAWARE, { dist: 300, detectRange: 400, hasLos: false, noiseDist: null });
    expect(aware).toBe(false);
  });

  it('UNAWARE + far away but a gunshot lands nearby becomes AWARE ("heard")', () => {
    const aware = shouldBecomeAware(UNAWARE, { dist: 5000, detectRange: 400, hasLos: false, noiseDist: 50 });
    expect(aware).toBe(true);
  });

  it('a gunshot right at the noise-range boundary still counts; just past it does not', () => {
    const base = { dist: 5000, detectRange: 400, hasLos: false };
    expect(shouldBecomeAware(UNAWARE, { ...base, noiseDist: NOISE_AGGRO_RANGE })).toBe(true);
    expect(shouldBecomeAware(UNAWARE, { ...base, noiseDist: NOISE_AGGRO_RANGE + 1 })).toBe(false);
  });

  it('exactly at the detection range boundary counts as seen', () => {
    const aware = shouldBecomeAware(UNAWARE, { dist: 400, detectRange: 400, hasLos: true, noiseDist: null });
    expect(aware).toBe(true);
  });

  it('defaults hasLos to true and noiseDist to null when omitted', () => {
    expect(shouldBecomeAware(UNAWARE, { dist: 100, detectRange: 400 })).toBe(true);
    expect(shouldBecomeAware(UNAWARE, { dist: 1000, detectRange: 400 })).toBe(false);
  });
});
