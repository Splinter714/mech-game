// Indirect-fire target lock (#62, feel pass #77, rework #252) — the pure, engine-agnostic core
// of the targeting used by BOTH the player and enemy indirect-fire mechs. Kept here (no Phaser)
// so the last-known/dead-reckoning math and the reticle-slide easing can be unit-tested; the
// ArenaScene mixins wrap this with the actual convergence/enemy queries + drawing.
//
// #252 rework — the model in one place:
//   • The "lock" is nothing more than a mirror of whatever WEAPON CONVERGENCE currently has
//     selected (for the player: `convergeTarget`, shared.js `pickConvergeTarget` — an enemy, or,
//     #250, a fallback destructible-terrain hex, or null; for an enemy mech: simply the player
//     whenever it's in range). There is no separate acquire/charge phase (the old amber→red
//     LOCK_TIME climb), no independent maintain timer that outlives convergence itself (the old
//     LOCK_MAINTAIN hold-through-cover window), and no deliberate-switch dwell gate (the old
//     SWITCH_DWELL) — the target simply follows convergence's live pick, instantly, every frame.
//   • BLIND fire — convergence itself has no line-of-sight requirement (it's pure aim-line +
//     range geometry, same as before #252), so the live convergence target can be a real enemy
//     the holder currently can't see through a wall. When that happens, indirect rounds aim at
//     the target's last-known position advanced by its last-known velocity (dead reckoning), so
//     they arc over cover onto where the target probably is — skill, not wallhack. A static (hex)
//     target has no such concept: it never moves, so it's always exactly where it is.
//   • The reticle SLIDES rather than snaps: `stepReticlePosition` eases the drawn position toward
//     the live aim point each frame. This is purely cosmetic — it never affects what the weapon
//     actually fires at (that follows the live target immediately, per above); it only keeps the
//     old system's legibility/weight without reintroducing a waiting mechanic.

// ── Prediction / blind-fire ─────────────────────────────────────────────────────────────────
// A blind lob aims at last-known + dead-reckoned position. Three clamps keep that plausible so
// it lands near the target instead of on empty ground far away: a horizon on how many seconds
// ahead we extrapolate, a clamp on the last-known SPEED we reckon with (a spurious huge velocity
// can't fling the aim), and a hard cap on how far the predicted point may DRIFT from last-known.
export const LOCK_PREDICT_MAX = 0.8;        // s cap on how far ahead blind fire dead-reckons the target
export const LOCK_PREDICT_MAX_SPEED = 150;  // px/s cap on the last-known velocity used (light chassis tops out ~135)
export const LOCK_PREDICT_MAX_DRIFT = 130;  // px cap on predicted-point distance from last-known (~one mech-length+)

// ── Reticle slide (#252) ────────────────────────────────────────────────────────────────────
// Exponential ("frame-rate independent") ease toward the live aim point — smooth but responsive,
// not sluggish. Higher = snappier; this value converges most of the way within a couple of
// frames at 60fps while still reading as a slide rather than an instant jump.
export const LOCK_RETICLE_LERP_RATE = 16; // 1/s

// A fresh, empty lock record. `target` mirrors this frame's live convergence pick: an opaque
// enemy handle (carries `.mech`/`.x`/`.y`/`.vx`/`.vy`), a static `{x, y}` point (e.g. a
// destructible-terrain hex, #250 — no `.mech`), or null when convergence has nothing at all.
// `blind` is true only while `target` is an ENEMY currently without LOS (a static point is
// always "seen"). `last*` are the last-known LOS'd position/velocity used to dead-reckon a blind
// shot instead of homing through the wall on the target's true live position.
export function makeLock() {
  return {
    target: null,
    blind: false,
    lastX: 0, lastY: 0,
    lastVx: 0, lastVy: 0,
  };
}

// Does this lock currently have a target at all? Replaces the old charge-gated `isFullLock` —
// there's no charge phase any more, so any live convergence pick counts immediately.
export function hasLock(lock) {
  return !!lock.target;
}

// Should a PLAYER (or enemy) trigger pull actually fire, given this weapon's delivery and the
// current lock? A genuine tracking/homing missile (guidance === 'homing' — swarmRack, streakPod)
// needs a lock to fire at all: no convergence target ⇒ the trigger does nothing, not a
// dumbfire-straight fallback. Everything else — direct-fire hitscan/lasers, dumbfire projectiles
// (clusterRocket is explicitly guidance: 'dumbfire', never tracks), and arcing-but-unguided lobs
// (plasma cannon, napalm — they fly a fixed arc off the turret facing and never needed a lock to
// begin with) — fires unconditionally on trigger, lock or no lock. Pure; used by both the fire
// gate (firing.js) and its tests.
export function canFireWeapon(weapon, lock) {
  if (weapon.delivery?.guidance !== 'homing') return true;
  return hasLock(lock);
}

// Advance the lock to mirror this frame's live convergence pick (#252 — no charge, no maintain,
// no switch-dwell: the target simply follows `target`, immediately). Inputs (all computed by the
// caller from live world/convergence state):
//   target    — this frame's live convergence pick: an enemy handle, a static `{x,y}` point, or
//               null. Handed straight through to `lock.target`.
//   hasLos    — does the holder currently have line-of-sight to `target`? Always `true` for a
//               static point (nothing to see through) — the caller is responsible for that, this
//               function just consumes the flag.
//   targetPos — `{x, y, vx, vy}` of `target` THIS frame (for the last-known refresh); null/absent
//               when `target` is null.
// A target switch (identity change, including null→something) always refreshes the last-known
// fix from `targetPos` regardless of `hasLos` — mirroring the pre-#252 behavior where a freshly
// completed lock seeded its last-known position from the live target the instant it locked, not
// only once LOS was independently confirmed. Every subsequent frame on the SAME target only
// refreshes while `hasLos` is true; otherwise the lock goes blind and `last*` stays frozen.
// Mutates and returns `lock`. Pure aside from the mutation (no time/rng/DOM).
export function stepLock(lock, { target, hasLos, targetPos }) {
  const justAcquired = target !== lock.target;
  lock.target = target;
  if (!target) { lock.blind = false; return lock; }
  if (hasLos || justAcquired) {
    lock.blind = false;
    if (targetPos) {
      lock.lastX = targetPos.x; lock.lastY = targetPos.y;
      lock.lastVx = targetPos.vx || 0; lock.lastVy = targetPos.vy || 0;
    }
  } else {
    lock.blind = true;   // last-known stays frozen from the last frame we had LOS
  }
  return lock;
}

// Where indirect (homing/arcing) fire should aim RIGHT NOW for a live lock:
//   • with LOS (or a static point) → the last-known position (refreshed live every frame it can be).
//   • blind (enemy target, no current LOS) → the last-known position dead-reckoned forward by the
//     last-known velocity.
// Three clamps keep a blind lob plausible instead of flinging it onto empty ground: the lead time
// is capped at LOCK_PREDICT_MAX seconds, the reckoned SPEED at LOCK_PREDICT_MAX_SPEED, and the
// total drift from last-known at LOCK_PREDICT_MAX_DRIFT px. `age` is seconds since LOS was last
// had (0 while visible/static). Returns { x, y }.
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

// Ease the drawn reticle position toward `target` ({x, y}) over `dt` seconds instead of snapping
// (#252) — a frame-rate-independent exponential approach (never overshoots, converges faster at
// low framerate so it doesn't lag behind on a slow frame). `pos` is the previous frame's drawn
// position, or null when there wasn't one (nothing was locked last frame) — in that case this
// SNAPS straight to `target` rather than sliding in from nowhere, so a lock acquired from
// "nothing" pops in at the right spot instead of visibly flying in from the corner of the screen.
// Pure; returns a fresh {x, y} (never mutates `pos`).
export function stepReticlePosition(pos, target, dt) {
  if (!pos) return { x: target.x, y: target.y };
  const k = 1 - Math.exp(-LOCK_RETICLE_LERP_RATE * dt);
  return { x: pos.x + (target.x - pos.x) * k, y: pos.y + (target.y - pos.y) * k };
}
