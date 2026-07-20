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
export function clampToLeash(players, focus, radius = LEASH_RADIUS) {
  if (!focus || !(players?.length > 1)) return 0;
  let clamped = 0;
  for (const p of players) {
    const dx = p.x - focus.x, dy = p.y - focus.y;
    const d = Math.hypot(dx, dy);
    if (!(d > radius)) continue;
    const ux = dx / d, uy = dy / d;
    p.x = focus.x + ux * radius;
    p.y = focus.y + uy * radius;
    // Strip only the outward radial component; inward motion and sliding are untouched.
    const radial = (p.vx ?? 0) * ux + (p.vy ?? 0) * uy;
    if (radial > 0) { p.vx -= radial * ux; p.vy -= radial * uy; }
    clamped += 1;
  }
  return clamped;
}
