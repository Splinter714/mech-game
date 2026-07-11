// Pure geometry for HUD wayfinding (#80): the edge direction arrow + the corner minimap both
// need "where is this world point relative to the camera / the player," which is ordinary
// arithmetic with no Phaser dependency — so it lives here, fully unit-tested, and HudScene just
// calls it each frame with whatever it read off the registry.

// Is `point` (world-space {x,y}) inside `view`, a world-space rect {x, y, width, height}
// (top-left + size — the shape of a Phaser camera's `worldView`)? Used to decide whether the
// objective's own world-space marker (mission.js's pulsing ring) is already visible, in which
// case the edge arrow should hide rather than double up.
export function isPointInView(view, point) {
  return (
    point.x >= view.x && point.x <= view.x + view.width &&
    point.y >= view.y && point.y <= view.y + view.height
  );
}

// Where should the edge-arrow indicator sit, and which way should it point, given the camera's
// world-space view rect, the HUD's screen size, and the target's world position? The view rect
// maps linearly onto the screen (0,0)..(screenW,screenH) — that's exactly what a camera's
// worldView represents — so the target's screen-space position is a simple linear remap. From
// there, draw a ray from screen-center through the target and clamp it to an inset rectangle so
// the indicator always sits just inside the edge, pointing along the true direction to the
// (possibly far off-screen) target.
//
// `margin` is either a single number (uniform inset on all four edges — the old behaviour) or a
// per-edge `{ top, right, bottom, left }` object. The arena HUD reserves real screen space along
// the bottom (the skill-tile toolbar) and a smaller strip along the top (hints/objective text),
// so it passes a taller bottom/top margin there to keep the arrow from landing underneath them —
// see HudScene's `_updateWayArrow`.
// Returns {x, y, angle} in HUD screen space (angle in radians, atan2 convention).
export function edgeArrowPosition(view, screenW, screenH, point, margin = 24) {
  const m = typeof margin === 'number' ? { top: margin, right: margin, bottom: margin, left: margin } : margin;

  const sx = view.width ? ((point.x - view.x) / view.width) * screenW : screenW / 2;
  const sy = view.height ? ((point.y - view.y) / view.height) * screenH : screenH / 2;
  const cx = screenW / 2, cy = screenH / 2;
  let dx = sx - cx, dy = sy - cy;
  if (dx === 0 && dy === 0) dx = 1;   // degenerate (target exactly at center) — arbitrary direction
  const angle = Math.atan2(dy, dx);

  // Ray from screen-center through (dx, dy); find where it crosses the inset box's edges (the
  // box may be off-center when margins differ per side) and clamp to the nearer crossing.
  const xEdge = dx > 0 ? screenW - m.right : m.left;
  const yEdge = dy > 0 ? screenH - m.bottom : m.top;
  const tx = dx !== 0 ? (xEdge - cx) / dx : Infinity;
  const ty = dy !== 0 ? (yEdge - cy) / dy : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t, angle };
}

// NOTE (#80): a `relativeClamped`-style helper for projecting world points into a minimap's
// local space was drafted alongside this, but the corner minimap is being shipped as a separate
// follow-up (owner's call, 2026-07-10) — so it's been pulled back out of this pass entirely.
// This file should stay arrow-only until that follow-up lands.
