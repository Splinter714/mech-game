// #288 (rebuilt): drawing the base approach walls — a THICKENED BOUNDARY LINE straddling the hex
// edges, not a hex texture. Every other piece of world art in the game is a per-hex generated
// texture (hexArt.js) stamped on a tile; a wall owns no tile, so it can't be one. It's stroked
// directly as vector geometry onto a single Graphics object instead, which also means a span's
// damage state is a redraw rather than a texture swap.
//
// Kept here in src/art/ (rather than inline in the scene) alongside the rest of the procedural art,
// and written against the minimal Graphics surface (`clear/fillStyle/fillPoints/fillCircle`) so it
// can be exercised with a plain recording stub in tests without Phaser.
import { WALL_THICKNESS_PX } from '../data/wallEdges.js';

// Steel-plate palette — deliberately the same dark, cold, man-made family the removed
// `wallSegment` tile used (0x34383e/0x212429), so the wall still reads as base infrastructure and
// not as terrain, just drawn as a line now.
const WALL_DARK = 0x212429;    // shadowed base / outer edge
const WALL_BODY = 0x34383e;    // main plate face
const WALL_LIT = 0x4a505a;     // top-lit highlight strip along the plate's crest
const WALL_POST = 0x3f454e;    // the pillar at each junction between spans
const HAZARD = 0xc99a2c;       // amber hazard flash, so the gate reads as "defended", not scenery

// A quad of half-width `hw` centred on the segment (x0,y0)→(x1,y1), as fillPoints-ready points.
function band(x0, y0, x1, y1, hw) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * hw, ny = dx / len * hw;
  return [
    { x: x0 + nx, y: y0 + ny }, { x: x1 + nx, y: y1 + ny },
    { x: x1 - nx, y: y1 - ny }, { x: x0 - nx, y: y0 - ny },
  ];
}

// Draw every STANDING span of a wall-edge set onto `g` (which is cleared first). Destroyed spans
// draw nothing at all — that's the breach: a literal hole in the line you can see through and
// drive through, with the rest of the wall still standing on either side.
//
// A damaged-but-standing span visibly degrades before it falls (the plate face narrows and its
// highlight fades as HP drops), so a player can tell which span they've been chewing on and how
// close it is to going down without reading a health bar.
export function drawWallEdges(g, edges, thickness = WALL_THICKNESS_PX) {
  g.clear();
  const hw = thickness / 2;
  const live = edges.filter((e) => !e.destroyed);
  // Pass 1: a soft drop shadow under the whole line, so it reads as standing UP off the ground
  // rather than being painted on it.
  g.fillStyle(0x000000, 0.3);
  for (const e of live) g.fillPoints(band(e.x0, e.y0 + 3, e.x1, e.y1 + 3, hw), true);
  // Pass 2: the dark outer plate at full thickness.
  g.fillStyle(WALL_DARK, 1);
  for (const e of live) g.fillPoints(band(e.x0, e.y0, e.x1, e.y1, hw), true);
  // Pass 3: the plate face, inset — and narrowed by damage, so a battered span looks eaten away.
  for (const e of live) {
    const frac = e.maxHp ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 1;
    g.fillStyle(WALL_BODY, 1);
    g.fillPoints(band(e.x0, e.y0, e.x1, e.y1, hw * (0.36 + 0.44 * frac)), true);
    g.fillStyle(WALL_LIT, 0.25 + 0.55 * frac);
    g.fillPoints(band(e.x0, e.y0 - 1, e.x1, e.y1 - 1, hw * 0.22 * frac), true);
  }
  // Pass 4: a pillar at every junction where two standing spans meet, so the jagged chain of hex
  // edges reads as ONE continuous barrier rather than a row of disconnected sticks — and so the
  // outer corners are visually capped where a span dead-ends into a breach or the corridor edge.
  g.fillStyle(WALL_POST, 1);
  for (const e of live) {
    g.fillCircle(e.x0, e.y0, hw * 0.92);
    g.fillCircle(e.x1, e.y1, hw * 0.92);
  }
  // Pass 5: an amber hazard pip at each standing span's midpoint — small, but it's what makes the
  // line read from a distance as a defended gate rather than a rock formation.
  for (const e of live) {
    const frac = e.maxHp ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 1;
    g.fillStyle(HAZARD, 0.35 + 0.5 * frac);
    g.fillCircle((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2, hw * 0.3);
  }
}
