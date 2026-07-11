// #103 — enemy awareness/aggro. An enemy starts UNAWARE (idle/loiter near its spawn point, not
// actively closing on or firing at the player) and flips to AWARE — its normal tactical AI —
// once it detects the player. Detection is deliberately simple: "in detection range AND has
// line-of-sight" OR "a noise event (the player firing) happened nearby", either trips it.
// AWARE is a ONE-WAY transition (no lose-aggro/forget system) so an alerted enemy stays alerted
// for the rest of the encounter, per the issue's "don't over-engineer a stealth system" call.
// Kept Phaser-free so the transition rule itself is unit-testable (awareness.test.js); the arena
// (scenes/arena/enemies.js) owns the per-enemy `awareness` field and calls `shouldBecomeAware`
// each frame.

export const UNAWARE = 'unaware';
export const AWARE = 'aware';

// An enemy's detection range is its own engagement range (weapon opt-derived standoff for a
// mech, or `fireRange` for a non-mech kind — the range concept each already tracks) widened a
// bit, so it notices the player a beat before it's technically in firing range rather than
// exactly at the firing-range boundary. Owner: tunable.
export const DETECTION_RANGE_MULT = 1.2;

// A gunshot within this radius (px) of an unaware enemy instantly alerts it, regardless of LOS —
// a simple "noise" aggro trigger (the player announcing themselves by firing nearby). Owner:
// tunable.
export const NOISE_AGGRO_RANGE = 260;

// How long (ms) a fire event counts as "just happened" for noise-aggro purposes — after this the
// enemy no longer treats it as a live noise cue (it isn't a memory system, just "did a shot go
// off basically this instant"). Owner: tunable.
export const NOISE_WINDOW_MS = 200;

// This enemy's detection range, from its own base engagement range.
export function detectionRangeFor(baseRange, mult = DETECTION_RANGE_MULT) {
  return (baseRange || 300) * mult;
}

// Should this enemy be (or become) AWARE this frame? One-way: an already-AWARE enemy always
// stays AWARE. Otherwise it flips the instant it's seen (within `detectRange` AND `hasLos`) or
// heard (`noiseDist` — the enemy's distance from the most recent player gunshot — is within
// `noiseRange`, or omitted/null if no shot is currently "live"). Pure: no Phaser/scene access.
export function shouldBecomeAware(state, { dist, detectRange, hasLos = true, noiseDist = null, noiseRange = NOISE_AGGRO_RANGE }) {
  if (state === AWARE) return true;
  const seen = hasLos && dist <= detectRange;
  const heard = noiseDist != null && noiseDist <= noiseRange;
  return seen || heard;
}
