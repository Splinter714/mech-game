// Target lock & reticle (#62, feel pass #77, rework #252, unification #341) — the pure,
// engine-agnostic remnant of the targeting used by BOTH the player and enemy indirect-fire mechs.
// Kept here (no Phaser) so the reticle-slide easing can be unit-tested; the ArenaScene mixins wrap
// this with the actual convergence/enemy queries + drawing.
//
// #341 — there is only ONE target concept now. #252 had already collapsed the BEHAVIOUR (no
// amber→red charge-up, no independent maintain timer, no deliberate-switch dwell, no LOS rule of
// its own, no dead-reckoned "blind fire" state), leaving a `lock` record whose `target` field was
// re-assigned from the convergence pick every single frame — two names for one thing. That record
// and its `makeLock`/`stepLock`/`hasLock` helpers are gone. The target IS the convergence pick:
//   • Player: `this.convergeTarget` (targeting.js `_updateLock`, via shared.js `pickConvergeTarget`,
//     #322) — the nearest candidate inside a ~20° cone of the aim direction: a visible enemy
//     (#306/#337: targeting respects sight, flyers exempt), a destructible-terrain hex (#250), a
//     base wall span, or null.
//   • Enemy: `e.lockTarget` (enemies.js `_updateEnemyLock`) — trivially the player whenever in
//     range, else null.
// A target is therefore an opaque enemy/player handle (carries `.mech`/`.x`/`.y`/`.vx`/`.vy`), a
// static `{x, y}` point (no `.mech`), or null.
//
// What survives here is the presentational half plus the one shared firing rule:
//   • The reticle SLIDES rather than snaps: `stepReticlePosition` eases the DRAWN position toward
//     the live aim point each frame. Purely cosmetic — it never affects what a weapon actually
//     fires at (that follows the live target immediately); it only keeps the old system's
//     legibility/weight without reintroducing a waiting mechanic.
//   • `canFireWeapon` — the no-target-no-fire gate for genuine tracking missiles.

// ── Reticle slide (#252) ────────────────────────────────────────────────────────────────────
// Exponential ("frame-rate independent") ease toward the live aim point — smooth but responsive,
// not sluggish. Higher = snappier; this value converges most of the way within a couple of
// frames at 60fps while still reading as a slide rather than an instant jump.
export const LOCK_RETICLE_LERP_RATE = 16; // 1/s

// Should a PLAYER (or enemy) trigger pull actually fire, given this weapon's delivery and the
// current target (the convergence pick — see the file header; there is no separate lock object
// any more, #341)? A genuine tracking/homing missile (guidance === 'homing', swarmRack, streakPod)
// needs a target to fire at all: no convergence target ⇒ the trigger does nothing, not a
// dumbfire-straight fallback. Everything else — direct-fire hitscan/lasers, dumbfire projectiles
// (clusterRocket is explicitly guidance: 'dumbfire', never tracks), and arcing-but-unguided lobs
// (plasma cannon, napalm — they fly a fixed arc off the turret facing and never needed a target to
// begin with) — fires unconditionally on trigger, target or no target. Pure; used by both the fire
// gate (firing.js) and its tests. `target` may be an enemy handle, a static point, or null.
export function canFireWeapon(weapon, target) {
  if (weapon.delivery?.guidance !== 'homing') return true;
  return !!target;
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
