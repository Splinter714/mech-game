// Procedural hex-tile art. Pointy-top hexes sized from hexgrid's HEX_SIZE, drawn as a
// filled polygon with a subtle inset so adjacent tiles read as a grid. A dark
// battlefield palette keeps the bright mech + weapon barrels popping. The arena places
// one of these at each hex centre (hexgrid.hexToPixel).

import { gen, scaledGraphics, ART_SCALE } from './_frames.js';
import { HEX_SIZE, hexCorners, hexToPixel } from '../data/hexgrid.js';
import { TERRAIN } from '../data/terrain.js';
import { drawWallSpans } from './wallArt.js';
import { WALL_THICKNESS_PX } from '../data/wallEdges.js';

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
// IRRATIONAL, so on-screen it never lands on a whole device pixel. Phaser used to snap each
// tile sprite's rendered position to a whole pixel independently every frame (`pixelArt: true`
// forces `roundPixels: true`). #455 turned that snapping OFF game-wide — it was also what made
// the mech's arms/shoulders jostle against the body — so this particular seam should no longer
// occur at all. The bleed below is KEPT regardless: overlapping tile edges are harmless, and it
// costs nothing to stay robust to sub-pixel seams. The original diagnosis, for the record: as
// the camera scrolls
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
// DETAIL painters for `deepWater`/`mesa`/`ice`/`collapsed`/`lava`.
//
// #464 (playtest, owner: "I'm still seeing the art for the deep hexes, which we talked about not
// needing"): the five GROUND TEXTURES themselves are now gone too. `buildHexTextures` skips these
// ids entirely, so `hex_deepWater`/`hex_mesa`/`hex_ice`/`hex_collapsed`/`hex_lava` are never
// baked. Nothing in the arena ever placed them (world.js skips boundary hexes in both its tile
// loop and its edge pass), and the art gallery derives its rows from which textures EXIST, so the
// biomes' `deep` role now drops out of the gallery by itself. The ids' PAL and TERRAIN entries
// STAY: the ring's `passable: false` is the invisible wall keeping the mech in the corridor, and
// the PAL fill is what `terrainFillColor` hands the camera background.
export { isBoundaryTerrainId, BOUNDARY_ONLY_IDS };


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
// #471: the stubble used to be a 7-speck `speckle` inside a ±15px box — a little clump in the
// middle of a 48-radius tile. It's a full-tile mottle lattice now (see `stubbleSpots`), so the
// remnants read as scattered evenly across the cleared ground.
function clearedCoverFloor(sg, floor, floorAlpha, stubble, seed) {
  coverFloor(sg, floor, floorAlpha);
  mottle(sg, stubbleSpots(seed), stubble, 0.22);
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

// (#471: the hand-placed `crackLine` polyline helper is gone — every tile that drew one drew it
// mid-tile, and they all use the full-tile `streaks` network now. Its `segQuad` stroke helper went
// with the #471 playtest follow-up: `streaks` builds the stroke quad itself so it can clip the
// QUAD — not just the centreline — to the tile.)

// ── #471 playtest follow-up: DETAIL NEVER SPILLS PAST THE HEX BORDER ──────────────────────
// The full-tile primitives (#447's `mottle`, #471's `streaks`/`buildSlabs`) all place a mark by
// its CENTRE and then draw a shape of some size around it, so a mark seeded near the rim painted
// its outer half over the neighbouring tile — a blotch's radius, a slab's half-width, a stroke's
// half-width. The owner sees that as texture bleeding outside the hex outline.
//
// The fix is geometric, not a fudge factor: every mark is clipped as a POLYGON against the true
// hex (Sutherland–Hodgman over the six inward half-planes), so the painted pixels stop exactly
// at the border. Note this is the DETAIL layer only — the base fill keeps its `HEX_BLEED`
// overdraw (see `drawHex`), which is what stops the hairline seams of #255. Fill may bleed;
// marks may not.
//
// Clipping (rather than shrinking or dropping rim marks) is also what preserves #471's
// channel-continuity property: a streak still runs right up to the edge and terminates ON it, so
// the neighbouring tile — painting the same lattice-periodic pattern — picks it up at the very
// same point.

// Clip a convex polygon (flat [x0,y0,x1,y1,…] offsets from the hex centre) to the pointy-top
// hexagon of circumradius `s`. Returns a new flat array, or null if nothing survives.
function clipPolyToHex(poly, s) {
  const corners = hexCorners(s);
  let cur = poly;
  for (let e = 0; e < 6 && cur.length; e++) {
    const a = corners[e], b = corners[(e + 1) % 6];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    if (-a.x * nx - a.y * ny < 0) { nx = -nx; ny = -ny; }   // inward normal (the centre is inside)
    const dist = (x, y) => (x - a.x) * nx + (y - a.y) * ny; // ≥ 0 means inside this edge
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const j = (i + 2) % cur.length;
      const x0 = cur[i], y0 = cur[i + 1], x1 = cur[j], y1 = cur[j + 1];
      const d0 = dist(x0, y0), d1 = dist(x1, y1);
      if (d0 >= 0) next.push(x0, y0);
      if ((d0 >= 0) !== (d1 >= 0)) {
        const t = d0 / (d0 - d1);
        next.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      }
    }
    cur = next;
  }
  return cur.length >= 6 ? cur : null;
}

// Paint a centre-relative polygon clipped to the tile, as a triangle fan (the scaledGraphics
// wrapper has fillTriangle but no clip/mask API).
function fillClippedPoly(sg, poly, s = HEX_SIZE) {
  const c = clipPolyToHex(poly, s);
  if (!c) return;
  for (let i = 2; i + 3 < c.length; i += 2) {
    sg.fillTriangle(C.cx + c[0], C.cy + c[1], C.cx + c[i], C.cy + c[i + 1],
      C.cx + c[i + 2], C.cy + c[i + 3]);
  }
}

// Is an axis-aligned ellipse (centre dx,dy, radii rx,ry) wholly inside the hex? Exact: compare
// each edge's signed distance from the centre against the ellipse's support along that normal.
function ellipseInHex(dx, dy, rx, ry, s) {
  const corners = hexCorners(s);
  for (let e = 0; e < 6; e++) {
    const a = corners[e], b = corners[(e + 1) % 6];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    if (-a.x * nx - a.y * ny < 0) { nx = -nx; ny = -ny; }
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const d = (dx - a.x) * nx + (dy - a.y) * ny;            // distance from the ellipse centre
    if (d < Math.hypot(rx * nx, ry * ny)) return false;     // support radius along this normal
  }
  return true;
}

// An ellipse as a polygon, for the clipped path.
function ellipsePoly(dx, dy, rx, ry, segs = 20) {
  const p = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    p.push(dx + Math.cos(t) * rx, dy + Math.sin(t) * ry);
  }
  return p;
}


// A generic rubble scatter (broken slabs over a scorched base), palette-driven per biome.
// #471: was a 26x20 ellipse of scorch with 7 slabs inside ±11px of the centre — a small heap in
// the middle of a big empty tile. Now the scorch is a full-tile mottle and the slabs come from a
// full-tile `buildSlabs` lattice, so the debris field covers the whole hex.
function rubbleScatter(sg, baseCol, slabCol, litCol, ashSpots, slabSpots, baseAlpha = 0.5) {
  mottle(sg, ashSpots, baseCol, baseAlpha);
  for (const [dx, dy, w, h] of slabSpots) {
    sg.fillStyle(slabCol, 1); clippedRect(sg, dx, dy, w, h);
    sg.fillStyle(litCol, 1); clippedRect(sg, dx, dy - h / 2 + 0.6, w, 1.2);  // top-lit edge
  }
}

// An ellipse mark clipped to the tile — the same fits-inside-fast-path / clip-the-polygon rule
// `mottle` uses, for a one-off shape that isn't part of a mottle set (e.g. a chunk's drop shadow).
function clippedEllipse(sg, dx, dy, rx, ry) {
  if (ellipseInHex(dx, dy, rx, ry, HEX_SIZE)) sg.fillEllipse(C.cx + dx, C.cy + dy, rx * 2, ry * 2);
  else fillClippedPoly(sg, ellipsePoly(dx, dy, rx, ry));
}

// #475 (owner: debris "needs more chunky-ness maybe?"). `rubbleScatter` paints each slab as ONE
// flat rect with a lit top edge — fine for a dense heap, but a strewn street of those reads as
// small loose SCRAPS with no weight. A chunk is the same rectangle given mass: a soft drop shadow
// under it, a dark body, a lit top face inset from the body (so the piece has a visible thickness
// rather than being a painted patch), and a dark cast edge along its lower side. Bigger, fewer and
// solid-looking — which is the whole ask. Everything clips to the tile like every other mark.
function chunkScatter(sg, baseCol, ashSpots, chunkSpots, darkCol, bodyCol, litCol, baseAlpha = 0.5) {
  mottle(sg, ashSpots, baseCol, baseAlpha);
  for (const [dx, dy, w, h] of chunkSpots) {
    sg.fillStyle(0x000000, 0.34);
    clippedEllipse(sg, dx + w * 0.12, dy + h * 0.42, w * 0.62, h * 0.5);   // ground shadow under the mass
    sg.fillStyle(darkCol, 1); clippedRect(sg, dx, dy, w, h);               // dark body
    sg.fillStyle(bodyCol, 1); clippedRect(sg, dx - w * 0.06, dy - h * 0.18, w * 0.86, h * 0.62); // top face
    sg.fillStyle(litCol, 1);
    clippedRect(sg, dx - w * 0.06, dy - h * 0.42, w * 0.86, h * 0.16);     // top-lit leading edge
  }
}

// #464: the three bespoke soft-cover debris scatters that lived here (`organicDebrisScatter`,
// `iceShardScatter`, `cinderScatter`) are gone with the `*Rubble` tiles they painted — see the
// `rubbleId` note in data/terrain.js. `rubbleScatter` above stays: `hex_debris` still uses it.

// #447: DIFFUSE FULL-TILE TEXTURE. A hex is HEX_SIZE=48 across the circumradius, but most DETAIL
// painters below draw hand-placed shapes within roughly ±13px of the centre — so they read as a
// small motif parked in the middle of a large empty tile, and (worse) that motif repeats
// identically at the same spot on every hex of that terrain. `buildMottle` instead lays soft
// blotches on a jittered lattice covering the WHOLE hex (the same recipe the forest/cover lattices
// use), so the terrain reads as one continuous vague surface with no centre to it. Deterministic,
// so the texture is stable build-to-build; built once at module load, not per bake.
// Returns [dx, dy, rx, ry] offsets from the hex centre.
function buildMottle(seed, step, rMin, rMax, squash = 0.55, inset = 0.94) {
  const s = HEX_SIZE * inset;
  const rnd = seeded(seed);
  const n = Math.ceil(HEX_SIZE / step) + 1;
  const spots = [];
  for (let row = -n; row <= n; row++) {
    const oy = row * step * 0.86;
    const xoff = (row & 1) ? step / 2 : 0;
    for (let col = -n; col <= n; col++) {
      const dx = col * step + xoff + (rnd() - 0.5) * step * 0.9;
      const dy = oy + (rnd() - 0.5) * step * 0.9;
      const rx = rMin + rnd() * (rMax - rMin);
      const ry = rx * (squash + rnd() * 0.35);
      if (inHex(dx, dy, s)) spots.push([dx, dy, rx, ry]);
    }
  }
  return spots;
}

// Paint one mottle layer (a set of `buildMottle` spots) in a single colour/alpha. Layering two or
// three of these — a lighter dry tone, a darker wet tone, a faint sheen — is what makes the surface
// read as vague and organic rather than as a stamped shape.
// A blotch that fits inside the tile is drawn as a plain ellipse; one that would overhang the
// border is drawn as its clipped polygon instead, so the layer still reaches the rim without
// painting over the neighbour (see the clipping note above `clipPolyToHex`).
function mottle(sg, spots, color, alpha, scale = 1) {
  sg.fillStyle(color, alpha);
  for (const [dx, dy, rx0, ry0] of spots) {
    const rx = rx0 * scale, ry = ry0 * scale;
    if (ellipseInHex(dx, dy, rx, ry, HEX_SIZE)) sg.fillEllipse(C.cx + dx, C.cy + dy, rx * 2, ry * 2);
    else fillClippedPoly(sg, ellipsePoly(dx, dy, rx, ry));
  }
}

// A rectangular mark (rubble/debris slab), clipped to the tile the same way.
function clippedRect(sg, dx, dy, w, h) {
  const x0 = dx - w / 2, y0 = dy - h / 2, x1 = x0 + w, y1 = y0 + h;
  if (inHex(x0, y0, HEX_SIZE) && inHex(x1, y0, HEX_SIZE)
    && inHex(x1, y1, HEX_SIZE) && inHex(x0, y1, HEX_SIZE)) {
    sg.fillRect(C.cx + x0, C.cy + y0, w, h);
    return;
  }
  fillClippedPoly(sg, [x0, y0, x1, y0, x1, y1, x0, y1]);
}

// ── #471: DETAIL THAT CONTINUES ACROSS THE TILE BOUNDARY ──────────────────────────────────
// Mottle (above) fixes "the motif sits in the middle of the tile", but it doesn't fix the OTHER
// half of the problem the #447 audit found on the channel tiles (`river`/`slush`/`canal`): a
// river hex has to read as a river RUNNING THROUGH, i.e. its ripples have to line up with the
// neighbouring river hex's ripples across the shared edge. Every hex of a terrain shares ONE
// baked texture, so the only way to get that is to make the texture PERIODIC UNDER THE HEX
// LATTICE.
//
// The trick: pick feature seeds inside the hex (one fundamental domain of the lattice), then
// also emit every lattice TRANSLATE of each feature, and clip the lot to the hex. If P is the
// resulting lattice-invariant pattern and H the hex, each tile paints P ∩ H — so the world,
// which is ∪_L ((P ∩ H) + L), equals P ∩ ∪_L (H + L) = P. A streak that leaves the right edge
// of one tile re-enters the left edge of its neighbour at exactly the same point, because the
// neighbour is painting the same pattern shifted by exactly that lattice vector. No neighbour
// awareness needed at bake time, and no per-hex texture variants.
//
// Lattice translates out to ring 2 — a streak seeded anywhere in the hex reaches at most
// ~HEX_SIZE + streak length, which ring 2 covers for every length used here.
export const HEX_LATTICE = (() => {
  const v = [];
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      if (Math.abs(q + r) > 2) continue;
      const p = hexToPixel(q, r);
      v.push([p.x, p.y]);
    }
  }
  return v;
})();

// Clip a segment to the pointy-top hexagon of circumradius `s` (convex parametric clip against
// the six edge half-planes). Returns [x0, y0, x1, y1] or null if the segment misses the hex.
// This is what keeps the lattice translates from painting over the neighbouring tile.
export function clipSegToHex(x0, y0, x1, y1, s) {
  const pts = hexCorners(s);
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 6; i++) {
    const a = pts[i], b = pts[(i + 1) % 6];
    let nx = -(b.y - a.y), ny = b.x - a.x;               // a normal of this edge
    if (-a.x * nx - a.y * ny < 0) { nx = -nx; ny = -ny; } // orient it inward (centre is inside)
    const f0 = (x0 - a.x) * nx + (y0 - a.y) * ny;         // signed distance at t=0
    const g = dx * nx + dy * ny;                          // rate of change along the segment
    if (Math.abs(g) < 1e-9) { if (f0 < 0) return null; continue; }
    const t = -f0 / g;
    if (g > 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
    if (t0 > t1) return null;
  }
  return [x0 + dx * t0, y0 + dy * t0, x0 + dx * t1, y0 + dy * t1];
}

// Build a lattice-periodic set of streak polylines — flow lines, ripple crests, fracture cracks.
// Seeds are drawn uniformly from INSIDE the hex (the fundamental domain), each walks `segs` steps
// of `len / segs` in a direction that wanders by up to `wobble` radians per step, and every seed
// is then replicated at all `HEX_LATTICE` offsets. `angle` pins the base heading (radians, null =
// random per streak); `angleJitter` is how far each streak may deviate from it — 0 gives the dead-
// straight parallel lines a man-made culvert wants, PI gives an every-which-way fracture web.
// Returns polylines as flat arrays of plane coords: [x0, y0, x1, y1, …] offset from the hex centre.
// Exported (with `clipSegToHex` and `HEX_LATTICE`) so the tile-to-tile continuity property can be
// asserted directly in hexArt.test.js rather than inferred from the baked pixels.
// `wave: { amp, period, jitter }` swaps the random walk for a real SINE — the streak holds one
// heading and swings side to side across it by `amp` px every `period` px of travel (both jittered
// by ±`jitter` per streak, default ±25%, with a random phase; a SMALL jitter is what makes a set of
// lines read as one regular map-symbol treatment rather than a field of individual squiggles).
// That's the difference between a gently-wobbled straight and a mark
// that is visibly SQUIGGLY: the wander is a repeating undulation, not a drift, so the path reverses
// its turn direction several times over its length. `segs` becomes the sampling resolution of the
// curve, so a waved streak wants many more of them (~2px per sample) than a walked one. Still built
// from one seed inside the fundamental domain and replicated over the lattice, so periodicity —
// hence tile-to-tile channel continuity — is untouched by the shape of the path.
// `curl` (#475) is the third path shape: a CONSTANT turn rate (radians per step, sign picked at
// random per streak) that the wobble rides on top of, so the path sweeps steadily around one way
// instead of wandering. Over enough steps that's an arc / part-spiral — a SWIRL, which is what
// quicksand wants and what no amount of `wobble` gives you (wobble is a drift with no preferred
// direction, so it averages out to a straightish line).
export function buildStreaks(seed, { count, len, segs = 3, wobble = 0.3, angle = null, angleJitter = Math.PI, wave = null, curl = 0 }) {
  const rnd = seeded(seed);
  const hw = HEX_SIZE * SQRT3 / 2;
  const bases = [];
  while (bases.length < count) {
    const sx = (rnd() - 0.5) * 2 * hw, sy = (rnd() - 0.5) * 2 * HEX_SIZE;
    if (!inHex(sx, sy, HEX_SIZE)) continue;
    let th = (angle === null ? rnd() * Math.PI * 2 : angle + (rnd() - 0.5) * 2 * angleJitter);
    if (wave) {
      const j = wave.jitter ?? 0.25;
      const amp = wave.amp * (1 - j + rnd() * 2 * j);
      const period = wave.period * (1 - j + rnd() * 2 * j);
      const phase = rnd() * Math.PI * 2;
      const dx = Math.cos(th), dy = Math.sin(th);
      const line = [];
      for (let i = 0; i <= segs; i++) {
        const s = (i / segs) * len;
        const o = amp * Math.sin((s / period) * Math.PI * 2 + phase);
        line.push(sx + dx * s - dy * o, sy + dy * s + dx * o);
      }
      bases.push(line);
      continue;
    }
    const step = len / segs;
    const line = [sx, sy];
    const spin = curl === 0 ? 0 : (rnd() < 0.5 ? -curl : curl);
    let x = sx, y = sy;
    for (let i = 0; i < segs; i++) {
      th += spin + (rnd() - 0.5) * 2 * wobble;
      x += Math.cos(th) * step; y += Math.sin(th) * step;
      line.push(x, y);
    }
    bases.push(line);
  }
  const out = [];
  for (const line of bases) {
    for (const [ox, oy] of HEX_LATTICE) {
      const t = new Array(line.length);
      for (let i = 0; i < line.length; i += 2) { t[i] = line[i] + ox; t[i + 1] = line[i + 1] + oy; }
      out.push(t);
    }
  }
  return out;
}

// #475: a SELF-SIMILAR fracture web. `buildStreaks` gives a field of cracks that are all the same
// size — uniform scale, so the eye reads "hatching" rather than "this ice broke". A real fracture
// branches: a trunk splits into shorter limbs, each of which splits again into shorter twigs. This
// builds exactly that, `levels` generations deep, each generation `shrink`× the length of its
// parent and attached AT one of the parent's own vertices (so the web is connected, not a pile of
// loose sticks). Returns one lattice-replicated line set PER LEVEL — the caller strokes level 0
// widest/brightest down to the twigs, which is what makes the self-similarity legible.
// Each trunk seed is drawn from inside the hex (the fundamental domain) exactly as `buildStreaks`
// does, and the whole tree is replicated over `HEX_LATTICE`, so the periodicity that makes a mark
// continue into the neighbouring tile is preserved — including a branch attachment, since parent
// and child are translated by the same lattice vector.
export function buildFractalCracks(seed, { count, len, levels = 3, segs = 3, wobble = 0.3, shrink = 0.52, branches = 2 }) {
  const rnd = seeded(seed);
  const hw = HEX_SIZE * SQRT3 / 2;
  const out = Array.from({ length: levels }, () => []);

  const walk = (sx, sy, th0, L) => {
    const step = L / segs;
    const line = [sx, sy];
    let x = sx, y = sy, th = th0;
    for (let i = 0; i < segs; i++) {
      th += (rnd() - 0.5) * 2 * wobble;
      x += Math.cos(th) * step; y += Math.sin(th) * step;
      line.push(x, y);
    }
    return line;
  };

  const grow = (sx, sy, th, L, lvl) => {
    const line = walk(sx, sy, th, L);
    out[lvl].push(line);
    if (lvl + 1 >= levels) return;
    for (let b = 0; b < branches; b++) {
      const vi = 1 + Math.floor(rnd() * segs);               // a vertex of the parent, never its root
      const ax = line[vi * 2], ay = line[vi * 2 + 1];
      const ph = Math.atan2(ay - line[vi * 2 - 1], ax - line[vi * 2 - 2]);   // parent heading there
      const off = (0.45 + rnd() * 0.65) * (rnd() < 0.5 ? -1 : 1);           // ~26°–63° off the parent
      grow(ax, ay, ph + off, L * shrink, lvl + 1);
    }
  };

  let made = 0;
  while (made < count) {
    const sx = (rnd() - 0.5) * 2 * hw, sy = (rnd() - 0.5) * 2 * HEX_SIZE;
    if (!inHex(sx, sy, HEX_SIZE)) continue;
    grow(sx, sy, rnd() * Math.PI * 2, len, 0);
    made++;
  }

  return out.map((lines) => {
    const rep = [];
    for (const line of lines) {
      for (const [ox, oy] of HEX_LATTICE) {
        const t = new Array(line.length);
        for (let i = 0; i < line.length; i += 2) { t[i] = line[i] + ox; t[i + 1] = line[i + 1] + oy; }
        rep.push(t);
      }
    }
    return rep;
  });
}

// Paint a `buildStreaks` set, clipping each sub-segment to the tile so a translate that only
// grazes this hex contributes just the sliver that belongs to it. The stroke is then clipped as a
// QUAD as well (#471 follow-up) — clipping the centreline alone still let half the stroke width
// paint past the border where a line met the edge.
function streaks(sg, lines, color, alpha, width) {
  sg.fillStyle(color, alpha);
  for (const line of lines) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const c = clipSegToHex(line[i], line[i + 1], line[i + 2], line[i + 3], HEX_SIZE);
      if (!c) continue;
      const dx = c[2] - c[0], dy = c[3] - c[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * (width / 2), ny = (dx / len) * (width / 2);
      fillClippedPoly(sg, [c[0] + nx, c[1] + ny, c[2] + nx, c[3] + ny,
        c[2] - nx, c[3] - ny, c[0] - nx, c[1] - ny]);
    }
  }
}

// A full-tile scatter of broken slabs (rubble/debris), on the same jittered lattice as `mottle`.
// Returns [dx, dy, w, h] offsets from the hex centre.
function buildSlabs(seed, step, wMin, wMax) {
  const s = HEX_SIZE * 0.94;
  const rnd = seeded(seed);
  const n = Math.ceil(HEX_SIZE / step) + 1;
  const out = [];
  for (let row = -n; row <= n; row++) {
    const oy = row * step * 0.86;
    const xoff = (row & 1) ? step / 2 : 0;
    for (let col = -n; col <= n; col++) {
      const dx = col * step + xoff + (rnd() - 0.5) * step * 0.9;
      const dy = oy + (rnd() - 0.5) * step * 0.9;
      const w = wMin + rnd() * (wMax - wMin);
      const h = w * (0.5 + rnd() * 0.5);
      if (inHex(dx, dy, s)) out.push([dx, dy, w, h]);
    }
  }
  return out;
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

// #447: mud's four diffuse layers, each its own scatter across the whole tile — a lighter drying
// crust, darker water-logged patches, a faint greenish sheen where water still stands, and a fine
// pitting of hoof/track pockmarks. Different steps/sizes per layer so no two layers line up and the
// result reads as vague boggy ground rather than a pattern.
const MUD_DRY = buildMottle(0xd1, 11, 4.5, 9, 0.55);
const MUD_WET = buildMottle(0xd2, 9, 3.5, 7.5, 0.5);
const MUD_SHEEN = buildMottle(0xd3, 15, 2.2, 5, 0.4);
const MUD_PITS = buildMottle(0xd4, 8, 0.7, 1.7, 0.8);

// ── #471: the rest of the audit's centre-motif tiles ──────────────────────────────────────
// Each tile keeps its OWN language so they don't all collapse into "mud in a different hue":
// what varies is which primitives it uses (blotch layers vs. fracture streaks vs. slab lattice
// vs. ember points), how tight/loose the lattices are, and the palette. Built once at module load.

// TIER 1 — quicksand: clean warm sand, no cracks and no hard edges; its signature is long, soft
// surface RIPPLES over pale/damp blotching (mud has pitting and no ripples).
// #475 (owner: quicksand "could be more swirly/wet looking"). Two changes, both in that direction
// and neither of them a crack (cracks are dryRiver's language and stay out of this tile):
//   SWIRLY — the ripples are `curl`ed now (see buildStreaks), so each one sweeps steadily around
//     one way into an arc rather than wandering; a second, tighter, shorter set curls harder still,
//     so the surface reads as sand being drawn round in eddies. A `wet` sheen set curls with them.
//   WET — the damp layer goes darker and more saturated, and gains a specular SHEEN pass (a pale
//     cool highlight over the pale sand, the same trick slush uses for standing water) plus a dark
//     saturated soak underneath, so the pit looks waterlogged instead of dusty.
const QS_PALE = buildMottle(0xe1, 12, 5, 10, 0.5);
const QS_DAMP = buildMottle(0xe2, 10, 4, 8, 0.5);
const QS_GRAIN = buildMottle(0xe3, 7, 0.6, 1.4, 0.9);
const QS_SOAK = buildMottle(0x110, 14, 5, 11, 0.55);
const QS_SHEEN = buildMottle(0x111, 16, 3.5, 8, 0.45);
const QS_RIPPLE = buildStreaks(0xe4, { count: 18, len: 40, segs: 10, wobble: 0.12, curl: 0.26 });
const QS_EDDY = buildStreaks(0x112, { count: 14, len: 26, segs: 9, wobble: 0.1, curl: 0.42 });
// Exported for the swirl property test — "the ripples actually curl round" is exactly the kind of
// intent a count/containment check can't see (see the river's wave test for the same lesson).
export const QUICKSAND_SWIRL_SETS = { ripple: QS_RIPPLE, eddy: QS_EDDY };

// TIER 1 — brokenIce: big PALE PLATES with dark water in the gaps and a bright FRACTURE WEB
// (short, near-straight, every direction) — the crack network is the read, not a single crack.
// #475 (owner: broken ice "could be slightly more fractal, but overall looks good"). A light touch:
// the palette, the plates, the water in the gaps and the pressure ridges all stay. Only the crack
// WEB changes — it was 26 cracks all the same 26px length (uniform scale reads as hatching), and is
// now a three-generation branching tree (`buildFractalCracks`): a few trunks, each splitting into
// roughly-half-length limbs, each splitting again into twigs, strokes thinning per generation. Same
// number of marks on screen, self-similar structure instead of one size.
const ICE_PLATE = buildMottle(0xe5, 17, 6, 12.5, 0.62);
const ICE_WATER = buildMottle(0xe6, 11, 3, 6.5, 0.5);
export const ICE_CRACK_LEVELS = buildFractalCracks(0xe7, {
  count: 6, len: 30, levels: 3, segs: 3, wobble: 0.24, shrink: 0.5, branches: 2,
});
// #471 playtest follow-up: the long wandering crest lines #471 gave the RIVER read as ice, not as
// water ("would be great for ice or something, but looks horrible as a river"). They move here —
// brokenIce keeps its own identity (pale plates, dark water in the gaps, the short fracture web)
// and gains those long lattice-continuous lines as PRESSURE RIDGES running through the floe. They
// replace the old duplicate bright-lip pass over ICE_CRACK, so the tile doesn't get busier — the
// bright tone now travels along the ridges instead of double-drawing the same short cracks.
const ICE_RIDGE = buildStreaks(0x103, { count: 16, len: 46, segs: 4, wobble: 0.22 });
const ICE_GLINT = buildStreaks(0x104, { count: 18, len: 20, segs: 2, wobble: 0.3 });

// TIER 1 — cinderField: the point-light tile. Dark ash blotching with MANY small embers scattered
// right across the hex (crust does its glow as lines, this one as points).
// #475 (owner: "cinder field should look like a combination between cinder field and crust"). It
// keeps its ember POINTS — that's still what the tile is — but gains crust's MATERIAL: dark cooled
// plates with a seam network running between them, so the embers now sit in a broken-plate surface
// instead of on featureless ash. (The plates/seams are crust's own primitives at cinderField's
// scale; `crust` itself is untouched here — it's volcanic's channel and gets reworked separately.)
const CIN_ASH = buildMottle(0xe8, 12, 5, 10, 0.5);
const CIN_WARM = buildMottle(0xe9, 15, 4, 8.5, 0.5);
const CIN_EMBER = buildMottle(0xea, 11, 0.7, 1.6, 0.9);
const CIN_PLATE = buildMottle(0x113, 16, 5, 11.5, 0.6);
const CIN_SEAM = buildStreaks(0x114, { count: 16, len: 30, segs: 3, wobble: 0.3 });

// TIER 1 — crust: dark cooled plates with a MOLTEN CRACK NETWORK glowing through — same fracture
// primitive as brokenIce, inverted palette (dark plate / hot line instead of pale plate / cold line).
const CRUST_PLATE = buildMottle(0xeb, 15, 5, 11, 0.6);
const CRUST_WARM = buildMottle(0xec, 19, 4, 9, 0.5);
const CRUST_CRACK = buildStreaks(0xed, { count: 20, len: 30, segs: 3, wobble: 0.3 });

// TIER 1 — dryRiver: a baked bed. Dense, FINE, dark crazing (many more, much shorter streaks than
// crust's cracks) over warm bed tones and pale dry sandbanks. No glow anywhere.
const DR_BED = buildMottle(0xee, 12, 5, 10, 0.5);
const DR_BANK = buildMottle(0xef, 16, 4, 9, 0.45);
const DR_CRAZE = buildStreaks(0xf0, { count: 34, len: 17, segs: 2, wobble: 0.5 });

// TIER 1 — rubble vs. debris: the same slab primitive at two densities. `rubble` is a collapsed
// structure (bigger slabs, tightly packed); `debris` is a strewn street (smaller scraps, looser).
const RUBBLE_ASH = buildMottle(0xf1, 12, 5, 10, 0.55);
const RUBBLE_SLABS = buildSlabs(0xf2, 11, 5, 9);
const RUBBLE_GAPS = buildMottle(0xf3, 14, 1.2, 2.6, 0.8);
// #475 (owner: debris "needs work... needs more chunky-ness maybe?"). The pieces were 3–6px wide
// scraps on a 14px lattice — small and flat. They're 7–12px CHUNKS on a 17px lattice now: bigger
// individual pieces, fewer of them, and drawn by `chunkScatter` (shadow + body + inset lit top
// face) so each one has real mass. Rubble stays a different read for a different reason than size:
// it's a tight-packed HEAP of slabs with dark voids between them, this is a street with big solid
// pieces lying loose on it.
const DEBRIS_ASH = buildMottle(0xf4, 13, 5, 10, 0.55);
const DEBRIS_SLABS = buildSlabs(0xf5, 17, 7, 12);
// Exported so the "debris is chunky" property can be asserted on PIECE SIZE (the thing the owner
// actually asked for) rather than on a mark count, which would have pinned the old scrappy look.
export const SLAB_SETS = { rubble: RUBBLE_SLABS, debris: DEBRIS_SLABS };

// TIER 3 — the CHANNELS. All three use `buildStreaks`, so the water lines run straight across the
// hex boundary into the next channel tile (see the lattice note above). They stay distinct by how
// the lines behave: river = long, fast, wandering crests; slush = few, broad, sluggish drags under
// ice skins; canal = dead-straight parallel courses plus a cross-run of culvert joints.
const RIV_BED = buildMottle(0xf6, 13, 5, 10, 0.5);
const RIV_DEEP = buildMottle(0xf7, 16, 4, 9, 0.5);
// #471 playtest follow-up — river, fourth pass. History, so nobody oscillates back: (1) a dense
// lattice of crest lines read as ice, not water; (2) calming it cut the count but left the marks
// literally straight (arc/endpoint 1.001×); (3) a real sine fixed the straightness but at ~3.4
// swings per line over two sets it became its own busy TEXTURE — "should be simpler texture so it
// blends with the 'deep' better, simple horizontal wave lines".
//
// So: the classic map-symbol water treatment. ONE set, five lines, pinned HORIZONTAL (angle 0,
// essentially no angle jitter), a gentle regular undulation — amplitude 2.6px over a 24px period,
// ~2¼ swings across a 54px line — and only ±12% jitter on amp/period so the lines read as one
// repeated symbol rather than five individual squiggles. The bright glint set is GONE; the single
// remaining colour sits close to the water fill (0x2f6d86) so the marks recede into it.
const RIV_FLOW = buildStreaks(0xf8, {
  count: 5, len: 54, segs: 24, angle: 0, angleJitter: 0.05,
  wave: { amp: 2.6, period: 24, jitter: 0.12 },
});
// Exported for the wave property test — "the river's lines actually undulate" is the one thing a
// density/containment test can't see, and it's exactly how an earlier pass shipped wrong.
export const RIVER_STREAK_SETS = { flow: RIV_FLOW };
const SLU_WATER = buildMottle(0xfa, 12, 5, 10, 0.5);
const SLU_SKIN = buildMottle(0xfb, 16, 5.5, 11, 0.62);
const SLU_SPARK = buildMottle(0xfc, 13, 0.6, 1.3, 0.9);
const SLU_DRAG = buildStreaks(0xfd, { count: 16, len: 30, segs: 2, wobble: 0.16 });
const CAN_STAIN = buildMottle(0xfe, 13, 4, 9, 0.5);
const CAN_FLOW = buildStreaks(0xff, { count: 16, len: 62, segs: 1, angle: 0, angleJitter: 0.02 });
const CAN_JOINT = buildStreaks(0x101, { count: 9, len: 62, segs: 1, angle: Math.PI / 3, angleJitter: 0.02 });

// TIER 4 — fumaroleCleared's vent embers: several small hot points spread over the tile instead of
// the one glow disc parked at dead centre.
const FUM_VENT = buildMottle(0x102, 24, 0.9, 2.0, 0.9);

// TIER 4 — the `*Cleared` floors' stubble. The old `speckle` call scattered it inside a ±15px box,
// so every cleared hex had a small clump of stems in the middle and bare floor out to the edges.
// One full-tile lattice per biome seed, built lazily and cached (five tiles, once at boot).
const STUBBLE = new Map();
function stubbleSpots(seed) {
  if (!STUBBLE.has(seed)) STUBBLE.set(seed, buildMottle(seed, 9, 0.7, 1.9, 0.85));
  return STUBBLE.get(seed);
}

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
  // Shallow river: fast water you can wade/shoot over, with the sandy bed showing through.
  // #471 (tier 3): the ripples used to be nine short ellipses clustered mid-tile, so a river of
  // ten hexes read as ten identical stamps rather than one stream. They're `buildStreaks` now —
  // long wandering crests that leave one edge and continue into the neighbouring river hex at
  // exactly the same point. #471 playtest: that first pass was TOO BUSY to read as water at all —
  // the crest lattice looked like ice (it has since moved to `brokenIce`). The river is calm now:
  // a mostly flat water tone, a few broad soft current lines and the odd glint, all still
  // lattice-periodic so a run of river hexes remains one continuous stream. #471 playtest, again:
  // those calm lines were still STRAIGHT, then the sine that fixed that overshot into a texture of
  // its own. Now it's the map-symbol read: five plain horizontal wave lines on flat water (see
  // RIV_FLOW above), in a tone close to the water fill so they blend into the deep instead of
  // sitting on top of it.
  hex_river: (sg) => {
    mottle(sg, RIV_DEEP, 0x1f4f64, 0.18);          // deeper channel shadow, softened
    mottle(sg, RIV_BED, 0x6d8a7a, 0.10);           // sandy bed faintly through the shallows
    streaks(sg, RIV_FLOW, 0x6ea8bd, 0.12, 2.4);    // simple horizontal wave lines, low contrast
  },
  // #464: the five BOUNDARY-ONLY ids (deepWater / mesa / ice / collapsed / lava) have no DETAIL
  // painter — `buildHexTextures` has skipped them since #222 (they'd tile into an obviously-
  // repeating pattern across the ring), and since #222's 4th pass the ring isn't even rendered as
  // tiles. Their PAL + TERRAIN entries are load-bearing and stay; only the dead art is gone.

  // Rubble: a scatter of broken slabs + ash over the ashen base — the remains of a stomped outpost.
  // #471: was 7 hand-placed chunks on a 26x20 scorch ellipse. Now the heap covers the whole hex —
  // BIG slabs on a TIGHT lattice with dark voids between them, so it reads as a collapsed
  // structure. (`debris` uses the same primitive at smaller size and looser spacing: a strewn
  // street, not a heap.)
  hex_rubble: (sg) => {
    rubbleScatter(sg, 0x24262b, 0x3a3d44, 0x4c4f57, RUBBLE_ASH, RUBBLE_SLABS, 0.55);
    mottle(sg, RUBBLE_GAPS, 0x191b1f, 0.5);   // dark voids down between the slabs
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
  // A cracked, dry riverbed.
  // #471: was a 26x12 bed ellipse with two cracks and a sandbank streak, all mid-tile. Now the
  // whole hex is baked bed: warm bed tone, pale dry sandbanks, and DENSE FINE CRAZING — many more,
  // much shorter cracks than crust's molten network, and nothing glowing.
  hex_dryRiver: (sg) => {
    mottle(sg, DR_BED, 0x836838, 0.38);           // damp-dark bed
    mottle(sg, DR_BANK, 0xc7a666, 0.24);          // sun-bleached dry sandbanks
    streaks(sg, DR_CRAZE, 0x6a5228, 0.55, 1.0);   // fine crazed mud-crack network
  },
  // #289/#464: the brush FLOOR (canopy clumps live in CANOPY_DETAIL.scrub) + a faint stubble of
  // cut stems — one tile for both the standing `scrub` hex and its cleared state.
  hex_scrubCleared: (sg) => clearedCoverFloor(sg, 0x8f7440, 0.55, 0x6b5730, 0xc2),
  // #278: mud — grassland's own in-map hazard: a boggy patch, distinct from quicksand's cleaner
  // sand-pit look.
  // #447: reworked from a CENTRAL MOTIF (one 24x14 puddle ellipse, two pockmarks and a crack line,
  // all inside ~±12px of a 48-radius hex) to a DIFFUSE, VAGUE TEXTURE covering the whole tile — the
  // old version left most of the hex flat and put an obvious repeated blob dead centre on every mud
  // hex. Four overlapping full-tile mottle layers, low alpha, no shape you can name.
  hex_mud: (sg) => {
    mottle(sg, MUD_DRY, 0x5c4926, 0.34);    // drying crust, slightly lighter than the fill
    mottle(sg, MUD_WET, 0x2e2210, 0.40);    // water-logged darker patches
    mottle(sg, MUD_SHEEN, 0x5c6a3a, 0.13);  // faint dull sheen where water still stands
    mottle(sg, MUD_PITS, 0x241b0e, 0.35);   // fine pitting / churned pockmarks
  },
  // #110: quicksand — a sunken, rippled pit distinct from the dry-riverbed channel.
  // #471: was a 22x14 ellipse + a 14x8 highlight + one crack, all within ±11px of the centre. Now
  // the whole tile is soft sand: pale sunlit blotches, damp sunken blotches, fine grain, and long
  // shallow surface ripples running right off the edges. No cracks — that's dryRiver's language.
  // #475: swirlier and wetter. The ripples curl into eddies (two sets, the tighter one over the
  // broad one), and a dark saturated soak plus a pale specular sheen make the surface read as
  // waterlogged sand being drawn round rather than dry sand with lines on it. Still no cracks.
  hex_quicksand: (sg) => {
    mottle(sg, QS_PALE, 0xa5854a, 0.30);           // pale sunlit dry sand
    mottle(sg, QS_SOAK, 0x2e2410, 0.30);           // dark saturated soak — water in the sand
    mottle(sg, QS_DAMP, 0x53431f, 0.34);           // damp, sunken hollows
    streaks(sg, QS_RIPPLE, 0x6b5830, 0.26, 3.0);   // broad swirling drag, dark side
    streaks(sg, QS_RIPPLE, 0xc7a877, 0.22, 1.6);   // its lit crest
    streaks(sg, QS_EDDY, 0xd8c092, 0.20, 1.2);     // tighter eddies curling into the pit
    mottle(sg, QS_SHEEN, 0xdfd8bd, 0.13);          // wet specular sheen sitting on the surface
    mottle(sg, QS_GRAIN, 0x6b5830, 0.18);          // fine grain
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
  // Half-frozen melt: cold water under ice skins.
  // #471 (tier 3): same continuous-channel treatment as `river`, tuned SLUGGISH — few, broad,
  // barely-wandering drags instead of many long fast crests, mostly hidden under pale ice skins.
  // That's what keeps it from reading as "river in a cold palette".
  hex_slush: (sg) => {
    mottle(sg, SLU_WATER, 0x5c7c92, 0.34);         // cold melt water
    streaks(sg, SLU_DRAG, 0x7f9cb0, 0.40, 3.2);    // slow, broad drag of the current
    mottle(sg, SLU_SKIN, 0xdbe7f0, 0.32);          // ice skins floating on it
    mottle(sg, SLU_SPARK, 0xffffff, 0.45);         // frost sparkle
  },
  // #289/#464: the packed-snow FLOOR (drift clumps live in CANOPY_DETAIL.drift) + faint
  // churned-snow flecks — one tile for both the standing `drift` hex and its cleared state.
  hex_driftCleared: (sg) => clearedCoverFloor(sg, 0xb2c3d3, 0.6, 0x93a6b6, 0xc3),
  // #110: broken ice — thin cracked plates over cold water, lighter/weaker read than solid ice.
  // #471: was a 20x10 ellipse with a single crack across it. Now the plates and the fracture web
  // cover the whole hex — big pale plates, cold water showing in the gaps between them, and a
  // network of short bright fractures in every direction (crust uses the same web, hot and dark).
  hex_brokenIce: (sg) => {
    mottle(sg, ICE_WATER, 0x2c4a5e, 0.34);       // cold water in the gaps
    mottle(sg, ICE_PLATE, 0xa9c6d8, 0.30);       // pale floating plates
    // #475: the fracture web is a branching tree now — trunks, then half-length limbs, then twigs,
    // each generation thinner and fainter, so the break reads as self-similar rather than as a
    // field of same-sized cracks.
    streaks(sg, ICE_CRACK_LEVELS[0], 0x2f5069, 0.50, 2.0);  // trunk fractures
    streaks(sg, ICE_CRACK_LEVELS[1], 0x3a5b70, 0.45, 1.3);  // limbs splitting off them
    streaks(sg, ICE_CRACK_LEVELS[2], 0x466b80, 0.38, 0.8);  // twigs
    streaks(sg, ICE_RIDGE, 0x7fb0c8, 0.38, 2.2); // long pressure ridges running through the floe
    streaks(sg, ICE_GLINT, 0xe4f2fa, 0.45, 1.2); // light catching along the ridge crests
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
  // #475: chunkier — bigger, fewer, solid-looking pieces (shadow + body + lit top face) instead of
  // small flat scraps. See the DEBRIS_SLABS note above.
  hex_debris: (sg) => chunkScatter(sg, 0x35322d, DEBRIS_ASH, DEBRIS_SLABS, 0x2a2723, 0x4f4a43, 0x6f675c, 0.5),
  // #278: canal — urban's own channel: a flooded concrete drainage culvert. Straight parallel
  // concrete-lip edges (unlike the organic riverbank curve of `river`/`dryRiver`) with a
  // rippled water fill, so it reads as man-made rather than a natural stream.
  // #471 (tier 3): the culvert used to be a 28x14 concrete box centred on the tile, so a run of
  // canal hexes read as a row of separate bathtubs. Now it's built from the same continuous streak
  // system as `river`/`slush`, but with the angle jitter and wobble taken to ~zero: DEAD-STRAIGHT
  // parallel courses, plus a sparse cross-run of joints at 60°. Straightness and regularity are
  // what make it read as man-made next to the river's wandering natural crests.
  hex_canal: (sg) => {
    mottle(sg, CAN_STAIN, 0x293338, 0.34);        // concrete staining / silt
    streaks(sg, CAN_JOINT, 0x1f2a2f, 0.45, 1.2);  // culvert joints running across the course
    streaks(sg, CAN_FLOW, 0x5a7d87, 0.35, 1.6);   // straight concrete lips + channelled water
    streaks(sg, CAN_FLOW, 0x9fc4dd, 0.16, 0.7);   // a thin highlight along each course
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
  // Cooling lava crust: dark plates with molten cracks glowing through.
  // #471: was three hand-placed cracks over a 26x16 ellipse. Now a full-tile network of molten
  // cracks over full-tile dark plates — the glow is LINEAR here, which is what separates crust
  // from cinderField's field of glowing POINTS.
  hex_crust: (sg) => {
    mottle(sg, CRUST_PLATE, 0x140c09, 0.45);       // dark cooled plates
    mottle(sg, CRUST_WARM, 0x3a1408, 0.34);        // heat still in the rock
    streaks(sg, CRUST_CRACK, 0xff5a14, 0.80, 1.4); // molten crack
    streaks(sg, CRUST_CRACK, 0xffc23a, 0.55, 0.6); // white-hot core of the crack
  },
  // #289/#464: the ashen FLOOR (ash mounds live in CANOPY_DETAIL.fumarole) + a faint vent ember
  // and cinder flecks — one tile for both the standing `fumarole` hex and its cleared state. The
  // intact tile's brighter vent ember went with the merge (owner-accepted).
  // #471: the vent ember was one 5px glow disc parked at dead centre of every fumarole hex. It's
  // now a handful of small vents spread over the tile — same "the ground is still venting" read,
  // no bullseye.
  hex_fumaroleCleared: (sg) => {
    clearedCoverFloor(sg, 0x211d19, 0.6, 0x140f0c, 0xc5);
    mottle(sg, FUM_VENT, 0xff6a1e, 0.10, 3.4);   // vent glow
    mottle(sg, FUM_VENT, 0xff8a3a, 0.40);        // ember at the vent mouth
  },
  // #110: cinder field — a hot ash/ember patch, milder read than a full molten-lava pool.
  // #471: was a 22x13 scorch ellipse with two embers in it. Now a full-tile ash field with embers
  // scattered right across it — many small glowing POINTS (crust glows in lines, this in dots).
  // #475 (owner: "cinder field should look like a combination between cinder field and crust"):
  // crust's cooled-plate material — dark plates with a hot seam network running between them —
  // now carries cinderField's own scattered ember points, which stay the brightest thing on the
  // tile. `crust` is deliberately unchanged; the two are meant to converge here.
  hex_cinderField: (sg) => {
    mottle(sg, CIN_ASH, 0x241209, 0.40);            // cold ash
    mottle(sg, CIN_PLATE, 0x18100b, 0.42);          // dark cooled plates (crust's material)
    mottle(sg, CIN_WARM, 0x6b2a10, 0.28);           // heat-soaked patches
    streaks(sg, CIN_SEAM, 0xc4400f, 0.55, 1.4);     // the seams between the plates, still hot
    streaks(sg, CIN_SEAM, 0xffa23a, 0.35, 0.6);     // brighter core down in the seam
    mottle(sg, CIN_EMBER, 0xd8461a, 0.16, 3.2);     // each ember's soft halo
    mottle(sg, CIN_EMBER, 0xff8a3a, 0.7);           // the ember itself
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
    // #464 (playtest): the five world-boundary-only ids (deep water / mesa / ice / collapsed /
    // lava) get NO tile at all. #222's 4th pass stopped placing ring tiles in the arena — the ring
    // is one flat camera-background fill (`terrainFillColor(B.deep)`, world.js) — so these
    // textures had no renderer left anywhere except the art gallery, where they showed up as five
    // flat "deep" swatches the owner asked to be rid of. Their PAL entries stay (that fill is
    // exactly what the camera background reads); only the baked tile goes.
    if (isBoundaryTerrainId(key)) continue;
    tiles[`hex_${key}`] = pal;
  }
  for (const [key, pal] of Object.entries(tiles)) {
    gen(scene, key, HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => {
      const sg = scaledGraphics(g);
      drawHex(sg, pal.fill, pal.edge, 0.9, isImpassableTerrainId(key));
      DETAIL[key]?.(sg);
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

  // #483 follow-up: a straight WALL SEGMENT for the locked-target preview pod — one clean
  // horizontal span drawn with the REAL wall art (`drawWallSpans`, the no-clear body of
  // drawWallEdges), so a targeted span reads as an actual piece of wall rather than the `hex_wall`
  // hex-TILE block viewed head-on. Baked ONCE here like every other hex texture; the pod just
  // sprites it (HudScene stays paint-only). drawWallSpans works in raw pixels, so the span coords
  // and thickness are pre-multiplied by ART_SCALE to super-sample like the rest of the art.
  gen(scene, 'hex_wallSegment', HEX_TEX_W * ART_SCALE, HEX_TEX_H * ART_SCALE, (g) => {
    const y = (HEX_TEX_H / 2) * ART_SCALE;
    const x0 = 6 * ART_SCALE, x1 = (HEX_TEX_W - 6) * ART_SCALE;
    drawWallSpans(g, [{ x0, y0: y, x1, y1: y, hp: 1, maxHp: 1, role: 'wall' }], WALL_THICKNESS_PX * ART_SCALE);
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
