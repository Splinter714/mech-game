// Where a kill's pickup actually lands.
//
// A drop is not placed at the raw kill point: #88 scatters it a little so simultaneous drops
// don't stack on one pixel, and #73 snaps it to ground the player can actually walk to. This is
// the pure geometry of that placement, injected with the callers' world predicates so it
// unit-tests without Phaser or a terrain generator.
//
// #336 additionally constrained a drop to the same SIDE of a base wall as the thing that died,
// because a drop across a wall was one the player couldn't collect. **That rule was removed on
// 2026-07-20** (see #336's reversal): #378 gives both collectible kinds a magnetic pickup that
// pulls THROUGH walls, so which side of a wall a drop landed on stopped mattering — it drifts to
// the player either way. What's left is #73's original and still-valid job: a drop is relocated
// only if where it landed is genuinely unreachable GROUND (deep water, impassable terrain,
// off-map), and otherwise stays exactly where the enemy died.
//
// Worth recording, because it's the satisfying part: #336's same-side search is precisely what
// caused #345's freeze. A kill landing ON a wall span put the reference point inside the wall, so
// almost nothing read as same-side, and the ring search burned its whole budget running a
// geometric wall-separation test per candidate — 1.7M of them, 549 seconds for one drop. #345
// bounded the search, which fixed the hang; this removes the expensive predicate outright.
import { pixelToHex, hexToPixel, nearestHex, HEX_SIZE } from './hexgrid.js';

// Scatter radius shared by powerups (arena/powerups.js) and salvage (arena/salvage.js).
// #88 wanted only enough jitter that two drops from one kill don't sit on the same pixel; the
// original 30px was most of a 48px hex wide, so a drop could be flung most of a hex from the kill
// that earned it. #336 tamed it to 12px, which still separates two drops visibly at their 26px
// pickup radius. KEPT through the same-side reversal — it fixed a real problem that had nothing
// to do with walls.
export const DROP_SCATTER_RADIUS = 12;

// #345 (freeze): how far the placement search may ever wander, in rings. This is deliberately a
// FIXED LOCAL NEIGHBOURHOOD and not derived from the world's size.
//
// The callers used to pass `worldRadius * 2 + BOUNDARY_RING_WIDTH + 15` — a budget inherited from
// `nearestValidHex` — and #340's 24,000px corridor pushed that to 752 rings (~1.7M hexes),
// measured at 549 SECONDS for one drop placement. That is the hang Jackson hit fighting beside a
// base.
//
// KEPT deliberately even though the expensive per-candidate wall test that made the walk so slow
// is now gone: the bound guards the bug CLASS — a search budget scaled off world size — not just
// the one instance of it. 6 rings is ~290px, capping the worst case at ~127 hexes; beyond that
// there is nothing useful to find anyway, since a pickup 300px from the kill is already at the
// edge of reading as "that's my reward".
export const DROP_SEARCH_RINGS = 6;

// Resolve a drop's final resting place.
//
//   x, y      the (already scattered) ideal drop point
//   blocked   (x, y) => bool — the scene's pixel-space "can't stand here" test, or null
//   passable  (q, r) => bool — is this hex walkable ground
//
// Returns { x, y, fallback } — `fallback` true only in the corner case below.
export function resolveDropPos(x, y, {
  blocked = null, passable = () => true, maxSteps = DROP_SEARCH_RINGS, size = HEX_SIZE,
} = {}) {
  // Already fine where it landed — which, with the side rule gone, is the overwhelmingly common
  // case: a drop stays where the enemy died unless that spot is genuinely unwalkable.
  if (blocked && !blocked(x, y)) return { x, y, fallback: false };
  const start = pixelToHex(x, y, size);
  // The #73 outward ring search: expand ring by ring from the drop point and take the first
  // walkable tile.
  const hex = nearestHex(start, (q, r) => passable(q, r), maxSteps);
  if (hex) return { ...hexToPixel(hex.q, hex.r, size), fallback: false };
  // Nothing walkable within the bounded search (something died wedged in a sealed pocket).
  // Leave the drop exactly where it landed rather than silently losing a reward the player
  // earned — a pickup clipping bad ground beats a drop that vanishes, and the magnet (#378) can
  // pull it out to the player regardless.
  return { x, y, fallback: true };
}
