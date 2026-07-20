// The shared-camera LEASH (#348, phase 2 of local co-op — parent #335).
//
// Co-op runs ONE camera for every player on the machine, so the players cannot be allowed to
// walk arbitrarily far apart. Jackson picked the resolution explicitly and rejected the two
// usual alternatives by name: no zoom-out as they separate, and no rubber-band pulling them
// together. It is a HARD STOP — the leading player simply cannot go further.
//
// The rule, stated once so it generalises past two players (Jackson: "2 for now, design for
// more"): the camera frames the CENTROID of the live players, and no player may be further
// than `LEASH_RADIUS` from that centroid. Two consequences fall out of that and both are
// wanted:
//   - Maximum separation between any two players is 2 * LEASH_RADIUS, because each is inside
//     the same circle. That is what has to fit on screen.
//   - It is symmetric. If both walk apart, both stop. If one stands still and the other walks
//     away, the centroid drifts halfway toward the walker, so the walker stops at
//     2 * LEASH_RADIUS from the stationary one — the stationary player is never dragged.
//
// LEASH_RADIUS is a playtest dial and deliberately the only number here. Two things bound it:
// a base's ring is ~479px across and both players may need to be inside one at once (so the
// 560px max separation has to cover that), and the shared camera at GAMEPLAY_ZOOM 1.3 shows
// roughly 600 world px of HEIGHT on a typical window — the tighter of the two screen axes. A
// 560px separation therefore still leaves both mechs on screen even when they are stacked
// vertically, which is the whole point of a hard stop: it can never strand a player off-frame.
export const LEASH_RADIUS = 280;

// Centre of the live players — the point the camera frames and the leash is measured from.
// Pure: takes anything with x/y and an `alive` predicate, so the scene's real player objects
// and a plain test fixture both work. Returns null for an empty list.
export function leashFocus(players, alive = () => true) {
  const list = (players ?? []).filter(alive);
  const pool = list.length ? list : (players ?? []);
  if (!pool.length) return null;
  let sx = 0, sy = 0;
  for (const p of pool) { sx += p.x; sy += p.y; }
  return { x: sx / pool.length, y: sy / pool.length };
}

// Enforce the hard stop. Any player further than `radius` from `focus` is placed back ON the
// leash circle (not near it — exactly on it, so a player pressed against the limit slides
// along it rather than stuttering in and out), and the OUTWARD part of their velocity is
// removed while the tangential part is kept. That tangential keep is what makes the stop feel
// like a wall rather than a freeze: you can still circle the boundary and walk back in, you
// just cannot push through it.
//
// Mutates the players in place (the arena's per-frame drive does the same) and returns how
// many were clamped, which is the only thing a caller/test needs to know afterwards.
// A single player is never clamped: they ARE the centroid, so their distance from it is 0.
// #348 (playtest 2026-07-19: "multiplayer leash can pull the other player through the boundary
// of the corridor" — and, sharpening it, "through ANY kind of blocking cover, e.g. base walls"):
// this clamp used to teleport. It runs AFTER locomotion has already resolved the frame's terrain
// and wall collision, so the position it wrote was never re-checked against anything — which
// dragged mechs through corridor boundaries, hard cover and base walls alike, silently defeating
// #320's wall body-radius collision.
//
// The fix is the pattern the player-collision push (data/playerCollision.js) already established
// and proved: an optional `canMove(player, x, y)` predicate, wired by the scene to the SAME swept
// wall/terrain test locomotion itself uses. The correction is clipped through it, so the leash can
// never place a mech somewhere it could not have driven.
//
// TERRAIN AND WALLS WIN over the leash. That is a real change in what the leash guarantees: when
// a wall blocks the correction, a player CAN remain beyond `radius`, so "no player exceeds the
// leash radius" is no longer an invariant that always holds after this call. It is a transient
// overshoot the camera framing has to tolerate — and it is the right trade, because a briefly
// over-stretched leash is a far smaller problem than a mech standing inside a wall. It also
// self-corrects: the outward velocity strip below still happens, so nothing keeps pushing out.
//
// When the full correction is blocked the player is moved as far along it as collision allows —
// found by a fixed CLIP_STEPS-step bisection. That budget is a constant and deliberately NOT
// derived from the world size (#345: a world-scaled search budget is what froze the game for
// minutes once #340 lengthened the corridor).
const CLIP_STEPS = 6;

// The furthest point along p → (tx, ty) that `canMove` still allows. Returns null if even the
// first fraction is blocked, meaning the player simply stays put this frame.
function clippedTowards(p, tx, ty, canMove) {
  if (canMove(p, tx, ty)) return { x: tx, y: ty };
  let lo = 0, hi = 1;
  for (let i = 0; i < CLIP_STEPS; i++) {
    const mid = (lo + hi) / 2;
    const mx = p.x + (tx - p.x) * mid, my = p.y + (ty - p.y) * mid;
    if (canMove(p, mx, my)) lo = mid; else hi = mid;
  }
  if (lo <= 0) return null;
  return { x: p.x + (tx - p.x) * lo, y: p.y + (ty - p.y) * lo };
}

export function clampToLeash(players, focus, radius = LEASH_RADIUS, opts = {}) {
  if (!focus || !(players?.length > 1)) return 0;
  const { canMove = null } = opts;
  let clamped = 0;
  for (const p of players) {
    const dx = p.x - focus.x, dy = p.y - focus.y;
    const d = Math.hypot(dx, dy);
    if (!(d > radius)) continue;
    const ux = dx / d, uy = dy / d;
    const tx = focus.x + ux * radius, ty = focus.y + uy * radius;
    if (!canMove) {
      p.x = tx; p.y = ty;
    } else {
      const spot = clippedTowards(p, tx, ty, canMove);
      if (spot) { p.x = spot.x; p.y = spot.y; }
    }
    // Strip only the outward radial component; inward motion and sliding are untouched. This
    // happens even when the move was clipped — the player is over the leash either way, and
    // keeping them steerable back inward is the point.
    const radial = (p.vx ?? 0) * ux + (p.vy ?? 0) * uy;
    if (radial > 0) { p.vx -= radial * ux; p.vy -= radial * uy; }
    clamped += 1;
  }
  return clamped;
}
