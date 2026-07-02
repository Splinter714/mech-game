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
  grass:    { fill: 0x2f5230, edge: 0x24401f },
  grassB:   { fill: 0x35592f, edge: 0x284a22 },
  // Shallow river: lighter, brighter blue-green (you can see the riverbed through it).
  river:    { fill: 0x2f6d86, edge: 0x24566a },
  // Deep water: darker, colder navy.
  deepWater:{ fill: 0x163a58, edge: 0x0f2c45 },
  forest:   { fill: 0x223f20, edge: 0x18311a },
  building: { fill: 0x3c4148, edge: 0x2a2e34 },
  // Rubble: the ashen debris a flattened outpost leaves behind.
  rubble:   { fill: 0x2f3138, edge: 0x212329 },
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

// Is (dx,dy) — offset from the hex centre — inside a pointy-top hexagon of circumradius s?
function inHex(dx, dy, s) {
  const hw = s * SQRT3 / 2;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  return ax <= hw && ay <= s * (1 - ax / (2 * hw));
}

// A full canopy: trees on a jittered triangular lattice covering the whole hex, kept to
// those whose centre sits inside the (slightly inset) hexagon, then drawn back-to-front
// so the grove reads as a continuous tree-line out to the tile edges. Deterministic jitter
// keeps the texture stable build-to-build.
function buildForestTrees() {
  const s = HEX_SIZE * 0.98;       // place out to ~the tile edge
  const step = 13;                 // lattice spacing (~tree spacing)
  let seed = 1337;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const trees = [];
  for (let row = -4; row <= 4; row++) {
    const oy = row * step * 0.86;
    const xoff = (row & 1) ? step / 2 : 0;
    for (let col = -4; col <= 4; col++) {
      const dx = col * step + xoff + (rnd() - 0.5) * 5;
      const dy = oy + (rnd() - 0.5) * 5;
      const r = 5.5 + rnd() * 3;
      if (inHex(dx, dy, s - r * 0.5)) trees.push([dx, dy, r]);
    }
  }
  trees.sort((a, b) => a[1] - b[1]); // back (top) to front (bottom)
  return trees;
}
const FOREST_TREES = buildForestTrees();

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
  // Shallow river: many bright, thin ripple streaks (lighter/animated feel) plus a couple of
  // sandy riverbed glints showing through — reads as fast, shallow water you can wade/shoot over.
  hex_river: (sg) => {
    sg.fillStyle(0x4f95b2, 0.55);
    for (const [dx, dy, w] of [[-7, -7, 15], [4, -3, 17], [-4, 2, 14], [6, 7, 13], [-8, 9, 11]]) {
      sg.fillEllipse(C.cx + dx, C.cy + dy, w, 2);
    }
    sg.fillStyle(0x8fc4d8, 0.5);   // bright crest highlights (sun on ripples)
    for (const [dx, dy, w] of [[-2, -5, 9], [3, 4, 8], [-5, 8, 7]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 1.4);
    sg.fillStyle(0x6d8a7a, 0.35);  // riverbed peeking through the shallows
    sg.fillEllipse(C.cx + 2, C.cy - 1, 6, 3);
  },
  // Deep water: a few slow, dark swells and a faint cold sheen — heavier and stiller than the river.
  hex_deepWater: (sg) => {
    sg.fillStyle(0x1f4d6e, 0.6);
    sg.fillEllipse(C.cx - 5, C.cy - 4, 18, 3.2);
    sg.fillEllipse(C.cx + 5, C.cy + 6, 16, 3);
    sg.fillStyle(0x2c6488, 0.4); sg.fillEllipse(C.cx + 1, C.cy + 1, 12, 2.4);
    sg.fillStyle(0x0e2a40, 0.5); sg.fillEllipse(C.cx - 3, C.cy + 8, 14, 2.6);  // dark depths
  },
  // Rubble: a scatter of broken slabs + ash over the ashen base — the remains of a stomped outpost.
  hex_rubble: (sg) => {
    sg.fillStyle(0x24262b, 0.8);   // scorch/ash base
    sg.fillEllipse(C.cx, C.cy, 26, 20);
    const chunks = [
      [-9, -6, 7, 5], [3, -8, 6, 4], [8, 2, 5, 6], [-6, 6, 6, 4],
      [1, 7, 5, 4], [-2, -2, 4, 4], [11, -3, 4, 3],
    ];
    for (const [dx, dy, w, h] of chunks) {
      sg.fillStyle(0x3a3d44, 1); sg.fillRect(C.cx + dx - w / 2, C.cy + dy - h / 2, w, h);
      sg.fillStyle(0x4c4f57, 1); sg.fillRect(C.cx + dx - w / 2, C.cy + dy - h / 2, w, 1.5);  // top-lit edge
    }
    sg.fillStyle(0x191b1f, 0.6);   // a couple of dark gaps between the debris
    sg.fillRect(C.cx - 2, C.cy + 1, 3, 3); sg.fillRect(C.cx + 5, C.cy - 5, 2, 3);
  },
  hex_forest: (sg) => {
    // Shadowy forest floor under the canopy, filling the whole hex.
    sg.fillStyle(0x14290f, 0.7);
    sg.fillPoints(hexCorners(HEX_SIZE * 0.95).map((p) => ({ x: C.cx + p.x, y: C.cy + p.y })), true);
    // A grove of trees covering the entire tile, drawn back-to-front.
    for (const [dx, dy, r] of FOREST_TREES) tree(sg, C.cx + dx, C.cy + dy, r);
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
    hex_grass: PAL.grass, hex_grassB: PAL.grassB,
    hex_river: PAL.river, hex_deepWater: PAL.deepWater,
    hex_forest: PAL.forest, hex_building: PAL.building, hex_rubble: PAL.rubble,
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
