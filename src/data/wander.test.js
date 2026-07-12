// #151 repro: "infantry swarms hanging out in the water" — grassland's river/channel terrain is
// passable (mechs/tanks are meant to wade it) but a small trooper voluntarily settling in one
// reads badly. #114/#115 already validate SPAWN placement against terrain; this covers the
// separate idle-wander GOAL-PICKING path (scenes/arena/enemies.js `_idleMoveIntent`), which
// picked waypoints with no notion of "water" at all before this fix.
import { describe, it, expect } from 'vitest';
import { pickWanderGoal } from './wander.js';
import { axialKey, hexToPixel, pixelToHex } from './hexgrid.js';
import { isPassable, isWaterTerrain } from './terrain.js';

// Deterministic PRNG (mulberry32) so the "many random trials" repro never flakes.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A grass disc around the origin with a solid patch of `river` hexes sitting right next to the
// spawn point — mirrors a grassland channel running past an infantry mob's drop point.
const RADIUS = 8;
function makeTerrainWithRiver() {
  const t = new Map();
  for (let q = -RADIUS; q <= RADIUS; q++) {
    for (let r = -RADIUS; r <= RADIUS; r++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > RADIUS) continue;
      t.set(axialKey(q, r), 'grass');
    }
  }
  // A wide river band across q in [-1, 1] for every r — guaranteed to overlap the wander radius
  // of a spawn point sitting at the origin.
  for (let r = -RADIUS; r <= RADIUS; r++) {
    for (const q of [-1, 0, 1]) t.set(axialKey(q, r), 'river');
  }
  return t;
}

function terrainAt(terrain, x, y) {
  const h = pixelToHex(x, y);
  return terrain.get(axialKey(h.q, h.r));
}

describe('pickWanderGoal (#151)', () => {
  it('never returns a point on blocked terrain (baseline, no water awareness)', () => {
    const terrain = makeTerrainWithRiver();
    // Carve one impassable hex directly at a spawn candidate to prove the blocked-check works.
    terrain.set(axialKey(4, 0), 'deepWater');
    const rng = mulberry32(1);
    const spawn = hexToPixel(6, 0);   // clear of both the river band and the deep-water hex
    for (let i = 0; i < 200; i++) {
      const isBlocked = (x, y) => !isPassable(terrainAt(terrain, x, y));
      const g = pickWanderGoal(spawn.x, spawn.y, 300, isBlocked, rng);
      expect(isPassable(terrainAt(terrain, g.x, g.y))).toBe(true);
    }
  });

  it('#151: with avoidWater, an idle-wander goal near a river never lands on a water hex', () => {
    const terrain = makeTerrainWithRiver();
    const rng = mulberry32(42);
    // Spawn just outside the river band, on dry grass — mirrors a validated (#114/#115) infantry
    // spawn point sitting near a channel.
    const spawn = hexToPixel(3, 0);
    expect(isWaterTerrain(terrainAt(terrain, spawn.x, spawn.y))).toBe(false);

    // Simulate many idle-wander re-picks (the arena calls this every time the current waypoint
    // is reached or its hold timer expires) with a wander radius big enough to reach the river.
    const RADIUS_PX = 260;   // several hexes — comfortably overlaps the river band from q=3
    for (let i = 0; i < 500; i++) {
      const isBlocked = (x, y) => {
        const id = terrainAt(terrain, x, y);
        return !isPassable(id) || isWaterTerrain(id);
      };
      const g = pickWanderGoal(spawn.x, spawn.y, RADIUS_PX, isBlocked, rng);
      const id = terrainAt(terrain, g.x, g.y);
      expect(isWaterTerrain(id), `trial ${i}: landed on water terrain ${id}`).toBe(false);
    }
  });

  it('without avoidWater (e.g. tank/mech), the same picker is free to land in the river', () => {
    const terrain = makeTerrainWithRiver();
    const rng = mulberry32(7);
    const spawn = hexToPixel(3, 0);
    let sawWater = false;
    for (let i = 0; i < 200 && !sawWater; i++) {
      const isBlocked = (x, y) => !isPassable(terrainAt(terrain, x, y));   // no water check
      const g = pickWanderGoal(spawn.x, spawn.y, 260, isBlocked, rng);
      if (isWaterTerrain(terrainAt(terrain, g.x, g.y))) sawWater = true;
    }
    // A picker with no water awareness should be able to land on the (passable) river at least
    // once across 200 tries — proving the water-avoidance in the previous test is doing real work,
    // not just something the geometry could never reach anyway.
    expect(sawWater).toBe(true);
  });

  it('converges toward the spawn point (always valid) when the whole wander disc is water', () => {
    const terrain = new Map();
    for (let q = -RADIUS; q <= RADIUS; q++) {
      for (let r = -RADIUS; r <= RADIUS; r++) {
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > RADIUS) continue;
        terrain.set(axialKey(q, r), 'river');
      }
    }
    terrain.set(axialKey(0, 0), 'grass');   // only the spawn hex itself is dry
    const spawn = hexToPixel(0, 0);
    const rng = mulberry32(99);
    for (let i = 0; i < 50; i++) {
      const isBlocked = (x, y) => isWaterTerrain(terrainAt(terrain, x, y));
      const g = pickWanderGoal(spawn.x, spawn.y, 200, isBlocked, rng);
      // Every retry halves the distance to the (valid) spawn point, so after 5 nudges it should
      // land acceptably close even though it can't fully re-validate past the retry budget.
      expect(Math.hypot(g.x - spawn.x, g.y - spawn.y)).toBeLessThan(200);
    }
  });
});
