// Magnetic pickup pull (#226, generalised in #378) — the ONE mechanism both world-space
// collectible kinds use to drift toward a player: SCRAP (scenes/arena/salvage.js) and
// timed-buff POWERUPS (scenes/arena/powerups.js).
//
// Jackson (#378): "add a magnetic pick-up radius for powerups also, not just scrap; use the
// scrap magnetic pickup code, but maybe make the radius slightly lower and the strength of the
// pull slightly lower as well" — so this is deliberately SHARED code with two tuning tables,
// not a second copy of the rule. Adding a magnet to a future collectible = one more table.
//
// Pure: no Phaser, no scene. The caller supplies the target point and (optionally) the
// wall-reachability predicate; this file only does the geometry.

// Scrap's tuning is exactly #226's playtested numbers, unchanged.
export const SCRAP_MAGNET = {
  radius: 240,      // px — inside this an uncollected drop starts drifting in
  minSpeed: 0.25,   // px/ms at the outer edge of the radius
  maxSpeed: 0.6,    // px/ms right on top of the player — the drift accelerates in
};

// #378 playtest dials. "Slightly lower" on both axes, taken as ~75% of scrap's: a powerup is a
// bigger, more deliberate moment than a currency trickle, so it should ask you to walk to it a
// little more than scrap does. Nothing here is load-bearing — these three numbers are the
// intended tuning surface if the pull feels too weak or too grabby in play.
export const POWERUP_MAGNET = {
  radius: 180,      // 0.75 × scrap's 240
  minSpeed: 0.18,   // ~0.72 × scrap's 0.25
  maxSpeed: 0.45,   // 0.75 × scrap's 0.6
};

// Where a drop should be after `delta` ms of magnetic pull toward `target`, or null for
// "don't move it this frame" (out of range, or already on top of the target).
//
// THE PULL DELIBERATELY IGNORES GEOMETRY — it drags a drop straight THROUGH walls. Jackson
// (#378): "magnet should pull through walls". That's an explicit game-feel call, not an
// oversight, and it's worth stating plainly because it otherwise reads as a bug: magnetic pickup
// is already unphysical, and the alternative — gating the pull on the swept `_blockedAlongSegment`
// test locomotion uses — leaves drops the player can SEE inside a compound but can never reach.
//
// This does NOT undo #336, which puts a drop on the correct SIDE of a base wall when it spawns:
// placement stays picky, only the pull is permissive. And because the drift is pure position
// assignment along the straight line to the player, with no collision test anywhere on the path,
// a drop can never lodge against the inside face of a wall and stick there just out of reach — it
// converges on the player's OWN position, which is by definition somewhere the player is, so it
// always closes all the way into pickup range.
export function magnetPull(drop, target, delta, tuning) {
  if (!drop || !target || !tuning || !(delta > 0)) return null;
  const dx = target.x - drop.x, dy = target.y - drop.y;
  const dist = Math.hypot(dx, dy);
  if (!(dist > 0) || dist > tuning.radius) return null;
  const closeness = 1 - dist / tuning.radius;   // 0 at the outer edge, →1 near the player
  const speed = tuning.minSpeed + (tuning.maxSpeed - tuning.minSpeed) * closeness;
  const step = Math.min(dist, speed * delta);
  return { x: drop.x + (dx / dist) * step, y: drop.y + (dy / dist) * step };
}
