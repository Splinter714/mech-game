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
import { axialKey, hexToPixel, pixelToHex, nearestHex } from './hexgrid.js';
import { isPassable } from './terrain.js';
import { BOUNDARY_RING_WIDTH } from './worldgen.js';

// Is (q, r) a hex this terrain map actually has AND that's passable ground? A hex outside the
// generated playable area (organic boundary / world radius) is simply absent from the map, so
// `terrain.get(...)` is `undefined` and `isPassable(undefined)` is already false — off-map and
// "blocked terrain" collapse into the same check with no separate bounds arithmetic needed.
function passableCheck(terrain) {
  return (q, r) => isPassable(terrain?.get(axialKey(q, r)));
}

// Nearest passable, in-bounds HEX to a raw pixel point. Searches outward ring-by-ring
// (`nearestHex`) — generous enough to always find a valid hex somewhere on any real map, but
// bounded so a degenerate all-blocked terrain map can't spin forever; falls back to the raw
// (invalid) hex in that vanishingly unlikely case; callers then still spawn there rather than
// crashing.
//
// #158: `2 * worldRadius` alone (the original formula) silently assumed `worldRadius` (the
// generous MAX_WORLD_RADIUS bounding cap, data/worldgen.js) was always much BIGGER than
// BOUNDARY_RING_WIDTH (the impassable ring's fixed 35-hex depth, #126) — true at the old, much
// larger map sizes (73 vs 35), but #158 shrank the playable interior enough that worldRadius can
// now be SMALLER than the ring itself (e.g. 20 vs 35). A raw point that lands within or just past
// the ring (a real case — this is exactly what "off the edge of the map" spawn points look like)
// then needs to cross the ring's own width to get back to passable ground, which `2 *
// worldRadius` alone no longer guarantees once worldRadius shrinks below it. Add
// BOUNDARY_RING_WIDTH explicitly (plus a flat margin for the shape's own organic noise) so the
// budget stays correct regardless of how small worldRadius gets relative to the ring.
export function nearestValidHex(terrain, worldRadius, x, y) {
  const rawHex = pixelToHex(x, y);
  const searchSteps = (worldRadius ?? 20) * 2 + BOUNDARY_RING_WIDTH + 15;
  return nearestHex(rawHex, passableCheck(terrain), searchSteps) ?? rawHex;
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

// #145 (playtest 2026-07-11: "turrets are in 3 separate hexes, but they should be in 1 hex
// centered on that hex's center"): a turret-nest cluster is now a single tight emplacement, not
// spread across a neighborhood — every one of the `count` turrets shares the SAME validated hex
// (the nearest passable/in-bounds hex to the raw point). Callers still get an array of `count`
// hexes back (same shape as before #145) so they don't need to special-case a single-hex result;
// they're just all identical now. `_spawnTurretCluster` (scenes/arena/enemies.js) is responsible
// for nudging the turrets a few px apart around that one hex's centre so they don't render as an
// indistinguishable blob.
export function turretClusterHexes(terrain, worldRadius, x, y, count) {
  const centerHex = nearestValidHex(terrain, worldRadius, x, y);
  const hexes = [];
  for (let i = 0; i < count; i++) hexes.push(centerHex);
  return hexes;
}
