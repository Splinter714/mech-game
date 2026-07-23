import { describe, it, expect } from 'vitest';
import {
  VEHICLE_SCALE_MULT, MECH_SCALE_FACTOR, vehicleScaleFactor, trueScaleBase,
} from './unitScale.js';
import { ENEMY_KINDS, ENEMY_KIND_IDS } from './enemyKinds.js';

describe('vehicleScaleFactor', () => {
  it('uses the kind\'s own scale', () => {
    expect(vehicleScaleFactor({ scale: 0.4 })).toBe(0.4);
  });

  it('falls back to the shared vehicle multiplier', () => {
    expect(vehicleScaleFactor({})).toBe(VEHICLE_SCALE_MULT);
    expect(vehicleScaleFactor(undefined)).toBe(VEHICLE_SCALE_MULT);
  });

  it('resolves a real factor for every enemy kind', () => {
    for (const id of ENEMY_KIND_IDS) {
      const f = vehicleScaleFactor(ENEMY_KINDS[id]);
      expect(f, id).toBeGreaterThan(0);
    }
  });

  it('keeps the mech as the unit of comparison', () => {
    expect(MECH_SCALE_FACTOR).toBe(1);
  });
});

describe('trueScaleBase', () => {
  it('fits the largest entry to the box, leaving the rest proportionally smaller', () => {
    const entries = [
      { w: 100, h: 100, factor: 1 },      // 100 world px
      { w: 100, h: 100, factor: 0.5 },    // 50 world px
    ];
    const base = trueScaleBase(entries, 200);
    expect(base).toBeCloseTo(2);                     // biggest fills the 200px box
    expect(100 * 0.5 * base).toBeCloseTo(100);       // the small one draws at half of it
  });

  it('honours the taller of the two dimensions', () => {
    const base = trueScaleBase([{ w: 50, h: 200, factor: 1 }], 100);
    expect(base).toBeCloseTo(0.5);
  });

  it('is one shared scale — the ratio between two units is their factor ratio', () => {
    const base = trueScaleBase([
      { w: 240, h: 200, factor: 0.6 },
      { w: 240, h: 200, factor: 0.19 },
    ], 300);
    const big = 0.6 * base, small = 0.19 * base;
    expect(small / big).toBeCloseTo(0.19 / 0.6);
  });

  it('defaults a missing factor to 1', () => {
    expect(trueScaleBase([{ w: 100, h: 100 }], 50)).toBeCloseTo(0.5);
  });

  it('ignores blank/degenerate entries and returns 0 when nothing is drawable', () => {
    expect(trueScaleBase([], 100)).toBe(0);
    expect(trueScaleBase([{ w: 0, h: 0, factor: 1 }], 100)).toBe(0);
    expect(trueScaleBase([{ w: 0, h: 0, factor: 1 }, { w: 100, h: 100, factor: 1 }], 100))
      .toBeCloseTo(1);
  });
});
