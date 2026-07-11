// Pure procedural map generation (#81) — the seeded terrain-stamping algorithm behind
// `scenes/arena/world.js` `_buildWorld`, extracted so it can run (and be unit-tested)
// without a Phaser scene. Given a seed + biome + world radius + a "safe zone" centre, this
// always produces the SAME terrain/buildingHp/coverHp maps for the same inputs — the arena
// mixin is just the thin wrapper that turns the result into tile Images and stores it on
// `this`. No Phaser here; this is the pure data layer, same spirit as data/mission.js and
// data/run.js.
//
// #81 also moved the "regenerate a fresh map each stage" + "no teleport" logic here: the
// safe-clear zone (previously a fixed ring around hex (0,0)) now clears around whatever hex
// `safeCenter` names — the arena passes the player's CURRENT hex on stage advance so the new
// terrain never strands the mech in a lake/wall, without moving its actual world position.
import { axialKey, range, neighbors, hexToPixel, pixelToHex, distance, HEX_SIZE } from './hexgrid.js';
import { buildingHp as buildingHpOf, isSoftCover } from './terrain.js';

// Small seeded PRNG (mulberry32) — deterministic given `a`, so the same seed always yields
// the same terrain layout. #81: the seed itself now varies per stage (arena/world.js draws
// a fresh one by default each call); this function is unchanged, just relocated.
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
// #81 (organic growth rewrite): `included` (optional `(q, r) => boolean`, e.g. from
// `organicBoundary`/`growRegion`) restricts which hexes are actually part of the playable
// area at all — a hex outside `included` never gets a tile (stays undefined, same as "off
// the old fixed disc" used to read). Omitting it (the default) falls back to the full
// `worldRadius` disc, matching the pre-#81-growth behavior.
//
// #81 follow-up (partial regen): `reveal` (optional `(q, r) => boolean`) and
// `previous` (optional `{ terrain, buildingHp, coverHp }` — the just-finished stage's live
// maps) together opt into a PARTIAL regeneration instead of the full stamp. When both are
// supplied, every hex where `reveal(q, r)` is false is snapped back to its exact previous
// value (terrain id AND remaining destructible HP, byte-identical) instead of the fresh stamp
// computed below; only hexes where `reveal` is true keep the newly generated content. With
// neither argument (the default), every hex keeps its fresh stamp — this is the original
// full-map behavior, unchanged, so the very first stage's build (and any caller that
// doesn't opt in) is unaffected.
export function generateTerrain({
  seed, worldRadius, biome, safeCenter = { q: 0, r: 0 }, extraClear = [],
  reveal = null, previous = null, included = null,
}) {
  const R = worldRadius;
  const rng = mulberry32(seed);
  const all = range({ q: 0, r: 0 }, R).filter((h) => !included || included(h.q, h.r));
  // The actual extent of the playable area (may be far smaller than the `worldRadius`
  // bounding box once `included` carves an organic shape out of it) — feature density/spread
  // below scales off this, not the raw bounding radius, so a small starting map doesn't get a
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

  // A DEEP impassable blob off to one side (lake / mesa / ice / collapsed heap / lava pool),
  // distinct from the channel. Grown as a blobby disc so its edge reads naturally; kept clear
  // of the world's true centre (deliberately NOT `safeCenter` — the deep blob avoids world
  // origin specifically so it stays a stable landmark independent of where the player is).
  if (B.hasDeep) {
    const deep = all[Math.floor(rng() * all.length)];
    if (Math.hypot(hexToPixel(deep.q, deep.r).x, hexToPixel(deep.q, deep.r).y) > 6 * 48) {
      for (const h of range(deep, 3)) {
        const d = Math.max(Math.abs(h.q - deep.q), Math.abs(h.r - deep.r), Math.abs(h.q + h.r - deep.q - deep.r));
        const k = axialKey(h.q, h.r);
        if (T.has(k) && rng() < 1 - d * 0.28) T.set(k, B.deep);
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

  // Clear the safe zone (continuing spawn point + line of fire) back to open ground. #81:
  // this used to be an unconditional ring around hex (0,0); it now clears around whatever
  // hex `safeCenter` names, so a stage-advance rebuild can centre it on the player's actual
  // continuing position instead of teleporting them back to world origin.
  for (const h of range(safeCenter, 3)) { const k = axialKey(h.q, h.r); if (T.has(k)) T.set(k, groundAt(h)); }
  // Force-clear any extra hexes (e.g. the debug DUMMY_HEX) regardless of the RNG.
  for (const k of extraClear) {
    if (!T.has(k)) continue;
    const [q, r] = k.split(',').map(Number);
    T.set(k, B.groundA);
  }

  // Partial regen: restore every hex OUTSIDE `reveal` to its exact previous terrain id, so
  // only the revealed region actually changed from the fresh stamp above.
  const isPreserved = (q, r) => reveal && previous && !reveal(q, r) && previous.terrain.has(axialKey(q, r));
  if (reveal && previous) {
    for (const h of all) {
      const k = axialKey(h.q, h.r);
      if (isPreserved(h.q, h.r)) T.set(k, previous.terrain.get(k));
    }
  }

  const buildingHp = new Map();   // hexKey → remaining HP for destructible OUTPOST (solid) hexes
  const coverHp = new Map();      // hexKey → remaining HP for destructible soft-cover hexes
  for (const [k, id] of T) {
    const [q, r] = k.split(',').map(Number);
    if (isPreserved(q, r)) {
      // Preserved hexes carry over their exact remaining HP too (a half-destroyed outpost
      // outside the reveal region stays half-destroyed, not reset to full).
      if (previous.buildingHp.has(k)) buildingHp.set(k, previous.buildingHp.get(k));
      if (previous.coverHp.has(k)) coverHp.set(k, previous.coverHp.get(k));
      continue;
    }
    const hp = buildingHpOf(id);
    if (hp > 0) (isSoftCover(id) ? coverHp : buildingHp).set(k, hp);
  }
  return { terrain: T, buildingHp, coverHp };
}

// #81 (organic growth rewrite): tunable shape/growth constants.
// SECTORS: how many angular wedges the per-direction boundary noise is sampled at — enough
// to read as an irregular coastline once smoothed, not so many it looks noisy.
// INITIAL_*: the very first stage's small starting area (a fraction of the old fixed
// worldRadius=20 disc) — big enough that a far objective (see run.js FAR_OBJECTIVE_MIN_DIST)
// comfortably fits, small enough to clearly read as "not a big round map".
// GROWTH_*: each stage-advance's freshly added lobe — its own organic shape, extending
// outward from the previously-explored edge.
// MAX_WORLD_RADIUS: a hard cap on how far ANY hex can be from world origin — `pickGrowthCenter`
// clamps every new lobe to fit inside it, so a run's total map size is generous but finite
// regardless of how many stages or which directions growth wanders in.
export const SECTORS = 20;
export const INITIAL_BASE_RADIUS = 9;
export const INITIAL_VARIATION = 3;
export const GROWTH_RADIUS = 13;
export const GROWTH_VARIATION = 4;
export const GROWTH_ANCHOR_FRACTION = 0.6; // how far (× growth radius) the new lobe's centre sits beyond the player, so its near edge overlaps the existing explored area
export const MAX_WORLD_RADIUS = 80;

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
// shape `generateTerrain`'s `included`/`reveal` options expect. This REPLACES the old
// `range(center, R)` hard hex-disc cutoff as "is this hex part of the playable area".
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

// #81: given the just-finished stage's live `previous` maps and a freshly-organic-shaped
// `center`, build the `included`/`reveal` pair for a stage-advance GROWTH pass: `included` is
// the union of everywhere already explored (every key in `previous.terrain` — the cumulative
// boundary carried forward stage to stage, since each stage's terrain map already IS the
// previous one plus its own growth) and the new organic lobe; `reveal` is just the new lobe
// minus anywhere already explored, so an overlap between the new lobe and the old edge stays
// preserved rather than being re-stamped. This is genuinely ADDITIVE — everywhere in
// `previous.terrain` stays part of `included` forever, so nothing already explored can ever
// fall back out of the map on a later stage.
export function growRegion({ previous, center, rng, baseRadius = GROWTH_RADIUS, variation = GROWTH_VARIATION, sectors = SECTORS }) {
  const lobe = organicBoundary(center, rng, { baseRadius, variation, sectors });
  const prevTerrain = previous?.terrain ?? null;
  const alreadyExplored = (q, r) => !!prevTerrain && prevTerrain.has(axialKey(q, r));
  const included = (q, r) => alreadyExplored(q, r) || lobe(q, r);
  const reveal = (q, r) => lobe(q, r) && !alreadyExplored(q, r);
  return { included, reveal };
}

// #81: pick the angle (radians, world/pixel space) the new growth lobe opens up in. Prefers
// continuing the player's current heading (`headingAngle`, derived from vx/vy by the caller)
// if that direction still has meaningful room before the hard `maxWorldRadius` cap; otherwise
// samples random directions (deterministic via injectable `rand`) until one has room, and
// falls back to "away from world origin" if nothing else clears.
export function pickRevealAngle({
  playerPx, playerPy, headingAngle = null, maxWorldRadius = MAX_WORLD_RADIUS,
  growthRadius = GROWTH_RADIUS, growthVariation = GROWTH_VARIATION,
  anchorFraction = GROWTH_ANCHOR_FRACTION, rand = Math.random, maxTries = 16,
}) {
  const testDist = growthRadius * anchorFraction * HEX_SIZE;
  const reach = growthRadius + growthVariation;
  const hasRoom = (angle) => {
    const tx = playerPx + Math.cos(angle) * testDist;
    const ty = playerPy + Math.sin(angle) * testDist;
    return distance(pixelToHex(tx, ty), { q: 0, r: 0 }) + reach <= maxWorldRadius;
  };
  if (headingAngle != null && Number.isFinite(headingAngle) && hasRoom(headingAngle)) return headingAngle;
  for (let i = 0; i < maxTries; i++) {
    const angle = rand() * Math.PI * 2;
    if (hasRoom(angle)) return angle;
  }
  // Fallback: away from world origin has the most guaranteed room for an off-centre player;
  // at true origin every direction is equivalent, so just pick "east".
  if (playerPx === 0 && playerPy === 0) return 0;
  return Math.atan2(playerPy, playerPx);
}

// #81: the world-pixel-space centre of the next stage's growth lobe — `growthRadius *
// anchorFraction` hexes out along `angle` from the player, so the lobe's own organic boundary
// (radius ~growthRadius) reaches back far enough to overlap the player's current position
// (which sits inside the previously-explored area) while its far edge extends into fresh
// territory. Clamped so the lobe's own reach (`growthRadius + variation`) never pushes any
// hex beyond `maxWorldRadius` from world origin — the hard cap on total map size (#81 design
// point 4) — by scaling the centre back toward the origin along the same direction.
export function pickGrowthCenter({
  playerPx, playerPy, angle, growthRadius = GROWTH_RADIUS, variation = GROWTH_VARIATION,
  anchorFraction = GROWTH_ANCHOR_FRACTION, maxWorldRadius = MAX_WORLD_RADIUS,
}) {
  const anchorPx = growthRadius * anchorFraction * HEX_SIZE;
  const rawHex = pixelToHex(playerPx + Math.cos(angle) * anchorPx, playerPy + Math.sin(angle) * anchorPx);
  const reach = growthRadius + variation;
  const originDist = distance(rawHex, { q: 0, r: 0 });
  if (originDist === 0 || originDist + reach <= maxWorldRadius) return rawHex;
  const scale = Math.max(0, (maxWorldRadius - reach) / originDist);
  const rawPx = hexToPixel(rawHex.q, rawHex.r);
  return pixelToHex(rawPx.x * scale, rawPx.y * scale);
}

// #81: pick the next stage's objective from the still-standing outpost hex keys, biased
// toward one that's actually far from `fromHex` (the player's continuing position) — so
// reaching it takes a real drive across the freshly regenerated terrain rather than a step
// to an adjacent hex. Pure (no RNG): ranks candidates by hex distance from `fromHex`,
// farthest first, and returns the farthest one that clears `minDistance`; if none clear the
// floor (e.g. a small biome with few outposts) falls back to the single farthest candidate
// so a stage is never left without an objective. Ties among equal distances break on the
// sorted hex-key order (same deterministic rule `_initMission` uses for stage 0).
//
// #81 follow-up: an optional `reveal` predicate (`(q, r) => boolean`, e.g. from
// `growRegion`) restricts candidates to hexes INSIDE the newly-added growth lobe — so the
// objective always lands in the fresh area the player has to walk into, not just "far away"
// (which a full-map regen made equivalent, but additive growth does not: "far from the
// player" and "in the untouched preserved terrain" can both be true). Omitting `reveal` (the
// default) keeps the original whole-map behavior unchanged.
export function pickFarObjective(hexKeys, fromHex, minDistance = 6, reveal = null) {
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
