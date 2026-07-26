// #497 rework — pure unit tests for the Friendly Drone Launcher's decision logic (spawn count,
// leash-clamped orbit movement, target priority). Mirrors interceptor.test.js's plain-object
// style; no Phaser/scene involved.
import { describe, it, expect } from 'vitest';
import {
  DRONE_COUNT_MIN, DRONE_COUNT_MAX, randomDroneCount,
  clampToRadius, stepFriendlyDroneOrbit, pickFriendlyDroneTarget,
} from './friendlyDroneAI.js';

describe('#497 randomDroneCount', () => {
  it('is always within [DRONE_COUNT_MIN, DRONE_COUNT_MAX]', () => {
    for (let i = 0; i < 200; i++) {
      const n = randomDroneCount();
      expect(n).toBeGreaterThanOrEqual(DRONE_COUNT_MIN);
      expect(n).toBeLessThanOrEqual(DRONE_COUNT_MAX);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('is deterministic given an injected rng, and covers both ends of the range', () => {
    expect(randomDroneCount(() => 0)).toBe(DRONE_COUNT_MIN);
    expect(randomDroneCount(() => 0.999999)).toBe(DRONE_COUNT_MAX);
  });
});

describe('#497 clampToRadius', () => {
  it('leaves a point inside the radius untouched', () => {
    expect(clampToRadius(5, 5, 0, 0, 100)).toEqual({ x: 5, y: 5 });
  });

  it('pulls a point outside the radius back onto the circle, hard — no easing', () => {
    const p = clampToRadius(200, 0, 0, 0, 100);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(0);
  });

  it('handles a point exactly at the center', () => {
    expect(clampToRadius(0, 0, 0, 0, 100)).toEqual({ x: 0, y: 0 });
  });
});

describe('#497 stepFriendlyDroneOrbit', () => {
  const tuning = {
    maxSpeed: 150, accel: 420, orbitRadius: 90, leashRadius: 160,
    separationRadius: 40, separationWeight: 1.5, jitterMin: 300, jitterMax: 700,
  };

  it('never moves the drone further than the leash radius from its owner', () => {
    let state = { x: 1000, y: 0, vx: 0, vy: 0, orbitAng: 0, orbitR: 90, jitterAt: 9999, handed: 1 };
    for (let i = 0; i < 120; i++) {
      state = stepFriendlyDroneOrbit(state, 0, 0, 1 / 30, tuning, []);
      const dist = Math.hypot(state.x, state.y);
      expect(dist).toBeLessThanOrEqual(tuning.leashRadius + 1e-6);
    }
  });

  it('closes distance toward its owner when spawned far away', () => {
    let state = { x: 1000, y: 0, vx: 0, vy: 0, orbitAng: 0, orbitR: 90, jitterAt: 9999, handed: 1 };
    const startDist = Math.hypot(state.x, state.y);
    for (let i = 0; i < 30; i++) state = stepFriendlyDroneOrbit(state, 0, 0, 1 / 30, tuning, []);
    const endDist = Math.hypot(state.x, state.y);
    expect(endDist).toBeLessThan(startDist);
  });

  it('accelerates gradually rather than snapping straight to max speed', () => {
    const state = { x: 200, y: 0, vx: 0, vy: 0, orbitAng: 0, orbitR: 90, jitterAt: 9999, handed: 1 };
    const next = stepFriendlyDroneOrbit(state, 0, 0, 1 / 60, tuning, []);
    const speed = Math.hypot(next.vx, next.vy);
    expect(speed).toBeLessThan(tuning.maxSpeed);
    expect(speed).toBeGreaterThan(0);
  });

  it('pushes apart from an overlapping squadmate', () => {
    const state = { x: 0, y: 0, vx: 0, vy: 0, orbitAng: 0, orbitR: 0, jitterAt: 9999, handed: 1 };
    const sibling = { x: 1, y: 0 };
    const next = stepFriendlyDroneOrbit(state, 0, 0, 1 / 30, tuning, [sibling]);
    // With the owner target coincident (orbitR 0) and a squadmate sitting right on top of it, the
    // separation term should push it away from the sibling (negative x).
    expect(next.vx).toBeLessThan(0);
  });

  it('re-picks its orbit point periodically rather than holding one forever', () => {
    let state = { x: 0, y: 0, vx: 0, vy: 0, orbitAng: 0, orbitR: 90, jitterAt: 10, handed: 1 };
    state = stepFriendlyDroneOrbit(state, 0, 0, 1 / 30, tuning, []);
    // jitterAt started at 10ms and dt is ~33ms, so this step must have crossed zero and re-rolled
    // to a fresh value drawn from [jitterMin, jitterMax] — it can't still be counting down from 10.
    expect(state.jitterAt).toBeGreaterThanOrEqual(tuning.jitterMin);
    expect(state.jitterAt).toBeLessThanOrEqual(tuning.jitterMax);
  });
});

describe('#497 pickFriendlyDroneTarget', () => {
  const near = { x: 10, y: 0 };
  const far = { x: 50, y: 0 };

  it('prefers the locked target when it is live and in range', () => {
    const t = pickFriendlyDroneTarget(0, 0, 100, [near, far], far);
    expect(t).toBe(far);
  });

  it('falls back to nearest when there is no locked target', () => {
    const t = pickFriendlyDroneTarget(0, 0, 100, [near, far], null);
    expect(t).toBe(near);
  });

  it('falls back to nearest when the locked target is out of the drone\'s own range', () => {
    const t = pickFriendlyDroneTarget(0, 0, 20, [near, far], far);
    expect(t).toBe(near);
  });

  it('falls back to nearest when the locked target is not in the live-enemy list', () => {
    const stale = { x: 5, y: 0 };
    const t = pickFriendlyDroneTarget(0, 0, 100, [near, far], stale);
    expect(t).toBe(near);
  });

  it('returns null when nothing is in range', () => {
    const t = pickFriendlyDroneTarget(0, 0, 1, [near, far], null);
    expect(t).toBe(null);
  });
});
