// Procedural hex-tile art. Pointy-top hexes sized from hexgrid's HEX_SIZE, drawn as a
// filled polygon with a subtle inset so adjacent tiles read as a grid. A dark
// battlefield palette keeps the bright mech + weapon barrels popping. The arena places
// one of these at each hex centre (hexgrid.hexToPixel).

import { gen, scaledGraphics, ART_SCALE } from './_frames.js';
import { HEX_SIZE, hexCorners } from '../data/hexgrid.js';

const SQRT3 = Math.sqrt(3);
// Texture footprint (true on-screen px); displayed at 1/ART_SCALE after super-sampling.
export const HEX_TEX_W = Math.ceil(SQRT3 * HEX_SIZE) + 2;
export const HEX_TEX_H = Math.ceil(2 * HEX_SIZE) + 2;

const PAL = {
  // Abstract arena (kept).
  ground:  { fill: 0x1b2129, edge: 0x2a333f },
  groundB: { fill: 0x1f2630, edge: 0x2a333f },
  wall:    { fill: 0x3a4250, edge: 0x4a5564 },
  // Natural battlefield (#41).
  grass:   { fill: 0x2f5230, edge: 0x24401f },
  grassB:  { fill: 0x35592f, edge: 0x284a22 },
  water:   { fill: 0x1f4a6b, edge: 0x173a55 },
  forest:  { fill: 0x223f20, edge: 0x18311a },
  building:{ fill: 0x3c4148, edge: 0x2a2e34 },
};

function drawHex(sg, fill, edge, inset = 0.9) {
  const cx = HEX_TEX_W / 2, cy = HEX_TEX_H / 2;
  const outer = hexCorners(HEX_SIZE).map((p) => ({ x: cx + p.x, y: cy + p.y }));
  const inner = hexCorners(HEX_SIZE * inset).map((p) => ({ x: cx + p.x, y: cy + p.y }));
  sg.fillStyle(edge, 1);
  sg.fillPoints(outer, true);
  sg.fillStyle(fill, 1);
  sg.fillPoints(inner, true);
}

// A top-down tree: a soft drop shadow, then a canopy built from several overlapping
// blobs (so the silhouette reads as foliage, not a flat disc), shaded dark->light from
// the lower-right shadow side to the upper-left sun side, with a couple of bright
// speckles for leaf glints. Slight per-tree variation via the offset table.
const CANOPY_BLOBS = [
  [0, 0, 1.0], [-0.45, -0.35, 0.62], [0.5, -0.18, 0.55],
  [0.18, 0.48, 0.58], [-0.4, 0.4, 0.46], [0.42, 0.42, 0.4],
];
function tree(sg, cx, cy, r) {
  // Soft layered shadow on the ground.
  sg.fillStyle(0x0e1d0c, 0.55); sg.fillEllipse(cx + 1.6, cy + 2.2, r * 2.1, r * 1.5);
  // Dark base silhouette (the full canopy footprint).
  sg.fillStyle(0x1c3a1a, 1);
  for (const [dx, dy, s] of CANOPY_BLOBS) sg.fillCircle(cx + dx * r, cy + dy * r, r * s);
  // Mid-tone body, pulled slightly toward the sun (upper-left).
  sg.fillStyle(0x2f5a2c, 1);
  for (const [dx, dy, s] of CANOPY_BLOBS) sg.fillCircle(cx + dx * r - r * 0.12, cy + dy * r - r * 0.12, r * s * 0.82);
  // Sun-side highlight clusters.
  sg.fillStyle(0x4c8a40, 0.95);
  sg.fillCircle(cx - r * 0.3, cy - r * 0.3, r * 0.5);
  sg.fillCircle(cx + r * 0.12, cy - r * 0.05, r * 0.32);
  // Leaf glints.
  sg.fillStyle(0x6fb058, 0.9);
  sg.fillCircle(cx - r * 0.38, cy - r * 0.4, r * 0.16);
  sg.fillCircle(cx + r * 0.05, cy + r * 0.18, r * 0.12);
}

const C = { cx: HEX_TEX_W / 2, cy: HEX_TEX_H / 2 };

// Per-terrain detail painted over the base hex.
const DETAIL = {
  hex_grass: (sg) => {
    sg.fillStyle(0x244020, 0.7);
    for (const [dx, dy] of [[-10, -6], [7, -9], [11, 5], [-6, 9], [-12, 6]]) sg.fillEllipse(C.cx + dx, C.cy + dy, 5, 2.4);
    sg.fillStyle(0x3f6a38, 0.55);
    for (const [dx, dy] of [[-3, -2], [4, 3], [9, -3]]) sg.fillEllipse(C.cx + dx, C.cy + dy, 4, 2);
  },
  hex_grassB: (sg) => {
    sg.fillStyle(0x284a24, 0.7);
    for (const [dx, dy] of [[-8, 4], [6, 8], [10, -5], [-11, -4], [2, -8]]) sg.fillEllipse(C.cx + dx, C.cy + dy, 5, 2.4);
  },
  hex_water: (sg) => {
    sg.fillStyle(0x2f6a92, 0.6);
    sg.fillEllipse(C.cx - 6, C.cy - 4, 16, 2.6);
    sg.fillEllipse(C.cx + 5, C.cy + 7, 13, 2.3);
    sg.fillStyle(0x4a86b0, 0.4); sg.fillEllipse(C.cx + 1, C.cy + 1, 11, 2);
  },
  hex_forest: (sg) => {
    // Shadowy forest floor showing between the canopies.
    sg.fillStyle(0x14290f, 0.6); sg.fillEllipse(C.cx, C.cy, 26, 24);
    // Trees painted back-to-front (top rows first) so nearer canopies overlap farther ones.
    tree(sg, C.cx + 5, C.cy - 10, 5.5);
    tree(sg, C.cx - 8, C.cy - 6, 6.5);
    tree(sg, C.cx + 9, C.cy - 2, 6);
    tree(sg, C.cx - 1, C.cy + 1, 7.5);
    tree(sg, C.cx - 9, C.cy + 7, 5.5);
    tree(sg, C.cx + 6, C.cy + 8, 6.5);
    tree(sg, C.cx + 1, C.cy + 11, 4.5);
  },
  hex_building: (sg) => {
    sg.fillStyle(0x2a2e34, 1); sg.fillRect(C.cx - 15, C.cy - 13, 30, 26);    // base/outline
    sg.fillStyle(0x4a5159, 1); sg.fillRect(C.cx - 13, C.cy - 11, 26, 22);    // roof
    sg.fillStyle(0x565d66, 1); sg.fillRect(C.cx - 13, C.cy - 11, 26, 5);     // top-light strip
    sg.fillStyle(0x2a2e34, 1); sg.fillRect(C.cx - 7, C.cy - 1, 6, 6); sg.fillRect(C.cx + 3, C.cy + 4, 5, 5); // vents
    sg.fillStyle(0xc8a23a, 0.85); sg.fillRect(C.cx + 6, C.cy - 9, 3, 3);     // a warning light
  },
};

export function buildHexTextures(scene) {
  const tiles = {
    hex_ground: PAL.ground, hex_groundB: PAL.groundB,
    hex_grass: PAL.grass, hex_grassB: PAL.grassB, hex_water: PAL.water,
    hex_forest: PAL.forest, hex_building: PAL.building,
  };
  for (const [key, pal] of Object.entries(tiles)) {
    gen(scene, key, HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => {
      const sg = scaledGraphics(g);
      drawHex(sg, pal.fill, pal.edge);
      DETAIL[key]?.(sg);
    });
  }
  // The wall tile gets a raised top plate so cover reads as solid.
  gen(scene, 'hex_wall', HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => {
    const sg = scaledGraphics(g);
    drawHex(sg, PAL.wall.fill, PAL.wall.edge, 0.92);
    drawHex(sg, 0x4a5564, 0x39414d, 0.6);
  });
}
