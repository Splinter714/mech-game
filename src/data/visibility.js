// #306: the player's FIELD OF VIEW over the hex grid — "which hexes can I actually see from
// where I'm standing?" — as pure, testable geometry. This is categorically different from the
// LOS the rest of the game already had: `_wallDistanceLos` (arena/world.js) and
// `shotBlockedAt`/`coverBlocksForRay` (terrain.js) answer "is THIS one ray clear?" for a single
// shot. A visual dimming overlay needs the answer for EVERY hex in view, continuously, so it
// needs a whole-set computation with a recompute strategy, not N independent raycasts.
//
// ── Why hex-space line casting and not shadowcasting ──
// Recursive shadowcasting is the textbook roguelike answer, but it's defined over SQUARE grids
// (octants with clean slope arithmetic); the hex analogue is fiddly, hard to unit-test, and its
// win only matters at radii far larger than a camera viewport. What actually has to fit the
// frame budget here is the RECOMPUTE CADENCE, not the per-pass constant: visibility only changes
// when the viewer moves to a different hex or terrain collapses, which in practice is a few
// times per SECOND, not 60. So this uses the straightforward, obviously-correct algorithm — walk
// a hex line from the viewer to each hex in the disc — and pays for correctness with a cost that
// is O(R^3)-ish but tiny in absolute terms (radius 14 ≈ 600 hexes × ≈8 steps ≈ 5k integer ops,
// measured well under a tenth of a millisecond) and amortised over many frames. Measured against
// scripts/profile-fight.mjs before/after; see the issue for the numbers.
//
// Consistency matters more than cleverness here: this reuses `coverBlocksForRay` — the SAME
// shared decision `shotBlockedAt` / `_isWallForRound` / `_wallDistanceLos` use — so what you can
// SEE and what you can SHOOT THROUGH can never drift apart. In particular the endpoint own-hex
// exemption (#72: soft cover never hides its own occupant) is honoured identically: the viewer's
// hex and the queried hex are both exempt, so standing in scrub doesn't blind you and a unit
// hiding in scrub is still seen when nothing else intervenes.
import { axialKey, cubeRound, distance, range } from './hexgrid.js';
import { coverBlocksForRay } from './terrain.js';

// A blocking hex is itself VISIBLE — you can see the wall that's blocking you, you just can't
// see past it. Anything else looks broken (buildings would dim themselves out).
//
// `terrainAt(q, r)` returns the terrain id at a hex (or undefined off-map). Off-map hexes are
// treated as non-blocking by `coverBlocksForRay`, which is what we want: the arena disc's outside
// shouldn't cast shadows inward.
//
// Returns a Set of axial keys — every hex within `radius` of `center` the viewer can see,
// always including the viewer's own hex.
export function computeVisibleHexes(center, radius, terrainAt) {
  const disc = range(center, radius);
  const visible = new Set();
  // Fast path, and it is the COMMON path: if nothing in the disc blocks a ray at all, every hex
  // is visible and there is no point walking ~600 sight lines to prove it. Open ground, and any
  // ground whose only cover is soft (forest/scrub, which a mech sees over), lands here — which in
  // this game is most of the map most of the time. One flat pass of cheap lookups replaces the
  // whole O(R^3) walk, and the caller skips its overlay redraw too since nothing is dimmed.
  let anyBlocker = false;
  for (const h of disc) {
    if (coverBlocksForRay(terrainAt(h.q, h.r), false)) { anyBlocker = true; break; }
  }
  if (!anyBlocker) {
    for (const h of disc) visible.add(axialKey(h.q, h.r));
    return visible;
  }
  visible.add(axialKey(center.q, center.r));
  for (const h of disc) {
    const k = axialKey(h.q, h.r);
    if (visible.has(k)) continue;
    if (hexLineClear(center, h, terrainAt)) visible.add(k);
  }
  return visible;
}

// Is the hex line from `a` to `b` unobstructed? Both ENDPOINTS are exempt from soft cover
// (#72's own-hex rule, mirrored from `_wallDistanceLos`); every hex strictly between them is
// tested with `coverBlocksForRay`, so solid cover always blocks and soft cover blocks unless it
// IS an endpoint. Exported for direct unit testing.
export function hexLineClear(a, b, terrainAt) {
  const n = distance(a, b);
  if (n <= 1) return true;   // adjacent or same hex: nothing can be strictly between them
  // Standard cube-lerp line walk (redblobgames), the same interpolation `hexesAlongSegment`
  // performs in pixel space — done here directly in hex space because both endpoints are already
  // integer hexes, so there's no pixel round-trip to lose precision to.
  const EPS = 1e-6;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const h = cubeRound(a.q + (b.q - a.q) * t + EPS, a.r + (b.r - a.r) * t + EPS);
    if (coverBlocksForRay(terrainAt(h.q, h.r), false)) return false;
  }
  return true;
}

// #306 (confirmed with Jackson): TARGETING RESPECTS LOS — the convergence/lock system must not
// acquire an enemy the player has no sight of, so breaking a sightline genuinely protects a unit.
//
// FLYING enemies are always targetable regardless of the visible set: they're in the air, above
// whatever blocks ground-level sight. That's the same exception #245/#257 already make for
// flyers and cover when FIRING, and it's what makes the rendering rule (flyers draw above the
// dimming overlay) and the targeting rule agree — a helicopter you can plainly see is a
// helicopter you can lock.
//
// Pure so the rule is unit-testable without a scene: `hexKeyOf` maps the enemy's world position
// to its axial key, `visible` is the computed set.
export function enemyTargetable(enemy, visible, hexKeyOf) {
  if (!visible) return true;          // no FOV computed yet ⇒ don't silently disable targeting
  if (enemy.flying) return true;
  return visible.has(hexKeyOf(enemy.x, enemy.y));
}
