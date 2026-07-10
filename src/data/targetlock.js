// Indirect-fire target lock (#62, feel pass #77) — the pure, engine-agnostic core of the
// acquire-and-hold targeting used by BOTH the player and enemy indirect-fire mechs. Kept here
// (no Phaser) so the candidate scoring, the maintain-timer transitions, the deliberate-switch
// dwell, and the dead-reckoned "firing blind" prediction can all be unit-tested; the ArenaScene
// mixins wrap this with the actual enemy/aim queries + drawing.
//
// The lifecycle in one place:
//   • CHARGE  — while a target is held near the aim line, `progress` climbs 0→1 over
//     LOCK_TIME. A partial (amber) lock is not yet maintained; losing/changing the target
//     resets it — so acquiring (amber) retargets FREELY, exactly as the player expects.
//   • MAINTAINED — once `progress` hits 1 (red), the lock latches. It now survives the
//     target leaving the aim cone / line-of-sight being broken, for LOCK_MAINTAIN seconds.
//     Every frame the holder HAS line-of-sight, the maintain timer refreshes to full and the
//     last-known position/velocity is refreshed. When LOS is broken the lock goes BLIND and
//     the timer bleeds down; if it reaches 0 with no refresh (or the target dies / leaves
//     range) the lock is dropped. A red lock is STICKY — a tiny aim jitter never flicks it to
//     a neighbour — but NOT permanent: deliberately aiming at a different enemy for
//     SWITCH_DWELL seconds hands the lock over (it re-charges amber→red on the new target),
//     so the player can switch targets without a manual drop (#77).
//   • BLIND fire — while maintained-but-blind, indirect rounds are aimed at the target's
//     last-known position advanced by its last-known velocity (dead reckoning), so they arc
//     over cover onto where the target probably is now — skill, not wallhack.

export const LOCK_TIME = 0.6;        // s of holding a target near the aim line to charge amber→red
export const LOCK_MAINTAIN = 3.5;    // s a full (red) lock survives with no LOS before it drops
export const SWITCH_DWELL = 0.28;    // s of deliberately aiming at a DIFFERENT enemy before a red lock hands over (#77)

// ── Prediction / blind-fire (#77) ──────────────────────────────────────────────────────────
// A blind lob aims at last-known + dead-reckoned position. Three clamps keep that plausible so
// it lands near the target instead of on empty ground far away: a horizon on how many seconds
// ahead we extrapolate, a clamp on the last-known SPEED we reckon with (a spurious huge velocity
// can't fling the aim), and a hard cap on how far the predicted point may DRIFT from last-known.
export const LOCK_PREDICT_MAX = 0.8;        // s cap on how far ahead blind fire dead-reckons the target
export const LOCK_PREDICT_MAX_SPEED = 150;  // px/s cap on the last-known velocity used (light chassis tops out ~135)
export const LOCK_PREDICT_MAX_DRIFT = 130;  // px cap on predicted-point distance from last-known (~one mech-length+)

// ── Candidate scoring (#77) ─────────────────────────────────────────────────────────────────
// Which enemy the player "means" when several are near the aim. Pure angular nearest-the-line
// (the old rule) locks a far enemy that happens to be centred over a near one right under the
// reticle. Instead SCORE blends angular offset with proximity, and a tight cone gates it:
//   score = ang/ACQUIRE_CONE + LOCK_PROX_WEIGHT * (dist/range)     (lower = better)
// so a close, roughly-aimed enemy beats a distant, dead-centred one. The current lock/candidate
// gets a small score discount (LOCK_STICKY_BONUS) so a tiny aim wobble never swaps the pick —
// the player has to aim MEANINGFULLY at another enemy to overcome it. All feel/tuning levers.
export const ACQUIRE_CONE = 0.30;    // rad half-angle a candidate must be within to be lockable (tightened from 0.35)
export const LOCK_PROX_WEIGHT = 0.9; // how much proximity matters vs. angular offset in the pick
export const LOCK_STICKY_BONUS = 0.22; // score discount the incumbent target gets (anti-flicker)

// Score one candidate (lower is better). `ang` = |angular offset from the aim line| (rad),
// `dist` = range to it (px), `range` = the max lock range used to normalise proximity.
export function scoreCandidate(ang, dist, range) {
  return ang / ACQUIRE_CONE + LOCK_PROX_WEIGHT * (dist / range);
}

// Pick the best lock candidate from in-range enemies. `cands` is [{ handle, ang, dist }] (the
// caller supplies live geometry); `current` is the incumbent target handle (gets the sticky
// discount). Returns the chosen handle, or null when nothing is inside the cone. Pure.
export function pickLockCandidate(cands, current = null, range = 620) {
  let best = null, bestScore = Infinity;
  for (const c of cands) {
    if (c.ang >= ACQUIRE_CONE) continue;          // outside the acquire cone — not a candidate
    let s = scoreCandidate(c.ang, c.dist, range);
    if (c.handle === current) s -= LOCK_STICKY_BONUS;  // stickiness: hold the incumbent through jitter
    if (s < bestScore) { bestScore = s; best = c.handle; }
  }
  return best;
}

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
    challenger: null,     // #77: a different enemy the player is deliberately aiming at (switch candidate)
    challengeTime: 0,     // #77: s the challenger has been aimed at (accrues toward SWITCH_DWELL)
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

  // A maintained (red) lock latches onto its target: it isn't stolen by a fresh candidate the
  // way an amber charge is. It ends when it becomes invalid (dead / out of range), its maintain
  // window bleeds out with no LOS refresh, OR the player DELIBERATELY aims at another enemy long
  // enough (#77) — a fresh candidate that isn't the current target accrues dwell, and once it
  // clears SWITCH_DWELL the lock hands over and re-charges on the new target.
  if (maintained) {
    if (!valid) return dropLock(lock);
    if (cand && cand !== lock.enemy) {
      // A deliberate switch attempt: keep dwelling while the SAME challenger stays aimed at.
      if (cand === lock.challenger) lock.challengeTime += dt;
      else { lock.challenger = cand; lock.challengeTime = dt; }
      if (lock.challengeTime >= SWITCH_DWELL) {
        // Hand over: begin a fresh amber charge on the new target (keeps the charge-up concept).
        lock.enemy = cand;
        lock.progress = 0;
        lock.maintain = 0;
        lock.blind = false;
        lock.challenger = null;
        lock.challengeTime = 0;
        return lock;
      }
    } else {
      lock.challenger = null;   // aiming back at (or off of) the locked target resets the dwell
      lock.challengeTime = 0;
    }
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
  lock.challenger = null;
  lock.challengeTime = 0;
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
  lock.challenger = null;
  lock.challengeTime = 0;
  return lock;
}

// Where indirect fire should aim RIGHT NOW for a maintained lock:
//   • with LOS  → the target's live position (caller passes it as last-known, refreshed).
//   • blind     → the last-known position dead-reckoned forward by the last-known velocity.
// Three clamps (#77) keep a blind lob plausible instead of flinging it onto empty ground:
// the lead time is capped at LOCK_PREDICT_MAX seconds, the reckoned SPEED at
// LOCK_PREDICT_MAX_SPEED, and the total drift from last-known at LOCK_PREDICT_MAX_DRIFT px.
// `age` is seconds since LOS was last had (0 while visible). Returns { x, y }.
export function predictedTarget(lock, age = 0) {
  const t = Math.min(Math.max(age, 0), LOCK_PREDICT_MAX);
  // Clamp the last-known velocity to a sane mech speed so a spurious value can't throw the aim.
  let vx = lock.lastVx, vy = lock.lastVy;
  const sp = Math.hypot(vx, vy);
  if (sp > LOCK_PREDICT_MAX_SPEED) { const k = LOCK_PREDICT_MAX_SPEED / sp; vx *= k; vy *= k; }
  // Dead-reckon, then cap how far the predicted point may drift from last-known.
  let dx = vx * t, dy = vy * t;
  const drift = Math.hypot(dx, dy);
  if (drift > LOCK_PREDICT_MAX_DRIFT) { const k = LOCK_PREDICT_MAX_DRIFT / drift; dx *= k; dy *= k; }
  return { x: lock.lastX + dx, y: lock.lastY + dy };
}
