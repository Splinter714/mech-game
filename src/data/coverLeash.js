// #72 AI reposition leash — pure timing/identity logic for "an enemy can't camp one cover
// spot forever". The arena AI (scenes/arena/enemies.js) tracks, per enemy, WHICH cover spot
// it's committed to and SINCE when; once the leash expires the cover search must exclude
// that spot, forcing a fresh position (or an advance if no other cover is reachable).
// Kept Phaser-free so the timing/identity rules are unit-testable (coverLeash.test.js).

// How long (ms) an enemy may stay committed to one cover spot before it must move on.
// Owner: tunable (spec: ~4–6s).
export const COVER_LEASH_MS = 5000;

// Two cover points closer than this (px) count as the SAME spot — re-picking a point a few
// pixels away doesn't reset the leash, and the post-leash search must find a spot at least
// this far from the stale one.
export const COVER_SPOT_RADIUS = 60;

// Fold this decision's cover spot into the tracked one. Returns the track to keep:
//   - no spot            → null (not camping; leash cleared)
//   - same spot as prev  → prev unchanged (the `since` stamp keeps aging)
//   - a new spot         → a fresh track stamped `since: now`
export function trackCoverSpot(prev, spot, now, radius = COVER_SPOT_RADIUS) {
  if (!spot) return null;
  if (prev && Math.hypot(spot.x - prev.x, spot.y - prev.y) <= radius) return prev;
  return { x: spot.x, y: spot.y, since: now };
}

// Has this enemy been parked at its tracked cover spot long enough that it must reposition?
export function coverLeashExpired(track, now, ms = COVER_LEASH_MS) {
  return !!track && now - track.since >= ms;
}
