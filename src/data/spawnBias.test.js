import { describe, it, expect } from 'vitest';
import { biasedSpawnAngle, isWithinSpawnBias, SPAWN_BIAS_SPREAD } from './spawnBias.js';

describe('#102 spawn-direction bias — spawns read as coming from the objective', () => {
  it('with no objective angle, falls back to a uniform bearing (whatever rand gives)', () => {
    expect(biasedSpawnAngle(null, SPAWN_BIAS_SPREAD, () => 0.75)).toBeCloseTo(0.75 * Math.PI * 2);
    expect(biasedSpawnAngle(undefined, SPAWN_BIAS_SPREAD, () => 0.25)).toBeCloseTo(0.25 * Math.PI * 2);
    expect(biasedSpawnAngle(NaN, SPAWN_BIAS_SPREAD, () => 0.5)).toBeCloseTo(0.5 * Math.PI * 2);
  });

  it('picks an angle within ±spread of the objective bearing', () => {
    const objAngle = 1.2;
    // Sweep the injectable rand across its whole range and confirm every result stays in-arc.
    for (let r = 0; r <= 1; r += 0.05) {
      const a = biasedSpawnAngle(objAngle, SPAWN_BIAS_SPREAD, () => r);
      expect(isWithinSpawnBias(a, objAngle)).toBe(true);
    }
  });

  it('rand=0.5 (midpoint) lands exactly on the objective bearing', () => {
    const objAngle = -0.4;
    expect(biasedSpawnAngle(objAngle, SPAWN_BIAS_SPREAD, () => 0.5)).toBeCloseTo(objAngle);
  });

  it('the extremes of rand land at exactly ±spread from the objective bearing', () => {
    const objAngle = 0.9;
    expect(biasedSpawnAngle(objAngle, SPAWN_BIAS_SPREAD, () => 0)).toBeCloseTo(objAngle - SPAWN_BIAS_SPREAD);
    expect(biasedSpawnAngle(objAngle, SPAWN_BIAS_SPREAD, () => 1)).toBeCloseTo(objAngle + SPAWN_BIAS_SPREAD);
  });

  it('isWithinSpawnBias handles angle wraparound at the ±π seam', () => {
    const objAngle = Math.PI - 0.05;   // just under the seam
    const candidate = -Math.PI + 0.05;  // just past it the other way — 0.1 rad apart, not ~2π
    expect(isWithinSpawnBias(candidate, objAngle)).toBe(true);
  });

  it('a bearing well outside the arc (directly opposite the objective) is rejected', () => {
    const objAngle = 0;
    expect(isWithinSpawnBias(Math.PI, objAngle)).toBe(false);
  });

  it('a narrower custom spread is honored by both functions', () => {
    const objAngle = 2.0;
    const narrow = 0.1;
    for (let r = 0; r <= 1; r += 0.25) {
      const a = biasedSpawnAngle(objAngle, narrow, () => r);
      expect(isWithinSpawnBias(a, objAngle, narrow)).toBe(true);
    }
    expect(isWithinSpawnBias(objAngle + 0.5, objAngle, narrow)).toBe(false);
  });
});
