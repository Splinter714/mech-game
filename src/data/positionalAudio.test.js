// #264 — pure math tests for the positional-audio helpers (distanceGain/stereoPan). No
// Phaser/Web Audio here at all; see audio/sfx.js's positionalBus for how these numbers get
// turned into real GainNode/StereoPannerNode values, and its own tests for that wiring.
import { describe, it, expect } from 'vitest';
import {
  distanceGain, stereoPan, NEAR_DISTANCE, MAX_AUDIBLE_DISTANCE, FLOOR_GAIN, PAN_RANGE_PX,
} from './positionalAudio.js';

describe('distanceGain', () => {
  it('is full volume (1) when source and listener are at the exact same point', () => {
    expect(distanceGain(100, 100, 100, 100)).toBe(1);
  });

  it('is full volume (1) anywhere inside NEAR_DISTANCE, in any direction', () => {
    expect(distanceGain(0, 0, NEAR_DISTANCE - 1, 0)).toBe(1);
    expect(distanceGain(0, 0, 0, NEAR_DISTANCE - 1)).toBe(1);
    expect(distanceGain(0, 0, -(NEAR_DISTANCE - 1), 0)).toBe(1);
    // Diagonal offset with a Euclidean distance still under NEAR_DISTANCE.
    const d = NEAR_DISTANCE * 0.6;
    expect(distanceGain(0, 0, d * Math.SQRT1_2, d * Math.SQRT1_2)).toBe(1);
  });

  it('is exactly full volume right at the NEAR_DISTANCE boundary', () => {
    expect(distanceGain(0, 0, NEAR_DISTANCE, 0)).toBe(1);
  });

  it('clamps to FLOOR_GAIN at and beyond MAX_AUDIBLE_DISTANCE', () => {
    expect(distanceGain(0, 0, MAX_AUDIBLE_DISTANCE, 0)).toBeCloseTo(FLOOR_GAIN, 6);
    expect(distanceGain(0, 0, MAX_AUDIBLE_DISTANCE * 5, 0)).toBeCloseTo(FLOOR_GAIN, 6);
  });

  it('never drops below FLOOR_GAIN or exceeds 1, across a wide distance sweep', () => {
    for (let d = 0; d <= MAX_AUDIBLE_DISTANCE * 3; d += 50) {
      const g = distanceGain(0, 0, d, 0);
      expect(g).toBeGreaterThanOrEqual(FLOOR_GAIN - 1e-9);
      expect(g).toBeLessThanOrEqual(1);
    }
  });

  it('decreases monotonically as distance increases past NEAR_DISTANCE', () => {
    let prev = distanceGain(0, 0, NEAR_DISTANCE, 0);
    for (let d = NEAR_DISTANCE + 50; d <= MAX_AUDIBLE_DISTANCE; d += 50) {
      const g = distanceGain(0, 0, d, 0);
      expect(g).toBeLessThanOrEqual(prev + 1e-9);
      prev = g;
    }
  });

  it('depends only on Euclidean distance, not on axis or the sign of the offset', () => {
    const a = distanceGain(500, 0, 0, 0);
    const b = distanceGain(0, 500, 0, 0);
    const c = distanceGain(-500, 0, 0, 0);
    const d = distanceGain(0, 0, 500, 0); // reversed source/listener roles
    expect(a).toBeCloseTo(b, 9);
    expect(a).toBeCloseTo(c, 9);
    expect(a).toBeCloseTo(d, 9);
  });

  it('is symmetric under a shared translation of both points', () => {
    const a = distanceGain(300, 300, 0, 0);
    const b = distanceGain(300 + 1000, 300 - 1000, 0 + 1000, 0 - 1000);
    expect(a).toBeCloseTo(b, 9);
  });
});

describe('stereoPan', () => {
  it('is centered (0) when the source is directly above/below the listener (no horizontal offset)', () => {
    expect(stereoPan(0, 500, 0, 0)).toBe(0);
    expect(stereoPan(0, -500, 0, 0)).toBe(0);
  });

  it('is centered (0) when source and listener coincide', () => {
    expect(stereoPan(10, 10, 10, 10)).toBe(0);
  });

  it('pans negative (left) when the source is to the listener\'s left', () => {
    expect(stereoPan(-100, 0, 0, 0)).toBeLessThan(0);
  });

  it('pans positive (right) when the source is to the listener\'s right', () => {
    expect(stereoPan(100, 0, 0, 0)).toBeGreaterThan(0);
  });

  it('is a hard left/right ±1 at and beyond PAN_RANGE_PX', () => {
    expect(stereoPan(PAN_RANGE_PX, 0, 0, 0)).toBe(1);
    expect(stereoPan(-PAN_RANGE_PX, 0, 0, 0)).toBe(-1);
    expect(stereoPan(PAN_RANGE_PX * 10, 0, 0, 0)).toBe(1);
    expect(stereoPan(-PAN_RANGE_PX * 10, 0, 0, 0)).toBe(-1);
  });

  it('never exceeds the [-1, 1] range', () => {
    for (let dx = -PAN_RANGE_PX * 4; dx <= PAN_RANGE_PX * 4; dx += 100) {
      const p = stereoPan(dx, 0, 0, 0);
      expect(p).toBeGreaterThanOrEqual(-1);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('scales roughly linearly with horizontal offset inside the pan range', () => {
    const quarter = stereoPan(PAN_RANGE_PX / 4, 0, 0, 0);
    const half = stereoPan(PAN_RANGE_PX / 2, 0, 0, 0);
    expect(half).toBeCloseTo(quarter * 2, 6);
  });

  it('ignores vertical offset entirely (fixed top-down camera, no listener rotation)', () => {
    const a = stereoPan(200, 0, 0, 0);
    const b = stereoPan(200, 900, 0, 900);
    expect(a).toBeCloseTo(b, 9);
  });

  it('is antisymmetric: mirroring the source across the listener flips the sign', () => {
    const p = stereoPan(250, 0, 0, 0);
    const mirrored = stereoPan(-250, 0, 0, 0);
    expect(mirrored).toBeCloseTo(-p, 9);
  });
});
