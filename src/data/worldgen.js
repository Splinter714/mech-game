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
// #81 follow-up (directional partial regen): `reveal` (optional `(q, r) => boolean`) and
// `previous` (optional `{ terrain, buildingHp, coverHp }` — the just-finished stage's live
// maps) together opt into a PARTIAL regeneration instead of the full-disc one. When both are
// supplied, every hex where `reveal(q, r)` is false is snapped back to its exact previous
// value (terrain id AND remaining destructible HP, byte-identical) instead of the fresh stamp
// computed below; only hexes where `reveal` is true keep the newly generated content. With
// neither argument (the default), every hex keeps its fresh stamp — this is the original
// #81 full-disc behavior, unchanged, so the very first stage's build (and any caller that
// doesn't opt in) is unaffected.
export function generateTerrain({
  seed, worldRadius, biome, safeCenter = { q: 0, r: 0 }, extraClear = [],
  reveal = null, previous = null,
}) {
  const R = worldRadius;
  const rng = mulberry32(seed);
  const all = range({ q: 0, r: 0 }, R);
  const T = new Map();
  const B = biome;
  const groundAt = (h) => ((h.q + h.r) % 2 ? B.groundB : B.groundA);
  const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };

  // Base: a checkered open floor (grass / sand / snow / pavement / ash by biome).
  for (const h of all) T.set(axialKey(h.q, h.r), groundAt(h));

  // Channel: a winding strip sweeping across the map — river / dry-bed / slush / road / lava-crust.
  if (B.hasChannel) {
    for (let q = -R + 2; q <= R - 2; q++) {
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
  for (let i = 0; i < Math.round(R * 2.2 * B.coverClusters); i++) {
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

// #81 follow-up: the reveal-region geometry — a wedge/cone extending outward from the
// player's current WORLD PIXEL position in one direction, starting beyond `bufferHexes` (so
// nothing close to the player ever changes) out to the edge of the world disc. Returns a
// `(q, r) => boolean` predicate suitable for `generateTerrain`'s `reveal` option. Half-angle
// of ~40° (an ~80° wide cone) reads as a real "off in this direction" region without being so
// narrow the player might miss it entirely. Owner: tunable.
export const REVEAL_BUFFER_HEXES = 5;
export const REVEAL_HALF_ANGLE = Math.PI * 2 / 9; // 40°

export function makeRevealRegion(playerPx, playerPy, angle, {
  bufferHexes = REVEAL_BUFFER_HEXES, halfAngle = REVEAL_HALF_ANGLE,
} = {}) {
  const bufferPx = bufferHexes * HEX_SIZE;
  return (q, r) => {
    const { x, y } = hexToPixel(q, r);
    const dx = x - playerPx, dy = y - playerPy;
    const dist = Math.hypot(dx, dy);
    if (dist < bufferPx) return false;
    let diff = Math.atan2(dy, dx) - angle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // normalize to (-pi, pi]
    return Math.abs(diff) <= halfAngle;
  };
}

// #81 follow-up: pick the angle (radians, world/pixel space) the new region opens up in.
// Prefers continuing the player's current heading (`headingAngle`, derived from vx/vy by the
// caller) if there's enough room in that direction within the fixed-size world disc; otherwise
// samples random directions (deterministic via injectable `rand`) until one has room, and
// falls back to "away from world origin" (the direction with the most guaranteed room for an
// off-centre player) if nothing else clears. "Room" means a point `bufferHexes + minDepthHexes`
// out along that direction is still within `worldRadius` hexes of the origin — so the reveal
// region has real depth to generate into rather than immediately hitting the world edge.
export function pickRevealAngle({
  playerPx, playerPy, worldRadius, headingAngle = null,
  bufferHexes = REVEAL_BUFFER_HEXES, minDepthHexes = 6, rand = Math.random, maxTries = 16,
}) {
  const testDist = (bufferHexes + minDepthHexes) * HEX_SIZE;
  const hasRoom = (angle) => {
    const tx = playerPx + Math.cos(angle) * testDist;
    const ty = playerPy + Math.sin(angle) * testDist;
    return distance(pixelToHex(tx, ty), { q: 0, r: 0 }) <= worldRadius - 1;
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
// `makeRevealRegion`) restricts candidates to hexes INSIDE the newly-generated reveal
// region — so the objective always lands in the fresh area the player has to walk into,
// not just "far away" (which the whole-map regen made equivalent, but a partial regen does
// not: "far from the player" and "in the untouched preserved terrain" can both be true).
// Omitting `reveal` (the default) keeps the original whole-map behavior unchanged.
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
