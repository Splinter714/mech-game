// Procedural hex-tile art. Pointy-top hexes sized from hexgrid's HEX_SIZE, drawn as a
// filled polygon with a subtle inset so adjacent tiles read as a grid. A dark
// battlefield palette keeps the bright mech + weapon barrels popping. The arena places
// one of these at each hex centre (hexgrid.hexToPixel).

import { gen, scaledGraphics, ART_SCALE } from './_frames.js';
import { HEX_SIZE, hexCorners } from '../data/hexgrid.js';
import { TERRAIN } from '../data/terrain.js';

const SQRT3 = Math.sqrt(3);

// #251 (playtest follow-up): the ONE fixed fill/edge every base-infrastructure hex type uses,
// regardless of biome — see the PAL.dock comment below for why. Exported so future base-infra
// terrain entries can reuse it instead of re-deriving a color.
// #393: `edge` toned UP from 0x40444a toward the fill so base-infra hexes no longer render a
// heavy dark boundary band — a base tile should read as flat built ground, NOT as a wall. Walls
// carry the dark/raised structural look now (see PAL.wall), so a wall vs. a base edge vs. an
// opening is legible at a glance.
export const BASE_INFRA_COLOR = { fill: 0x565a5f, edge: 0x4e5258 };

// The ashen debris tone the generic `rubble` tile uses. (#287 introduced it as a shared value for
// `rubble` + the dedicated `turretRubble` wreck; #287's 2026-07-19 follow-up removed the turret
// emplacement and its wreck entirely, so `rubble` is the only reader today — kept named rather
// than inlined so a future debris tile has one tone to reuse.)
const RUBBLE_COLOR = { fill: 0x2f3138, edge: 0x212329 };

// #395: the base tile shared by both dock states — a near-black recessed bay (the shaft the two
// sliding doors cover / reveal). A very dark interior with a slightly-lit metal frame rim so it
// reads as a fabricated opening in the ground rather than a flat black tile.
const DOCK_BAY = { fill: 0x0d0f13, edge: 0x2b2f36 };

// #255: adjacent hex tiles are placed at their mathematically-exact centre spacing
// (hexgrid.hexToPixel, e.g. HEX_SIZE*SQRT3 for same-row neighbours) — but that spacing is
// IRRATIONAL, so on-screen it never lands on a whole device pixel. Phaser's `pixelArt: true`
// (main.js) forces `roundPixels: true`, which independently snaps each tile sprite's
// rendered position to the nearest whole device pixel every frame. As the camera scrolls
// continuously, the rounding residual at any two neighbouring tiles' shared edge drifts in
// and out of alignment — sometimes the two roundings cancel (no visible seam), sometimes
// they don't (a hairline gap of background colour shows through the tiles' anti-aliased
// edge, which — by construction — fades fully to transparent exactly AT the true
// mathematical hex boundary and not a pixel further). This can't be fixed by "rounding the
// placement math more consistently": the camera transform re-introduces a fresh fractional
// device-pixel offset every frame regardless of what the source hexToPixel value was, so no
// amount of pre-rounding at generation time survives a smoothly-scrolling camera.
// The fix is standard texture-atlas tile BLEED: draw each tile's outer boundary polygon
// `HEX_BLEED` design px past the true hex radius, so the polygon's opaque interior already
// covers the true tile boundary and the anti-alias fade-to-transparent happens further out,
// inside the footprint the neighbouring tile independently paints over. Whichever way a
// given frame's rounding jitters, at least one of the two tiles has opaque paint at the seam
// pixel, so the background never shows through. `HEX_BLEED` is chosen so the bled polygon's
// apothem (centre-to-flat-side distance) exceeds half the same-row neighbour spacing (see
// hexArt.test.js) — i.e. genuine geometric overlap, not just a hopeful nudge — while still
// leaving margin inside the texture bounds below for the bled edge's own AA ring.
export const HEX_BLEED = 1;

// Texture footprint (true on-screen px); displayed at 1/ART_SCALE after super-sampling.
// Padding is bumped (+2 → +6) to keep comfortable margin around the now-larger (HEX_SIZE +
// HEX_BLEED) outer polygon plus its own anti-aliasing ring.
export const HEX_TEX_W = Math.ceil(SQRT3 * (HEX_SIZE + HEX_BLEED)) + 6;
export const HEX_TEX_H = Math.ceil(2 * (HEX_SIZE + HEX_BLEED)) + 6;

const PAL = {
  // Abstract arena (kept).
  ground:  { fill: 0x1b2129, edge: 0x2a333f },
  groundB: { fill: 0x1f2630, edge: 0x2a333f },
  // #393: walls must read as a SOLID RAISED STRUCTURE, clearly distinct from a base-infra hex's
  // (now toned-down) boundary band — so that when a wall span is destroyed the gap is obviously an
  // opening. Darker, cooler body than before (0x3a4250 → 0x2d343f) with a bright top-lit rim; the
  // raised top-plate layering happens in buildHexTextures below.
  wall:    { fill: 0x2d343f, edge: 0x545f6e },
  // Natural battlefield (#41).
  grass:    { fill: 0x2f5230, edge: 0x24401f },
  grassB:   { fill: 0x35592f, edge: 0x284a22 },
  // Shallow river: lighter, brighter blue-green (you can see the riverbed through it).
  river:    { fill: 0x2f6d86, edge: 0x24566a },
  // Deep water: darker, colder navy.
  deepWater:{ fill: 0x163a58, edge: 0x0f2c45 },
  // #405/#464: the forest GROUND tile — the floor the trees stand on, worn by BOTH the standing
  // `forest` hex and its cleared state (the trees themselves are the separate #289 canopy overlay,
  // so the two only ever differed by a stubble speckle — see the SOFT-COVER GROUND TEXTURE note in
  // data/terrain.js). `TERRAIN.forest.tex` points here too; there is no separate `hex_forest`.
  forestCleared: { fill: 0x223f20, edge: 0x18311a },
  // Rubble: the ashen debris a flattened destructible hex leaves behind.
  rubble:   RUBBLE_COLOR,
  // #278: grassland's own in-map hazard — a boggy mud patch. Warm dark brown, distinct from
  // forest's greens (rather than an earthy tone that could read as "just more forest floor").
  mud:      { fill: 0x4a3a20, edge: 0x352918 },
  // #251 (playtest follow-up): base-infrastructure hex types (dock/alertTower/objective) render with ONE fixed neutral colour regardless of which biome they're stamped
  // into — a dock must look like a dock on grass, desert, ice, or ash alike. Reusing the CURRENT
  // biome's ground fill (grass green) would make it read as biome-tinted grass rather than a
  // distinct man-made surface. A cool neutral concrete/tarmac tone reads as "built", not
  // "natural", against every biome's warm/cold palette; per-TYPE distinction comes from the
  // DETAIL painter's icon/shape, never from the fill colour.
  // #269 playtest follow-up: `dock` and `alertTower` originally reused the now-removed `helipad`/
  // `tower` outpost textures verbatim (#275) — in play this made docks indistinguishable from
  // helipads, and alert towers indistinguishable from ordinary destructible outpost buildings, so
  // a player fighting through a base would destroy an alert tower incidentally without ever
  // realizing it (canceling its wake countdown before it could complete). Both now get their own
  // PAL/DETAIL entries below. Both stay on the shared BASE_INFRA_COLOR fill (same neutral
  // concrete/tarmac tone) so they still read as "part of the base-infrastructure family"
  // regardless of biome — the distinction between them comes entirely from each one's own DETAIL
  // painter shape.
  // #395: a dock hex is now a recessed BLACK BAY — a dark shaft framed by a metal rim — whether it
  // reads as open or closed. The open/closed state is carried by two separate sliding DOOR sprites
  // (see `hex_dockDoorL`/`hex_dockDoorR` below + bases.js `_animateDock`), NOT by the base tile: when
  // the doors part they reveal this black bay, so `dock` (open) and `dockClosed` (sealed) share the
  // same dark base texture and differ only in whether their doors are slid shut over it.
  dock:       DOCK_BAY,
  alertTower: BASE_INFRA_COLOR,
  // #288 (ring placement): `baseYard` — the base compound's paved floor, filling out its whole
  // hex footprint inside the wall ring. Deliberately a SHADE DARKER/flatter than the shared
  // BASE_INFRA_COLOR its structure siblings use: it's the ground BETWEEN the structures, so it has
  // to read as the same fabricated concrete family (so the compound looks like one continuous
  // built surface, and the wall ring visibly encloses "the base" rather than a patch of grass)
  // while still letting a dock/objective pop out of it rather than blending in.
  // #393: border band toned up (0x3a3e44 → 0x44484e) so the paved apron reads as flat ground, not
  // a bordered tile.
  baseYard:   { fill: 0x494d53, edge: 0x44484e },
  // #269 playtest follow-up ("objectives are picking an arbitrary hex, not a real target"): the
  // dedicated destructible `objective` base hex (data/terrain.js) each base's mission marker now
  // points at. Same shared base-infra fill as its siblings — the DETAIL painter below (a squared
  // bunker silhouette with a bold red target-ring beacon) is what makes it read as visually
  // distinct — specifically as "THE thing to punch through."
  objective: BASE_INFRA_COLOR,
  // #269 playtest follow-up (dock open/closed states): the CLOSED state of a dock hex (terrain.js
  // `dockClosed`) — a genuine sealed structure (destructible, LOS-blocking; #286: passable-but-
  // slow, not a blockade). #395: the base tile is now the SAME black bay as the open `dock` (the
  // sealed look comes from the two door sprites slid shut over it, not the tile), so both share
  // `DOCK_BAY` — a dark shaft framed by a metal rim.
  dockClosed: DOCK_BAY,

  // ── Desert / badlands (#67) — warm sandy palette. ──
  sand:      { fill: 0xbf9c5e, edge: 0xa5834a },
  sandB:     { fill: 0xc7a666, edge: 0xab8a4e },
  dryRiver:  { fill: 0x9c7f4a, edge: 0x836838 },
  mesa:      { fill: 0x8a5a3a, edge: 0x633c26 },
  // #405/#464: the scrub GROUND tile, worn by both the standing `scrub` hex and its cleared state.
  scrubCleared: { fill: 0xb1904f, edge: 0x8f7440 },
  // #110: quicksand — a lesser desert hazard (mesa is now boundary-only).
  quicksand: { fill: 0x8a723e, edge: 0x6b5830 },

  // ── Snow / arctic (#67) — cold white/blue palette. ──
  snow:      { fill: 0xd9e6ef, edge: 0xbccbd8 },
  snowB:     { fill: 0xcfdeeb, edge: 0xb2c3d3 },
  slush:     { fill: 0x9db6c6, edge: 0x84a0b3 },
  ice:       { fill: 0x9fc4dd, edge: 0x76a3c4 },
  // #405/#464: the snowdrift GROUND tile, worn by both the standing `drift` hex and its cleared state.
  driftCleared: { fill: 0xe4eef5, edge: 0xc3d3e0 },
  // #110: broken ice — a lesser arctic hazard (solid ice is now boundary-only).
  brokenIce: { fill: 0x7f9cb0, edge: 0x678698 },

  // ── Urban ruins (#67) — grey industrial palette. ──
  pavement:  { fill: 0x4b4f56, edge: 0x3a3e44 },
  pavementB: { fill: 0x53575e, edge: 0x40444a },
  collapsed: { fill: 0x44484f, edge: 0x2f3238 },
  // #405/#464: the wreckage GROUND tile, worn by both the standing `wreck` hex and its cleared state.
  wreckCleared: { fill: 0x4a4640, edge: 0x35322d },
  // #110: debris field — a lesser urban hazard (the collapsed heap is now boundary-only).
  debris:    { fill: 0x4a4640, edge: 0x35322d },
  // #278: urban's own channel — a flooded concrete drainage canal. Cool blue-grey (distinct from
  // debris's warm ash-brown and pavement's neutral grey) so it reads as standing water in a
  // man-made culvert.
  canal:     { fill: 0x39474d, edge: 0x293338 },

  // ── Volcanic wasteland (#67) — dark/ember palette. ──
  ash:       { fill: 0x2b2723, edge: 0x1d1a17 },
  ashB:      { fill: 0x322d28, edge: 0x201d19 },
  crust:     { fill: 0x3a2620, edge: 0x281713 },
  lava:      { fill: 0x7a2410, edge: 0x4a1608 },
  // #405/#464: the fumarole GROUND tile, worn by both the standing `fumarole` hex and its cleared state.
  fumaroleCleared: { fill: 0x35302b, edge: 0x211d19 },
  // #110: cinder field — a lesser volcanic hazard, distinct from boundary-only 'lava'.
  cinderField: { fill: 0x4a2a18, edge: 0x341c0f },
};

function drawHex(sg, fill, edge, inset = 0.9, sunken = false) {
  const cx = HEX_TEX_W / 2, cy = HEX_TEX_H / 2;
  // #255: the OUTER polygon is the one that meets the neighbouring tile at the true hex
  // boundary, so it's the one that needs the seam-hiding bleed (see HEX_BLEED above). The
  // inset "grid line" ring stays at the exact, un-bled size — it's a purely interior detail.
  const outer = hexCorners(HEX_SIZE + HEX_BLEED).map((p) => ({ x: cx + p.x, y: cy + p.y }));
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
// hard-cover structures like `alertTower`/`dockClosed`/`objective` — those keep their normal
// bordered, detailed look). Only these five get the seamless boundary treatment below.
const BOUNDARY_ONLY_IDS = new Set(['deepWater', 'mesa', 'ice', 'collapsed', 'lava']);
function isBoundaryTerrainId(key) {
  return BOUNDARY_ONLY_IDS.has(key.replace(/^hex_/, ''));
}

// #222's 3rd playtest pass baked a SECOND, flat (non-sunken) texture per boundary-only id
// (`flatBoundaryTexKey`) so world.js could pick it for interior ring tiles. The 4th pass replaced
// per-tile boundary art with a single flat camera-background fill (`terrainFillColor(B.deep)`,
// world.js) and stopped placing tile Images in the ring at all — which stranded both that helper
// and its whole texture-build pass with zero consumers. #464 deleted them, along with the five
// DETAIL painters for `deepWater`/`mesa`/`ice`/`collapsed`/`lava`, which the `boundary` guard in
// `buildHexTextures` had already been skipping. The ids' PAL and TERRAIN entries STAY: the ring's
// `passable: false` is the invisible wall keeping the mech in the corridor, and the PAL fill is
// what the camera background reads.
export { isBoundaryTerrainId, BOUNDARY_ONLY_IDS };

// #222 (2nd playtest pass): even with identical fill and no per-hex decoration, the boundary
// ring still read as an obviously-tiled hex grid rather than one continuous surface. Root cause
// isn't the art content — it's that every hex is a SEPARATE baked texture stamped at its own
// centre (world.js `hexToPixel`), rendered with `pixelArt: true` (nearest-filtering, main.js) and
// the arena's fractional `dpr * zoomFactor` camera zoom (main.js `applySize`). Adjacent tiles'
// polygons meet at a mathematically-exact shared edge in "design space", but once that boundary
// gets projected through a non-integer zoom and rounded to device pixels, each tile's quad rounds
// independently — a classic tile-seam/bleed problem, visible as a hairline gap (or double-thick
// line) at every hex edge, same-color fill or not. The standard fix is overdraw: make each boundary
// tile's fill polygon slightly LARGER than its true hex footprint so neighbours' opaque fills
// physically overlap at the seam instead of exactly abutting, hiding any rounding gap regardless of
// zoom/subpixel placement. `HEX_TEX_W/H` already carry a small margin around the true hex bounds
// (added for supersampling headroom), which conveniently doubles as overdraw room: neighbouring
// hex images' texture RECTS already overlap by exactly that margin (their centres are spaced by the
// true hex width/height, while each texture is slightly wider/taller than that), so growing the
// fill polygon into that margin is safe — it can't spill past either tile's own texture bounds.
// 1.015 pushes the fill ~0.7px past the true edge on every side, comfortably inside the tightest
// margin (the vertical one, ~1px each side) with headroom to spare, while every other terrain's
// normal (non-boundary) inset is untouched.
const BOUNDARY_OVERDRAW_INSET = 1.015;

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

// #405: a CLEARED soft-cover hex — the SAME under-lump ground floor its standing cover drew
// (`coverFloor`, so forest shows the shadowy tree floor, scrub the brush floor, etc.), now with the
// canopy/lumps GONE and only a faint scatter of stubble/remnants left. This reads as "the cover
// was blasted flat and you can see the ground it grew on", NOT a swap to a different biome tile.
// `stubble` is a low-alpha darker speck of what the lumps left behind; `seed` keeps each biome's
// scatter stable per tile.
function clearedCoverFloor(sg, floor, floorAlpha, stubble, seed) {
  coverFloor(sg, floor, floorAlpha);
  speckle(sg, seed, stubble, 0.22, 7, 1, 2.4, 15);
}

// ── #395: dock bay + sliding doors ─────────────────────────────────────────────────────────
// A dock hex's base tile: a recessed BLACK shaft framed by a metal rim, plus the two vertical
// guide rails the doors ride in. Shared by the open (`hex_dock`) and sealed (`hex_dockClosed`)
// states — the state is expressed by the separate door sprites slid over it, so both reveal this
// same black bay when open.
const DOCK_HALF_W = SQRT3 / 2 * HEX_SIZE;   // hex half-width along the straight vertical edges
function dockBay(sg) {
  const S = HEX_SIZE;
  // A deep black interior shaft, inset from the frame rim (drawn from the tile's DOCK_BAY edge/fill).
  sg.fillStyle(0x050608, 1);
  sg.fillPoints(hexCorners(S * 0.74).map((p) => ({ x: C.cx + p.x, y: C.cy + p.y })), true);
  // The two vertical guide rails the door leaves ride in, just inside each straight (vertical) edge.
  sg.fillStyle(0x2c3037, 0.9);
  sg.fillRect(C.cx - DOCK_HALF_W + 1, C.cy - S * 0.5, 2.4, S);
  sg.fillRect(C.cx + DOCK_HALF_W - 3.4, C.cy - S * 0.5, 2.4, S);
}

// Vertical half-height of a pointy-top hex at horizontal offset x from centre (0 outside the hex).
// The inverse of the closed-shutter `halfAt`: used to keep each vertical door slat inside the hex.
function dockVHalfAt(x) {
  const ax = Math.abs(x);
  if (ax >= DOCK_HALF_W) return 0;
  return HEX_SIZE - (ax / DOCK_HALF_W) * (HEX_SIZE / 2);
}

// One door leaf covering HALF the hex, corrugated with VERTICAL metal slats (a lit ridge on the
// left of each slat, a shadow groove on the right — light from upper-left). `side` = -1 draws the
// LEFT leaf (spanning [-HALF_W, 0]), +1 the RIGHT leaf ([0, +HALF_W]); the two meet at a central
// vertical seam. Drawn on a transparent background (like the canopy overlays) so the leaf can be
// placed as its own sprite over the black bay and slid apart horizontally to open (bases.js).
function dockDoor(sg, side) {
  const S = HEX_SIZE, slatW = 5.4;
  const x0 = side < 0 ? -DOCK_HALF_W : 0;
  const x1 = side < 0 ? 0 : DOCK_HALF_W;
  for (let x = x0; x < x1; x += slatW) {
    const w = Math.min(slatW, x1 - x);
    const outerAx = Math.max(Math.abs(x), Math.abs(x + w));   // wider end → stays inside the hex
    const vh = dockVHalfAt(outerAx);
    if (vh < 2) continue;
    const sx = C.cx + x, top = C.cy - vh, h = vh * 2;
    // #395: brighter, higher-contrast slat metal so a closed leaf reads as a bold solid panel
    // against the black bay it slides off of (the parting has to be obvious in motion).
    sg.fillStyle(0x6a7280, 1);    sg.fillRect(sx, top, w - 0.8, h);            // slat face
    sg.fillStyle(0x8b93a2, 0.95); sg.fillRect(sx, top, 1.2, h);               // left-lit ridge
    sg.fillStyle(0x191c22, 1);    sg.fillRect(sx + w - 1.6, top, 1.6, h);     // shadow groove (right)
  }
  // #395: outer vertical edge of each leaf — a bright rim where the metal meets the black bay, so
  // the door's leading/trailing edge stays crisp as it slides across the shaft.
  const outVh = dockVHalfAt(DOCK_HALF_W - 2.2);
  sg.fillStyle(0x9aa3b2, 0.9);
  if (side < 0) sg.fillRect(C.cx - DOCK_HALF_W + 0.6, C.cy - outVh, 1.6, outVh * 2);
  else          sg.fillRect(C.cx + DOCK_HALF_W - 2.2, C.cy - outVh, 1.6, outVh * 2);
  // #395: top/bottom edge caps — a dark lip framing the panel top and bottom so each leaf reads as
  // one solid door, not a stack of loose bars.
  const capVh = dockVHalfAt(Math.abs(side < 0 ? -DOCK_HALF_W / 2 : DOCK_HALF_W / 2));
  const capX = side < 0 ? C.cx - DOCK_HALF_W : C.cx;
  sg.fillStyle(0x14171c, 0.85);
  sg.fillRect(capX, C.cy - capVh, DOCK_HALF_W, 2.2);
  sg.fillRect(capX, C.cy + capVh - 2.2, DOCK_HALF_W, 2.2);
  // #395: the CENTRAL SEAM where the two leaves meet — the single most important read of a closed
  // dock. Each leaf paints its own half of a bold, chamfered hatch seam: a bright bevel lip catching
  // the light, then a deep near-black channel at dead centre. Together the two halves form a crisp,
  // high-contrast vertical line straight down the middle, so a sealed dock unmistakably reads as two
  // doors meeting — and the moment it parts, that line splits and black bay yawns open between them.
  const seamVh = dockVHalfAt(2.0);
  if (side < 0) {
    sg.fillStyle(0x9aa3b2, 0.95); sg.fillRect(C.cx - 4.0, C.cy - seamVh, 1.6, seamVh * 2);  // bevel lip
    sg.fillStyle(0x05070a, 1);    sg.fillRect(C.cx - 2.4, C.cy - seamVh, 2.4, seamVh * 2);  // dark channel (left half)
  } else {
    sg.fillStyle(0x05070a, 1);    sg.fillRect(C.cx,       C.cy - seamVh, 2.4, seamVh * 2);  // dark channel (right half)
    sg.fillStyle(0x9aa3b2, 0.95); sg.fillRect(C.cx + 2.4, C.cy - seamVh, 1.6, seamVh * 2);  // bevel lip
  }
  // Small red "sealed" light on the right leaf near the seam, so a closed dock still reads as
  // shut/dangerous (kept from the old dome/shutter version). It slides away as the door opens.
  if (side > 0) {
    sg.fillStyle(0xb3392a, 0.32); sg.fillCircle(C.cx + 5, C.cy + S * 0.42, 2.6);
    sg.fillStyle(0xff3a2a, 1);    sg.fillCircle(C.cx + 5, C.cy + S * 0.42, 1.3);
  }
}
// The door-leaf texture keys, and the on-screen distance each leaf slides to fully clear the bay.
export const DOCK_DOOR_TEX = { L: 'hex_dockDoorL', R: 'hex_dockDoorR' };
export const DOCK_DOOR_SLIDE = DOCK_HALF_W + 3;

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

// #464: the three bespoke soft-cover debris scatters that lived here (`organicDebrisScatter`,
// `iceShardScatter`, `cinderScatter`) are gone with the `*Rubble` tiles they painted — see the
// `rubbleId` note in data/terrain.js. `rubbleScatter` above stays: `hex_debris` still uses it.

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
  // #288 (ring placement): `baseYard` — the compound's paved apron. Deliberately UNDERSTATED: this
  // tile carpets most of a base's footprint, so anything with a recognizable "icon" would tile into
  // an obviously-repeating pattern (the same failure #222 fixed for the boundary ring). Instead it
  // gets flat concrete-slab language only — faint expansion-joint scoring plus a couple of low-
  // contrast stain/patch blotches — which reads as continuous poured hardstanding across a cluster
  // of hexes while keeping the dock/turret/objective icons the only things that draw the eye.
  hex_baseYard: (sg) => {
    sg.fillStyle(0x3a3e44, 0.75);                            // expansion-joint scoring
    sg.fillRect(C.cx - 20, C.cy - 4.5, 40, 0.9);
    sg.fillRect(C.cx - 2.5, C.cy - 20, 0.9, 40);
    sg.fillStyle(0x53575e, 0.5);                             // lighter poured-slab patches
    sg.fillEllipse(C.cx - 9, C.cy + 8, 11, 6);
    sg.fillEllipse(C.cx + 10, C.cy - 10, 9, 5);
    sg.fillStyle(0x3f4349, 0.45);                            // oil/scorch staining
    sg.fillEllipse(C.cx + 7, C.cy + 9, 7, 4);
  },
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
  // #464: the five BOUNDARY-ONLY ids (deepWater / mesa / ice / collapsed / lava) have no DETAIL
  // painter — `buildHexTextures` has skipped them since #222 (they'd tile into an obviously-
  // repeating pattern across the ring), and since #222's 4th pass the ring isn't even rendered as
  // tiles. Their PAL + TERRAIN entries are load-bearing and stay; only the dead art is gone.

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
  // #289: ground layer only — the shadowy forest floor, with a faint stubble of stumps/remnants.
  // The tree canopy itself renders as a SEPARATE overlay image (see CANOPY_DETAIL.forest below +
  // `buildHexTextures`'s canopy pass) so a small ground unit standing in cover can render between
  // the floor and the canopy sprites instead of being fully hidden under (or drawn flat on top of)
  // one combined texture. #464: this ONE tile serves both the standing `forest` hex and its cleared
  // state — under a full canopy the stubble is invisible anyway.
  hex_forestCleared: (sg) => clearedCoverFloor(sg, 0x14290f, 0.7, 0x0c1c08, 0xc1),
  // #269 playtest follow-up: `dock` — a rectangular bay/mooring pad. Reads as a loading bay: a
  // squared-off deck with a painted border frame, two corner bollard studs, and a chevron "lane"
  // marking down the middle pointing toward the bay's mouth — a docked unit backs/parks into this.
  // #395: a dock hex's base tile is a recessed BLACK BAY (shared by open `dock` and sealed
  // `dockClosed` — see `dockBay`). What the doors slide apart to reveal is exactly this shaft.
  hex_dock: (sg) => dockBay(sg),
  // #269 playtest follow-up: `alertTower` — a slim sensor/beacon mast, distinct from the regular
  // `tower` outpost's blocky building roof so it reads as a DETECTOR to avoid/snipe, not another
  // structure. A short plinth base, a thin mast rising well above a normal roofline, an angled
  // dish near the top (the "listening" element), and a pulsing amber warning light at the very
  // tip with a soft glow halo — the light is the loudest visual cue, deliberately unlike
  // anything in the building/outpost family.
  hex_alertTower: (sg) => {
    sg.fillStyle(0x2c2f34, 1); sg.fillRect(C.cx - 6, C.cy + 6, 12, 6);           // plinth base
    sg.fillStyle(0x3f444c, 1); sg.fillRect(C.cx - 5, C.cy + 6, 10, 2);           // plinth top-light edge
    sg.fillStyle(0x565b63, 1); sg.fillRect(C.cx - 1.6, C.cy - 14, 3.2, 20);      // thin vertical mast
    sg.fillStyle(0x676d76, 1); sg.fillRect(C.cx - 8, C.cy - 12, 16, 2.2);        // sensor crossbar
    sg.fillStyle(0x9098a3, 0.95); sg.fillEllipse(C.cx + 5.5, C.cy - 15, 6, 3.6); // angled dish
    sg.fillStyle(0x676d76, 0.9);  sg.fillEllipse(C.cx + 5.5, C.cy - 15, 3.2, 1.8);
    sg.fillStyle(0xd8462a, 0.35); sg.fillCircle(C.cx, C.cy - 17.5, 4.2);         // beacon glow halo
    sg.fillStyle(0xff6a3a, 0.95); sg.fillCircle(C.cx, C.cy - 17.5, 2);           // beacon light
  },
  // #395: a sealed dock's base tile is the SAME black bay as an open one — the "sealed" read comes
  // from the two door sprites (`hex_dockDoorL`/`hex_dockDoorR`) slid shut over this shaft, not from
  // the tile art. See `dockBay` for the shaft, and the door build pass in `buildHexTextures`.
  hex_dockClosed: (sg) => dockBay(sg),
  // #269 playtest follow-up: `objective` — a squat, reinforced bunker silhouette topped with a
  // bold red target-ring beacon, so it reads unmistakably as "the real objective," distinct from
  // the alertTower's slim sensor mast.
  hex_objective: (sg) => {
    sg.fillStyle(0x000000, 0.3); sg.fillEllipse(C.cx + 2, C.cy + 5, 30, 14);                  // ground shadow
    sg.fillStyle(0x25282e, 1); sg.fillRect(C.cx - 16, C.cy - 10, 32, 20);                     // bunker base/outline
    sg.fillStyle(0x454b53, 1); sg.fillRect(C.cx - 14, C.cy - 8, 28, 16);                      // armored face
    sg.fillStyle(0x565d66, 1); sg.fillRect(C.cx - 14, C.cy - 8, 28, 4);                       // top-light strip
    sg.fillStyle(0x25282e, 1); sg.fillRect(C.cx - 4, C.cy - 2, 8, 8);                          // reinforced hatch
    sg.fillStyle(0xb3392a, 0.3); sg.fillCircle(C.cx, C.cy - 13, 7);                             // beacon glow halo
    sg.fillStyle(0xd8342a, 0.95); sg.fillCircle(C.cx, C.cy - 13, 4.2);                          // target ring (outer)
    sg.fillStyle(0x25282e, 1);    sg.fillCircle(C.cx, C.cy - 13, 2.8);                          // target ring (punch-through)
    sg.fillStyle(0xff5a3a, 1); sg.fillCircle(C.cx, C.cy - 13, 1.6);                            // beacon core
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
  // #289/#464: the brush FLOOR (canopy clumps live in CANOPY_DETAIL.scrub) + a faint stubble of
  // cut stems — one tile for both the standing `scrub` hex and its cleared state.
  hex_scrubCleared: (sg) => clearedCoverFloor(sg, 0x8f7440, 0.55, 0x6b5730, 0xc2),
  // #278: mud — grassland's own in-map hazard: a soft boggy patch with glossy standing-water
  // pools and a few sunken cracked-mud rings, distinct from quicksand's cleaner sand-pit look.
  hex_mud: (sg) => {
    sg.fillStyle(0x352918, 0.6); sg.fillEllipse(C.cx, C.cy, 24, 14);
    sg.fillStyle(0x5c6a3a, 0.35); sg.fillEllipse(C.cx - 3, C.cy + 2, 12, 5);   // dull puddle sheen
    sg.fillStyle(0x241b0e, 0.5); sg.fillCircle(C.cx - 6, C.cy - 2, 2.4); sg.fillCircle(C.cx + 6, C.cy + 3, 1.8); // sunken pockmarks
    crackLine(sg, [[C.cx - 9, C.cy - 4], [C.cx - 1, C.cy], [C.cx + 8, C.cy - 3]], 0x2a2010, 0.6, 1);
  },
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
  // #289/#464: the packed-snow FLOOR (drift clumps live in CANOPY_DETAIL.drift) + faint
  // churned-snow flecks — one tile for both the standing `drift` hex and its cleared state.
  hex_driftCleared: (sg) => clearedCoverFloor(sg, 0xb2c3d3, 0.6, 0x93a6b6, 0xc3),
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
  // #289/#464: the scorched FLOOR (wreck piles live in CANOPY_DETAIL.wreck) + faint scattered
  // scraps — one tile for both the standing `wreck` hex and its cleared state. The intact tile's
  // ground-level smoulder glow went with the merge (owner-accepted).
  hex_wreckCleared: (sg) => clearedCoverFloor(sg, 0x35322d, 0.6, 0x201d19, 0xc4),
  // #110: debris field — a loose rubble-strewn street patch, lighter than a collapsed-tower heap.
  // #275: also urban's `channel` role now (see biomes.js) — a paved lane and a rubble-strewn
  // street both read as "urban street" well enough to share one texture.
  hex_debris: (sg) => rubbleScatter(sg, 0x35322d, 0x4a4640, 0x6a6258, 0x82),
  // #278: canal — urban's own channel: a flooded concrete drainage culvert. Straight parallel
  // concrete-lip edges (unlike the organic riverbank curve of `river`/`dryRiver`) with a
  // rippled water fill, so it reads as man-made rather than a natural stream.
  hex_canal: (sg) => {
    sg.fillStyle(0x293338, 0.85); sg.fillRect(C.cx - 14, C.cy - 7, 28, 14);   // concrete channel bed
    sg.fillStyle(0x3d5a63, 0.7); sg.fillRect(C.cx - 12, C.cy - 5, 24, 10);    // standing water
    sg.fillStyle(0x5a7d87, 0.4); sg.fillRect(C.cx - 12, C.cy - 5, 24, 1.5);   // concrete lip highlight
    sg.fillStyle(0x5a7d87, 0.4); sg.fillRect(C.cx - 12, C.cy + 3.5, 24, 1.5);
    sg.fillStyle(0x9fc4dd, 0.3); sg.fillEllipse(C.cx - 3, C.cy, 10, 1.6); sg.fillEllipse(C.cx + 6, C.cy - 2, 6, 1.2); // ripples
  },

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
  // #289/#464: the ashen FLOOR (ash mounds live in CANOPY_DETAIL.fumarole) + a faint vent ember
  // and cinder flecks — one tile for both the standing `fumarole` hex and its cleared state. The
  // intact tile's brighter vent ember went with the merge (owner-accepted).
  hex_fumaroleCleared: (sg) => {
    clearedCoverFloor(sg, 0x211d19, 0.6, 0x140f0c, 0xc5);
    sg.fillStyle(0xff6a1e, 0.15); sg.fillCircle(C.cx, C.cy, 5);
  },
  // #110: cinder field — a hot ash/ember patch, milder read than a full molten-lava pool.
  hex_cinderField: (sg) => {
    sg.fillStyle(0x341c0f, 0.6); sg.fillEllipse(C.cx, C.cy, 22, 13);
    sg.fillStyle(0xd8461a, 0.5); sg.fillCircle(C.cx - 3, C.cy + 1, 3);
    sg.fillStyle(0xff8a3a, 0.7); sg.fillCircle(C.cx - 3, C.cy + 1, 1.4);
    sg.fillStyle(0xff6a1e, 0.6); sg.fillCircle(C.cx + 6, C.cy - 3, 1);
  },
};

// #289: the "canopy" pass — the foliage/obstruction silhouette that used to be baked directly
// into each cover terrain's single combined texture (see the DETAIL.hex_forest/scrub/drift/
// wreck/fumarole comments above), now rendered as its OWN transparent-background texture so
// world.js can place it as a separate Image at a depth ABOVE ground units but BELOW the player/
// large units — a small unit standing in cover then reads as peeking out from under the canopy
// instead of being fully hidden beneath (or drawn flat on top of) one flat tile. Keyed by the
// bare terrain id (not the `hex_`-prefixed texture key) since `buildHexTextures` below drives
// this off `COVER_CANOPY_IDS`, not the PAL/tiles loop.
const CANOPY_DETAIL = {
  forest: (sg) => {
    for (const [dx, dy, r] of FOREST_TREES) tree(sg, C.cx + dx, C.cy + dy, r);
  },
  scrub: (sg) => {
    for (const [dx, dy, r] of CLUMP_SPOTS) {
      if ((dx + dy) % 2 === 0) continue;   // sparse: skip ~half the lattice (matches the old combined art)
      coverClump(sg, C.cx + dx, C.cy + dy, r * 0.8, 0x5c4a24, 0x7d6a34, 0xa89150);
    }
  },
  drift: (sg) => {
    for (const [dx, dy, r] of CLUMP_SPOTS) coverClump(sg, C.cx + dx, C.cy + dy, r, 0xa9bccb, 0xcfe0ec, 0xffffff);
  },
  wreck: (sg) => {
    for (const [dx, dy, r] of CLUMP_SPOTS) {
      if ((dx + 2 * dy) % 3 === 0) continue;
      coverClump(sg, C.cx + dx, C.cy + dy, r * 0.85, 0x2a2723, 0x4a453d, 0x6a6258, 0.4);
    }
  },
  fumarole: (sg) => {
    for (const [dx, dy, r] of CLUMP_SPOTS) coverClump(sg, C.cx + dx, C.cy + dy, r * 0.9, 0x1e1a17, 0x3a352f, 0x55504a);
  },
};
// The 5 cover terrain ids that get a separate canopy overlay texture (#289). Exported so
// world.js can iterate/check membership without re-deriving the list.
export const COVER_CANOPY_IDS = Object.keys(CANOPY_DETAIL);
// The canopy overlay texture key for a cover terrain id. Tolerates a `hex_` prefix, but #464 makes
// the BARE ID the only correct input from a caller holding a terrain id: since a standing cover hex
// shares its cleared twin's ground texture, passing `TERRAIN[id].tex` here names a
// `hex_forestCleared_canopy` that is never baked.
export function canopyTexKey(key) {
  const id = key.replace(/^hex_/, '');
  return `hex_${id}_canopy`;
}
export function isCoverCanopyId(key) {
  return CANOPY_DETAIL.hasOwnProperty(key.replace(/^hex_/, ''));
}

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
  // The abstract-arena tiles, which the biome loop below deliberately skips. (#464: this seed list
  // used to re-declare grass/river/deepWater/forest/rubble too — every one of them redundant with
  // the loop, and `hex_forest` no longer a tile at all now that a standing forest wears the same
  // ground texture as a cleared one.)
  const tiles = { hex_ground: PAL.ground, hex_groundB: PAL.groundB };
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
      // were stamped edge-to-edge across a very wide ring, which made every hex show the identical
      // bordered tile PLUS an identical "icon" (a wave swell, a rock butte, a rubble heap, a lava
      // pool) — an obviously-repeating tiled pattern rather than one continuous surface. So a
      // boundary tile drops the darker inset border band (an inset of >=1.0 instead of 0.9, the
      // fill running flush to and slightly past the true edge, see BOUNDARY_OVERDRAW_INSET) and
      // skips the terrain's DETAIL painter entirely.
      // #464: those five DETAIL painters were then DELETED — the guard below meant they could
      // never run, and #222's 4th pass went further still and stopped placing ring tiles at all
      // (world.js paints the camera background `terrainFillColor(B.deep)` instead), so nothing
      // renders these textures in play today. The guard stays because it's what makes that true,
      // and the textures themselves are still cheap to keep for the art gallery.
      const boundary = isBoundaryTerrainId(key);
      drawHex(sg, pal.fill, pal.edge, boundary ? BOUNDARY_OVERDRAW_INSET : 0.9, isImpassableTerrainId(key));
      if (!boundary) DETAIL[key]?.(sg);
    });
  }
  // #393: the wall reads as a SOLID, RAISED block so it's unmistakable against a (now flat-looking)
  // base-infra hex — and so a destroyed span reads as a real OPENING. Three stacked layers: a dark
  // drop-shadow footprint hugging the tile edge (the block sits "above" the ground and casts down),
  // a darker wall body, then a bright top-lit plate stepped in from the body — a visible ledge, not
  // a flat tile with a thin grid line.
  gen(scene, 'hex_wall', HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => {
    const sg = scaledGraphics(g);
    drawHex(sg, 0x1a1e25, 0x12151b, 0.98);          // drop-shadow footprint (the block's cast shadow)
    drawHex(sg, PAL.wall.fill, PAL.wall.edge, 0.86); // wall body, dark cool metal with a lit rim
    drawHex(sg, 0x4b5666, 0x363e49, 0.6);            // raised top plate, stepped in — the ledge
  });

  // #289: a SECOND, separate texture-build pass for each cover terrain's canopy overlay — a
  // transparent-background image containing ONLY the tree/foliage silhouette (`CANOPY_DETAIL`
  // above), no ground fill. `gen()` starts every texture's backing canvas fully transparent, and
  // nothing here paints outside the silhouette shapes, so the unpainted background stays see-
  // through. world.js places this as a second Image per cover hex, above the ground tile.
  for (const id of COVER_CANOPY_IDS) {
    gen(scene, canopyTexKey(id), HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => {
      const sg = scaledGraphics(g);
      CANOPY_DETAIL[id](sg);
    });
  }

  // #395: the two dock DOOR leaves — each a transparent-background half-hex panel of vertical metal
  // slats (like the canopy pass, only its own shapes are opaque). world.js/bases.js place a pair of
  // these over a dock hex's black bay and tween them apart to open / together to close.
  gen(scene, DOCK_DOOR_TEX.L, HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => dockDoor(scaledGraphics(g), -1));
  gen(scene, DOCK_DOOR_TEX.R, HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => dockDoor(scaledGraphics(g), +1));
}
