// #81 — pure world-generation coverage: the seeded terrain algorithm, the safe-zone
// geometry, and the distance-biased objective picker used by stage advance. No Phaser here;
// these are the deterministic/parameterized pieces the arena mixin (scenes/arena/world.js,
// scenes/arena/run.js) is a thin wrapper around.
import { describe, it, expect } from 'vitest';
import {
  mulberry32, safeZoneKeys, generateTerrain, pickFarObjective,
  makeRevealRegion, pickRevealAngle,
} from './worldgen.js';
import { getBiome } from './biomes.js';
import { axialKey, range, hexToPixel } from './hexgrid.js';

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

  // #81 follow-up — directional partial regen: given an existing terrain map + a reveal-region
  // predicate, hexes OUTSIDE the region must come back byte-identical to the input map, and
  // hexes INSIDE the region must be the generator's fresh stamp (not the preserved value).
  describe('partial regen (reveal + previous)', () => {
    const worldRadius = 20;
    // A simple "east half" reveal region so the split is easy to reason about in tests: q >= 0
    // is "inside" (eligible to regenerate), q < 0 is "outside" (must be preserved).
    const eastHalf = (q) => q >= 0;

    it('preserves every hex outside the reveal region exactly as the previous map had it', () => {
      const previous = generateTerrain({ seed: 0x5eed, worldRadius, biome: GRASSLAND });
      const next = generateTerrain({
        seed: 0xC0FFEE, worldRadius, biome: GRASSLAND, reveal: eastHalf, previous,
      });
      for (const [k, id] of previous.terrain) {
        const [q] = k.split(',').map(Number);
        if (!eastHalf(q)) {
          expect(next.terrain.get(k)).toBe(id);
          expect(next.buildingHp.get(k)).toBe(previous.buildingHp.get(k));
          expect(next.coverHp.get(k)).toBe(previous.coverHp.get(k));
        }
      }
    });

    it('preserves a partially-destroyed outpost\'s remaining HP outside the region, not full HP', () => {
      const previous = generateTerrain({ seed: 0x5eed, worldRadius, biome: GRASSLAND });
      // Find a standing outpost hex outside the reveal region and simulate partial damage.
      const outsideOutpost = [...previous.buildingHp.keys()].find((k) => !eastHalf(Number(k.split(',')[0])));
      expect(outsideOutpost).toBeTruthy();
      previous.buildingHp.set(outsideOutpost, 5); // partially damaged, far from full HP
      const next = generateTerrain({
        seed: 0xC0FFEE, worldRadius, biome: GRASSLAND, reveal: eastHalf, previous,
      });
      expect(next.buildingHp.get(outsideOutpost)).toBe(5);
    });

    it('actually regenerates hexes inside the reveal region with the new stamp', () => {
      const previous = generateTerrain({ seed: 0x5eed, worldRadius, biome: GRASSLAND });
      const next = generateTerrain({
        seed: 0xC0FFEE, worldRadius, biome: GRASSLAND, reveal: eastHalf, previous,
      });
      // Compare against a fully independent second pass with the SAME new seed and no
      // preservation — the "inside" hexes of `next` must match this fresh, un-preserved stamp
      // (proving the generator's stamping logic ran for them, not just copied `previous`).
      const freshOnly = generateTerrain({ seed: 0xC0FFEE, worldRadius, biome: GRASSLAND });
      let matchesFresh = 0, matchesPrevious = 0, total = 0;
      for (const [k, id] of next.terrain) {
        const [q] = k.split(',').map(Number);
        if (eastHalf(q)) {
          total++;
          if (id === freshOnly.terrain.get(k)) matchesFresh++;
          if (id === previous.terrain.get(k)) matchesPrevious++;
        }
      }
      expect(total).toBeGreaterThan(0);
      expect(matchesFresh).toBe(total); // inside the region, `next` IS the fresh stamp
      // And it's a genuinely new arrangement — not simply identical to the old one everywhere.
      expect(matchesPrevious).toBeLessThan(total);
    });

    it('with no reveal/previous (the default), behaves exactly like the original full-disc regen', () => {
      const opts = { seed: 0x5eed, worldRadius, biome: GRASSLAND };
      const a = generateTerrain(opts);
      const b = generateTerrain({ ...opts, reveal: null, previous: null });
      expect([...a.terrain.entries()]).toEqual([...b.terrain.entries()]);
      expect([...a.buildingHp.entries()]).toEqual([...b.buildingHp.entries()]);
      expect([...a.coverHp.entries()]).toEqual([...b.coverHp.entries()]);
    });
  });
});

describe('makeRevealRegion', () => {
  it('excludes hexes within the buffer distance of the player, in every direction', () => {
    const reveal = makeRevealRegion(0, 0, 0, { bufferHexes: 5 });
    // A hex right next to the player (distance ~1) must never be "inside", regardless of angle.
    for (const h of range({ q: 0, r: 0 }, 1)) expect(reveal(h.q, h.r)).toBe(false);
  });

  it('includes a hex straight ahead in the chosen direction, beyond the buffer', () => {
    const angle = 0; // due "east" in pixel space
    const reveal = makeRevealRegion(0, 0, angle, { bufferHexes: 3, halfAngle: Math.PI / 4 });
    const { x } = hexToPixel(12, 0);
    expect(x).toBeGreaterThan(0);
    expect(reveal(12, 0)).toBe(true);
  });

  it('excludes a hex behind the player (opposite the chosen direction), even far away', () => {
    const angle = 0; // facing east
    const reveal = makeRevealRegion(0, 0, angle, { bufferHexes: 3, halfAngle: Math.PI / 4 });
    expect(reveal(-12, 0)).toBe(false);
  });

  it('excludes a hex well off to the side, outside the wedge half-angle', () => {
    const angle = 0; // facing east
    const reveal = makeRevealRegion(0, 0, angle, { bufferHexes: 3, halfAngle: Math.PI / 6 }); // 30°
    // Straight "south" (90°) is well outside a 30°-half-angle east-facing wedge.
    expect(reveal(0, 12)).toBe(false);
  });
});

describe('pickRevealAngle', () => {
  it('continues the given heading when there is room in that direction', () => {
    const angle = pickRevealAngle({
      playerPx: 0, playerPy: 0, worldRadius: 20, headingAngle: 0,
    });
    expect(angle).toBe(0);
  });

  it('does not continue a heading that would run straight into the world edge with no room', () => {
    // Stand the player near the edge, heading further outward (away from origin) — that
    // direction has no depth left, so the picked angle must NOT be the outward heading.
    const worldRadius = 20;
    const edgePx = (worldRadius - 1) * 48 * Math.sqrt(3); // just inside the disc, due east
    const outwardHeading = 0; // continuing further east runs straight off the map
    const angle = pickRevealAngle({
      playerPx: edgePx, playerPy: 0, worldRadius, headingAngle: outwardHeading, rand: () => 0.5,
    });
    expect(angle).not.toBe(outwardHeading);
  });

  it('is deterministic given an injected rand function', () => {
    const opts = { playerPx: 100, playerPy: -50, worldRadius: 20, headingAngle: null, rand: () => 0.37 };
    expect(pickRevealAngle(opts)).toBe(pickRevealAngle(opts));
  });

  it('falls back to a real angle (not NaN) even from world origin with no heading', () => {
    const angle = pickRevealAngle({ playerPx: 0, playerPy: 0, worldRadius: 20, headingAngle: null, rand: () => 0.9 });
    expect(Number.isFinite(angle)).toBe(true);
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

  // #81 follow-up: a `reveal` predicate scopes the pick to hexes inside the reveal region —
  // the objective must always land where the player has to walk into the fresh area, even if
  // an outside-the-region candidate would otherwise have been picked as "farthest".
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
});
