// GROUND-UNIT mutual collision as SOFT SEPARATION (#361).
//
// WHY THIS EXISTS
// ---------------
// Playtest 2026-07-19, Jackson: "just saw a bunch of tanks get piled up at a base gate and
// couldn't get out." Ground-unit-vs-ground-unit collision used to be a HARD BLOCK: enemies.js
// asked `_blockedByOtherGroundUnit` before committing a step and rejected any candidate move
// whose destination overlapped another unit's circle. That rule is correct against a STATIC
// obstacle and deadlocks against a second thing that is also trying to move — each unit rejects
// every candidate because the other one is standing in it, and neither yields. A gate mouth is
// the narrowest place a garrison tries to pass at once (#332's sortie), so it is where the
// deadlock surfaced first; more doors (#354) reduce the pressure but cannot fix a deadlock.
//
// The project has been here twice already, and both times the answer was the same shape:
//   • #282 — `_blockedByOtherFlyer` was a hard flyer-vs-flyer block, it gridlocked drone piles
//     ("piles of drones are stuck on each other"), and it was DELETED for soft boids separation.
//   • #348 — the agent adding player-vs-player collision refused to reuse the hard-block rule,
//     naming this exact gate-mouth scenario, and wrote `playerCollision.js` (symmetric push
//     apart, closing velocity stripped, push clipped through the wall check) instead.
//
// So this module is `playerCollision.js`'s rule generalized to a heterogeneous crowd. It is
// deadlock-free for the same reason that one is: separation only ever ADDS an outward
// displacement and only ever REMOVES the approaching component of velocity. A unit's own
// forward and tangential motion is never touched, so no arrangement of bodies can produce a
// state where a unit is unable to move.
//
// WHAT IS DIFFERENT FROM THE PLAYER RULE
// --------------------------------------
// 1. Per-unit radii. Contact is at `ra + rb`, not a shared `2 * radius`, because a tank
//    (~11px) and a mech (28px) are wildly different footprints.
// 2. Mass, replacing #282's size-tier rule. The old hard block said "a small obstacle only
//    blocks other small units" so tanks never froze mechs. Soft separation expresses the same
//    intent better: the push is split by mass, so a tank shoved against a mech takes almost
//    all of the displacement and the mech barely notices — but it does notice, which is what
//    keeps a mech from parking permanently on top of a tank. An IMMOBILE unit (a turret,
//    `mass: Infinity`) takes none of it at all and behaves exactly like the wall it is.
// 3. Pathing. #312's router is untouched: separation perturbs POSITION only, it never edits a
//    goal or a waypoint, and it never invalidates a route. A unit nudged a few pixels sideways
//    is still walking the same waypoint list, so the router has nothing to thrash about. (The
//    old hard block did the opposite — it zeroed velocity and expired `decideAt` to force a
//    replan, which is a crowd of units all replanning into the same jammed doorway.)

// Mass tiers. Only the RATIO matters — these are how much of a shared push each body absorbs.
export const MASS_SMALL = 1;      // tank, infantry
export const MASS_LARGE = 4;      // mech, carrier
export const MASS_IMMOBILE = Infinity;   // turret / emplaced: an obstacle, never displaced

// Resolve every overlapping pair of ground units by pushing them apart.
//
// `units`   — live, non-flying ground units. Mutated in place, like every other per-frame
//             movement step in the arena. Flyers must be filtered out by the caller: they have
//             their own separation (`flyerSeparation`) and do not share a plane with these.
// `radiusOf(u)`  — the unit's own body radius (scene: `groundEnemyRadius`).
// `massOf(u)`    — one of the tiers above (scene: immobile ⇒ Infinity, small ⇒ 1, else 4).
// `canMove(u, x, y)` — optional. Asked before a push is committed, at the unit's own wall
//             radius, so separation can never shove a body through a gate's wall plates (#320
//             made wall collision body-radius-based precisely to stop bodies ending up inside
//             walls). A blocked push is skipped for that unit; its partner still takes its own
//             share, so the pair still separates, just asymmetrically — which is exactly right
//             when one of them is backed against a wall.
//
// Returns the number of overlapping pairs resolved, which is all a caller or test needs.
export function separateGroundUnits(units, { radiusOf, massOf, canMove = null } = {}) {
  const list = units ?? [];
  if (list.length < 2) return 0;
  let pairs = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i], ra = radiusOf(a), ma = massOf(a);
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j], rb = radiusOf(b), mb = massOf(b);
      const minDist = ra + rb;
      let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d >= minDist) continue;
      if (!isFinite(ma) && !isFinite(mb)) continue;   // two turrets overlapping: neither can move
      pairs += 1;
      const overlap = minDist - d;
      if (d === 0) {
        // Exactly co-located (two units spawned on the same point, a carrier drop landing on a
        // garrison unit). Any axis works as long as it is DETERMINISTIC — random jitter would
        // make the same frame resolve differently per machine and is untestable. Split along x,
        // ordered by list index, so a pile always fans out the same way.
        dx = 1; dy = 0; d = 1;
      }
      const ux = dx / d, uy = dy / d;
      // Split the overlap by mass: the LIGHTER body moves more. An infinite-mass partner takes
      // none and gives all of it to the other.
      const shareA = !isFinite(ma) ? 0 : !isFinite(mb) ? 1 : mb / (ma + mb);
      moveBy(a, -ux * overlap * shareA, -uy * overlap * shareA, canMove);
      moveBy(b, ux * overlap * (1 - shareA), uy * overlap * (1 - shareA), canMove);
      // Kill the CLOSING part of the relative velocity, split by the same mass shares, so a unit
      // driving into another comes to rest against it instead of grinding through. Only the
      // approaching component goes — both keep everything else, so either can immediately drive
      // away in any other direction. This is the whole anti-deadlock guarantee.
      const rel = ((b.vx ?? 0) - (a.vx ?? 0)) * ux + ((b.vy ?? 0) - (a.vy ?? 0)) * uy;
      if (rel < 0) {
        if (a.vx != null) { a.vx += rel * shareA * ux; a.vy += rel * shareA * uy; }
        if (b.vx != null) { b.vx -= rel * (1 - shareA) * ux; b.vy -= rel * (1 - shareA) * uy; }
      }
    }
  }
  return pairs;
}

// Commit a push, clipped against the world. Tries the whole displacement, then each axis alone
// (the same slide-along-the-blocked-axis fallback the units' own locomotion uses), then gives up
// rather than teleporting anyone into geometry.
function moveBy(u, dx, dy, canMove) {
  if (dx === 0 && dy === 0) return;
  const nx = u.x + dx, ny = u.y + dy;
  if (!canMove) { u.x = nx; u.y = ny; return; }
  if (canMove(u, nx, ny)) { u.x = nx; u.y = ny; return; }
  if (canMove(u, nx, u.y)) { u.x = nx; return; }
  if (canMove(u, u.x, ny)) { u.y = ny; }
}
