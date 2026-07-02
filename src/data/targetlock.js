// Indirect-fire target lock (#62) — the pure, engine-agnostic core of the acquire-and-hold
// targeting used by BOTH the player and enemy indirect-fire mechs. Kept here (no Phaser) so
// the maintain-timer transitions and the dead-reckoned "firing blind" prediction can be
// unit-tested; the ArenaScene mixins wrap this with the actual enemy/aim queries + drawing.
//
// The lifecycle in one place:
//   • CHARGE  — while a target is held near the aim line, `progress` climbs 0→1 over
//     LOCK_TIME. A partial (amber) lock is not yet maintained; losing the target resets it.
//   • MAINTAINED — once `progress` hits 1 (red), the lock latches. It now survives the
//     target leaving the aim cone / line-of-sight being broken, for LOCK_MAINTAIN seconds.
//     Every frame the holder HAS line-of-sight, the maintain timer refreshes to full and the
//     last-known position/velocity is refreshed. When LOS is broken the lock goes BLIND and
//     the timer bleeds down; if it reaches 0 with no refresh (or the target dies / leaves
//     range) the lock is dropped.
//   • BLIND fire — while maintained-but-blind, indirect rounds are aimed at the target's
//     last-known position advanced by its last-known velocity (dead reckoning), so they arc
//     over cover onto where the target probably is now — skill, not wallhack.

export const LOCK_TIME = 0.6;        // s of holding a target near the aim line to charge amber→red
export const LOCK_MAINTAIN = 3.5;    // s a full (red) lock survives with no LOS before it drops
export const LOCK_PREDICT_MAX = 0.8; // s cap on how far ahead blind fire dead-reckons the target

// A fresh, empty lock record. `enemy` is the opaque target handle (an enemy object for the
// player; the player-proxy for an enemy). `progress` is the amber→red charge; `maintain` is
// the remaining hold time once red; `blind` is true when maintained without current LOS.
export function makeLock() {
  return {
    enemy: null,          // current target handle, or null
    progress: 0,          // 0→1 charge
    maintain: 0,          // s of maintain time remaining (only meaningful once progress===1)
    blind: false,         // maintained but currently without LOS → firing from memory
    lastX: 0, lastY: 0,   // last-known target position (refreshed while LOS)
    lastVx: 0, lastVy: 0, // last-known target velocity (for dead reckoning)
  };
}

// Is this lock fully charged (red)? Only a full lock is maintained / feeds indirect fire.
export function isFullLock(lock) {
  return !!lock.enemy && lock.progress >= 1;
}

// Advance the lock one step. Inputs (all computed by the caller from live world state):
//   dt        — seconds elapsed
//   cand      — the best fresh in-cone candidate this frame (target handle) or null
//   hasLos    — does the holder currently have line-of-sight to the CURRENT locked target?
//   targetPos — { x, y, vx, vy } of the current locked target this frame (for last-known
//               refresh while LOS); ignored when there's no current lock. May be null.
//   valid     — is the current locked target still a legal target (alive AND in range)? When
//               false the lock drops regardless of maintain time (target died / fled range).
// Mutates and returns `lock`. Pure aside from the mutation (no time/rng/DOM).
export function stepLock(lock, { dt, cand, hasLos, targetPos, valid }) {
  const maintained = isFullLock(lock);

  // A maintained (red) lock latches onto its target: it does NOT get stolen by a fresh
  // candidate and it survives the target leaving the cone. It only ends when it becomes
  // invalid (dead / out of range) or its maintain window bleeds out with no LOS refresh.
  if (maintained) {
    if (!valid) return dropLock(lock);
    if (hasLos) {
      lock.maintain = LOCK_MAINTAIN;   // refresh the hold window every frame we can see it
      lock.blind = false;
      if (targetPos) {
        lock.lastX = targetPos.x; lock.lastY = targetPos.y;
        lock.lastVx = targetPos.vx || 0; lock.lastVy = targetPos.vy || 0;
      }
    } else {
      lock.blind = true;
      lock.maintain -= dt;
      if (lock.maintain <= 0) return dropLock(lock);
    }
    return lock;
  }

  // Not yet maintained: the pre-lock CHARGE phase. Track the best fresh candidate; charge
  // while one is held, reset the charge on a target swap, bleed down when there's nothing.
  const prev = lock.enemy;
  lock.enemy = cand;
  lock.blind = false;
  if (!lock.enemy) {
    lock.progress = Math.max(0, lock.progress - dt / LOCK_TIME);
    return lock;
  }
  if (lock.enemy !== prev) lock.progress = 0;
  lock.progress = Math.min(1, lock.progress + dt / LOCK_TIME);
  // The instant it tops out it becomes maintained — seed the hold window + last-known from
  // this frame so a lock acquired and immediately blinded still has a position to lob at.
  if (lock.progress >= 1) {
    lock.maintain = LOCK_MAINTAIN;
    if (targetPos) {
      lock.lastX = targetPos.x; lock.lastY = targetPos.y;
      lock.lastVx = targetPos.vx || 0; lock.lastVy = targetPos.vy || 0;
    }
  }
  return lock;
}

// Clear a lock back to empty (target lost). Separate so both drop paths read the same.
export function dropLock(lock) {
  lock.enemy = null;
  lock.progress = 0;
  lock.maintain = 0;
  lock.blind = false;
  return lock;
}

// Where indirect fire should aim RIGHT NOW for a maintained lock:
//   • with LOS  → the target's live position (caller passes it as last-known, refreshed).
//   • blind     → the last-known position dead-reckoned forward by the last-known velocity,
//     capped at LOCK_PREDICT_MAX seconds of lead so a long blind hold doesn't fling the aim
//     off the map. `age` is seconds since LOS was last had (0 while visible).
// Returns { x, y }. Caller decides whether to use it (only when isFullLock).
export function predictedTarget(lock, age = 0) {
  const t = Math.min(Math.max(age, 0), LOCK_PREDICT_MAX);
  return {
    x: lock.lastX + lock.lastVx * t,
    y: lock.lastY + lock.lastVy * t,
  };
}
