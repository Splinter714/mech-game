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
// "don't move it this frame" (out of range, already on top of the target, or walled off).
//
// #378 / #336: the pull MUST respect walls. #336 exists specifically because the drop-placement
// search was hopping drops across base walls; a magnet that ignored geometry would drag them
// straight back through and undo it. `canReach(drop, x, y)` is the caller's swept collision test
// (the scene passes `_blockedAlongSegment`, the same one locomotion, the #348 leash clamp and
// #361's ground separation use). It is tested against the PLAYER's position, not against the
// one-frame step: if the drop cannot reach the player without crossing a wall it simply does not
// drift at all, rather than creeping up to the wall and pooling against it. (A blocked full
// segment implies a blocked step along it, so the single test covers both.)
export function magnetPull(drop, target, delta, tuning, opts = {}) {
  if (!drop || !target || !tuning || !(delta > 0)) return null;
  const { canReach = null } = opts;
  const dx = target.x - drop.x, dy = target.y - drop.y;
  const dist = Math.hypot(dx, dy);
  if (!(dist > 0) || dist > tuning.radius) return null;
  if (canReach && !canReach(drop, target.x, target.y)) return null;
  const closeness = 1 - dist / tuning.radius;   // 0 at the outer edge, →1 near the player
  const speed = tuning.minSpeed + (tuning.maxSpeed - tuning.minSpeed) * closeness;
  const step = Math.min(dist, speed * delta);
  return { x: drop.x + (dx / dist) * step, y: drop.y + (dy / dist) * step };
}
