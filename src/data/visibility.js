// ⚠ #337 SUPERSEDED MOST OF THIS FILE. The region fog (data/fogRegions.js) replaced the per-hex
// LOS model wholesale: `computeVisibleHexes`/`hexLineClear` are no longer wired to anything in the
// running game — the lit set now comes from which REGION the player is in, and the shadow-polygon
// renderer they shared a header with (data/shadowPolygon.js) is deleted. They are kept, tested, as
// the general "what can be seen from this hex" utility, and because #337's breach reveal is the
// same idea at a different cadence. What IS still live is `enemyTargetable` below, as the fallback
// path when a scene has no fog (`_enemyVisible` is the real gate — arena/visibility.js).
//
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
// `opts.segmentBlocked(x0, y0, x1, y1)` (optional) is the PIXEL-SPACE blocker test, for blockers
// that aren't tiles at all. #288 made base walls hex-EDGE geometry rather than terrain hexes, so a
// terrain-only pass would look straight through a base wall — they have to be consulted as line
// segments, exactly as `_wallDistance`/`_wallEdgeDistance` already do for shots. Pass null (the
// default) when the map has no standing walls, which also re-enables the open-ground fast path.
// `opts.hexCenter(q, r)` maps a hex to its pixel centre; required whenever `segmentBlocked` is set.
export function computeVisibleHexes(center, radius, terrainAt, opts = {}) {
  const { segmentBlocked = null, hexCenter = null } = opts;
  const disc = range(center, radius);
  const visible = new Set();
  // Fast path, and it is the COMMON path: if nothing in the disc blocks a ray at all, every hex
  // is visible and there is no point walking ~600 sight lines to prove it. Open ground, and any
  // ground whose only cover is soft (forest/scrub, which a mech sees over), lands here — which in
  // this game is most of the map most of the time. One flat pass of cheap lookups replaces the
  // whole O(R^3) walk, and the caller skips its overlay redraw too since nothing is dimmed.
  let anyBlocker = !!segmentBlocked;   // standing walls ⇒ the fast path is never valid
  if (!anyBlocker) {
    for (const h of disc) {
      if (coverBlocksForRay(terrainAt(h.q, h.r), false)) { anyBlocker = true; break; }
    }
  }
  if (!anyBlocker) {
    for (const h of disc) visible.add(axialKey(h.q, h.r));
    return visible;
  }
  visible.add(axialKey(center.q, center.r));
  const c = segmentBlocked ? hexCenter(center.q, center.r) : null;
  for (const h of disc) {
    const k = axialKey(h.q, h.r);
    if (visible.has(k)) continue;
    if (!hexLineClear(center, h, terrainAt)) continue;
    // Walls are a line, not a tile, so they're tested against the actual pixel sight line rather
    // than the hexes it passes through — the same exact-crossing test shots use, for the same
    // reason (a hex-stepped scan can slip past a 14px-thick span it genuinely crosses).
    if (segmentBlocked) {
      const p = hexCenter(h.q, h.r);
      if (segmentBlocked(c.x, c.y, p.x, p.y)) continue;
    }
    visible.add(k);
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
// #316 REVERSES the flyer exception this function used to carry. It read:
//
//     if (enemy.flying) return true;   // always targetable, they're above ground-level sight
//
// which made flyers lockable through anything, matching #245/#257's firing exemptions and #306's
// "flyers draw above the dimming overlay" rendering rule. Jackson found the resulting rules
// confusing in play — "let's stop being able to shoot them beyond cover also; let's let cover be
// actual cover" — so all three went away together.
//
// #338 PUTS THE FLYER EXCEPTION BACK, as the first line of the function, but sourced from the
// shared `targetCoverExempt` below rather than written inline here. That distinction is the entire
// issue: #316 removed this line and firing.js's `ignoreCover` together, but the fog rule
// (`enemyVisibleInFog`, data/fogRegions.js) went on exempting airborne enemies — so the LIVE
// targeting path said yes to a helicopter over a base wall while the shot said no. Routing both
// through one function makes that disagreement unwriteable.
//
// Soft cover is not special-cased here either, and doesn't need to be: `computeVisibleHexes`
// builds `visible` from `coverBlocksForRay`, which already lets a LARGE unit see over soft cover —
// so a flyer over forest stays in the visible set and stays lockable, exactly like a ground mech.
//
// Pure so the rule is unit-testable without a scene: `hexKeyOf` maps the enemy's world position
// to its axial key, `visible` is the computed set.
export function enemyTargetable(enemy, visible, hexKeyOf) {
  if (targetCoverExempt(enemy)) return true;   // #338 — the shared rule; see below
  if (!visible) return true;          // no FOV computed yet ⇒ don't silently disable targeting
  return visible.has(hexKeyOf(enemy.x, enemy.y));
}

// ── #338: THE ONE PREDICATE ──────────────────────────────────────────────────────────────
// Jackson's invariant: "you should only be able to lock what you could actually hit." The flyer
// bug existed because target ELIGIBILITY and the SHOT were derived independently — targeting
// exempted airborne enemies from the sight gate by rule (here, and `enemyVisibleInFog` rule 1 in
// fogRegions.js), while firing exempted nobody by geometry (#316 deleted firing.js's
// `ignoreCover`). Two rules in two files, disagreeing by construction: lock says yes, shot says no.
//
// This is that rule, written once. Both sides now call it, so flyers are exempt on BOTH or
// NEITHER and the disagreement is not expressible. Its consumers:
//   • target eligibility — `enemyTargetable` above (the no-fog fallback) and `enemyVisibleInFog`
//     (data/fogRegions.js), which together decide what `_updateLock` may acquire.
//   • the shot — `_shotIgnoresCover` (scenes/arena/firing.js), gating the hitscan wall trace and
//     the `ignoresCover` stamp an in-flight round carries.
//
// It is deliberately NOT "shots ignore geometry". Ground targets are gated in both places exactly
// as before: a tank behind a boulder still takes no hits through it. Only AIRBORNE targets are
// exempt, which is what Jackson chose ("that might work better now that I'm changing locking
// behavior") — and it is a much narrower licence than it was when this was last true, because
// #322's 20°-cone/nearest-wins/1750px gate and #337's "nobody targets what they can't see" have
// since made the set of flyers you can legitimately lock small.
//
// Three places where lock and shot still legitimately disagree, and MUST keep disagreeing — they
// are the simulation being honest about geometry, not the rules contradicting each other:
//   1. The target moves after you fire (locked in the open, ducks behind a wall mid-flight). The
//      alternative is homing rounds phasing through terrain.
//   2. The muzzle is not the eye — weapons sit offset from the mech's centre (#320), so you can
//      see what your left arm cannot shoot past.
//   3. Partial cover — a mech's head over a wall is visible while a flat shot into it hits stone.
//
// `airborne !== false` mirrors `enemyVisibleInFog`: a flying kind that is currently grounded
// (landed/downed) is NOT exempt — it's a ground target while it's on the ground.
export function targetCoverExempt(target) {
  return !!(target && target.flying && target.airborne !== false);
}
