// Indirect-fire target lock (#62, feel pass #77, rework #252, live-through-cover follow-up #252)
// — the pure, engine-agnostic core of the targeting used by BOTH the player and enemy
// indirect-fire mechs. Kept here (no Phaser) so the reticle-slide easing can be unit-tested; the
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
//   • Playtest follow-up (#252): an earlier pass added a "blind fire" state — when convergence's
//     live pick had no LOS (a real enemy behind a wall), indirect rounds aimed at a dead-reckoned
//     last-known-position-plus-velocity guess instead of the truth, and the reticle drew violet
//     to flag it. Jackson's call: drop that entirely. Indirect fire (homing/lob) never had an LOS
//     requirement on ITS OWN already-picked target to begin with — this mirrors #245 (a flying
//     enemy's own shots ignore terrain cover) and #257 (the player's shots ignore cover when
//     aimed at a flying enemy), both elsewhere in this same scene. So the lock always tracks the
//     LIVE target position, always drawn "locked," and a homing round's own steering
//     (projectiles.js) already has no wall gate at all — arcing rounds (every indirect weapon in
//     the catalog is `path: 'arcing'`) never detonate on terrain cover in the first place
//     (`!p.arc` guards that check), so there's nothing left to bypass there either. There is no
//     more prediction math, no more `lock.blind`, no more last-known bookkeeping: `stepLock` just
//     mirrors `target`.
//   • The reticle SLIDES rather than snaps: `stepReticlePosition` eases the drawn position toward
//     the live aim point each frame. This is purely cosmetic — it never affects what the weapon
//     actually fires at (that follows the live target immediately, per above); it only keeps the
//     old system's legibility/weight without reintroducing a waiting mechanic.

// ── Reticle slide (#252) ────────────────────────────────────────────────────────────────────
// Exponential ("frame-rate independent") ease toward the live aim point — smooth but responsive,
// not sluggish. Higher = snappier; this value converges most of the way within a couple of
// frames at 60fps while still reading as a slide rather than an instant jump.
export const LOCK_RETICLE_LERP_RATE = 16; // 1/s

// A fresh, empty lock record. `target` mirrors this frame's live convergence pick: an opaque
// enemy handle (carries `.mech`/`.x`/`.y`/`.vx`/`.vy`), a static `{x, y}` point (e.g. a
// destructible-terrain hex, #250 — no `.mech`), or null when convergence has nothing at all.
export function makeLock() {
  return {
    target: null,
  };
}

// Does this lock currently have a target at all? Replaces the old charge-gated `isFullLock` —
// there's no charge phase any more, so any live convergence pick counts immediately.
export function hasLock(lock) {
  return !!lock.target;
}

// Should a PLAYER (or enemy) trigger pull actually fire, given this weapon's delivery and the
// current lock? A genuine tracking/homing missile (guidance === 'homing', swarmRack, streakPod)
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
// no switch-dwell, and, per the playtest follow-up above, no blind/dead-reckoning state either):
// the target simply follows `target`, immediately, always live. Mutates and returns `lock`. Pure
// (no time/rng/DOM).
export function stepLock(lock, { target }) {
  lock.target = target;
  return lock;
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
