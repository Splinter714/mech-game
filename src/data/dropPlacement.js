// #336: where a kill's pickup actually lands.
//
// A drop is not placed at the raw kill point: #88 scatters it a little so simultaneous drops
// don't stack on one pixel, and #73 snaps it to ground the player can actually walk to. Both
// nudges were side-agnostic, so a kill next to a base wall could push its reward through the
// wall — either stranding a pickup the player earned, or handing him one he hadn't breached
// his way to yet.
//
// This is the pure geometry of that placement, injected with the callers' world predicates so
// it unit-tests without Phaser or a terrain generator. The rule: a drop may move as far as it
// needs to find walkable ground, but it may never end up on the far side of a standing wall
// from its REFERENCE point (`ref`) — the side the drop belongs to.
import { pixelToHex, hexToPixel, nearestHex, HEX_SIZE } from './hexgrid.js';

// Scatter radius shared by powerups (arena/powerups.js) and salvage (arena/salvage.js).
// #88 wanted only enough jitter that two drops from one kill don't sit on the same pixel; the
// original 30px was most of a 48px hex wide, so the scatter ALONE could throw a drop across a
// wall band before the reachability snap even ran (#336). 12px still separates two drops
// visibly at their 26px pickup radius, but can no longer cross a wall on its own.
export const DROP_SCATTER_RADIUS = 12;

// Resolve a drop's final resting place.
//
//   x, y      the (already scattered) ideal drop point
//   ref       { x, y } the point whose SIDE of any wall the drop must stay on — the death
//             position for a ground kill, or the player's position for a flyer (a flyer shot
//             down over a wall has no real side of its own, so it drops on the side the player
//             can collect from). Pass null to skip the side rule entirely.
//   blocked   (x, y) => bool — the scene's pixel-space "can't stand here" test, or null
//   passable  (q, r) => bool — is this hex walkable ground
//   separated (ax, ay, bx, by) => bool — is a standing wall genuinely BETWEEN these two points.
//             Callers back this with `wallEdgeSeparating` (#320), a true opposite-sides test —
//             NOT `wallEdgeCrossing`, whose "segment ends inside the wall's thickness" clause
//             would reject perfectly good spots that merely sit against the plate on the
//             correct side.
//
// Returns { x, y, fallback } — `fallback` true only in the corner case below.
export function resolveDropPos(x, y, {
  ref = null, blocked = null, passable = () => true,
  separated = () => false, maxSteps = 40, size = HEX_SIZE,
} = {}) {
  const sameSide = (px, py) => !ref || !separated(ref.x, ref.y, px, py);
  // Already fine where it landed: walkable AND on the right side of everything.
  if (blocked && !blocked(x, y) && sameSide(x, y)) return { x, y, fallback: false };
  const start = pixelToHex(x, y, size);
  // The #73 outward ring search, now side-aware: it still expands ring by ring from the drop
  // point and takes the first walkable tile, but a tile on the far side of a wall is simply not
  // a candidate, so the search keeps going and finds the nearest walkable tile on OUR side.
  const onSide = (q, r) => { const p = hexToPixel(q, r, size); return sameSide(p.x, p.y); };
  const hex = nearestHex(start, (q, r) => passable(q, r) && onSide(q, r), maxSteps);
  if (hex) return { ...hexToPixel(hex.q, hex.r, size), fallback: false };
  // Corner case: nothing walkable exists on our side within the search (something died wedged
  // in a sealed pocket). Rather than silently losing a reward the player earned, place it on
  // the nearest correct-side tile even though that tile is blocked — a pickup clipping a wall
  // beats a drop that vanishes.
  const wedged = nearestHex(start, onSide, maxSteps);
  if (wedged) return { ...hexToPixel(wedged.q, wedged.r, size), fallback: true };
  // Nothing at all passed (no ref would make this impossible) — leave it exactly where the
  // thing died, which is by definition on its own side.
  if (ref) return { x: ref.x, y: ref.y, fallback: true };
  return { x: 0, y: 0, fallback: true };
}
