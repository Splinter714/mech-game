// #81 — pure world-generation coverage: the seeded terrain algorithm, the safe-zone
// geometry, and the distance-biased objective picker used by stage advance. No Phaser here;
// these are the deterministic/parameterized pieces the arena mixin (scenes/arena/world.js,
// scenes/arena/run.js) is a thin wrapper around.
import { describe, it, expect } from 'vitest';
import { mulberry32, safeZoneKeys, generateTerrain, pickFarObjective } from './worldgen.js';
import { getBiome } from './biomes.js';
import { axialKey, range } from './hexgrid.js';

const GRASSLAND = getBiome('grassland');

describe('mulberry32', () => {
  it('is deterministic: the same seed always produces the same sequence', () => {
    const a = mulberry32(0x5eed);
    const b = mulberry32(0x5eed);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different sequences', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });
});

describe('safeZoneKeys', () => {
  it('clears exactly the expected filled disc around a hex', () => {
    const center = { q: 3, r: -2 };
    const keys = safeZoneKeys(center, 3);
    const expected = range(center, 3).map((h) => axialKey(h.q, h.r));
    expect(new Set(keys)).toEqual(new Set(expected));
    // A radius-3 disc has 1 + 3*3*4 = 37 hexes.
    expect(keys.length).toBe(37);
  });

  it('is centred on an arbitrary hex, not always world origin', () => {
    const keys = safeZoneKeys({ q: 10, r: -5 }, 1);
    expect(keys).toContain(axialKey(10, -5));
    expect(keys).not.toContain(axialKey(0, 0));
  });
});

describe('generateTerrain', () => {
  it('given a seed, generation is exactly reproducible', () => {
    const opts = { seed: 0x5eed, worldRadius: 20, biome: GRASSLAND };
    const a = generateTerrain(opts);
    const b = generateTerrain(opts);
    expect([...a.terrain.entries()]).toEqual([...b.terrain.entries()]);
    expect([...a.buildingHp.entries()]).toEqual([...b.buildingHp.entries()]);
    expect([...a.coverHp.entries()]).toEqual([...b.coverHp.entries()]);
  });

  it('different seeds (very likely) produce a different feature arrangement', () => {
    const a = generateTerrain({ seed: 1, worldRadius: 20, biome: GRASSLAND });
    const b = generateTerrain({ seed: 2, worldRadius: 20, biome: GRASSLAND });
    let diffs = 0;
    for (const [k, id] of a.terrain) if (b.terrain.get(k) !== id) diffs++;
    expect(diffs).toBeGreaterThan(0);
  });

  it('clears the safe zone around an arbitrary safeCenter back to open ground', () => {
    const safeCenter = { q: 8, r: -4 };
    const { terrain } = generateTerrain({ seed: 0x5eed, worldRadius: 20, biome: GRASSLAND, safeCenter });
    for (const h of range(safeCenter, 3)) {
      const id = terrain.get(axialKey(h.q, h.r));
      expect([GRASSLAND.groundA, GRASSLAND.groundB]).toContain(id);
    }
  });

  it('force-clears extraClear hexes to groundA regardless of the RNG', () => {
    const dummy = axialKey(3, -1);
    const { terrain } = generateTerrain({
      seed: 0x5eed, worldRadius: 20, biome: GRASSLAND, extraClear: [dummy],
    });
    expect(terrain.get(dummy)).toBe(GRASSLAND.groundA);
  });

  it('buildingHp only holds destructible outpost hexes, never soft cover', () => {
    const { terrain, buildingHp, coverHp } = generateTerrain({ seed: 0x5eed, worldRadius: 20, biome: GRASSLAND });
    for (const k of buildingHp.keys()) expect(terrain.get(k)).toBe(GRASSLAND.outpost);
    for (const k of coverHp.keys()) expect(terrain.get(k)).toBe(GRASSLAND.cover);
  });
});

describe('pickFarObjective', () => {
  it('returns null for an empty candidate list', () => {
    expect(pickFarObjective([], { q: 0, r: 0 })).toBeNull();
  });

  it('picks a candidate at or beyond minDistance over a closer one', () => {
    const from = { q: 0, r: 0 };
    const near = axialKey(2, 0);   // distance 2
    const far = axialKey(10, 0);   // distance 10
    const picked = pickFarObjective([near, far], from, 6);
    expect(picked).toBe(far);
  });

  it('falls back to the single farthest candidate if none clear minDistance', () => {
    const from = { q: 0, r: 0 };
    const a = axialKey(1, 0);   // distance 1
    const b = axialKey(2, 0);   // distance 2
    const picked = pickFarObjective([a, b], from, 50);
    expect(picked).toBe(b);
  });

  it('is deterministic given the same inputs (no RNG)', () => {
    const from = { q: 1, r: -1 };
    const keys = [axialKey(4, 0), axialKey(-3, 2), axialKey(0, 5)];
    expect(pickFarObjective(keys, from, 3)).toBe(pickFarObjective(keys, from, 3));
  });
});
