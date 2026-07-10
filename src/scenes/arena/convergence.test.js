// #74 — direct-fire convergence clamp. The point-blank toe-in bug: with no floor on the
// convergence distance, an enemy at ~0px range put the convergence point on the mech and
// rotated the off-centre muzzles until they nearly crossed. convergedFireAngle() floors the
// distance at MIN_CONVERGE_DIST so the toe-in stays modest. Pure math, no Phaser/scene.
import { describe, it, expect } from 'vitest';
import { convergedFireAngle, MIN_CONVERGE_DIST, CONVERGE_DIST } from './shared.js';

// The worst-case real muzzle: the heavy chassis' arm. Lateral offset r and forward offset f
// in world px, derived from mechLayout arm.x/ y × ARENA_MECH_SCALE(0.34) × ART_SCALE(4):
//   r = |W*0.72*armSpread| * 1.36 ≈ 32.7px,  f ≈ 12.1px  (see locomotion _muzzle / shared.js).
const R = 32.7, F = 12.1;
// Toe-in of a muzzle at lateral offset r, forward offset f, converging at distance `dist`
// (relative to the turret facing = 0 here, mech at origin).
const toeDeg = (dist) => {
  const ang = convergedFireAngle(0, 0, 0, dist, F, R);   // muzzle at (f, r), turret facing +x
  return Math.abs((ang * 180) / Math.PI);
};

describe('convergedFireAngle — point-blank convergence clamp (#74)', () => {
  it('clamps a below-floor distance to MIN_CONVERGE_DIST', () => {
    // dist far below the floor must produce the SAME angle as exactly at the floor.
    const atPointBlank = convergedFireAngle(0, 0, 0, 1, F, R);
    const atFloor = convergedFireAngle(0, 0, 0, MIN_CONVERGE_DIST, F, R);
    expect(atPointBlank).toBeCloseTo(atFloor, 10);
  });

  it('leaves an above-floor distance unchanged', () => {
    // Convergence point at (CONVERGE_DIST, 0), muzzle at (F, R) → angle = atan2(0 - R, CONVERGE_DIST - F).
    const expected = Math.atan2(-R, CONVERGE_DIST - F);
    const got = convergedFireAngle(0, 0, 0, CONVERGE_DIST, F, R);
    expect(got).toBeCloseTo(expected, 10);
    // ...and it differs from the clamped-at-floor angle (proving the floor isn't applied here).
    expect(got).not.toBeCloseTo(convergedFireAngle(0, 0, 0, MIN_CONVERGE_DIST, F, R), 4);
  });

  it('keeps the worst-case (heavy arm) toe-in modest at the floor — not tens of degrees', () => {
    // At the floor the heaviest muzzle should toe in only ~10°, never the ~45–90° near-cross
    // that the un-floored point-blank case produced.
    expect(toeDeg(MIN_CONVERGE_DIST)).toBeLessThan(12);
    expect(toeDeg(MIN_CONVERGE_DIST)).toBeGreaterThan(2);
  });

  it('toe-in only ever DEcreases as the enemy gets closer than the floor (never explodes)', () => {
    const atFloor = toeDeg(MIN_CONVERGE_DIST);
    // Every closer-than-floor distance is clamped, so its toe-in equals the floor's — it can
    // never exceed it. (Without the clamp, dist→0 would send this toward ~90°.)
    for (const dist of [0, 1, 25, 100, MIN_CONVERGE_DIST - 1]) {
      expect(toeDeg(dist)).toBeCloseTo(atFloor, 6);
    }
    // Farther than the floor, convergence tightens the toe LESS (point is farther → straighter).
    expect(toeDeg(CONVERGE_DIST)).toBeLessThan(atFloor);
  });

  it('accepts an explicit minDist override', () => {
    const a = convergedFireAngle(0, 0, 0, 10, F, R, 300);
    const b = convergedFireAngle(0, 0, 0, 300, F, R);
    expect(a).toBeCloseTo(b, 10);
  });
});
