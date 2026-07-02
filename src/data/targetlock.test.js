import { describe, it, expect } from 'vitest';
import {
  makeLock, stepLock, dropLock, isFullLock, predictedTarget,
  LOCK_TIME, LOCK_MAINTAIN, LOCK_PREDICT_MAX,
} from './targetlock.js';

const A = { id: 'a' };
const B = { id: 'b' };
const pos = (x, y, vx = 0, vy = 0) => ({ x, y, vx, vy });

// Charge a fresh lock to full (red) on target `tgt`, with LOS + a fixed position each step.
function chargeToFull(lock, tgt, targetPos = pos(100, 0)) {
  for (let i = 0; i < 10; i++) {
    stepLock(lock, { dt: LOCK_TIME / 5, cand: tgt, hasLos: true, targetPos, valid: true });
    if (isFullLock(lock)) break;
  }
  return lock;
}

describe('targetlock — charge phase', () => {
  it('charges amber→red over LOCK_TIME while a candidate is held', () => {
    const lock = makeLock();
    stepLock(lock, { dt: LOCK_TIME / 2, cand: A, hasLos: true, targetPos: pos(1, 2), valid: true });
    expect(lock.enemy).toBe(A);
    expect(lock.progress).toBeCloseTo(0.5, 5);
    expect(isFullLock(lock)).toBe(false);
    stepLock(lock, { dt: LOCK_TIME / 2, cand: A, hasLos: true, targetPos: pos(1, 2), valid: true });
    expect(lock.progress).toBe(1);
    expect(isFullLock(lock)).toBe(true);
  });

  it('resets the charge when the candidate changes before locking', () => {
    const lock = makeLock();
    stepLock(lock, { dt: LOCK_TIME * 0.9, cand: A, hasLos: true, targetPos: pos(0, 0), valid: true });
    expect(lock.progress).toBeCloseTo(0.9, 5);
    stepLock(lock, { dt: 0.001, cand: B, hasLos: true, targetPos: pos(0, 0), valid: true });
    expect(lock.enemy).toBe(B);
    expect(lock.progress).toBeLessThan(0.1);   // reset to 0 then charged a hair
  });

  it('bleeds the charge down when no candidate is in cone', () => {
    const lock = makeLock();
    stepLock(lock, { dt: LOCK_TIME * 0.6, cand: A, hasLos: true, targetPos: pos(0, 0), valid: true });
    expect(lock.progress).toBeCloseTo(0.6, 5);
    stepLock(lock, { dt: LOCK_TIME * 0.3, cand: null, hasLos: false, targetPos: null, valid: false });
    expect(lock.enemy).toBe(null);
    expect(lock.progress).toBeCloseTo(0.3, 5);
  });
});

describe('targetlock — maintain phase', () => {
  it('a full lock survives the candidate leaving the cone (no steal, no drop)', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    expect(isFullLock(lock)).toBe(true);
    // Candidate now null (out of cone) but still valid + we have LOS → held, refreshed.
    stepLock(lock, { dt: 0.1, cand: null, hasLos: true, targetPos: pos(200, 0), valid: true });
    expect(lock.enemy).toBe(A);
    expect(lock.blind).toBe(false);
    expect(lock.maintain).toBe(LOCK_MAINTAIN);
    expect(lock.lastX).toBe(200);
  });

  it('a full lock is NOT stolen by a fresh closer candidate', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    stepLock(lock, { dt: 0.1, cand: B, hasLos: true, targetPos: pos(0, 0), valid: true });
    expect(lock.enemy).toBe(A);   // latched, B is ignored
  });

  it('goes blind and bleeds the maintain window when LOS is broken', () => {
    const lock = makeLock();
    chargeToFull(lock, A, pos(100, 0, 10, 0));
    expect(lock.maintain).toBe(LOCK_MAINTAIN);
    stepLock(lock, { dt: 1, cand: null, hasLos: false, targetPos: pos(999, 999), valid: true });
    expect(lock.blind).toBe(true);
    expect(lock.enemy).toBe(A);
    expect(lock.maintain).toBeCloseTo(LOCK_MAINTAIN - 1, 5);
    // Blind: last-known position is NOT refreshed to the (unseen) live position.
    expect(lock.lastX).toBe(100);
  });

  it('drops the lock when the maintain window expires with no LOS', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    stepLock(lock, { dt: LOCK_MAINTAIN + 0.01, cand: null, hasLos: false, targetPos: null, valid: true });
    expect(lock.enemy).toBe(null);
    expect(isFullLock(lock)).toBe(false);
  });

  it('regaining LOS refreshes the maintain window and clears blind', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    stepLock(lock, { dt: LOCK_MAINTAIN - 0.5, cand: null, hasLos: false, targetPos: null, valid: true });
    expect(lock.blind).toBe(true);
    stepLock(lock, { dt: 0.1, cand: null, hasLos: true, targetPos: pos(50, 50, 1, 1), valid: true });
    expect(lock.blind).toBe(false);
    expect(lock.maintain).toBe(LOCK_MAINTAIN);
    expect(lock.lastX).toBe(50);
  });

  it('drops immediately when the target becomes invalid (dead / out of range)', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    stepLock(lock, { dt: 0.1, cand: null, hasLos: true, targetPos: pos(0, 0), valid: false });
    expect(lock.enemy).toBe(null);
  });
});

describe('targetlock — dead-reckoned blind fire', () => {
  it('predicts the target ahead by last-known velocity, capped', () => {
    const lock = makeLock();
    lock.lastX = 100; lock.lastY = 0; lock.lastVx = 20; lock.lastVy = 0;
    expect(predictedTarget(lock, 0)).toEqual({ x: 100, y: 0 });
    expect(predictedTarget(lock, 0.5)).toEqual({ x: 110, y: 0 });
    // Capped at LOCK_PREDICT_MAX regardless of age.
    const capped = predictedTarget(lock, 999);
    expect(capped.x).toBeCloseTo(100 + 20 * LOCK_PREDICT_MAX, 5);
  });
});

describe('targetlock — dropLock', () => {
  it('clears everything', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    dropLock(lock);
    expect(lock.enemy).toBe(null);
    expect(lock.progress).toBe(0);
    expect(lock.maintain).toBe(0);
    expect(lock.blind).toBe(false);
  });
});
