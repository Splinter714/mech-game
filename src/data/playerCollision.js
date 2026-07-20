// PLAYER-vs-PLAYER collision (#348 playtest answer: "Add player collision"). Phase 2 shipped
// players passing through each other; Jackson wants them solid to one another.
//
// WHY THIS IS A SOFT PUSH AND NOT A HARD MOVEMENT BLOCK
// ----------------------------------------------------
// Every other "solid" pair in the game is a hard block: a candidate move that would overlap the
// obstacle is simply rejected (locomotion.js `_blockedByGroundEnemy`, world.js
// `_blockedByOtherGroundUnit`). That rule is safe against a STATIC obstacle, and unsafe against
// a second thing that is also trying to move — which is exactly the failure #348 flagged in
// advance: two heavy mechs meeting in a gate mouth or a wall breach, each rejecting every move
// because the other is in it, both frozen until one backs out of a hole neither can see out of.
// The project has already been burned by precisely this shape once: #282's `_blockedByOtherFlyer`
// was a hard flyer-vs-flyer block, it gridlocked spawn piles ("piles of drones are stuck on each
// other"), and it was deleted in favour of soft boids separation in the flyer behaviours. The
// same reasoning applies with more force here, because the two bodies involved are the two
// HUMANS, and a jam they cannot steer out of is the single most infuriating thing this feature
// could do.
//
// So players are solid the way two physical bodies are solid: they never come to rest inside one
// another. Overlap is resolved by pushing the pair apart (symmetrically, half each) and by
// killing the part of their relative velocity that is closing the gap. Driving into your teammate
// shoves them; standing on them is impossible; but no configuration of two players — in a gate,
// in a breach, in a corner — can ever produce a state where neither can move, because separation
// only ever ADDS an outward displacement and only ever REMOVES the approaching component of
// velocity. A player's own inward and tangential motion is untouched, always.
//
// THE LEASH INTERACTION (data/leash.js), which is the real risk in this change
// ---------------------------------------------------------------------------
// The scene runs drive → separate → `clampToLeash`, in that order, so the leash always has the
// final word and its invariant ("no live player is further than LEASH_RADIUS from the centroid")
// cannot be broken by a shove. A player pinned ON the leash circle and simultaneously shoved by
// their teammate stays pinned and stays steerable: the clamp puts them back exactly on the circle
// and strips only their OUTWARD radial velocity, and separation never strips the inward or
// tangential velocity they steer with. There is no combination that zeroes a player's control.
//
// With exactly two players it is stronger than that — the two are geometrically incapable of
// being clamped and overlapping at the same time. The centroid of two players is their midpoint,
// so each sits at half their separation from it; overlapping means that separation is under
// 2 * PLAYER_COLLIDE_RADIUS (56px), i.e. each is within 28px of the centroid, and the leash only
// engages past 280px. A shove and a pin are 10x apart in scale and cannot co-occur at N=2. The
// ordering above is what keeps that true for N > 2, where the centroid is no longer the midpoint.

// The player chassis footprint. Same value as ENEMY_COLLIDE_RADIUS_MECH (scenes/arena/shared.js):
// a player is drawn at the same ARENA_MECH_SCALE as an enemy mech, and enemies already collide
// against the player at that radius (`_blockedByOtherGroundUnit`), so using it here makes the
// player-player pair exactly as solid as the player-enemy pair already is. Duplicated rather than
// imported because this module is pure data (no Phaser, no scene) and shared.js is not.
export const PLAYER_COLLIDE_RADIUS = 28;

// Resolve every overlapping pair of players by pushing them apart.
//
// `players` — live players only (the caller filters; a corpse is not a body). Mutated in place,
// like every other per-frame movement step in the arena.
// `radius` — per-player footprint; contact happens at 2 * radius.
// `canMove(player, x, y)` — optional. Asked before a push is committed, so a shove can never
// place a mech inside a wall or impassable terrain. A blocked push is simply skipped for that
// player (their partner still takes their own half, so the pair still separates — just
// asymmetrically, which is what you want when one of them is backed against a wall).
//
// Returns the number of overlapping pairs found, which is all a caller or test needs.
export function separatePlayers(players, { radius = PLAYER_COLLIDE_RADIUS, canMove = null } = {}) {
  const list = players ?? [];
  if (list.length < 2) return 0;
  const minDist = radius * 2;
  let pairs = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d >= minDist) continue;
      pairs += 1;
      // How far each of the two has to move. Computed from the REAL distance, before the
      // degenerate case below substitutes a direction — a fully co-located pair needs the whole
      // `minDist` split between them, not `minDist - 1`.
      const push = (minDist - d) / 2;
      if (d === 0) {
        // Exactly co-located (a joiner dropping onto the host, a respawn placing on top of a
        // teammate). Any axis works as long as it is DETERMINISTIC — a random jitter would make
        // the same frame resolve differently on each machine and is untestable. Split along x,
        // ordered by index, so the pair always fans out the same way.
        dx = 1; dy = 0; d = 1;
      }
      const ux = dx / d, uy = dy / d;
      moveBy(a, -ux * push, -uy * push, canMove);
      moveBy(b, ux * push, uy * push, canMove);
      // Kill the CLOSING part of the relative velocity so a mech driven into its teammate comes
      // to rest against them instead of grinding — that contact is what makes the other body read
      // as solid rather than as a slippery bubble. Only the approaching component goes; both keep
      // everything else, so either can immediately drive away in any other direction.
      const rel = ((b.vx ?? 0) - (a.vx ?? 0)) * ux + ((b.vy ?? 0) - (a.vy ?? 0)) * uy;
      if (rel < 0) {
        const half = rel / 2;
        if (a.vx != null) { a.vx += half * ux; a.vy += half * uy; }
        if (b.vx != null) { b.vx -= half * ux; b.vy -= half * uy; }
      }
    }
  }
  return pairs;
}

// Commit a push, clipped against the world. Tries the whole displacement, then each axis alone
// (the same slide-along-the-blocked-axis fallback the player's own locomotion uses), then gives
// up rather than teleporting anyone into geometry.
function moveBy(p, dx, dy, canMove) {
  const nx = p.x + dx, ny = p.y + dy;
  if (!canMove) { p.x = nx; p.y = ny; return; }
  if (canMove(p, nx, ny)) { p.x = nx; p.y = ny; return; }
  if (canMove(p, nx, p.y)) { p.x = nx; return; }
  if (canMove(p, p.x, ny)) { p.y = ny; }
}
