// #114/#115 — spawn/movement bounds-checking. Both bugs share the same root cause: an
// enemy-cluster expansion (`_spawnTurretCluster`, `_spawnInfantryMob` — scenes/arena/enemies.js)
// placed extra units at a fixed pixel offset from an already-validated raw spawn point, without
// checking whether that offset point was itself passable/in-bounds — so a turret or trooper on
// the edge of the cluster could land off the playable map or on top of forest/water. These pure
// helpers (extracted so they're testable without pulling in Phaser) are the fix: every unit's
// FINAL position is snapped to the nearest passable, in-bounds hex before it's placed.
import { describe, it, expect } from 'vitest';
import { nearestValidHex, nearestValidPixel, turretClusterHexes } from './spawnPlacement.js';
import { axialKey, hexToPixel, pixelToHex, distance } from './hexgrid.js';
import { isPassable } from './terrain.js';

// A hex disc of RADIUS filled with passable ground, with an optional set of impassable
// "lake" hexes carved out — mirrors real terrain generation, where anything outside the
// organic playable boundary is simply absent from the map (undefined ⇒ blocked, same as an
// explicitly-impassable id).
const RADIUS = 6;
// The `worldRadius` argument passed to the helpers is production's search-budget cap
// (`nearestHex`'s maxSteps), NOT the actual extent of the generated terrain — in the real game
// `this.worldRadius` is the generous MAX_WORLD_RADIUS bounding cap (80, data/worldgen.js) while
// the organic playable region itself is usually much smaller. A big value here lets the search
// reach all the way back to the small terrain island even from a raw point placed well outside
// it (mirrors `_reachableDropPos`'s identical `(this.worldRadius ?? 20) * 2` budget).
const BIG_RADIUS = 80;
function makeTerrain(waterHexes = []) {
  const t = new Map();
  for (let q = -RADIUS; q <= RADIUS; q++) {
    for (let r = -RADIUS; r <= RADIUS; r++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > RADIUS) continue;
      t.set(axialKey(q, r), 'grass');
    }
  }
  for (const [q, r] of waterHexes) t.set(axialKey(q, r), 'deepWater');
  return t;
}

describe('nearestValidHex / nearestValidPixel', () => {
  it('returns the same point unchanged when it is already passable + in-bounds', () => {
    const terrain = makeTerrain();
    const { x, y } = hexToPixel(1, 1);
    const pos = nearestValidPixel(terrain, BIG_RADIUS, x, y);
    expect(pos.x).toBeCloseTo(x, 6);
    expect(pos.y).toBeCloseTo(y, 6);
  });

  it('snaps a point in the middle of a lake to the nearest dry hex', () => {
    const terrain = makeTerrain([[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, -1], [-1, 1]]);
    const { x, y } = hexToPixel(0, 0);
    const pos = nearestValidPixel(terrain, BIG_RADIUS, x, y);
    const h = pixelToHex(pos.x, pos.y);
    expect(isPassable(terrain.get(axialKey(h.q, h.r)))).toBe(true);
  });

  it('snaps a point well beyond the generated map back onto the playable area', () => {
    const terrain = makeTerrain();
    const { x, y } = hexToPixel(RADIUS + 25, 0);   // far outside anything in `terrain`
    const hex = nearestValidHex(terrain, BIG_RADIUS, x, y);
    expect(terrain.has(axialKey(hex.q, hex.r))).toBe(true);
    expect(isPassable(terrain.get(axialKey(hex.q, hex.r)))).toBe(true);
    // It should be the closest valid hex to the map's edge along that bearing, not some
    // arbitrary far-flung fallback.
    expect(distance(hex, { q: 0, r: 0 })).toBeLessThanOrEqual(RADIUS);
  });
});

describe('turretClusterHexes (#114)', () => {
  it('returns `count` hexes, every one individually passable + in-bounds', () => {
    const terrain = makeTerrain([[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]);
    const { x, y } = hexToPixel(0, 0);   // raw point sits in the middle of the lake
    const hexes = turretClusterHexes(terrain, BIG_RADIUS, x, y, 3);
    expect(hexes.length).toBe(3);
    for (const h of hexes) {
      expect(isPassable(terrain.get(axialKey(h.q, h.r)))).toBe(true);
    }
  });

  it('never returns a hex off the generated map when the raw point is beyond the edge', () => {
    const terrain = makeTerrain();
    const { x, y } = hexToPixel(RADIUS + 20, 0);
    const hexes = turretClusterHexes(terrain, BIG_RADIUS, x, y, 3);
    expect(hexes.length).toBe(3);
    for (const h of hexes) {
      expect(terrain.has(axialKey(h.q, h.r))).toBe(true);
      expect(isPassable(terrain.get(axialKey(h.q, h.r)))).toBe(true);
    }
  });

  it('#145: puts every unit on the exact SAME single validated hex (a tight one-hex nest)', () => {
    const terrain = makeTerrain();
    const { x, y } = hexToPixel(3, -2);
    const hexes = turretClusterHexes(terrain, BIG_RADIUS, x, y, 3);
    const centerHex = nearestValidHex(terrain, BIG_RADIUS, x, y);
    for (const h of hexes) {
      expect(distance(h, centerHex)).toBe(0);
      expect(h.q).toBe(centerHex.q);
      expect(h.r).toBe(centerHex.r);
    }
  });

  it('across many random raw points, every cluster hex is always valid (stress check)', () => {
    const waterHexes = [[2, 0], [2, 1], [1, 1], [-2, 0], [-2, -1], [-1, -1]];
    const terrain = makeTerrain(waterHexes);
    for (let trial = 0; trial < 50; trial++) {
      const q = Math.round((Math.random() - 0.5) * (RADIUS * 4));
      const r = Math.round((Math.random() - 0.5) * (RADIUS * 4));
      const { x, y } = hexToPixel(q, r);
      const hexes = turretClusterHexes(terrain, BIG_RADIUS, x, y, 3);
      expect(hexes.length).toBe(3);
      for (const h of hexes) {
        expect(terrain.has(axialKey(h.q, h.r))).toBe(true);
        expect(isPassable(terrain.get(axialKey(h.q, h.r)))).toBe(true);
      }
    }
  });
});
