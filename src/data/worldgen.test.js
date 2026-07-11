// #81/#110/#111 — pure world-generation coverage: the seeded terrain algorithm, the safe-zone
// geometry, the organic (non-circular) region shaping, the boundary ring, and the distance-
// biased objective picker used by stage advance. No Phaser here; these are the deterministic/
// parameterized pieces the arena mixin (scenes/arena/world.js, scenes/arena/run.js) is a thin
// wrapper around.
import { describe, it, expect } from 'vitest';
import {
  mulberry32, safeZoneKeys, generateTerrain, pickFarObjective, FAR_OBJECTIVE_MIN_DIST,
  sectorBoundaries, organicBoundary, boundaryRingKeys,
  FULL_BUILD_BASE_RADIUS, FULL_BUILD_VARIATION, MAX_WORLD_RADIUS, BOUNDARY_RING_WIDTH,
} from './worldgen.js';
import { getBiome } from './biomes.js';
import { axialKey, range, neighbors, distance } from './hexgrid.js';

const GRASSLAND = getBiome('grassland');
const DESERT = getBiome('desert');

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

describe('sectorBoundaries', () => {
  it('varies meaningfully by sector — not a uniform (circular) radius', () => {
    const rng = mulberry32(0x5eed);
    const boundaries = sectorBoundaries(rng, { baseRadius: 10, variation: 4, sectors: 20 });
    expect(boundaries.length).toBe(20);
    const min = Math.min(...boundaries), max = Math.max(...boundaries);
    // A perfect circle would have max === min; real variation should spread noticeably.
    expect(max - min).toBeGreaterThan(1);
  });

  it('is deterministic given the same seeded rng sequence', () => {
    const a = sectorBoundaries(mulberry32(42), { baseRadius: 10, variation: 4 });
    const b = sectorBoundaries(mulberry32(42), { baseRadius: 10, variation: 4 });
    expect(a).toEqual(b);
  });

  it('smooths each sector toward its neighbours (no wild single-sector spikes)', () => {
    // With smoothing, no sector should land outside the theoretical unsmoothed extreme
    // (baseRadius ± variation) — smoothing only pulls values IN toward their neighbours.
    const rng = mulberry32(7);
    const boundaries = sectorBoundaries(rng, { baseRadius: 10, variation: 4, sectors: 16 });
    for (const d of boundaries) {
      expect(d).toBeGreaterThanOrEqual(10 - 4 - 1e-9);
      expect(d).toBeLessThanOrEqual(10 + 4 + 1e-9);
    }
  });
});

describe('organicBoundary', () => {
  it('produces a non-circular shape: included distance varies by direction', () => {
    const rng = mulberry32(0x5eed);
    const region = organicBoundary({ q: 0, r: 0 }, rng, { baseRadius: 10, variation: 4, sectors: 20 });
    // Walk outward along several different directions and find how far each stays "inside".
    const dirs = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 1, r: -1 }];
    const reach = dirs.map((d) => {
      let n = 0;
      while (n < 30 && region(d.q * n, d.r * n)) n++;
      return n;
    });
    // A perfect disc would give identical reach in every direction; an organic shape shouldn't.
    expect(new Set(reach).size).toBeGreaterThan(1);
  });

  it('always includes the centre hex itself', () => {
    const rng = mulberry32(3);
    const region = organicBoundary({ q: 5, r: -2 }, rng, { baseRadius: 8, variation: 3 });
    expect(region(5, -2)).toBe(true);
  });

  it('excludes hexes far beyond baseRadius + variation in every direction', () => {
    const rng = mulberry32(3);
    const region = organicBoundary({ q: 0, r: 0 }, rng, { baseRadius: 8, variation: 3 });
    expect(region(100, 0)).toBe(false);
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

  // #110: the biome's reserved-for-boundary `deep` id must never appear as an in-map feature —
  // only the biome's lesser `hazard` (if any) may show up, and only ever via `boundaryRing`
  // (tested separately below) does `deep` ever get stamped.
  describe('#110 deep is boundary-only; hazard is the in-map feature', () => {
    it('never stamps a biome\'s `deep` terrain id without an explicit boundaryRing', () => {
      const { terrain } = generateTerrain({ seed: 0x5eed, worldRadius: 25, biome: DESERT });
      for (const id of terrain.values()) expect(id).not.toBe(DESERT.deep);
    });

    it('may stamp the biome\'s lesser `hazard` id as an in-map feature (over many seeds)', () => {
      let sawHazard = false;
      for (let seed = 0; seed < 20 && !sawHazard; seed++) {
        const { terrain } = generateTerrain({ seed, worldRadius: 25, biome: DESERT });
        for (const id of terrain.values()) if (id === DESERT.hazard) { sawHazard = true; break; }
      }
      expect(sawHazard).toBe(true);
    });

    it('grassland (no hazard) never stamps anything but its normal roles', () => {
      const { terrain } = generateTerrain({ seed: 0x5eed, worldRadius: 25, biome: GRASSLAND });
      const validIds = new Set([
        GRASSLAND.groundA, GRASSLAND.groundB, GRASSLAND.channel, GRASSLAND.cover, GRASSLAND.outpost,
      ]);
      for (const id of terrain.values()) expect(validIds.has(id)).toBe(true);
    });

    it('stamps `boundaryRing` keys with the biome\'s `deep` id, unconditionally', () => {
      const ring = new Set([axialKey(50, 0), axialKey(51, 0)]);
      const { terrain } = generateTerrain({ seed: 0x5eed, worldRadius: 5, biome: DESERT, boundaryRing: ring });
      for (const k of ring) expect(terrain.get(k)).toBe(DESERT.deep);
    });
  });

  describe('included (organic-shape masking)', () => {
    it('excludes every hex outside the `included` predicate entirely (no tile at all)', () => {
      const included = (q, r) => q >= 0; // an arbitrary "east half" mask
      const { terrain } = generateTerrain({ seed: 0x5eed, worldRadius: 20, biome: GRASSLAND, included });
      for (const [k] of terrain) {
        const [q] = k.split(',').map(Number);
        expect(q).toBeGreaterThanOrEqual(0);
      }
    });

    it('an organic region produces a genuinely smaller/irregular hex count than the full disc', () => {
      const rng = mulberry32(0x5eed);
      const included = organicBoundary({ q: 0, r: 0 }, rng, { baseRadius: 12, variation: 4 });
      const organic = generateTerrain({ seed: 0x5eed, worldRadius: 20, biome: GRASSLAND, included });
      const fullDisc = generateTerrain({ seed: 0x5eed, worldRadius: 20, biome: GRASSLAND });
      expect(organic.terrain.size).toBeLessThan(fullDisc.terrain.size);
    });

    it('omitting `included` (the default) keeps the full worldRadius-disc behavior', () => {
      const opts = { seed: 0x5eed, worldRadius: 20, biome: GRASSLAND };
      const a = generateTerrain(opts);
      const b = generateTerrain({ ...opts, included: null });
      expect([...a.terrain.entries()]).toEqual([...b.terrain.entries()]);
    });
  });
});

// #111: the whole run's terrain is built ONCE, upfront, to a generous fixed max extent —
// there is no more per-stage incremental growth.
describe('full-run upfront build sizing (#111)', () => {
  it('FULL_BUILD_BASE_RADIUS + FULL_BUILD_VARIATION stays within MAX_WORLD_RADIUS', () => {
    expect(FULL_BUILD_BASE_RADIUS + FULL_BUILD_VARIATION).toBeLessThanOrEqual(MAX_WORLD_RADIUS);
  });

  it('keeps genuine (non-zero) organic variation at the full-build radius', () => {
    expect(FULL_BUILD_VARIATION).toBeGreaterThan(0);
  });

  it('produces a single build sized for the whole run — non-circular, and reaching well beyond the old small initial area (12ish hexes)', () => {
    const rng = mulberry32(0x5eed);
    const region = organicBoundary({ q: 0, r: 0 }, rng, {
      baseRadius: FULL_BUILD_BASE_RADIUS, variation: FULL_BUILD_VARIATION,
    });
    const dirs = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 1, r: -1 }];
    const reach = dirs.map((d) => {
      let n = 0;
      while (n < 90 && region(d.q * n, d.r * n)) n++;
      return n;
    });
    // Non-circular: not every direction reaches the same distance.
    expect(new Set(reach).size).toBeGreaterThan(1);
    // Generously larger than the old small opening area in every direction.
    for (const r of reach) expect(r).toBeGreaterThan(30);
  });
});

// #110: the boundary ring — a biome-appropriate impassable hex ring drawn just outside the
// pre-built area's own organic edge.
describe('boundaryRingKeys (#110)', () => {
  it('every ring hex is adjacent to at least one included hex (hugs the shape\'s edge)', () => {
    const rng = mulberry32(1);
    const included = organicBoundary({ q: 0, r: 0 }, rng, { baseRadius: 8, variation: 2 });
    const ring = boundaryRingKeys(included, { ringWidth: 1, boundingRadius: 14 });
    expect(ring.size).toBeGreaterThan(0);
    for (const k of ring) {
      const [q, r] = k.split(',').map(Number);
      expect(included(q, r)).toBe(false);
      const touchesIncluded = neighbors(q, r).some((n) => included(n.q, n.r));
      expect(touchesIncluded).toBe(true);
    }
  });

  it('never includes a hex that is itself part of the shape', () => {
    const rng = mulberry32(2);
    const included = organicBoundary({ q: 0, r: 0 }, rng, { baseRadius: 8, variation: 2 });
    const ring = boundaryRingKeys(included, { ringWidth: 2, boundingRadius: 14 });
    for (const k of ring) {
      const [q, r] = k.split(',').map(Number);
      expect(included(q, r)).toBe(false);
    }
  });

  it('a wider ringWidth produces a thicker (larger) ring', () => {
    const rng1 = mulberry32(3), rng2 = mulberry32(3);
    const included1 = organicBoundary({ q: 0, r: 0 }, rng1, { baseRadius: 8, variation: 2 });
    const included2 = organicBoundary({ q: 0, r: 0 }, rng2, { baseRadius: 8, variation: 2 });
    const thin = boundaryRingKeys(included1, { ringWidth: 1, boundingRadius: 14 });
    const thick = boundaryRingKeys(included2, { ringWidth: 3, boundingRadius: 14 });
    expect(thick.size).toBeGreaterThan(thin.size);
  });

  it('default BOUNDARY_RING_WIDTH is a small, sane positive number', () => {
    expect(BOUNDARY_RING_WIDTH).toBeGreaterThan(0);
    expect(BOUNDARY_RING_WIDTH).toBeLessThan(10);
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

  // A `reveal` predicate can still scope the pick to a subset of candidates — kept as an
  // optional filter (nothing in the live game passes it since #111, but it's still exercised
  // here since the parameter remains part of the pure API).
  describe('with a reveal predicate', () => {
    const from = { q: 0, r: 0 };
    const inRegion = (q) => q >= 0;

    it('never picks a candidate outside the reveal region', () => {
      const nearButInRegion = axialKey(3, 0);     // q=3 >= 0: inside
      const farButOutsideRegion = axialKey(-20, 0); // q=-20 < 0: outside, would win on distance alone
      const picked = pickFarObjective([nearButInRegion, farButOutsideRegion], from, 6, inRegion);
      expect(picked).toBe(nearButInRegion);
    });

    it('returns null if no candidate lies inside the reveal region', () => {
      const onlyOutside = [axialKey(-4, 0), axialKey(-9, 2)];
      expect(pickFarObjective(onlyOutside, from, 6, inRegion)).toBeNull();
    });

    it('omitting reveal keeps the original whole-map behavior', () => {
      const near = axialKey(2, 0);
      const far = axialKey(-10, 0);
      expect(pickFarObjective([near, far], from, 6)).toBe(far);
    });
  });

  // #81 follow-up (playtest 2026-07-10 point 4): the FIRST stage's objective (mission.js
  // `_initMission`) — and, per #111, every LATER stage's objective too (scenes/arena/run.js
  // `_pickNextStageObjective`) — shares this exact function + floor.
  describe('as used for the FIRST stage objective (mission.js _initMission)', () => {
    it('the default minDistance IS the shared FAR_OBJECTIVE_MIN_DIST floor', () => {
      const from = { q: 0, r: 0 };
      const near = axialKey(2, 0);   // distance 2 — inside spawn view, must not be picked
      const far = axialKey(10, 0);   // distance 10 — requires real travel
      expect(pickFarObjective([near, far], from)).toBe(far);
    });

    it('FAR_OBJECTIVE_MIN_DIST is exported so both the first stage and later stages share one floor', () => {
      expect(FAR_OBJECTIVE_MIN_DIST).toBeGreaterThan(0);
    });
  });
});
