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
import { Mech } from './Mech.js';
import { ENEMIES } from './enemies.js';
import { ENEMY_KINDS, isEnemyKind } from './enemyKinds.js';
import { detectionRangeFor } from './awareness.js';

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
// #345: and a CEILING on that budget, so it can't scale away with the world. `worldRadius` is
// MAX_WORLD_RADIUS, which #340 grew from 102 to 351 — `2 * worldRadius` is then 752 rings, ~1.7M
// hexes, all of it walked whenever the search finds nothing (a degenerate/empty terrain map). The
// sibling drop search hit exactly this and froze the game for minutes; the predicate here is only
// a Map lookup so it's far cheaper per candidate, but "unbounded by world size" is the bug either
// way. What the search actually has to cross is the impassable boundary ring's fixed depth plus
// the organic shape's noise — a fixed quantity that does not grow with the corridor's length. Two
// ring-widths plus 60 hexes of slack (~6200px) is generous for that and caps the worst case at
// ~51k lookups.
export const MAX_SEARCH_STEPS = BOUNDARY_RING_WIDTH * 2 + 60;

export function nearestValidHex(terrain, worldRadius, x, y) {
  const rawHex = pixelToHex(x, y);
  const searchSteps = Math.min(
    (worldRadius ?? 20) * 2 + BOUNDARY_RING_WIDTH + 15,
    MAX_SEARCH_STEPS,
  );
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

// #203 — mirrors the mech-role tuning in scenes/arena/enemies.js (`meanOpt`/`roleFor`'s standoff
// clamp) so this file's `minSafeSpawnDist` can derive the SAME detection range a mech enemy will
// actually be spawned with, without duplicating the tuning constants in two places or importing
// Phaser-dependent enemies.js into a unit test.
const BRAWLER_STANDOFF_MIN = 90;   // mirrors STANDOFF_MIN, enemies.js
const BRAWLER_STANDOFF_MAX = 520;  // mirrors STANDOFF_MAX, enemies.js
const STANDOFF_FRAC = 0.85;        // mirrors STANDOFF_FRAC, enemies.js
const DEFAULT_OPT = 220;           // mirrors DEFAULT_OPT, enemies.js
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function meanOptRange(mech) {
  const ws = mech.weapons().map((w) => w.weapon).filter(Boolean);
  if (!ws.length) return DEFAULT_OPT;
  return ws.reduce((a, w) => a + (w.range?.opt ?? DEFAULT_OPT), 0) / ws.length;
}

// #203 (playtest report: enemies near the deploy point already actively engaging the instant the
// player drops in): a turret nest's artillery fireRange (2400px, ENEMY_KINDS.turret) is
// distance-only-gated (no LOS needed) and dwarfs the ~700-1000px "just off view" distance the
// camera-viewport-based offscreen spawn point (`_offscreenSpawnPoint`, scenes/arena/enemies.js)
// normally produces — so a turret nest was AWARE and lobbing shells within the first second of
// EVERY deploy, regardless of window size, and a narrow/small browser window could shrink the
// off-view distance below even an ordinary mech's detection range too. This computes the
// distance below which a freshly-placed enemy of `typeId` would already be within its own
// detection range of the player standing at the spawn point origin — callers clamp the actual
// spawn distance to never land inside it (see `spawnDistance` below).
// #203 (reopened after playtest — "safety zone doesn't feel quite big enough — enemies
// (especially turret nests) still engage too soon after deploy"): landing EXACTLY at an
// enemy's own detection-range boundary is the bare minimum, not a comfortable margin — the
// player is deploying at roughly the centre of the safe zone and the enemy only has to close
// a step (or the player takes one) before the two distances meet. A flat px buffer, not a
// multiplier, is added on top of every type's detect-range floor: the per-type detect ranges
// here span a huge spread (infantry ~240px / drone ~336px up to the turret nest's already-large
// 2880px), and a multiplier applied uniformly would barely move the small, fast-closing types
// (infantry/drone/mech) that need the extra room just as much, while ballooning the turret
// nest's floor by hundreds more px than necessary (it's already the biggest number in the
// table). A flat buffer instead gives every type the SAME extra breathing room in the units
// that actually matter for "how many steps before I'm spotted" — proportionally huge for the
// small-range types, a modest ~16% top-up for the turret nest, whose floor was already generous.
export const SAFETY_MARGIN_PX = 450;

export function minSafeSpawnDist(typeId) {
  if (typeId === 'swarm') return detectionRangeFor(ENEMY_KINDS.drone.fireRange) + SAFETY_MARGIN_PX;
  if (typeId === 'turretNest') return detectionRangeFor(ENEMY_KINDS.turret.fireRange) + SAFETY_MARGIN_PX;
  if (typeId === 'infantryMob') return detectionRangeFor(ENEMY_KINDS.infantry.fireRange) + SAFETY_MARGIN_PX;
  if (isEnemyKind(typeId)) return detectionRangeFor(ENEMY_KINDS[typeId].fireRange) + SAFETY_MARGIN_PX;
  const def = ENEMIES[typeId] ?? ENEMIES.raider;
  const opt = meanOptRange(new Mech(def));
  const standoff = clamp(opt * STANDOFF_FRAC, BRAWLER_STANDOFF_MIN, BRAWLER_STANDOFF_MAX);
  return detectionRangeFor(standoff) + SAFETY_MARGIN_PX;
}

// #203 reopened (playtest 2026-07-15: "new enemy spawns should NEVER happen on screen" — an
// absolute requirement, stricter than and distinct from the detection-range/awareness concern
// above): `jitter` is normally `Math.random() * 120` at the one real call site
// (`_offscreenSpawnPoint`, scenes/arena/enemies.js), which is ALMOST always > 0 but not
// GUARANTEED to be — `Math.random()` can return exactly 0, which would leave `floor + jitter ===
// floor === viewR` exactly: a spawn landing precisely on the camera-viewport-radius boundary,
// which reads as "just barely visible at the edge of frame" rather than cleanly off-screen.
// EDGE_BUFFER_PX is a small FIXED (non-random) push added to the floor before jitter, so the
// guarantee holds deterministically regardless of what `jitter` rolls, instead of relying on
// jitter almost-never landing on exactly 0.
export const EDGE_BUFFER_PX = 40;

// #203: the actual off-view spawn distance — never closer than `viewR` (the camera-derived
// "just off screen" radius) NOR closer than `minSafeDist` (the enemy's own detection range, see
// `minSafeSpawnDist`), plus the fixed `EDGE_BUFFER_PX` so the floor itself is a strict margin
// past the viewport edge (not merely touching it), then jittered outward by `jitter` px and
// finally capped at `maxR` (the world edge) so a huge detection range (e.g. the turret nest)
// still can't be pushed past the playable map. Pure so the floor-enforcement itself is
// unit-testable without a Phaser scene.
export function spawnDistance({ viewR, minSafeDist = 0, maxR, jitter = 0 }) {
  const floor = Math.max(viewR, minSafeDist) + EDGE_BUFFER_PX;
  return Math.min(floor + jitter, maxR);
}
