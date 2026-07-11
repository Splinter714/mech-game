// Pure "validate this spawn point against terrain" helpers (#114/#115) — extracted out of
// scenes/arena/enemies.js (which pulls in Phaser and so can't be unit-tested directly) so the
// actual placement math is tested in isolation, same spirit as data/worldgen.js.
//
// #114 (turret clusters spawning off-map / on forest-water) and #115 (infantry ending up off
// the playable map) share one root cause: an enemy-cluster expansion (`_spawnTurretCluster`,
// `_spawnInfantryMob`) placed extra units at a fixed PIXEL offset from an already-validated raw
// spawn point, without checking whether that offset point was itself passable/in-bounds. The
// fix mirrors the existing `_reachableDropPos` primitive (scenes/arena/powerups.js, #73) used
// for powerup drops: snap to the nearest passable, in-bounds hex via `nearestHex` + an
// `isPassable` predicate read off the live terrain Map.
import { axialKey, hexToPixel, pixelToHex, nearestHex, range, distance } from './hexgrid.js';
import { isPassable } from './terrain.js';

// Is (q, r) a hex this terrain map actually has AND that's passable ground? A hex outside the
// generated playable area (organic boundary / world radius) is simply absent from the map, so
// `terrain.get(...)` is `undefined` and `isPassable(undefined)` is already false — off-map and
// "blocked terrain" collapse into the same check with no separate bounds arithmetic needed.
function passableCheck(terrain) {
  return (q, r) => isPassable(terrain?.get(axialKey(q, r)));
}

// Nearest passable, in-bounds HEX to a raw pixel point. Searches outward ring-by-ring
// (`nearestHex`) up to `2 * worldRadius` hex-steps — generous enough to always find a valid
// hex somewhere on any real map, but bounded so a degenerate all-blocked terrain map can't spin
// forever; falls back to the raw (invalid) hex in that vanishingly unlikely case; callers than
// still spawn there rather than crashing.
export function nearestValidHex(terrain, worldRadius, x, y) {
  const rawHex = pixelToHex(x, y);
  return nearestHex(rawHex, passableCheck(terrain), (worldRadius ?? 20) * 2) ?? rawHex;
}

// Pixel-space counterpart: (x, y) unchanged if already passable + in-bounds, else the nearest
// valid hex's centre.
export function nearestValidPixel(terrain, worldRadius, x, y) {
  const ok = passableCheck(terrain);
  const h0 = pixelToHex(x, y);
  if (ok(h0.q, h0.r)) return { x, y };
  const hex = nearestValidHex(terrain, worldRadius, x, y);
  return hexToPixel(hex.q, hex.r);
}

// The `count` hexes a turret-nest cluster should occupy around a raw pixel point: the nearest
// valid hex to the raw point as the cluster's CENTRE, then the closest other passable/in-bounds
// hexes around it (nearest-first, out to 2 rings). If fewer than `count` valid hexes exist that
// close (extremely cramped terrain), the centre hex is reused for the remainder — every
// returned hex is still guaranteed individually valid, it just means some units stack on the
// same spot rather than one ever landing somewhere invalid.
export function turretClusterHexes(terrain, worldRadius, x, y, count) {
  const centerHex = nearestValidHex(terrain, worldRadius, x, y);
  const ok = passableCheck(terrain);
  const candidates = range(centerHex, 2)
    .filter((h) => ok(h.q, h.r))
    .sort((a, b) => distance(centerHex, a) - distance(centerHex, b));
  const hexes = [];
  for (let i = 0; i < count; i++) hexes.push(candidates[i] ?? centerHex);
  return hexes;
}
