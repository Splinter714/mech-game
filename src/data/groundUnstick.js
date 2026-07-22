// #361 follow-up — a GENERIC anti-stall safety net for ground units, layered on top of the soft
// separation fix (`groundSeparation.js`) rather than replacing it.
//
// WHY THIS EXISTS
// ---------------
// Playtest 2026-07-21 (after the soft-separation fix had already landed, `0885b85`/`3bf6891`):
// "ground units STILL deadlock at base gates." Soft separation is mathematically deadlock-free —
// it only ever ADDS an outward push and REMOVES the approaching component of velocity, so no
// static arrangement of overlapping bodies can freeze one permanently (confirmed by re-running
// #361's own reproduction at realistic gate/target distances, scaled up to a 28-unit mob: it
// still fully clears, just slower). But it says nothing about a unit whose desired heading keeps
// re-aiming it at the exact same contested point every frame: a garrison converging on one gate
// from a near-mirror-symmetric spawn formation can settle into a standoff where nobody is
// technically blocked (every candidate move is legal) but progress through the chokepoint is
// asymptotically slow — no single body ever gets a reason to be the one that goes first. That
// reads as "stuck" to a player watching it, even when it isn't a true physics deadlock.
//
// THE FIX
// -------
// A per-unit STUCK TIMER: sample position roughly every `UNSTICK_SAMPLE_MS`; if a unit hasn't
// covered `UNSTICK_MIN_PROGRESS_PX` since the last sample, its stuck clock runs; the moment it
// does, the clock resets to zero. Once the clock exceeds `UNSTICK_GRACE_MS` (so an ordinary brief
// hold — reloading a corner, waiting a beat for a neighbour — never triggers this), the unit's
// TRAVEL heading (not its aim — see enemies.js `_updateVehicle`'s tux/tuy vs ux/uy split) is bent
// sideways by a small, ramping angle. The bend grows with how long the unit has been stuck (capped
// at `UNSTICK_MAX_BEND`) and its SIGN is the unit's own persistent `handed` flag (already assigned
// at spawn, `enemies.js`) — a stable per-unit tie-break, not a per-frame random jitter, so the same
// unit always tries the same side and two units queued back-to-back don't fight over which way to
// lean.
//
// This is deliberately generic — it does not know about gates, walls, or other units. It only
// asks "am I actually getting anywhere", which is exactly the right question for a stall regardless
// of WHAT is causing it (a symmetric crowd, an unlucky wedge against a wall corner, a genuinely
// unmodelled edge case). Pure and side-effect-free: the caller owns the mutable per-enemy state
// object and only ever replaces it wholesale.

// How often to re-sample position, in ms. Coarser than a frame on purpose — checking every tick
// would flag a unit as "stuck" during the single frame it happens to be squarely blocked by a
// neighbour mid-approach, which is normal and self-resolving. A few hundred ms is long enough to
// average that out.
export const UNSTICK_SAMPLE_MS = 400;

// How far (px) a unit must cover between samples to count as making progress. Small — this is not
// a speed check, just "did anything happen at all". A unit at any real ground speed clears this
// easily unless it is genuinely wedged.
export const UNSTICK_MIN_PROGRESS_PX = 6;

// How long a unit must show no progress before the nudge starts, in ms. Generous: several sample
// windows, so an ordinary brief hold (loading a decision, waiting a beat behind a neighbour that is
// about to move on its own) never triggers this. Owner: tunable — lower it if units still visibly
// idle at a gate before the nudge kicks in, raise it if the nudge ever fires during normal traffic.
export const UNSTICK_GRACE_MS = 1200;

// How long, once triggered, until the bend reaches its cap. A ramp rather than a step so the
// nudge reads as "trying harder to get around" rather than an abrupt swerve.
export const UNSTICK_RAMP_MS = 2000;

// The largest heading bend the nudge can apply, in radians (~51°). Big enough to reliably break a
// symmetric standoff (it meaningfully changes which side of a neighbour a unit is steering toward),
// small enough that a unit still reads as heading roughly where it means to, not spinning in place.
export const UNSTICK_MAX_BEND = 0.9;

// Advance the stuck-sample state one tick. `state` is the previous return value (or null/undefined
// on a unit's first tick — a fresh anchor is taken and nothing has had time to look stuck yet).
// `x`/`y` are the unit's CURRENT position, `dtMs` the elapsed time this tick in milliseconds.
//
// Returns a new state object; never mutates the one passed in, so callers that skip a tick (a
// dormant unit, a stand-down) simply hold the same reference with no extra bookkeeping.
export function tickUnstick(state, x, y, dtMs) {
  const s = state ?? { ms: 0, sampleMs: 0, ax: x, ay: y };
  const sampleMs = s.sampleMs + Math.max(0, dtMs);
  if (sampleMs < UNSTICK_SAMPLE_MS) {
    return { ms: s.ms, sampleMs, ax: s.ax, ay: s.ay };
  }
  const moved = Math.hypot(x - s.ax, y - s.ay);
  const ms = moved < UNSTICK_MIN_PROGRESS_PX ? s.ms + sampleMs : 0;
  return { ms, sampleMs: 0, ax: x, ay: y };
}

// How far (radians) to bend a travel heading given the current stuck duration (`ms`, from the
// state `tickUnstick` tracks) and the unit's persistent handedness (`enemies.js` `e.handed`, ±1).
// Zero while within the grace window; ramps linearly to `UNSTICK_MAX_BEND` (signed by `handedSign`)
// over `UNSTICK_RAMP_MS` beyond it, then holds at the cap for as long as the unit stays stuck.
export function unstickBend(ms, handedSign = 1) {
  if (!(ms > UNSTICK_GRACE_MS)) return 0;
  const frac = Math.min(1, (ms - UNSTICK_GRACE_MS) / UNSTICK_RAMP_MS);
  return frac * UNSTICK_MAX_BEND * (handedSign < 0 ? -1 : 1);
}

// Rotate a unit travel-heading vector by `bend` radians. Pure 2D rotation, split out only so the
// call site (enemies.js) and the tests share one implementation.
export function bendHeading(tux, tuy, bend) {
  if (!bend) return { tux, tuy };
  const c = Math.cos(bend), s = Math.sin(bend);
  return { tux: tux * c - tuy * s, tuy: tux * s + tuy * c };
}
