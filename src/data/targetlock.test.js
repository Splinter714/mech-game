import { describe, it, expect } from 'vitest';
import {
  makeLock, stepLock, hasLock, predictedTarget, canFireWeapon, stepReticlePosition,
  LOCK_PREDICT_MAX, LOCK_PREDICT_MAX_SPEED, LOCK_PREDICT_MAX_DRIFT,
} from './targetlock.js';

const A = { mech: { isDestroyed: () => false }, id: 'a' };
const B = { mech: { isDestroyed: () => false }, id: 'b' };
const hexA = { x: 300, y: 0 };   // a static (destructible-hex, #250) convergence target — no `.mech`
const pos = (x, y, vx = 0, vy = 0) => ({ x, y, vx, vy });

describe('targetlock (#252) — the lock mirrors the live target instantly', () => {
  it('has no target and cannot fire a homing weapon on a fresh lock', () => {
    const lock = makeLock();
    expect(hasLock(lock)).toBe(false);
    expect(lock.target).toBe(null);
  });

  it('acquires a target the SAME frame it appears — no charge delay', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(100, 0) });
    expect(lock.target).toBe(A);
    expect(hasLock(lock)).toBe(true);
  });

  it('switches targets immediately (no dwell/hand-over delay) when the live pick changes', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(0, 0) });
    stepLock(lock, { target: B, hasLos: true, targetPos: pos(50, 50) });
    expect(lock.target).toBe(B);
  });

  it('drops to no-target the instant the live pick goes null (no maintain grace period)', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(0, 0) });
    stepLock(lock, { target: null, hasLos: false, targetPos: null });
    expect(lock.target).toBe(null);
    expect(hasLock(lock)).toBe(false);
    expect(lock.blind).toBe(false);   // no target ⇒ not "blind", just nothing
  });

  it('re-acquiring the same target after a drop is instant too (no re-charge)', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(0, 0) });
    stepLock(lock, { target: null, hasLos: false, targetPos: null });
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(0, 0) });
    expect(hasLock(lock)).toBe(true);
  });
});

describe('targetlock (#252) — blind fire (LOS-less enemy target)', () => {
  it('is not blind while the holder has LOS', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(100, 0) });
    expect(lock.blind).toBe(false);
    expect(lock.lastX).toBe(100);
  });

  it('goes blind the instant LOS breaks, freezing the last-known position', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(100, 0, 10, 0) });
    stepLock(lock, { target: A, hasLos: false, targetPos: pos(999, 999) });
    expect(lock.blind).toBe(true);
    expect(lock.target).toBe(A);
    // Blind: last-known position is NOT refreshed to the (unseen) live position.
    expect(lock.lastX).toBe(100);
  });

  it('regaining LOS clears blind and refreshes the last-known position', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(100, 0) });
    stepLock(lock, { target: A, hasLos: false, targetPos: pos(999, 999) });
    expect(lock.blind).toBe(true);
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(50, 50, 1, 1) });
    expect(lock.blind).toBe(false);
    expect(lock.lastX).toBe(50);
  });

  it('never goes blind while the target stays the same but simply keeps having LOS', () => {
    const lock = makeLock();
    for (let i = 0; i < 5; i++) stepLock(lock, { target: A, hasLos: true, targetPos: pos(i, 0) });
    expect(lock.blind).toBe(false);
  });

  it('seeds a last-known fix the instant a NEW target is acquired even without LOS that frame — a freshly picked target still has somewhere to lob at (mirrors the pre-#252 seed-on-lock behavior)', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: false, targetPos: pos(200, 40) });
    expect(lock.blind).toBe(false);   // just-acquired: treated as a fresh fix, not stale memory
    expect(lock.lastX).toBe(200);
    expect(lock.lastY).toBe(40);
  });

  it('switching directly from a blind target to a fresh one seeds the NEW target immediately', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(0, 0) });
    stepLock(lock, { target: A, hasLos: false, targetPos: pos(999, 999) });   // A now blind
    stepLock(lock, { target: B, hasLos: false, targetPos: pos(300, 300) });  // switch to B, still no LOS
    expect(lock.target).toBe(B);
    expect(lock.blind).toBe(false);   // fresh acquisition, not stale from A
    expect(lock.lastX).toBe(300);
  });
});

describe('targetlock (#252) — static (destructible-hex, #250) targets are never blind', () => {
  it('a hex target (no `.mech`) is always treated as fully known, LOS or not', () => {
    const lock = makeLock();
    stepLock(lock, { target: hexA, hasLos: true, targetPos: { x: hexA.x, y: hexA.y, vx: 0, vy: 0 } });
    expect(lock.blind).toBe(false);
    expect(lock.lastX).toBe(300);
  });

  it('a homing weapon can fire at a hex target — hasLock only cares whether SOMETHING is targeted', () => {
    const lock = makeLock();
    stepLock(lock, { target: hexA, hasLos: true, targetPos: { x: hexA.x, y: hexA.y, vx: 0, vy: 0 } });
    const homing = { delivery: { guidance: 'homing' } };
    expect(canFireWeapon(homing, lock)).toBe(true);
  });
});

describe('targetlock — dead-reckoned blind fire prediction (unchanged math)', () => {
  it('predicts the target ahead by last-known velocity, capped', () => {
    const lock = makeLock();
    lock.lastX = 100; lock.lastY = 0; lock.lastVx = 20; lock.lastVy = 0;
    expect(predictedTarget(lock, 0)).toEqual({ x: 100, y: 0 });
    expect(predictedTarget(lock, 0.5)).toEqual({ x: 110, y: 0 });
    const capped = predictedTarget(lock, 999);
    expect(capped.x).toBeCloseTo(100 + 20 * LOCK_PREDICT_MAX, 5);
  });

  it('clamps the reckoned velocity to a sane mech speed', () => {
    const lock = makeLock();
    lock.lastX = 0; lock.lastY = 0; lock.lastVx = 4000; lock.lastVy = 0;   // absurd velocity
    const p = predictedTarget(lock, LOCK_PREDICT_MAX);
    expect(p.x).toBeLessThanOrEqual(LOCK_PREDICT_MAX_SPEED * LOCK_PREDICT_MAX + 1e-6);
  });

  it('caps how far the predicted point may drift from last-known', () => {
    const lock = makeLock();
    lock.lastX = 0; lock.lastY = 0; lock.lastVx = LOCK_PREDICT_MAX_SPEED; lock.lastVy = 0;
    const p = predictedTarget(lock, LOCK_PREDICT_MAX);
    const drift = Math.hypot(p.x - lock.lastX, p.y - lock.lastY);
    expect(drift).toBeLessThanOrEqual(LOCK_PREDICT_MAX_DRIFT + 1e-6);
  });

  it('a modest, in-bounds prediction is unchanged', () => {
    const lock = makeLock();
    lock.lastX = 100; lock.lastY = 0; lock.lastVx = 40; lock.lastVy = 0;
    expect(predictedTarget(lock, 0.5)).toEqual({ x: 120, y: 0 });
  });
});

// #252 no-lock-no-fire gate — unchanged semantics, just "has a target" instead of "fully charged".
describe('targetlock — canFireWeapon (no-lock-no-fire gate)', () => {
  const homing = { delivery: { guidance: 'homing', path: 'arcing' } };
  const dumbfireMissile = { delivery: { guidance: 'dumbfire', path: 'straight' } };
  const arcingLob = { delivery: { guidance: null, path: 'arcing' } };
  const directHitscan = { delivery: { guidance: null, path: 'straight', hit: 'hitscan' } };

  it('blocks a homing weapon with no target at all', () => {
    const lock = makeLock();
    expect(canFireWeapon(homing, lock)).toBe(false);
  });

  it('allows a homing weapon the instant a target is acquired — no charge-up wait', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(100, 0) });
    expect(canFireWeapon(homing, lock)).toBe(true);
  });

  it('blocks again once the target is gone', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(100, 0) });
    stepLock(lock, { target: null, hasLos: false, targetPos: null });
    expect(canFireWeapon(homing, lock)).toBe(false);
  });

  it('a homing weapon can fire blind (target acquired, currently no LOS)', () => {
    const lock = makeLock();
    stepLock(lock, { target: A, hasLos: true, targetPos: pos(100, 0) });
    stepLock(lock, { target: A, hasLos: false, targetPos: pos(999, 999) });
    expect(lock.blind).toBe(true);
    expect(canFireWeapon(homing, lock)).toBe(true);
  });

  it('never gates a dumbfire missile (clusterRocket) regardless of lock state', () => {
    const lock = makeLock();
    expect(canFireWeapon(dumbfireMissile, lock)).toBe(true);
  });

  it('never gates an unguided arcing lob (plasma/napalm) regardless of lock state', () => {
    const lock = makeLock();
    expect(canFireWeapon(arcingLob, lock)).toBe(true);
  });

  it('never gates direct-fire hitscan regardless of lock state', () => {
    const lock = makeLock();
    expect(canFireWeapon(directHitscan, lock)).toBe(true);
  });
});

describe('targetlock (#252) — reticle slide (stepReticlePosition)', () => {
  it('snaps straight to the target when there is no previous position (fresh acquisition)', () => {
    const p = stepReticlePosition(null, { x: 100, y: 50 }, 1 / 60);
    expect(p).toEqual({ x: 100, y: 50 });
  });

  it('eases toward the target rather than snapping — partway there after one frame', () => {
    const p = stepReticlePosition({ x: 0, y: 0 }, { x: 100, y: 0 }, 1 / 60);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(100);
  });

  it('converges to (arbitrarily close to) the target after enough frames', () => {
    let p = { x: 0, y: 0 };
    const target = { x: 200, y: -80 };
    for (let i = 0; i < 300; i++) p = stepReticlePosition(p, target, 1 / 60);
    expect(p.x).toBeCloseTo(target.x, 1);
    expect(p.y).toBeCloseTo(target.y, 1);
  });

  it('a bigger dt eases further in one step than a smaller dt (monotonic in dt)', () => {
    const small = stepReticlePosition({ x: 0, y: 0 }, { x: 100, y: 0 }, 1 / 120);
    const big = stepReticlePosition({ x: 0, y: 0 }, { x: 100, y: 0 }, 1 / 30);
    expect(big.x).toBeGreaterThan(small.x);
  });

  it('never overshoots the target', () => {
    const p = stepReticlePosition({ x: 0, y: 0 }, { x: 100, y: 0 }, 5);   // a huge dt
    expect(p.x).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('does not mutate the previous position object', () => {
    const prev = { x: 0, y: 0 };
    stepReticlePosition(prev, { x: 100, y: 0 }, 1 / 60);
    expect(prev).toEqual({ x: 0, y: 0 });
  });
});
