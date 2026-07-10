// Pure coalescing/throttle helpers for concentrated-fire hit feedback (#76). No Phaser here:
// the ArenaScene owns the actual Text objects, impact circles and audio triggers — these
// functions only DECIDE whether fresh feedback is warranted given recent activity. That lets
// the pathological "4 Repeaters into one heavy mech" case (many hits/frame at essentially one
// point) collapse into a bounded number of Text objects, circles and sounds, while ordinary
// fire (hits spaced out in time / space) is left completely untouched.
//
// The windows are deliberately short — a hair over one 60fps frame for bursts, ~7 frames for
// the rising damage total — so the merging only ever triggers under genuinely concentrated
// fire, never at a normal weapon's cadence.

// Damage floats on ONE enemy that land within this window merge into a single rising total,
// instead of spawning a fresh Text per hit. ~7 frames: long enough to catch a torrent, short
// enough that separate volleys still pop their own number.
export const FLOAT_COALESCE_MS = 110;

// Impact bursts at ~the same point within this window collapse to one (skip the later burst's
// circles). Just over one frame — near-simultaneous hits at a point look identical anyway.
export const IMPACT_BURST_MS = 45;

// Pixel radius that counts as "the same point" for the burst merge above.
export const IMPACT_MERGE_DIST = 20;

// Minimum gap between impact SOUNDS for a single weapon id, so a frame full of simultaneous
// hits from one weapon can't spawn dozens of oscillators/noise buffers at once. 50ms ≈ 20
// triggers/sec max per weapon — below a stream weapon's own ~18/sec cadence, so a normally-
// firing single weapon is unaffected; only overlapping/concentrated same-weapon fire collapses.
export const SOUND_THROTTLE_MS = 50;

// Time-keyed rate limiter. `last` is a plain object mapping id -> last-accepted timestamp.
// Returns true and records `now` when `now` is at least `minGapMs` past the last accepted time
// for `id` (or the id has never been seen); returns false — leaving `last` untouched — when the
// call is still inside the gap. Keyed so distinct ids throttle independently.
export function allowByKey(last, id, now, minGapMs) {
  const prev = last[id];
  if (prev !== undefined && now - prev < minGapMs) return false;
  last[id] = now;
  return true;
}

// Should a fresh damage number MERGE into an enemy's active float rather than spawn a new Text?
// True when there is a live float whose most recent hit was within `windowMs` of `now`. `active`
// is the per-enemy float record ({ lastHit, ... }) or a falsy value when none is live.
export function shouldMergeFloat(active, now, windowMs = FLOAT_COALESCE_MS) {
  return !!active && (now - active.lastHit) < windowMs;
}

// Should an impact burst be SKIPPED because an essentially-identical one just happened at the
// same spot (within `dist` px and `ms` ms)? `last` is the previous burst's { x, y, t } or null.
// Distance uses squared comparison to avoid a sqrt on the hot path.
export function skipImpactBurst(last, x, y, now, dist = IMPACT_MERGE_DIST, ms = IMPACT_BURST_MS) {
  if (!last || now - last.t >= ms) return false;
  const dx = x - last.x, dy = y - last.y;
  return dx * dx + dy * dy <= dist * dist;
}
