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
import { axialKey, range, neighbors, hexToPixel, distance } from './hexgrid.js';
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
export function generateTerrain({ seed, worldRadius, biome, safeCenter = { q: 0, r: 0 }, extraClear = [] }) {
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

  const buildingHp = new Map();   // hexKey → remaining HP for destructible OUTPOST (solid) hexes
  const coverHp = new Map();      // hexKey → remaining HP for destructible soft-cover hexes
  for (const [k, id] of T) {
    const hp = buildingHpOf(id);
    if (hp > 0) (isSoftCover(id) ? coverHp : buildingHp).set(k, hp);
  }
  return { terrain: T, buildingHp, coverHp };
}

// #81: pick the next stage's objective from the still-standing outpost hex keys, biased
// toward one that's actually far from `fromHex` (the player's continuing position) — so
// reaching it takes a real drive across the freshly regenerated terrain rather than a step
// to an adjacent hex. Pure (no RNG): ranks candidates by hex distance from `fromHex`,
// farthest first, and returns the farthest one that clears `minDistance`; if none clear the
// floor (e.g. a small biome with few outposts) falls back to the single farthest candidate
// so a stage is never left without an objective. Ties among equal distances break on the
// sorted hex-key order (same deterministic rule `_initMission` uses for stage 0).
export function pickFarObjective(hexKeys, fromHex, minDistance = 6) {
  if (!hexKeys || !hexKeys.length) return null;
  const ranked = [...hexKeys].sort().map((k) => {
    const [q, r] = k.split(',').map(Number);
    return { k, d: distance({ q, r }, fromHex) };
  }).sort((a, b) => b.d - a.d);
  const farEnough = ranked.find((c) => c.d >= minDistance);
  return (farEnough ?? ranked[0]).k;
}
