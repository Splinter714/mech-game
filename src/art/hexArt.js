// Procedural hex-tile art. Pointy-top hexes sized from hexgrid's HEX_SIZE, drawn as a
// filled polygon with a subtle inset so adjacent tiles read as a grid. A dark
// battlefield palette keeps the bright mech + weapon barrels popping. The arena places
// one of these at each hex centre (hexgrid.hexToPixel).

import { gen, scaledGraphics, ART_SCALE } from './_frames.js';
import { HEX_SIZE, hexCorners } from '../data/hexgrid.js';
import { TERRAIN } from '../data/terrain.js';

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

  // ── Desert / badlands (#67) — warm sandy palette. ──
  sand:      { fill: 0xbf9c5e, edge: 0xa5834a },
  sandB:     { fill: 0xc7a666, edge: 0xab8a4e },
  dryRiver:  { fill: 0x9c7f4a, edge: 0x836838 },
  mesa:      { fill: 0x8a5a3a, edge: 0x633c26 },
  scrub:     { fill: 0xb1904f, edge: 0x8f7440 },
  adobe:     { fill: 0xc79a5c, edge: 0x8a6636 },
  sandRubble:{ fill: 0x9c8355, edge: 0x7d6741 },
  // #110: quicksand — a lesser desert hazard (mesa is now boundary-only).
  quicksand: { fill: 0x8a723e, edge: 0x6b5830 },

  // ── Snow / arctic (#67) — cold white/blue palette. ──
  snow:      { fill: 0xd9e6ef, edge: 0xbccbd8 },
  snowB:     { fill: 0xcfdeeb, edge: 0xb2c3d3 },
  slush:     { fill: 0x9db6c6, edge: 0x84a0b3 },
  ice:       { fill: 0x9fc4dd, edge: 0x76a3c4 },
  drift:     { fill: 0xe4eef5, edge: 0xc3d3e0 },
  iceRuin:   { fill: 0xaebfcc, edge: 0x8497a6 },
  snowRubble:{ fill: 0xb6c4cf, edge: 0x96a6b3 },
  // #110: broken ice — a lesser arctic hazard (solid ice is now boundary-only).
  brokenIce: { fill: 0x7f9cb0, edge: 0x678698 },

  // ── Urban ruins (#67) — grey industrial palette. ──
  pavement:  { fill: 0x4b4f56, edge: 0x3a3e44 },
  pavementB: { fill: 0x53575e, edge: 0x40444a },
  road:      { fill: 0x36393f, edge: 0x2a2c31 },
  collapsed: { fill: 0x44484f, edge: 0x2f3238 },
  wreck:     { fill: 0x4a4640, edge: 0x35322d },
  tower:     { fill: 0x565b63, edge: 0x393d43 },
  cityRubble:{ fill: 0x3f4249, edge: 0x2c2f34 },
  // #110: debris field — a lesser urban hazard (the collapsed heap is now boundary-only).
  debris:    { fill: 0x4a4640, edge: 0x35322d },

  // ── Volcanic wasteland (#67) — dark/ember palette. ──
  ash:       { fill: 0x2b2723, edge: 0x1d1a17 },
  ashB:      { fill: 0x322d28, edge: 0x201d19 },
  crust:     { fill: 0x3a2620, edge: 0x281713 },
  lava:      { fill: 0x7a2410, edge: 0x4a1608 },
  fumarole:  { fill: 0x35302b, edge: 0x211d19 },
  obsidian:  { fill: 0x2a2530, edge: 0x171420 },
  ashRubble: { fill: 0x322d28, edge: 0x211d19 },
  // #110: cinder field — a lesser volcanic hazard, distinct from boundary-only 'lava'.
  cinderField: { fill: 0x4a2a18, edge: 0x341c0f },
};

function drawHex(sg, fill, edge, inset = 0.9, sunken = false) {
  const cx = HEX_TEX_W / 2, cy = HEX_TEX_H / 2;
  const outer = hexCorners(HEX_SIZE).map((p) => ({ x: cx + p.x, y: cy + p.y }));
  const inner = hexCorners(HEX_SIZE * inset).map((p) => ({ x: cx + p.x, y: cy + p.y }));
  sg.fillStyle(edge, 1);
  sg.fillPoints(outer, true);
  sg.fillStyle(fill, 1);
  sg.fillPoints(inner, true);
  if (sunken) {
    // #211: impassable terrain (deep water, mesa, lava, …) should read as sitting BELOW the
    // walkable ground around it rather than a flat same-level tile — a soft inset shadow band
    // just inside the tile's own edge, like light not quite reaching the base of a drop-off.
    // Drawn as a darker ring (full-inset fill at low alpha) with the tile's normal fill
    // re-painted over its centre, so only a border band actually darkens.
    sg.fillStyle(0x000000, 0.3);
    sg.fillPoints(inner, true);
    const core = hexCorners(HEX_SIZE * inset * 0.72).map((p) => ({ x: cx + p.x, y: cy + p.y }));
    sg.fillStyle(fill, 1);
    sg.fillPoints(core, true);
  }
}

// #211: does this PAL/tile key (with or without its `hex_` texture prefix) name a terrain the
// mech cannot drive onto? Drives the sunken-shadow depth cue above. Legacy abstract-arena keys
// (`ground`/`groundB`/`wall`) aren't real TERRAIN ids, so this is false for them (unaffected).
function isImpassableTerrainId(key) {
  const id = key.replace(/^hex_/, '');
  const t = TERRAIN[id];
  return !!t && t.passable === false;
}

// #222: the five terrain ids reserved EXCLUSIVELY for a biome's `deep` world-boundary ring
// (data/biomes.js — never placed as an in-map feature, see worldgen.js `boundaryRingKeys`).
// Distinct from `isImpassableTerrainId` above, which is broader (also true for destructible
// buildings/outposts like `building`/`adobe`/`tower` — those keep their normal bordered,
// detailed look). Only these five get the seamless boundary treatment below.
const BOUNDARY_ONLY_IDS = new Set(['deepWater', 'mesa', 'ice', 'collapsed', 'lava']);
function isBoundaryTerrainId(key) {
  return BOUNDARY_ONLY_IDS.has(key.replace(/^hex_/, ''));
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

// Tiny deterministic RNG so per-tile detail scatter is stable build-to-build.
function seeded(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

// A scatter of small speckles (rocks / snow lumps / cinders) inside the hex, given a seed.
function speckle(sg, seed, color, alpha, count, rMin, rMax, spread = 16) {
  const rnd = seeded(seed);
  sg.fillStyle(color, alpha);
  for (let i = 0; i < count; i++) {
    const dx = (rnd() - 0.5) * 2 * spread;
    const dy = (rnd() - 0.5) * 2 * spread;
    sg.fillCircle(C.cx + dx, C.cy + dy, rMin + rnd() * (rMax - rMin));
  }
}

// A biome "cover clump" (scrub bush / snowdrift / wreck pile / ash mound): a soft shadow, a dark
// base silhouette, a mid body pulled toward the sun (upper-left), and a highlight — the same
// read-as-a-mass recipe the forest tree uses, parameterized by palette so each biome's cover
// reads distinctly. `jag` adds a jaggier (rocky/wreck) vs rounder (snow/brush) silhouette.
const CLUMP_BLOBS = [
  [0, 0, 1.0], [-0.5, -0.3, 0.6], [0.5, -0.2, 0.55], [0.2, 0.45, 0.55], [-0.4, 0.4, 0.45],
];
function coverClump(sg, cx, cy, r, dark, mid, light, jag = 0) {
  sg.fillStyle(0x000000, 0.28); sg.fillEllipse(cx + 1.5, cy + 2, r * 2.1, r * 1.4);
  sg.fillStyle(dark, 1);
  for (const [dx, dy, s] of CLUMP_BLOBS) sg.fillCircle(cx + dx * r, cy + dy * r, r * s * (1 + jag * (dx > 0 ? 0.1 : 0)));
  sg.fillStyle(mid, 1);
  for (const [dx, dy, s] of CLUMP_BLOBS) sg.fillCircle(cx + dx * r - r * 0.12, cy + dy * r - r * 0.12, r * s * 0.8);
  sg.fillStyle(light, 0.95);
  sg.fillCircle(cx - r * 0.3, cy - r * 0.3, r * 0.5);
  sg.fillCircle(cx + r * 0.1, cy - r * 0.02, r * 0.3);
}

// A full-tile grove of cover clumps on the same jittered lattice the forest uses, drawn
// back-to-front — reused by every biome's walk-through cover so the mass fills the hex.
function buildClumpLattice(seed) {
  const s = HEX_SIZE * 0.98;
  const step = 13;
  const rnd = seeded(seed);
  const spots = [];
  for (let row = -4; row <= 4; row++) {
    const oy = row * step * 0.86;
    const xoff = (row & 1) ? step / 2 : 0;
    for (let col = -4; col <= 4; col++) {
      const dx = col * step + xoff + (rnd() - 0.5) * 5;
      const dy = oy + (rnd() - 0.5) * 5;
      const r = 5 + rnd() * 3;
      if (inHex(dx, dy, s - r * 0.5)) spots.push([dx, dy, r]);
    }
  }
  spots.sort((a, b) => a[1] - b[1]);
  return spots;
}
const CLUMP_SPOTS = buildClumpLattice(4242);

// Fill the whole hex with a darker floor colour under a cover grove (matches the forest recipe).
function coverFloor(sg, color, alpha = 0.7) {
  sg.fillStyle(color, alpha);
  sg.fillPoints(hexCorners(HEX_SIZE * 0.95).map((p) => ({ x: C.cx + p.x, y: C.cy + p.y })), true);
}

// A generic destructible-outpost roof (adobe / ice-ruin / tower / obsidian): a base outline, a
// roof plate, a top-light strip, and a couple of detail marks — palette-driven per biome.
function outpostRoof(sg, base, roof, light, mark, markCol) {
  sg.fillStyle(base, 1); sg.fillRect(C.cx - 15, C.cy - 13, 30, 26);
  sg.fillStyle(roof, 1); sg.fillRect(C.cx - 13, C.cy - 11, 26, 22);
  sg.fillStyle(light, 1); sg.fillRect(C.cx - 13, C.cy - 11, 26, 5);
  sg.fillStyle(base, 1); sg.fillRect(C.cx - 7, C.cy - 1, 6, 6); sg.fillRect(C.cx + 3, C.cy + 4, 5, 5);
  if (mark) { sg.fillStyle(markCol, 0.9); sg.fillRect(C.cx + 6, C.cy - 9, 3, 3); }
}

// A thin "crack"/seam line between successive points, drawn as a chain of thin oriented quads
// (the scaledGraphics wrapper has no stroke-path API, so we approximate with fillTriangle pairs).
function crackLine(sg, pts, color, alpha, width = 1) {
  sg.fillStyle(color, alpha);
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (width / 2), ny = (dx / len) * (width / 2);
    // Quad (x0±n, y0±n)–(x1±n) as two triangles.
    sg.fillTriangle(x0 + nx, y0 + ny, x0 - nx, y0 - ny, x1 + nx, y1 + ny);
    sg.fillTriangle(x0 - nx, y0 - ny, x1 - nx, y1 - ny, x1 + nx, y1 + ny);
  }
}

// A generic rubble scatter (broken slabs over a scorched base), palette-driven per biome.
function rubbleScatter(sg, baseCol, slabCol, litCol, seed) {
  sg.fillStyle(baseCol, 0.8); sg.fillEllipse(C.cx, C.cy, 26, 20);
  const rnd = seeded(seed);
  for (let i = 0; i < 7; i++) {
    const dx = (rnd() - 0.5) * 22, dy = (rnd() - 0.5) * 16;
    const w = 4 + rnd() * 4, h = 3 + rnd() * 3;
    sg.fillStyle(slabCol, 1); sg.fillRect(C.cx + dx - w / 2, C.cy + dy - h / 2, w, h);
    sg.fillStyle(litCol, 1); sg.fillRect(C.cx + dx - w / 2, C.cy + dy - h / 2, w, 1.5);
  }
}

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

  // ── Desert / badlands ──────────────────────────────────────────────────────────────────
  hex_sand: (sg) => {   // wind-blown dune ripples + a couple of pebbles
    sg.fillStyle(0xa5834a, 0.5);
    for (const [dx, dy, w] of [[-8, -6, 15], [5, -1, 17], [-3, 5, 15], [7, 9, 12]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 2);
    sg.fillStyle(0xd9bd80, 0.5);   // sun-lit ripple crests
    for (const [dx, dy, w] of [[-6, -7, 11], [3, 0, 12], [-1, 6, 10]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 1.3);
    speckle(sg, 0x21, 0x8a6a3a, 0.6, 3, 1, 2.2, 14);
  },
  hex_sandB: (sg) => {
    sg.fillStyle(0xab8a4e, 0.5);
    for (const [dx, dy, w] of [[-7, 4, 15], [6, 8, 13], [9, -4, 12], [-10, -3, 11]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 2);
    speckle(sg, 0x37, 0x8a6a3a, 0.55, 3, 1, 2, 14);
  },
  hex_dryRiver: (sg) => {   // a cracked, dry riverbed channel
    sg.fillStyle(0x836838, 0.7); sg.fillEllipse(C.cx, C.cy, 26, 12);
    crackLine(sg, [[C.cx - 12, C.cy - 3], [C.cx - 2, C.cy + 1], [C.cx + 5, C.cy - 2], [C.cx + 12, C.cy + 2]], 0x6a5228, 0.8, 1);
    crackLine(sg, [[C.cx - 8, C.cy + 4], [C.cx + 1, C.cy + 2], [C.cx + 9, C.cy + 5]], 0x6a5228, 0.8, 1);
    sg.fillStyle(0xc7a666, 0.4); sg.fillEllipse(C.cx - 4, C.cy - 4, 8, 2);   // dry sandbank
  },
  hex_mesa: (sg) => {   // a stepped rock butte casting a shadow — reads as a tall impassable cliff
    sg.fillStyle(0x000000, 0.3); sg.fillEllipse(C.cx + 2, C.cy + 4, 26, 16);
    sg.fillStyle(0x633c26, 1); sg.fillEllipse(C.cx, C.cy + 2, 26, 18);        // base
    sg.fillStyle(0x8a5a3a, 1); sg.fillEllipse(C.cx - 1, C.cy - 1, 22, 14);    // mid ledge
    sg.fillStyle(0xa5714a, 1); sg.fillEllipse(C.cx - 2, C.cy - 4, 15, 9);     // top plateau
    sg.fillStyle(0xc08a5c, 0.9); sg.fillEllipse(C.cx - 3, C.cy - 6, 9, 4);    // sun-lit cap
    sg.fillStyle(0x4a2c1c, 0.5); sg.fillRect(C.cx + 4, C.cy - 2, 2, 8);       // strata shadow
  },
  hex_scrub: (sg) => {   // sparse desert brush cover
    coverFloor(sg, 0x8f7440, 0.55);
    for (const [dx, dy, r] of CLUMP_SPOTS) {
      if ((dx + dy) % 2 === 0) continue;   // sparse: skip ~half the lattice
      coverClump(sg, C.cx + dx, C.cy + dy, r * 0.8, 0x5c4a24, 0x7d6a34, 0xa89150);
    }
  },
  hex_adobe: (sg) => outpostRoof(sg, 0x8a6636, 0xc79a5c, 0xd8b070, true, 0x6a4a24),
  hex_sandRubble: (sg) => rubbleScatter(sg, 0x7d6741, 0x9c8355, 0xb89b64, 0x51),
  // #110: quicksand — a sunken, rippled pit distinct from the dry-riverbed channel.
  hex_quicksand: (sg) => {
    sg.fillStyle(0x6b5830, 0.6); sg.fillEllipse(C.cx, C.cy, 22, 14);
    sg.fillStyle(0xa5854a, 0.5); sg.fillEllipse(C.cx - 2, C.cy - 1, 14, 8);
    crackLine(sg, [[C.cx - 9, C.cy - 2], [C.cx, C.cy + 2], [C.cx + 8, C.cy - 1]], 0x574726, 0.6, 1);
  },

  // ── Snow / arctic ──────────────────────────────────────────────────────────────────────
  hex_snow: (sg) => {   // soft drift shadows + sparkle
    sg.fillStyle(0xbccbd8, 0.5);
    for (const [dx, dy, w] of [[-8, -5, 15], [5, 2, 16], [-4, 7, 13]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 3);
    sg.fillStyle(0xffffff, 0.8);
    for (const [dx, dy] of [[-9, -6], [6, -3], [2, 6], [-5, 4]]) sg.fillCircle(C.cx + dx, C.cy + dy, 1.2);
  },
  hex_snowB: (sg) => {
    sg.fillStyle(0xb2c3d3, 0.5);
    for (const [dx, dy, w] of [[-6, 5, 15], [7, -4, 14], [-9, -3, 12]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 3);
    sg.fillStyle(0xffffff, 0.75);
    for (const [dx, dy] of [[-7, 6], [8, 3], [-2, -6]]) sg.fillCircle(C.cx + dx, C.cy + dy, 1.1);
  },
  hex_slush: (sg) => {   // half-frozen melt: cold water streaks with ice skins
    sg.fillStyle(0x7f9cb0, 0.6); for (const [dx, dy, w] of [[-6, -5, 15], [4, 1, 16], [-3, 6, 13]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 2.4);
    sg.fillStyle(0xdbe7f0, 0.55); for (const [dx, dy, w] of [[-4, -3, 9], [3, 4, 8]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 1.6); // ice skins
  },
  hex_ice: (sg) => {   // a solid frozen lake: pale sheen + cracks
    sg.fillStyle(0xc4dcec, 0.5); sg.fillEllipse(C.cx - 3, C.cy - 3, 20, 10);
    crackLine(sg, [[C.cx - 11, C.cy - 5], [C.cx - 1, C.cy - 1], [C.cx + 6, C.cy - 5]], 0x76a3c4, 0.8, 1);
    crackLine(sg, [[C.cx - 2, C.cy - 1], [C.cx + 3, C.cy + 7]], 0x76a3c4, 0.8, 1);
    sg.fillStyle(0xffffff, 0.5); sg.fillEllipse(C.cx + 4, C.cy + 2, 8, 2);   // glare
  },
  hex_drift: (sg) => {   // snowdrifts / frosted pines cover
    coverFloor(sg, 0xb2c3d3, 0.6);
    for (const [dx, dy, r] of CLUMP_SPOTS) coverClump(sg, C.cx + dx, C.cy + dy, r, 0xa9bccb, 0xcfe0ec, 0xffffff);
  },
  hex_iceRuin: (sg) => outpostRoof(sg, 0x8497a6, 0xaebfcc, 0xd2e0ea, true, 0x6f8698),
  hex_snowRubble: (sg) => rubbleScatter(sg, 0x96a6b3, 0xb6c4cf, 0xdae6ee, 0x63),
  // #110: broken ice — thin cracked plates over cold water, lighter/weaker read than solid ice.
  hex_brokenIce: (sg) => {
    sg.fillStyle(0x638094, 0.55); sg.fillEllipse(C.cx, C.cy, 20, 10);
    crackLine(sg, [[C.cx - 9, C.cy - 3], [C.cx - 1, C.cy], [C.cx + 7, C.cy - 3]], 0x4a6478, 0.7, 1);
    sg.fillStyle(0xc4dcec, 0.35); sg.fillEllipse(C.cx + 3, C.cy + 2, 8, 2);
  },

  // ── Urban ruins ────────────────────────────────────────────────────────────────────────
  hex_pavement: (sg) => {   // cracked concrete slab with seams
    sg.fillStyle(0x33363c, 0.7); sg.fillRect(C.cx - 13, C.cy - 2.5, 26, 1); sg.fillRect(C.cx + 1.5, C.cy - 12, 1, 24); // seams
    sg.fillStyle(0x3a3e44, 0.5); sg.fillCircle(C.cx - 6, C.cy + 5, 1.4); sg.fillCircle(C.cx + 7, C.cy - 6, 1.2); // potholes
  },
  hex_pavementB: (sg) => {
    sg.fillStyle(0x3a3e44, 0.7); sg.fillRect(C.cx - 13, C.cy + 3.5, 26, 1); sg.fillRect(C.cx - 5.5, C.cy - 12, 1, 24);
    sg.fillStyle(0x2f3238, 0.5); sg.fillCircle(C.cx + 5, C.cy + 6, 1.3);
  },
  hex_road: (sg) => {   // dark asphalt lane with a dashed centre line
    sg.fillStyle(0x2a2c31, 0.6); sg.fillRect(C.cx - 15, C.cy - 6, 30, 12);
    sg.fillStyle(0xc8b23a, 0.8);
    for (const dx of [-10, -2, 6]) sg.fillRect(C.cx + dx, C.cy - 1, 5, 2);   // centre-line dashes
    sg.fillStyle(0x9aa0a8, 0.4); sg.fillRect(C.cx - 15, C.cy - 6, 30, 1); sg.fillRect(C.cx - 15, C.cy + 5, 30, 1); // curbs
  },
  hex_collapsed: (sg) => {   // an impassable heap of collapsed structure
    sg.fillStyle(0x000000, 0.28); sg.fillEllipse(C.cx + 2, C.cy + 4, 26, 15);
    const rnd = seeded(0x99);
    for (let i = 0; i < 9; i++) {
      const dx = (rnd() - 0.5) * 24, dy = (rnd() - 0.5) * 18;
      const w = 6 + rnd() * 7, h = 5 + rnd() * 6;
      sg.fillStyle(0x2f3238, 1); sg.fillRect(C.cx + dx - w / 2, C.cy + dy - h / 2, w, h);
      sg.fillStyle(0x5a5f68, 1); sg.fillRect(C.cx + dx - w / 2, C.cy + dy - h / 2, w, 2);
    }
    sg.fillStyle(0x6d7480, 0.8); sg.fillRect(C.cx - 3, C.cy - 8, 4, 14);   // a leaning girder
  },
  hex_wreck: (sg) => {   // burned-out wreckage / low walls cover
    coverFloor(sg, 0x35322d, 0.6);
    for (const [dx, dy, r] of CLUMP_SPOTS) {
      if ((dx + 2 * dy) % 3 === 0) continue;
      coverClump(sg, C.cx + dx, C.cy + dy, r * 0.85, 0x2a2723, 0x4a453d, 0x6a6258, 0.4);
    }
    sg.fillStyle(0xd8632a, 0.35); sg.fillCircle(C.cx + 3, C.cy - 2, 5);   // a faint smoulder glow
  },
  hex_tower: (sg) => outpostRoof(sg, 0x393d43, 0x565b63, 0x676d76, true, 0xc8a23a),
  hex_cityRubble: (sg) => rubbleScatter(sg, 0x2c2f34, 0x484c53, 0x5c626b, 0x77),
  // #110: debris field — a loose rubble-strewn street patch, lighter than a collapsed tower heap.
  hex_debris: (sg) => rubbleScatter(sg, 0x35322d, 0x4a4640, 0x6a6258, 0x82),

  // ── Volcanic wasteland ─────────────────────────────────────────────────────────────────
  hex_ash: (sg) => {   // grey ash drifts + a few glowing embers
    sg.fillStyle(0x1d1a17, 0.5); for (const [dx, dy, w] of [[-7, -5, 15], [5, 2, 16], [-3, 7, 13]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 2.4);
    sg.fillStyle(0x45403a, 0.5); for (const [dx, dy, w] of [[-5, -6, 10], [3, 1, 11]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 1.4);
    sg.fillStyle(0xff6a1e, 0.85); sg.fillCircle(C.cx - 6, C.cy + 4, 1); sg.fillCircle(C.cx + 8, C.cy - 5, 0.9); // embers
  },
  hex_ashB: (sg) => {
    sg.fillStyle(0x201d19, 0.5); for (const [dx, dy, w] of [[-6, 4, 15], [7, -4, 13], [-9, -3, 12]]) sg.fillEllipse(C.cx + dx, C.cy + dy, w, 2.4);
    sg.fillStyle(0xff6a1e, 0.8); sg.fillCircle(C.cx + 4, C.cy + 5, 0.9); sg.fillCircle(C.cx - 7, C.cy - 4, 0.8);
  },
  hex_crust: (sg) => {   // cooling lava crust: dark plates with molten cracks glowing through
    sg.fillStyle(0x1c110d, 0.6); sg.fillEllipse(C.cx, C.cy, 26, 16);
    crackLine(sg, [[C.cx - 12, C.cy - 3], [C.cx - 2, C.cy + 1], [C.cx + 6, C.cy - 3], [C.cx + 12, C.cy + 2]], 0xff5a14, 0.85, 1.4);
    crackLine(sg, [[C.cx - 6, C.cy + 4], [C.cx + 3, C.cy + 6]], 0xff5a14, 0.85, 1.4);
    crackLine(sg, [[C.cx - 11, C.cy - 3], [C.cx - 3, C.cy + 0.5]], 0xffc23a, 0.7, 0.8);
  },
  hex_lava: (sg) => {   // molten lava: bright flow with hot crests and dark cooling skin
    sg.fillStyle(0xd8461a, 0.8); sg.fillEllipse(C.cx, C.cy, 24, 14);
    sg.fillStyle(0xffb028, 0.9); sg.fillEllipse(C.cx - 3, C.cy - 2, 14, 6);
    sg.fillStyle(0xfff0a0, 0.85); sg.fillEllipse(C.cx - 4, C.cy - 3, 7, 3);   // white-hot core
    sg.fillStyle(0x2a1108, 0.7); sg.fillEllipse(C.cx + 7, C.cy + 4, 8, 3); sg.fillEllipse(C.cx - 8, C.cy + 5, 6, 2); // cooling skin islands
  },
  hex_fumarole: (sg) => {   // ash mounds / smoke plumes cover
    coverFloor(sg, 0x211d19, 0.6);
    for (const [dx, dy, r] of CLUMP_SPOTS) coverClump(sg, C.cx + dx, C.cy + dy, r * 0.9, 0x1e1a17, 0x3a352f, 0x55504a);
    sg.fillStyle(0xff6a1e, 0.3); sg.fillCircle(C.cx, C.cy, 6);   // ember glow at the vent
  },
  hex_obsidian: (sg) => outpostRoof(sg, 0x171420, 0x2a2530, 0x3f3848, true, 0xff5a14),
  hex_ashRubble: (sg) => rubbleScatter(sg, 0x211d19, 0x3a352f, 0x55504a, 0x88),
  // #110: cinder field — a hot ash/ember patch, milder read than a full molten-lava pool.
  hex_cinderField: (sg) => {
    sg.fillStyle(0x341c0f, 0.6); sg.fillEllipse(C.cx, C.cy, 22, 13);
    sg.fillStyle(0xd8461a, 0.5); sg.fillCircle(C.cx - 3, C.cy + 1, 3);
    sg.fillStyle(0xff8a3a, 0.7); sg.fillCircle(C.cx - 3, C.cy + 1, 1.4);
    sg.fillStyle(0xff6a1e, 0.6); sg.fillCircle(C.cx + 6, C.cy - 3, 1);
  },
};

// #126: the flat base fill colour behind a terrain id's hex texture (e.g. a biome's `deep`
// boundary terrain) — exposed so the arena can paint the CAMERA BACKGROUND to match instead of
// leaving it a fixed void black. This is the backstop half of the boundary-void fix: the
// boundary ring itself is deepened to comfortably outrun any realistic camera view distance
// (see data/worldgen.js BOUNDARY_RING_WIDTH), but a background-colour match means even an
// utterly pathological viewport (a giant/ultrawide display, or a browser zoomed far out) still
// blends into "more deep terrain" at the horizon rather than snapping to raw black.
export function terrainFillColor(id) {
  return PAL[id]?.fill;
}

export function buildHexTextures(scene) {
  const tiles = {
    hex_ground: PAL.ground, hex_groundB: PAL.groundB,
    hex_grass: PAL.grass, hex_grassB: PAL.grassB,
    hex_river: PAL.river, hex_deepWater: PAL.deepWater,
    hex_forest: PAL.forest, hex_building: PAL.building, hex_rubble: PAL.rubble,
  };
  // Biome tiles (#67): every palette key besides the abstract-arena ones maps to a `hex_<key>`
  // texture, so adding a biome terrain is just its PAL entry (+ optional DETAIL painter) — no
  // per-tile wiring here.
  for (const [key, pal] of Object.entries(PAL)) {
    if (key === 'ground' || key === 'groundB' || key === 'wall') continue;
    tiles[`hex_${key}`] = pal;
  }
  for (const [key, pal] of Object.entries(tiles)) {
    gen(scene, key, HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => {
      const sg = scaledGraphics(g);
      // #222: the world-boundary-only terrain ids (deep water / mesa / ice / collapsed / lava)
      // are stamped edge-to-edge across a very wide ring (worldgen.js BOUNDARY_RING_WIDTH) with
      // this SAME baked texture — previously that meant every hex showed the identical bordered
      // tile PLUS an identical "icon" (a wave swell, a rock butte, a rubble heap, a lava pool),
      // which reads as an obviously-repeating tiled pattern rather than one continuous surface.
      // Two changes make adjacent boundary tiles visually indistinguishable from one another (so
      // the seam between them disappears and the whole ring reads as one continuous sea/wasteland):
      // an inset of 1.0 (instead of 0.9) removes the darker inset border band entirely — the fill
      // now runs flush to the tile's true edge, so there's no per-hex grid line — and the
      // terrain's DETAIL painter (the recognizable per-hex icon) is skipped. The #211 sunken-shadow
      // depth cue is untouched (still driven by `isImpassableTerrainId`), so the boundary still
      // reads as sitting below the playable ground around it.
      const boundary = isBoundaryTerrainId(key);
      drawHex(sg, pal.fill, pal.edge, boundary ? 1.0 : 0.9, isImpassableTerrainId(key));
      if (!boundary) DETAIL[key]?.(sg);
    });
  }
  // The wall tile gets a raised top plate so cover reads as solid.
  gen(scene, 'hex_wall', HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => {
    const sg = scaledGraphics(g);
    drawHex(sg, PAL.wall.fill, PAL.wall.edge, 0.92);
    drawHex(sg, 0x4a5564, 0x39414d, 0.6);
  });
}
