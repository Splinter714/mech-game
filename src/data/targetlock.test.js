import { describe, it, expect } from 'vitest';
import {
  makeLock, stepLock, dropLock, isFullLock, predictedTarget,
  pickLockCandidate, scoreCandidate, canFireWeapon,
  LOCK_TIME, LOCK_MAINTAIN, LOCK_PREDICT_MAX, SWITCH_DWELL,
  LOCK_PREDICT_MAX_SPEED, LOCK_PREDICT_MAX_DRIFT, ACQUIRE_CONE,
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

  it('a full lock is not flicked to a fresh candidate by a single frame (#77 dwell)', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    // One brief frame aiming at B is below SWITCH_DWELL → A is retained (anti-flicker).
    stepLock(lock, { dt: 0.1, cand: B, hasLos: true, targetPos: pos(0, 0), valid: true });
    expect(lock.enemy).toBe(A);
  });

  it('deliberately aiming at another enemy past SWITCH_DWELL hands the lock over (#77)', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    // Keep aiming at B; the dwell accrues and once it clears SWITCH_DWELL the lock switches to B
    // and RE-CHARGES from amber (progress back to 0) — the charge-up concept is preserved.
    let switched = false;
    for (let i = 0; i < 10; i++) {
      stepLock(lock, { dt: SWITCH_DWELL / 3, cand: B, hasLos: true, targetPos: pos(0, 0), valid: true });
      if (lock.enemy === B) { switched = true; break; }
    }
    expect(switched).toBe(true);
    expect(lock.progress).toBeLessThan(1);   // handed over as a fresh amber charge, not instantly red
  });

  it('aiming back at the locked target resets the switch dwell (no accidental handover)', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    // Aim at B for a bit (below dwell), then back at A → the challenge dwell must reset so a
    // later brief B glance can't accumulate across the interruption into a stolen lock.
    stepLock(lock, { dt: SWITCH_DWELL * 0.6, cand: B, hasLos: true, targetPos: pos(0, 0), valid: true });
    stepLock(lock, { dt: 0.1, cand: A, hasLos: true, targetPos: pos(0, 0), valid: true });
    expect(lock.challengeTime).toBe(0);
    stepLock(lock, { dt: SWITCH_DWELL * 0.6, cand: B, hasLos: true, targetPos: pos(0, 0), valid: true });
    expect(lock.enemy).toBe(A);   // the two 0.6·dwell glances don't add up because A reset it
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

describe('targetlock — candidate scoring & pick (#77)', () => {
  const RANGE = 620;
  it('picks the enemy under the reticle: proximity beats a distant dead-centred one', () => {
    // Near, slightly off-axis vs. far, dead-centred. The player means the near one.
    const near = { handle: A, ang: 0.12, dist: 160 };
    const far = { handle: B, ang: 0.0, dist: 600 };
    expect(pickLockCandidate([near, far], null, RANGE)).toBe(A);
  });

  it('a well-centred near enemy still beats a wildly off-axis near one', () => {
    const centred = { handle: A, ang: 0.02, dist: 200 };
    const offAxis = { handle: B, ang: 0.28, dist: 200 };
    expect(pickLockCandidate([centred, offAxis], null, RANGE)).toBe(A);
  });

  it('gates candidates outside the acquire cone', () => {
    const outOfCone = { handle: A, ang: ACQUIRE_CONE + 0.05, dist: 100 };
    expect(pickLockCandidate([outOfCone], null, RANGE)).toBe(null);
  });

  it('stickiness holds the incumbent through a tiny jitter but yields to a clear aim-off', () => {
    // Two near-equal candidates; the incumbent (A) wins by its sticky discount.
    const a = { handle: A, ang: 0.10, dist: 200 };
    const b = { handle: B, ang: 0.09, dist: 200 };
    expect(pickLockCandidate([a, b], A, RANGE)).toBe(A);
    // But when the player clearly aims at B (A now far off-axis), B wins despite A's stickiness.
    const aOff = { handle: A, ang: 0.27, dist: 200 };
    const bOn = { handle: B, ang: 0.03, dist: 200 };
    expect(pickLockCandidate([aOff, bOn], A, RANGE)).toBe(B);
  });

  it('scoreCandidate is lower (better) for closer / more-centred targets', () => {
    expect(scoreCandidate(0.0, 100, 620)).toBeLessThan(scoreCandidate(0.0, 500, 620));
    expect(scoreCandidate(0.05, 200, 620)).toBeLessThan(scoreCandidate(0.25, 200, 620));
  });
});

describe('targetlock — blind prediction clamps (#77)', () => {
  it('clamps the reckoned velocity to a sane mech speed', () => {
    const lock = makeLock();
    lock.lastX = 0; lock.lastY = 0; lock.lastVx = 4000; lock.lastVy = 0;   // absurd velocity
    const p = predictedTarget(lock, LOCK_PREDICT_MAX);
    // Even at max horizon the drift is capped by (clamped speed × time), not the raw 4000.
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

// #77 follow-up: "tracking missiles should not fire unless there is a lock" — a homing weapon
// with no full lock must not fire at all (no dumbfire fallback); every other delivery is
// unaffected by lock state.
describe('targetlock — canFireWeapon (#77 no-lock-no-fire gate)', () => {
  const homing = { delivery: { guidance: 'homing', path: 'arcing' } };
  const dumbfireMissile = { delivery: { guidance: 'dumbfire', path: 'straight' } };
  const arcingLob = { delivery: { guidance: null, path: 'arcing' } };
  const directHitscan = { delivery: { guidance: null, path: 'straight', hit: 'hitscan' } };

  it('blocks a homing weapon with no lock at all', () => {
    const lock = makeLock();
    expect(canFireWeapon(homing, lock)).toBe(false);
  });

  it('blocks a homing weapon with only a charging (amber, not full) lock', () => {
    const lock = makeLock();
    stepLock(lock, { dt: LOCK_TIME / 2, cand: A, hasLos: true, targetPos: pos(100, 0), valid: true });
    expect(isFullLock(lock)).toBe(false);
    expect(canFireWeapon(homing, lock)).toBe(false);
  });

  it('allows a homing weapon once the lock is full (red)', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    expect(isFullLock(lock)).toBe(true);
    expect(canFireWeapon(homing, lock)).toBe(true);
  });

  it('allows a homing weapon to fire again if the lock is dropped after being full', () => {
    const lock = makeLock();
    chargeToFull(lock, A);
    dropLock(lock);
    expect(canFireWeapon(homing, lock)).toBe(false);
  });

  it('never gates a dumbfire missile (clusterRocket) regardless of lock state', () => {
    const lock = makeLock();
    expect(canFireWeapon(dumbfireMissile, lock)).toBe(true);
    chargeToFull(lock, A);
    expect(canFireWeapon(dumbfireMissile, lock)).toBe(true);
  });

  it('never gates an arcing-but-unguided lob (plasma/napalm) regardless of lock state', () => {
    const lock = makeLock();
    expect(canFireWeapon(arcingLob, lock)).toBe(true);
  });

  it('never gates a direct-fire hitscan weapon regardless of lock state', () => {
    const lock = makeLock();
    expect(canFireWeapon(directHitscan, lock)).toBe(true);
    chargeToFull(lock, A);
    expect(canFireWeapon(directHitscan, lock)).toBe(true);
  });
});
