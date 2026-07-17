// Dash (#261) — a fixed, always-available movement ability every mech has, hardcoded to
// L3/Space. It REPLACES the old player-facing Sprint (#188): sustained hold/toggle sprint is
// gone for the player, swapped for a single-shot burst on a cooldown. Pure state machine here
// (no Phaser) so the burst/cooldown math is fully unit-tested; the arena scene (arena/firing.js's
// `_handleDash`, arena/locomotion.js's speed multiplier) just calls these.
//
// Mechanic: pressing the bind (edge-detected on BOTH devices now — a dash is inherently a
// discrete one-shot activation, not a sustained state, so there's no more per-device hold-vs-
// toggle split) fires a brief, strong burst of speed if the dash is off cooldown. The burst
// runs for a fixed short duration, then the dash goes on cooldown; pressing again mid-burst or
// mid-cooldown is simply ignored (no queueing, no re-trigger) until the cooldown clears.
//
// Note: the OLD Sprint mechanic (data/sprint.js) is NOT gone — it's kept exactly as-is because
// the Overclock powerup still force-activates it (fuel-free) for its duration. Dash and Sprint
// are now two independent movement-speed sources: Dash is the player's own hardcoded bind,
// Sprint is Overclock-only. See arena/locomotion.js `_drive` for how both multipliers combine.

// Speed multiplier during the burst. Meaningfully higher than Sprint's 1.5x (SPRINT_SPEED_MULT,
// data/sprint.js) so a dash reads as a distinct, punchier tool rather than "sprint but shorter" —
// 3.0x (bumped from 2.75x per #261 playtest feedback: the dash should go a bit further/faster)
// sits at the top of the original 2.5-3x "decisive burst, not a teleport" band.
export const DASH_SPEED_MULT = 3.0;

// Burst duration, in seconds. Short enough to read as a snap of momentum, not a sustained
// speed-up: at a medium chassis' 195px/s base speed this covers 195 * 3.0 * 0.25 ≈ 146px
// (~3 hexes, HEX_SIZE=48) in one press — a light chassis (268px/s) covers ~201px (~4.2 hexes),
// a heavy (135px/s) ~101px (~2.1 hexes) — scaling naturally with each chassis' own top speed
// exactly like Sprint's multiplier already does, so heavier mechs still dash a shorter absolute
// distance than light ones, matching their overall mobility identity. Bumped from 0.2s per #261
// playtest feedback alongside the multiplier, for a combined ~36% longer dash distance overall.
export const DASH_BURST_DURATION = 0.25;

// Cooldown, in seconds, from the moment a dash is triggered until it can be triggered again.
// Picked to read as "an occasional escape/reposition tool" — long enough that it's a deliberate
// tactical choice (can't spam it to out-run everything), short enough to matter again within a
// single engagement. 4s comfortably separates consecutive dashes while still coming back well
// within a typical firefight.
export const DASH_COOLDOWN = 4;

// A fresh dash state: inactive, no burst in progress, ready immediately (no cooldown).
export function initialDashState() {
  return { active: false, burstRemaining: 0, cooldown: 0 };
}

// True when a dash can be triggered right now: not already mid-burst, and not on cooldown.
// (In practice these two conditions never diverge — `triggerDash` always sets `cooldown` to a
// value >= `burstRemaining`, so the burst always finishes before the cooldown clears — but both
// are checked for clarity/robustness against future tuning where that might not hold.)
export function canDash(state) {
  return !state.active && state.cooldown <= 0;
}

// Resolve a press into a new state. No-ops (returns the SAME state, not a copy) if the dash
// isn't ready yet — mid-burst or still on cooldown — so a spammed press while waiting is
// silently ignored rather than queued or restarting the burst.
export function triggerDash(state, {
  cooldown = DASH_COOLDOWN, burstDuration = DASH_BURST_DURATION,
} = {}) {
  if (!canDash(state)) return state;
  return { active: true, burstRemaining: burstDuration, cooldown };
}

// Advance `{ active, burstRemaining, cooldown }` by `dt` seconds: counts the burst down while
// active (turning it off the instant it expires), and counts the cooldown down unconditionally
// (it was stamped at trigger time and includes the burst window itself). Returns a new state
// object; never mutates the input.
export function updateDash(state, dt) {
  let { active, burstRemaining, cooldown } = state;
  if (active) {
    burstRemaining = Math.max(0, burstRemaining - dt);
    if (burstRemaining <= 0) active = false;
  }
  if (cooldown > 0) cooldown = Math.max(0, cooldown - dt);
  return { active, burstRemaining, cooldown };
}
