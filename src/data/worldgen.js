// Pure procedural map generation (#81, reworked #110/#111) — the seeded terrain-stamping
// algorithm behind `scenes/arena/world.js` `_buildWorld`, extracted so it can run (and be
// unit-tested) without a Phaser scene. Given a seed + biome + world radius + a "safe zone"
// centre, this always produces the SAME terrain/buildingHp/coverHp maps for the same inputs —
// the arena mixin is just the thin wrapper that turns the result into tile Images and stores it
// on `this`. No Phaser here; this is the pure data layer, same spirit as data/mission.js and
// data/run.js.
//
// #111: the whole run's terrain is now built ONCE, upfront, at deploy time — there is no more
// per-stage incremental growth (the old #81 "grow a fresh organic lobe each stage advance"
// mechanism). `_buildWorld` calls this with one generously-sized organic region (see
// FULL_BUILD_BASE_RADIUS/VARIATION below) covering everywhere the player could plausibly reach
// across an entire run; stage advance (scenes/arena/run.js) only picks a new objective + spawns
// a new squad inside that already-built terrain, never rebuilds it.
import { axialKey, range, neighbors, hexToPixel, pixelToHex, distance, HEX_SIZE } from './hexgrid.js';
import { buildingHp as buildingHpOf, isSoftCover } from './terrain.js';

// Small seeded PRNG (mulberry32) — deterministic given `a`, so the same seed always yields
// the same terrain layout.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The hex keys the safe-clear zone occupies when centered at `center` — a filled disc of
// `radius` hexes (default 3, matching the original fixed spawn clearing). Exported so the
// geometry alone is unit-testable, independent of the rest of generation.
export function safeZoneKeys(center, radius = 3) {
  return range(center, radius).map((h) => axialKey(h.q, h.r));
}

// Generate one deterministic terrain layout. `biome` is a resolved biome record (data/
// biomes.js getBiome() result). `safeCenter` (default world origin, matching the original
// always-clear-the-centre behaviour) is cleared back to open ground so nothing spawns
// stranded there; `extraClear` is a list of additional hex keys (e.g. the debug DUMMY_HEX)
// force-cleared regardless of the RNG, same as before.
//
// `included` (optional `(q, r) => boolean`, e.g. from `organicBoundary`) restricts which hexes
// are actually part of the playable area at all — a hex outside `included` never gets a tile
// (stays undefined). Omitting it (the default) falls back to the full `worldRadius` disc.
//
// #110: `boundaryRing` (optional Set of hex keys, e.g. from `boundaryRingKeys`) stamps every
// hex it contains with the biome's `deep` terrain id — the world's outer boundary — regardless
// of `included` (these hexes are, by construction, just OUTSIDE the included shape). This is
// the ONLY place `biome.deep` is ever stamped now; the old in-map "deep blob" is gone (see
// `hasHazard`/`hazard` below).
export function generateTerrain({
  seed, worldRadius, biome, safeCenter = { q: 0, r: 0 }, extraClear = [],
  included = null, boundaryRing = null,
}) {
  const R = worldRadius;
  const rng = mulberry32(seed);
  const all = range({ q: 0, r: 0 }, R).filter((h) => !included || included(h.q, h.r));
  // The actual extent of the playable area (may be far smaller than the `worldRadius`
  // bounding box once `included` carves an organic shape out of it) — feature density/spread
  // below scales off this, not the raw bounding radius, so a small map doesn't get a
  // worldRadius-sized dose of channel/cover meant for a much bigger disc.
  const effR = all.length
    ? Math.max(5, ...all.map((h) => distance(h, { q: 0, r: 0 })))
    : R;
  const T = new Map();
  const B = biome;
  const groundAt = (h) => ((h.q + h.r) % 2 ? B.groundB : B.groundA);
  const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };

  // Base: a checkered open floor (grass / sand / snow / pavement / ash by biome).
  for (const h of all) T.set(axialKey(h.q, h.r), groundAt(h));

  // Channel: a winding strip sweeping across the map — river / dry-bed / slush / road / lava-crust.
  if (B.hasChannel) {
    for (let q = -effR + 2; q <= effR - 2; q++) {
      const r = Math.round(7 * Math.sin(q * 0.26) + 3 * Math.sin(q * 0.11));
      for (const dr of [0, 1]) { const k = axialKey(q, r + dr); if (T.has(k)) T.set(k, B.channel); }
    }
  }

  // #110: a LESSER in-map hazard blob (quicksand / broken ice / debris / cinder field — never
  // the biome's reserved-for-boundary `deep` id anymore), grown as a blobby disc so its edge
  // reads naturally; kept clear of the world's true centre (deliberately NOT `safeCenter` — the
  // hazard avoids world origin specifically so it stays a stable landmark independent of where
  // the player is). Grassland has no `hazard` (its channel already reads as the "watch your
  // footing" role) — `hasHazard` is false there, so this block simply doesn't run.
  if (B.hasHazard) {
    const spot = all[Math.floor(rng() * all.length)];
    if (Math.hypot(hexToPixel(spot.q, spot.r).x, hexToPixel(spot.q, spot.r).y) > 6 * 48) {
      for (const h of range(spot, 3)) {
        const d = Math.max(Math.abs(h.q - spot.q), Math.abs(h.r - spot.r), Math.abs(h.q + h.r - spot.q - spot.r));
        const k = axialKey(h.q, h.r);
        if (T.has(k) && rng() < 1 - d * 0.28) T.set(k, B.hazard);
      }
    }
  }

  // Cover clusters scattered across the field (seed + organic neighbour growth) — walk-through
  // cover (forest / scrub / snowdrift / wreckage / fumarole). Density scales per biome.
  for (let i = 0; i < Math.round(effR * 2.2 * B.coverClusters); i++) {
    const c = all[Math.floor(rng() * all.length)];
    const k0 = axialKey(c.q, c.r);
    if (!isGround(k0)) continue;
    T.set(k0, B.cover);
    for (const n of neighbors(c.q, c.r)) {
      const k = axialKey(n.q, n.r);
      if (isGround(k) && rng() < 0.6) T.set(k, B.cover);
    }
  }

  // A few DESTRUCTIBLE outposts (building clusters) — hard cover. HP seeded below.
  for (let i = 0; i < B.outposts; i++) {
    const c = all[Math.floor(rng() * all.length)];
    for (const h of [c, ...neighbors(c.q, c.r).filter(() => rng() < 0.55)]) {
      const k = axialKey(h.q, h.r); if (T.has(k)) T.set(k, B.outpost);
    }
  }

  // Clear the safe zone (spawn point + line of fire) back to open ground.
  for (const h of range(safeCenter, 3)) { const k = axialKey(h.q, h.r); if (T.has(k)) T.set(k, groundAt(h)); }
  // Force-clear any extra hexes (e.g. the debug DUMMY_HEX) regardless of the RNG.
  for (const k of extraClear) {
    if (!T.has(k)) continue;
    T.set(k, B.groundA);
  }

  // #110: stamp the boundary ring LAST (and unconditionally) — these hexes sit just OUTSIDE
  // `included`/`all`, so nothing above ever touched them; this is the one and only place
  // `biome.deep` is written to the terrain map.
  if (boundaryRing) {
    for (const k of boundaryRing) T.set(k, B.deep);
  }

  const buildingHp = new Map();   // hexKey → remaining HP for destructible OUTPOST (solid) hexes
  const coverHp = new Map();      // hexKey → remaining HP for destructible soft-cover hexes
  for (const [k, id] of T) {
    const hp = buildingHpOf(id);
    if (hp > 0) (isSoftCover(id) ? coverHp : buildingHp).set(k, hp);
  }
  return { terrain: T, buildingHp, coverHp };
}

// #81 (organic growth rewrite), #111 (single upfront build): tunable shape constants.
// SECTORS: how many angular wedges the per-direction boundary noise is sampled at — enough
// to read as an irregular coastline once smoothed, not so many it looks noisy.
// FULL_BUILD_BASE_RADIUS/VARIATION: the size of the ONE-TIME whole-run build (#111). Sized
// generously for the whole run's escalation: STAGE_COUNT is 5 (data/run.js) and the OLD
// incremental system added one ~13(+/-4)-hex organic lobe per stage advance on top of a
// ~12(+/-4)-hex opening area, i.e. a worst-case cumulative reach of roughly
// 16 + 4*17 = 84 hexes — which is why MAX_WORLD_RADIUS was already set to 80 as that system's
// hard cap. The new single build reuses that same total-size budget in one pass: a base radius
// of 62 + up to 16 hexes of organic variation reaches up to 78 hexes from the origin, just
// inside MAX_WORLD_RADIUS, leaving room for the boundary ring (see below) to sit just outside
// the shape's own edge without exceeding the old cap. This is a ONE-TIME generation cost paid
// at deploy (not per-stage), so the extra up-front generation time is an acceptable tradeoff —
// but it's still bounded by the same overall budget the old growth system used, so it doesn't
// balloon tile count/perf versus what a full run already generated before.
export const SECTORS = 20;
export const FULL_BUILD_BASE_RADIUS = 62;
export const FULL_BUILD_VARIATION = 16;
// MAX_WORLD_RADIUS: the hard reference cap the full build's max reach (BASE + VARIATION) stays
// inside of, plus a couple of hexes' headroom for the boundary ring outside the shape's edge.
export const MAX_WORLD_RADIUS = 80;

// #126 (playtest: black void visible past the boundary ring at some camera positions/zooms):
// BOUNDARY_RING_WIDTH is sized from the actual worst-case camera view distance, not a guessed
// constant, so the fix is a real guarantee rather than "probably fine."
//
// The camera's world-space viewport: `ArenaScene.create()` sets `cameras.main.setZoom(dpr)`,
// and `main.js` sizes the Phaser canvas to `window.innerWidth * dpr` x `window.innerHeight *
// dpr` (physical pixels, for crisp HiDPI rendering). Camera zoom divides the canvas size back
// down, so the visible world-space rect is exactly `innerWidth x innerHeight` CSS px — the dpr
// term cancels. 1 world unit === 1 CSS px at zoom 1 (see hexToPixel/HEX_SIZE).
//
// The camera follows the player (`startFollow(.12, .12)` lerp) and CONVERGES to being exactly
// centred on the player at rest — so the farthest point ever visible from the player's own
// position is half the viewport's diagonal (the screen's far corner). The player's own
// worst-case position is flush against the boundary ring itself (the ring is impassable, so
// that's as close as a mech can ever stand to it) — meaning the ring's rendered depth has to
// cover that whole half-diagonal, with no credit for any extra buffer.
//
// WORST_CASE_VIEWPORT_*: sized off the largest common consumer display resolution (4K UHD,
// 3840x2160) rather than an exotic 5K/8K/ultrawide monitor — those extreme/unbounded cases (plus
// a user zooming their browser far out, which effectively enlarges `window.innerWidth/Height` in
// CSS px beyond any fixed constant) are covered by a second, independent backstop: the arena's
// camera background colour is painted to match the current biome's `deep` terrain fill
// (scenes/arena/world.js `_buildWorld`), so even a viewport wider than this ring anticipates
// blends into "more deep terrain" at the horizon instead of snapping to raw black. The ring
// width below is the "make it look right, not just fail safe" layer; the background colour is
// the "never literally black" guarantee.
const WORST_CASE_VIEWPORT_W = 3840;
const WORST_CASE_VIEWPORT_H = 2160;
// 30% headroom on top of the raw 4K half-diagonal for camera-follow overshoot on a fast stop,
// non-fullscreen browser chrome quirks, and modest zoom-out.
const VIEW_DEPTH_SAFETY_MARGIN = 1.3;
// Exported (not just an internal const) so worldgen.test.js can assert BOUNDARY_RING_WIDTH
// actually derives from — and covers — this figure, rather than re-guessing a magic number.
export const REQUIRED_VIEW_DEPTH_PX =
  0.5 * Math.hypot(WORST_CASE_VIEWPORT_W, WORST_CASE_VIEWPORT_H) * VIEW_DEPTH_SAFETY_MARGIN; // ≈2864px
// Euclidean centre-to-centre distance between adjacent hexes — constant in every direction on
// this regular grid (unlike the hex "distance" metric), so it's the real px depth each BFS ring
// layer in `boundaryRingKeys` adds outward.
export const HEX_STEP_PX = HEX_SIZE * Math.sqrt(3); // ≈83.14px for HEX_SIZE=48
// BOUNDARY_RING_WIDTH: how many hexes thick the impassable boundary ring is, just outside the
// pre-built area's own organic edge. Derived (not guessed) from the camera math above, so it's
// guaranteed to outrun the farthest any real camera can ever see from the farthest any player
// can ever stand — see the backstop note above for what covers viewports even bigger than this.
export const BOUNDARY_RING_WIDTH = Math.ceil(REQUIRED_VIEW_DEPTH_PX / HEX_STEP_PX); // = 35

// The per-sector boundary distances (in hex units) for one organic region: a base radius +
// randomized variation per angular sector, smoothed by averaging each sector with its two
// neighbours (wrapping around the full circle) so the outline reads as a rolling, irregular
// coastline rather than spiky noise. Exported separately from `organicBoundary` so the
// variation itself is directly unit-testable without going through hex/angle math.
export function sectorBoundaries(rng, { baseRadius, variation = baseRadius * 0.35, sectors = SECTORS } = {}) {
  const raw = Array.from({ length: sectors }, () => baseRadius + (rng() * 2 - 1) * variation);
  return raw.map((d, i) => (raw[(i - 1 + sectors) % sectors] + d * 2 + raw[(i + 1) % sectors]) / 4);
}

// An organic (non-circular) region predicate: a hex belongs to the shape iff its distance
// from `center` is within that angle's smoothed sector boundary (see `sectorBoundaries`).
// Boundary distance is linearly interpolated between the two nearest sector samples so the
// edge doesn't visibly facet at sector boundaries. Returns `(q, r) => boolean`, the same
// shape `generateTerrain`'s `included` option expects — this is what shapes the WHOLE
// pre-built run's outer edge (#111), built once, not grown incrementally.
export function organicBoundary(center, rng, opts = {}) {
  const sectors = opts.sectors ?? SECTORS;
  const boundaries = sectorBoundaries(rng, { ...opts, sectors });
  const sectorAngle = (Math.PI * 2) / sectors;
  const { x: cx, y: cy } = hexToPixel(center.q, center.r);
  return (q, r) => {
    const { x, y } = hexToPixel(q, r);
    const dx = x - cx, dy = y - cy;
    const distHex = Math.hypot(dx, dy) / HEX_SIZE;
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += Math.PI * 2;
    const idx = angle / sectorAngle;
    const i0 = Math.floor(idx) % sectors;
    const i1 = (i0 + 1) % sectors;
    const frac = idx - Math.floor(idx);
    const boundary = boundaries[i0] * (1 - frac) + boundaries[i1] * frac;
    return distHex <= boundary;
  };
}

// #110: given an `included` region-membership predicate (typically `organicBoundary`'s
// result) and a generous bounding radius, returns the Set of hex keys forming a ring
// `ringWidth` hexes thick immediately OUTSIDE the included shape — the world's impassable
// outer boundary. Found by BFS-expanding outward from the shape's own edge (rather than
// stamping a fixed-radius circle), so the ring hugs the organic, irregular coastline the same
// way the shape itself is irregular, instead of reading as a perfect disc around it.
export function boundaryRingKeys(included, {
  ringWidth = BOUNDARY_RING_WIDTH, boundingRadius = MAX_WORLD_RADIUS + BOUNDARY_RING_WIDTH + 2,
} = {}) {
  const insideSet = new Set();
  for (const h of range({ q: 0, r: 0 }, boundingRadius)) {
    if (included(h.q, h.r)) insideSet.add(axialKey(h.q, h.r));
  }
  let frontier = insideSet;
  const ring = new Set();
  for (let layer = 0; layer < ringWidth; layer++) {
    const next = new Set();
    for (const k of frontier) {
      const [q, r] = k.split(',').map(Number);
      for (const n of neighbors(q, r)) {
        const nk = axialKey(n.q, n.r);
        if (insideSet.has(nk) || ring.has(nk) || next.has(nk)) continue;
        next.add(nk);
      }
    }
    for (const k of next) ring.add(k);
    frontier = next;
  }
  return ring;
}

// #81: pick the next stage's objective from the still-standing outpost hex keys, biased
// toward one that's actually far from `fromHex` (the player's continuing position) — so
// reaching it takes a real drive across the terrain rather than a step to an adjacent hex.
// Pure (no RNG): ranks candidates by hex distance from `fromHex`, farthest first, and returns
// the farthest one that clears `minDistance`; if none clear the floor (e.g. a small biome with
// few outposts) falls back to the single farthest candidate so a stage is never left without
// an objective. Ties among equal distances break on the sorted hex-key order (same
// deterministic rule `_initMission` uses for stage 0).
//
// #111: since the whole map is built upfront (no more per-stage growth region), every stage —
// including the very first — just picks from the full standing-outpost set; `reveal` is kept
// as an optional filter for callers that still want to scope the search, but nothing in the
// live game passes it anymore.
export const FAR_OBJECTIVE_MIN_DIST = 6;
export function pickFarObjective(hexKeys, fromHex, minDistance = FAR_OBJECTIVE_MIN_DIST, reveal = null) {
  if (!hexKeys || !hexKeys.length) return null;
  const candidates = reveal
    ? hexKeys.filter((k) => { const [q, r] = k.split(',').map(Number); return reveal(q, r); })
    : hexKeys;
  if (!candidates.length) return null;
  const ranked = [...candidates].sort().map((k) => {
    const [q, r] = k.split(',').map(Number);
    return { k, d: distance({ q, r }, fromHex) };
  }).sort((a, b) => b.d - a.d);
  const farEnough = ranked.find((c) => c.d >= minDistance);
  return (farEnough ?? ranked[0]).k;
}
