// Boss arena layout (#240) — pure hex geometry, no Phaser, so the whole arena's shape is
// unit-testable. `scenes/arena/boss.js` just stamps the returned terrain map.
//
// The normal battlefield is a long snaking CORRIDOR you traverse (worldgen.js). The boss arena
// is deliberately its own distinct space and the exact opposite shape: a closed circular pit
// you circle. Nothing is generated randomly — it's the same arena every time, because it's a
// set-piece and the fight should be learnable.
//
// Layout, centre outward:
//   - A clear CORE DISC around the boss (radius CORE_CLEAR_R): no cover at all directly under
//     it, so nothing shields you at point-blank and the boss always has a clean firing floor.
//   - An INNER RING of HARD cover pillars (permanent, impassable, LOS-blocking, indestructible)
//     — the reliable "duck behind this" spots that never go away.
//   - An OUTER RING of DESTRUCTIBLE cover — the spots the boss chews through as the fight goes
//     on. This is the mixed-cover ask: your safe spots partially erode without the arena ever
//     becoming a bare plate.
//   - The player spawns at the rim, so the first thing you see is the whole thing at once.
//
// Both rings are broken into ARCS with gaps rather than being solid walls, so there is always a
// firing lane through to the boss and it can never be perfectly cheesed from behind one pillar.

import { range, ring, axialKey } from './hexgrid.js';

const CENTRE = { q: 0, r: 0 };

// Arena radius in hexes. Sized so the pit comfortably contains a 10x mech plus circling room
// but is small enough that the boss's reach covers essentially all of it — you can break line
// of sight, you can never simply leave.
export const BOSS_ARENA_RADIUS = 14;

// Radius (hexes) of the guaranteed-clear disc around the boss at the centre.
export const CORE_CLEAR_R = 5;

// The two cover rings' hex radii from centre.
export const HARD_RING_R = 7;
export const SOFT_RING_R = 10;

// How many pillars per ring, and how many hexes each pillar spans along the ring. Arcs rather
// than single hexes so a pillar is genuinely wide enough to hide a player mech behind at this
// zoom, and offset between the rings so an outer gap never lines up with an inner gap.
export const HARD_PILLARS = 6;
export const HARD_PILLAR_SPAN = 2;
export const SOFT_PILLARS = 9;
export const SOFT_PILLAR_SPAN = 2;

// Where the boss stands and where the player walks in — opposite ends of the pit.
export const BOSS_HEX = { q: 0, r: 0 };
export const PLAYER_SPAWN_HEX = { q: 0, r: BOSS_ARENA_RADIUS - 2 };

// The pit's dressing, as a ROLE → terrain-id map (same shape/spirit as a biome record in
// data/biomes.js, so the arena builder never names a terrain id itself). Volcanic ids: this is
// a lair, not a random battlefield, and the black-ash floor with a lava rim reads as its own
// distinct place rather than "one of the five maps you've been running."
//
//   hard — `wallSegment` (impassable + LOS-blocking). It IS a destructible terrain id, but the
//          boss arena deliberately seeds NO building HP for these hexes, and `_damageBuildingAt`
//          (scenes/arena/world.js) no-ops on a hex with no HP entry — so they are permanent
//          here without needing a new terrain entry that behaves differently everywhere else.
//   soft — `fumarole`, ordinary destructible soft cover, seeded WITH HP so the boss (and the
//          player) chew through it over the course of the fight.
export const BOSS_ARENA_TERRAIN = {
  groundA: 'ash', groundB: 'ashB',
  hard: 'wallSegment',
  soft: 'fumarole',
  boundary: 'lava',
};

// Hex distance from the origin, in axial coords (same metric as hexgrid.js's `distance`,
// specialised to the centre so the layout doesn't need to import it).
function ringOf(q, r) {
  return (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2;
}

// Pick `pillars` evenly-spaced arcs of `span` hexes each out of the `count` hexes that make up
// one hex ring, starting at `offset`. Returned as a Set of indices into that ring's own order.
function arcIndices(count, pillars, span, offset = 0) {
  const picked = new Set();
  for (let p = 0; p < pillars; p++) {
    const start = Math.round((p * count) / pillars) + offset;
    for (let s = 0; s < span; s++) picked.add(((start + s) % count + count) % count);
  }
  return picked;
}

// Build the arena's hex sets. Returns plain key Sets/arrays (no terrain ids — the caller maps
// each role onto whichever terrain ids it wants, exactly like the biome role system does) so
// this module never needs to know which terrain id "hard cover" happens to be today.
//
//   floorKeys  every playable hex, including the ones a cover piece sits on.
//   hardKeys   permanent impassable LOS-blocking pillars.
//   softKeys   destructible cover.
//   boundaryKeys  the impassable rim, one hex ring outside the floor.
export function bossArenaLayout({
  radius = BOSS_ARENA_RADIUS,
  coreClear = CORE_CLEAR_R,
  hardR = HARD_RING_R,
  softR = SOFT_RING_R,
} = {}) {
  const floorKeys = new Set();
  for (const { q, r } of range(CENTRE, radius)) floorKeys.add(axialKey(q, r));
  // `ring` already walks a hex ring in a real traversal order (hexgrid.js), so the arcs below
  // land contiguously and identically every run — this is a set-piece, not a generated map.
  const hardRing = ring(CENTRE, hardR);
  const softRing = ring(CENTRE, softR);

  const hardPick = arcIndices(hardRing.length, HARD_PILLARS, HARD_PILLAR_SPAN, 0);
  // Half-a-gap offset on the outer ring so its pillars sit over the inner ring's GAPS — you can
  // never line up a straight unbroken corridor of cover from the rim to the centre.
  const softOffset = Math.round(softRing.length / (SOFT_PILLARS * 2));
  const softPick = arcIndices(softRing.length, SOFT_PILLARS, SOFT_PILLAR_SPAN, softOffset);

  const hardKeys = new Set();
  const softKeys = new Set();
  for (let i = 0; i < hardRing.length; i++) {
    if (hardPick.has(i)) hardKeys.add(axialKey(hardRing[i].q, hardRing[i].r));
  }
  for (let i = 0; i < softRing.length; i++) {
    if (softPick.has(i)) softKeys.add(axialKey(softRing[i].q, softRing[i].r));
  }

  // Belt-and-braces: nothing may stand inside the core clear disc or on the player's spawn hex.
  const spawnKey = axialKey(PLAYER_SPAWN_HEX.q, PLAYER_SPAWN_HEX.r);
  for (const set of [hardKeys, softKeys]) {
    for (const k of [...set]) {
      const [q, r] = k.split(',').map(Number);
      if (ringOf(q, r) <= coreClear || k === spawnKey) set.delete(k);
    }
  }

  // The rim: every hex on the ring just outside the floor. Impassable, so the pit is closed.
  const boundaryKeys = new Set();
  for (const { q, r } of range(CENTRE, radius + 1)) {
    const k = axialKey(q, r);
    if (!floorKeys.has(k)) boundaryKeys.add(k);
  }

  return {
    radius, floorKeys, hardKeys, softKeys, boundaryKeys,
    bossHex: BOSS_HEX, spawnHex: PLAYER_SPAWN_HEX,
  };
}
