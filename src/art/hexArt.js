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

// A top-down tree: drop shadow, canopy, sun-side highlight.
function tree(sg, cx, cy, r) {
  sg.fillStyle(0x132611, 1); sg.fillCircle(cx + 0.8, cy + 1.1, r);
  sg.fillStyle(0x2f5a2c, 1); sg.fillCircle(cx, cy, r);
  sg.fillStyle(0x437f3c, 0.9); sg.fillCircle(cx - r * 0.28, cy - r * 0.28, r * 0.5);
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
  hex_forest: (sg) => { tree(sg, C.cx - 9, C.cy - 4, 7); tree(sg, C.cx + 8, C.cy + 3, 8); tree(sg, C.cx - 2, C.cy + 9, 6); tree(sg, C.cx + 4, C.cy - 9, 5); },
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
