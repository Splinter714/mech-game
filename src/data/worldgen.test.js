// #81/#110/#111 — pure world-generation coverage: the seeded terrain algorithm, the safe-zone
// geometry, the organic (non-circular) region shaping, the boundary ring, and the distance-
// biased objective picker used by stage advance. No Phaser here; these are the deterministic/
// parameterized pieces the arena mixin (scenes/arena/world.js, scenes/arena/run.js) is a thin
// wrapper around.
import { describe, it, expect } from 'vitest';
import {
  mulberry32, safeZoneKeys, generateTerrain, pickFarObjective, FAR_OBJECTIVE_MIN_DIST,
  pickStageObjective, STAGE_OBJECTIVE_NEAR_FRACTION, STAGE_OBJECTIVE_FAR_FRACTION,
  sectorBoundaries, organicBoundary, boundaryRingKeys,
  FULL_BUILD_BASE_RADIUS, FULL_BUILD_VARIATION, MAX_WORLD_RADIUS, BOUNDARY_RING_WIDTH,
  REQUIRED_VIEW_DEPTH_PX, HEX_STEP_PX, CORRIDOR_ASPECT_RATIO, SECTORS,
  MIN_SPAWN_BOUNDARY_HEX_DIST,
} from './worldgen.js';
import { lateFraction as runLateFraction, STAGE_COUNT } from './run.js';
import { getBiome } from './biomes.js';
import { axialKey, range, neighbors, distance, hexToPixel } from './hexgrid.js';
import { GAMEPLAY_ZOOM } from '../scenes/arena/shared.js';

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

  // #127 (playtest: starting map read as a wide open blob — wants "more linear-ish"): the shape
  // can be ELONGATED into a long corridor/strip via `longAxis`/`aspectRatio`, rather than the
  // roughly-even organic blob the default `aspectRatio: 1` produces.
  describe('#127 elongation (longAxis/aspectRatio)', () => {
    // (1, 0) is exactly angle 0 in world space (hexToPixel(n, 0) has y === 0), matching
    // `longAxis: 0` below. (-1, 2) is exactly angle π/2 (hexToPixel(-k, 2k) has x === 0) — the
    // perpendicular ("short axis") direction. Both walk outward from the shared centre so the
    // comparison is a straight reach-in-hexes measurement along each axis.
    const alongLongAxis = { q: 1, r: 0 };
    const alongShortAxis = { q: -1, r: 2 };
    const reachAlong = (region, dir, max = 200) => {
      let n = 0;
      while (n < max && region(dir.q * n, dir.r * n)) n++;
      return n;
    };

    it('reaches much farther along the long axis than the perpendicular short axis', () => {
      const rng = mulberry32(0x5eed);
      const region = organicBoundary({ q: 0, r: 0 }, rng, {
        baseRadius: 40, variation: 10, longAxis: 0, aspectRatio: CORRIDOR_ASPECT_RATIO,
      });
      const longReach = reachAlong(region, alongLongAxis);
      const shortReach = reachAlong(region, alongShortAxis);
      // A "much narrower on one axis" corridor, not a subtle nudge: require at least a 2x
      // difference (comfortably below the ~3x target ratio, allowing for per-sector noise).
      expect(longReach).toBeGreaterThan(shortReach * 2);
    });

    // A single sampled ray is noisy (the per-sector `variation` noise can make one particular
    // ray run short or long by chance — see the flat `reachAlong` checks above, which use a
    // generous 2x margin to absorb that). To check that ROTATING `longAxis` actually rotates
    // the shape (not just verify one fixed orientation), integrate over the WHOLE shape instead
    // of a single ray: project every included hex's pixel position onto the rotated axis and
    // measure the resulting bounding-box span. That average is far less sensitive to any one
    // sector's noise draw than a single ray is.
    const extentAlongAngle = (region, angle, boundingRadius = 120) => {
      const cos = Math.cos(-angle), sin = Math.sin(-angle);
      let min = Infinity, max = -Infinity;
      for (const h of range({ q: 0, r: 0 }, boundingRadius)) {
        if (!region(h.q, h.r)) continue;
        const { x, y } = hexToPixel(h.q, h.r);
        const projected = x * cos - y * sin;   // position along the rotated axis
        if (projected < min) min = projected;
        if (projected > max) max = projected;
      }
      return max - min;
    };

    it('rotating longAxis rotates which direction reads as "long"', () => {
      const rng = mulberry32(0x5eed);
      // Same seed/rng sequence, but the corridor now points along the OTHER axis (π/2) —
      // what was the short axis should now be the long one, and vice versa.
      const region = organicBoundary({ q: 0, r: 0 }, rng, {
        baseRadius: 40, variation: 10, longAxis: Math.PI / 2, aspectRatio: CORRIDOR_ASPECT_RATIO,
      });
      const formerlyLongExtent = extentAlongAngle(region, 0);
      const formerlyShortExtent = extentAlongAngle(region, Math.PI / 2);
      expect(formerlyShortExtent).toBeGreaterThan(formerlyLongExtent * 1.5);
    });

    it('aspectRatio: 1 (the default) reproduces the original roughly-even organic shape', () => {
      const rngA = mulberry32(11), rngB = mulberry32(11);
      const withDefault = organicBoundary({ q: 0, r: 0 }, rngA, { baseRadius: 20, variation: 6 });
      const withExplicitOne = organicBoundary({ q: 0, r: 0 }, rngB, {
        baseRadius: 20, variation: 6, longAxis: 0, aspectRatio: 1,
      });
      for (const [q, r] of [[5, 0], [0, 5], [-4, 2], [3, -6]]) {
        expect(withDefault(q, r)).toBe(withExplicitOne(q, r));
      }
    });
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

  // #127: production (world.js `_buildWorld`) always builds this shape WITH the elongation
  // applied (`aspectRatio: CORRIDOR_ASPECT_RATIO`), never the bare isotropic circle — so this
  // sizing check exercises that actual combination, not just the raw radius constants alone.
  it('produces a single build sized for the whole run — non-circular, and reaching well beyond the old small initial area (12ish hexes) along the long axis', () => {
    const rng = mulberry32(0x5eed);
    const region = organicBoundary({ q: 0, r: 0 }, rng, {
      baseRadius: FULL_BUILD_BASE_RADIUS, variation: FULL_BUILD_VARIATION,
      longAxis: 0, aspectRatio: CORRIDOR_ASPECT_RATIO,
    });
    const dirs = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 1, r: -1 }];
    const reach = dirs.map((d) => {
      let n = 0;
      while (n < 90 && region(d.q * n, d.r * n)) n++;
      return n;
    });
    // Non-circular: not every direction reaches the same distance.
    expect(new Set(reach).size).toBeGreaterThan(1);
    // The long axis (q:1,r:0 is exactly angle 0, matching longAxis: 0) still reaches a real
    // distance, not a degenerate point — #158 deliberately shrank the WHOLE build (the old ">30
    // hexes, beyond the pre-#127 12-hex opening lobe" comparison no longer applies at this much
    // smaller scale; see the dedicated elongation-ratio check below for "long axis clearly beats
    // short axis," which is the actual shape claim that matters).
    expect(reach[0]).toBeGreaterThan(8);
  });

  // #127 sizing pitfall (see the big comment above FULL_BUILD_BASE_RADIUS/VARIATION): the
  // sector boundary values are in "distHex" units (Euclidean pixel distance / HEX_SIZE), which
  // is NOT the same as true hex cube-distance — the two differ by a factor that ranges from
  // 3/2 (at the "in-between" angles) to √3 (along a primary hex direction). Converting a
  // worst-case distHex value to true hex-distance means dividing by the ratio that makes the
  // bound tightest for that check, not comparing the raw distHex number straight to a
  // hex-distance cap (an early version of this test did exactly that and was too strict/wrong).
  const HEX_DIST_RATIO_MIN = 1.5;              // "in-between" angles: smallest distHex/hexDist ratio
  const HEX_DIST_RATIO_MAX = Math.sqrt(3);     // primary hex directions: largest ratio

  // #127: the ELONGATED build's worst-case reach along the long axis must still stay within
  // MAX_WORLD_RADIUS in real hex-distance terms — using the ratio that produces the LARGEST
  // possible hex-distance for a given distHex value (the smallest ratio, 1.5), since that's the
  // worst case for exceeding the cap.
  it('the ELONGATED worst-case long-axis reach (in real hex-distance) stays within MAX_WORLD_RADIUS', () => {
    const longMult = Math.sqrt(CORRIDOR_ASPECT_RATIO);
    const worstCaseLongReachDistHex = (FULL_BUILD_BASE_RADIUS + FULL_BUILD_VARIATION) * longMult;
    const worstCaseLongReachHexDist = worstCaseLongReachDistHex / HEX_DIST_RATIO_MIN;
    expect(worstCaseLongReachHexDist).toBeLessThanOrEqual(MAX_WORLD_RADIUS);
  });

  // #127: the live game (scenes/arena/world.js `_buildWorld`) builds the full-run shape with
  // `longAxis`/`aspectRatio: CORRIDOR_ASPECT_RATIO` — confirm THAT actual combination of
  // constants (not just a toy baseRadius/variation) really does read as an elongated corridor.
  it('the full-build shape, elongated with CORRIDOR_ASPECT_RATIO, reads as a corridor not a blob', () => {
    const rng = mulberry32(0x5eed);
    const region = organicBoundary({ q: 0, r: 0 }, rng, {
      baseRadius: FULL_BUILD_BASE_RADIUS, variation: FULL_BUILD_VARIATION,
      longAxis: 0, aspectRatio: CORRIDOR_ASPECT_RATIO,
    });
    let longReach = 0;
    while (longReach < 200 && region(longReach, 0)) longReach++;
    let shortReach = 0;
    while (shortReach < 200 && region(-shortReach, 2 * shortReach)) shortReach++;
    expect(longReach).toBeGreaterThan(shortReach * 1.5);
  });

  // #127 regression coverage: an earlier attempt at this sizing (base=45/variation=4/AR=3)
  // passed every distHex-based check above yet FAILED the live smoke test — scripts/smoke.mjs's
  // pre-existing #110 check that the biome's `deep` boundary terrain is absent within REAL
  // hex-distance 20 of spawn in EVERY direction. This test pins the real (hex-distance, not
  // distHex) near-spawn margin down directly at the data layer, converting the worst observed
  // distHex minimum via the WORST-CASE ratio (√3, the largest one — smallest resulting
  // hex-distance) — across many seeds/longAxis draws, not just one lucky/unlucky sample — so a
  // future resize of these constants fails fast here instead of only surfacing downstream in a
  // Playwright run.
  // #158: the flat hex-distance-20 floor this test used to pin down was never derived from
  // anything but a "comfortably large" guess (see MIN_SPAWN_BOUNDARY_HEX_DIST's own comment in
  // worldgen.js) — the ACTUAL requirement is just "the safe-clear zone (radius 3) never gets
  // encroached by the boundary ring." Re-derived MIN_SPAWN_BOUNDARY_HEX_DIST (6) as a real, much
  // smaller floor that still clears that hard requirement with margin, now that #158 deliberately
  // shrinks the interior so the boundary sits within camera view. This test still exists to catch
  // a future resize eroding even THAT smaller floor.
  it('never lets the near-spawn safety margin (#158, real hex-distance) get eroded below MIN_SPAWN_BOUNDARY_HEX_DIST', () => {
    let worstMinDistHex = Infinity;
    for (let seed = 0; seed < 500; seed++) {
      const rng = mulberry32(seed * 7919 + 13);
      const longAxis = rng() * Math.PI * 2;
      const boundaries = sectorBoundaries(rng, {
        baseRadius: FULL_BUILD_BASE_RADIUS, variation: FULL_BUILD_VARIATION,
        sectors: SECTORS, longAxis, aspectRatio: CORRIDOR_ASPECT_RATIO,
      });
      for (const b of boundaries) if (b < worstMinDistHex) worstMinDistHex = b;
    }
    const worstMinHexDist = worstMinDistHex / HEX_DIST_RATIO_MAX;
    // A direct grid-scan simulation (worldgen.js's own #158 comment, 2000 seeds) puts the real
    // worst case at 4 real hex-distance at 11/4 — this distHex/ratio conversion is a DIFFERENT,
    // more pessimistic method (divides by the largest ratio, so it always reads at or below the
    // true value), so it's checked against the hard floor with -1 slack rather than the observed
    // 4 directly, to avoid flaking on the two methods' small, expected disagreement.
    expect(worstMinHexDist).toBeGreaterThanOrEqual(MIN_SPAWN_BOUNDARY_HEX_DIST - 1);
  });

  // #127/#158: direct end-to-end confirmation at the data layer (mirroring what the live smoke
  // test checks) — build the actual `organicBoundary` + `boundaryRingKeys` the game uses, across
  // many seeds, and confirm the boundary/ring never lands within MIN_SPAWN_BOUNDARY_HEX_DIST of
  // spawn. This is the strongest regression guard: it doesn't rely on the ratio-conversion math
  // above being applied correctly, it just directly re-derives what scripts/smoke.mjs's near-spawn
  // check verifies.
  it('the actual built shape+ring never reaches within MIN_SPAWN_BOUNDARY_HEX_DIST of spawn, across many seeds', () => {
    let anyTooClose = false;
    for (let seed = 0; seed < 200 && !anyTooClose; seed++) {
      const shapeRng = mulberry32(seed);
      const longAxis = shapeRng() * Math.PI * 2;
      const included = organicBoundary({ q: 0, r: 0 }, shapeRng, {
        baseRadius: FULL_BUILD_BASE_RADIUS, variation: FULL_BUILD_VARIATION,
        sectors: SECTORS, longAxis, aspectRatio: CORRIDOR_ASPECT_RATIO,
      });
      const D = MIN_SPAWN_BOUNDARY_HEX_DIST;
      for (let q = -D; q <= D && !anyTooClose; q++) {
        for (let r = -D; r <= D; r++) {
          if (Math.abs(q) + Math.abs(r) + Math.abs(q + r) > 2 * D) continue;   // hex-distance > D
          if (!included(q, r)) { anyTooClose = true; break; }
        }
      }
    }
    expect(anyTooClose).toBe(false);
  });

  // #158: the whole point of this resize — confirm the boundary is now WITHIN the real camera
  // view RECTANGLE, not just "within half the viewport diagonal." An earlier version of this
  // suite used a circular half-diagonal proxy (matching #126's OWN ring-depth math) and passed
  // cleanly in simulation — then a real Playwright deploy showed the boundary on screen only
  // ~50% of the time. The diagonal (≈734px at 1280x720) is the right worst-case bound for "how
  // deep must the ring be so nothing beyond it is EVER visible" (#126's problem: any single
  // direction reaching that far is enough), but it's the WRONG bound for "is the boundary
  // reliably visible" (this issue's problem): the corridor's short axis lands at a random screen
  // orientation each deploy, and a 1280x720 rectangle's half-HEIGHT (360px) is much smaller than
  // its half-diagonal — a boundary hex "within the diagonal" is very often still outside the
  // actual rectangle. Every check below uses the real axis-aligned rectangle, matching
  // `world.js`/`ArenaScene`'s actual math (canvas size / zoom, dpr cancels) and the live smoke
  // test's own on-screen check, not a circular approximation.
  describe('#158 boundary visible within the real camera view', () => {
    const VIEWPORT_W = 1280, VIEWPORT_H = 720;
    const HALF_W = (VIEWPORT_W / 2) / GAMEPLAY_ZOOM;
    const HALF_H = (VIEWPORT_H / 2) / GAMEPLAY_ZOOM;

    // Does any boundary-ring hex fall inside the real camera rectangle centred at (cx, cy)?
    function boundaryOnScreen(ring, cx, cy) {
      for (const k of ring) {
        const [q, r] = k.split(',').map(Number);
        const { x: bx, y: by } = hexToPixel(q, r);
        if (bx >= cx - HALF_W && bx <= cx + HALF_W && by >= cy - HALF_H && by <= cy + HALF_H) return true;
      }
      return false;
    }

    it('at spawn, the boundary ring is on screen (inside the real 1280x720 rectangle), across many seeds', () => {
      let seeds = 0, onScreen = 0;
      for (let seed = 0; seed < 500; seed++) {
        const shapeRng = mulberry32(seed);
        const longAxis = shapeRng() * Math.PI * 2;
        const included = organicBoundary({ q: 0, r: 0 }, shapeRng, {
          baseRadius: FULL_BUILD_BASE_RADIUS, variation: FULL_BUILD_VARIATION,
          sectors: SECTORS, longAxis, aspectRatio: CORRIDOR_ASPECT_RATIO,
        });
        const ring = boundaryRingKeys(included);
        seeds++;
        if (boundaryOnScreen(ring, 0, 0)) onScreen++;
      }
      // Matches the live 4000-seed sweep in worldgen.js's own #158 comment: 99.9% (a handful of
      // misses at unlucky orientations, not a systematic gap) — not a strict 100%, since this is
      // a single frozen spawn-instant snapshot and the player sees it within moments of moving.
      expect(onScreen).toBeGreaterThanOrEqual(Math.floor(seeds * 0.99));
    });

    it('near a stage-0 objective (pickStageObjective, lateFrac 0), the boundary is on screen', () => {
      let seeds = 0, onScreen = 0;
      for (let seed = 0; seed < 150; seed++) {
        const shapeRng = mulberry32(seed);
        const longAxis = shapeRng() * Math.PI * 2;
        const included = organicBoundary({ q: 0, r: 0 }, shapeRng, {
          baseRadius: FULL_BUILD_BASE_RADIUS, variation: FULL_BUILD_VARIATION,
          sectors: SECTORS, longAxis, aspectRatio: CORRIDOR_ASPECT_RATIO,
        });
        const candidates = [];
        for (let d = 1; d < FULL_BUILD_BASE_RADIUS + FULL_BUILD_VARIATION + 15; d += 2) {
          for (const dir of [{ q: 1, r: 0 }, { q: -1, r: 0 }, { q: 1, r: -2 }, { q: -1, r: 2 }]) {
            if (included(dir.q * d, dir.r * d)) candidates.push(axialKey(dir.q * d, dir.r * d));
          }
        }
        if (candidates.length < 4) continue;
        const ring = boundaryRingKeys(included);
        const from = { q: 0, r: 0 };
        const objKey = pickStageObjective(candidates, from, runLateFraction(0), FAR_OBJECTIVE_MIN_DIST);
        if (!objKey) continue;
        const [oq, or_] = objKey.split(',').map(Number);
        const { x, y } = hexToPixel(oq, or_);
        seeds++;
        if (boundaryOnScreen(ring, x, y)) onScreen++;
      }
      expect(seeds).toBeGreaterThan(50);
      expect(onScreen).toBe(seeds);
    });

    it('near a mid-run stage objective, the boundary is on screen', () => {
      let seeds = 0, onScreen = 0;
      const midStage = Math.floor(STAGE_COUNT / 2);
      for (let seed = 0; seed < 150; seed++) {
        const shapeRng = mulberry32(seed);
        const longAxis = shapeRng() * Math.PI * 2;
        const included = organicBoundary({ q: 0, r: 0 }, shapeRng, {
          baseRadius: FULL_BUILD_BASE_RADIUS, variation: FULL_BUILD_VARIATION,
          sectors: SECTORS, longAxis, aspectRatio: CORRIDOR_ASPECT_RATIO,
        });
        const candidates = [];
        for (let d = 1; d < FULL_BUILD_BASE_RADIUS + FULL_BUILD_VARIATION + 15; d += 2) {
          for (const dir of [{ q: 1, r: 0 }, { q: -1, r: 0 }, { q: 1, r: -2 }, { q: -1, r: 2 }]) {
            if (included(dir.q * d, dir.r * d)) candidates.push(axialKey(dir.q * d, dir.r * d));
          }
        }
        if (candidates.length < 4) continue;
        const ring = boundaryRingKeys(included);
        const from = { q: 0, r: 0 };
        const objKey = pickStageObjective(candidates, from, runLateFraction(midStage), FAR_OBJECTIVE_MIN_DIST);
        if (!objKey) continue;
        const [oq, or_] = objKey.split(',').map(Number);
        const { x, y } = hexToPixel(oq, or_);
        seeds++;
        if (boundaryOnScreen(ring, x, y)) onScreen++;
      }
      expect(seeds).toBeGreaterThan(50);
      expect(onScreen).toBe(seeds);
    });

    it('MAX_WORLD_RADIUS still comfortably bounds the shrunk shape\'s real worst-case reach', () => {
      // Mirrors the long-axis test above (distHex/ratio conversion) but as a direct sanity check
      // against the actual constant in force, so a future MAX_WORLD_RADIUS edit that doesn't
      // track the shrunk FULL_BUILD_* values fails here.
      const longMult = Math.sqrt(CORRIDOR_ASPECT_RATIO);
      const worstCaseLongReachDistHex = (FULL_BUILD_BASE_RADIUS + FULL_BUILD_VARIATION) * longMult;
      const worstCaseLongReachHexDist = worstCaseLongReachDistHex / HEX_DIST_RATIO_MIN;
      expect(worstCaseLongReachHexDist).toBeLessThan(MAX_WORLD_RADIUS);
      // Not wastefully oversized either — MAX_WORLD_RADIUS bounds two O(R^2)-ish scans
      // (generateTerrain's `all` candidate set, boundaryRingKeys' BFS), so a MAX_WORLD_RADIUS far
      // beyond what the shape can ever reach costs real build time for no benefit.
      expect(MAX_WORLD_RADIUS).toBeLessThan(worstCaseLongReachHexDist + 20);
    });
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

  // #126: playtest — the boundary ring wasn't deep enough; the raw black void past it was
  // visible from some camera positions/zooms. BOUNDARY_RING_WIDTH must be derived from the
  // actual worst-case camera view distance (half the viewport diagonal, since the camera
  // converges to centring on the player, who can stand flush against the ring), not a guessed
  // small constant — these tests pin that relationship down instead of just re-asserting
  // whatever number is currently in the file.
  describe('#126 boundary depth actually covers the worst-case camera view distance', () => {
    it('BOUNDARY_RING_WIDTH rendered depth (in px) covers REQUIRED_VIEW_DEPTH_PX', () => {
      const ringDepthPx = BOUNDARY_RING_WIDTH * HEX_STEP_PX;
      expect(ringDepthPx).toBeGreaterThanOrEqual(REQUIRED_VIEW_DEPTH_PX);
    });

    it('is the tightest hex count that still covers that depth (not a wasteful over-guess)', () => {
      // One ring narrower must fall short — otherwise BOUNDARY_RING_WIDTH is bigger than the
      // math actually calls for (which would cost real perf/build-time for no benefit, #126's
      // explicit performance concern).
      const oneNarrower = (BOUNDARY_RING_WIDTH - 1) * HEX_STEP_PX;
      expect(oneNarrower).toBeLessThan(REQUIRED_VIEW_DEPTH_PX);
    });

    it('a full BFS-built ring at the default width is actually that deep in practice', () => {
      // Sanity-check the real BFS output (not just the arithmetic above) against a big, roughly
      // circular region — walk outward from a point squarely inside the shape until we exit the
      // ring, and confirm the ring's real span is at least BOUNDARY_RING_WIDTH hex-steps.
      const rng = mulberry32(0x5eed);
      const included = organicBoundary({ q: 0, r: 0 }, rng, { baseRadius: 20, variation: 2 });
      const ring = boundaryRingKeys(included, {
        ringWidth: BOUNDARY_RING_WIDTH, boundingRadius: 20 + BOUNDARY_RING_WIDTH + 4,
      });
      // Walk due "east" (q+, r=0) from just outside the shape until we leave the ring.
      let q = 0;
      while (included(q, 0)) q++;
      let depth = 0;
      while (ring.has(axialKey(q, 0))) { q++; depth++; }
      expect(depth).toBeGreaterThanOrEqual(BOUNDARY_RING_WIDTH);
    });

    it('stays within a sane order of magnitude (a real depth fix, not a runaway perf regression)', () => {
      // Guards against a future edit accidentally blowing this up (e.g. a typo'd extra zero in
      // the safety margin) — the whole world's tile count scales with this, per #126's own
      // performance-implications warning.
      expect(BOUNDARY_RING_WIDTH).toBeGreaterThan(10);
      expect(BOUNDARY_RING_WIDTH).toBeLessThan(75);
    });
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

// #138 (playtest: "the map still feels huge, especially on initial deploy"): the objective
// distance now scales with the run's `lateFraction` curve (reused straight from data/run.js,
// not reinvented here) instead of always jumping to the single farthest standing outpost.
describe('pickStageObjective (#138)', () => {
  const from = { q: 0, r: 0 };
  // A spread of candidates from very close to very far, so "closest to the target fraction of
  // the farthest candidate" has real choices to make at every stage of the curve.
  const spread = [1, 4, 8, 12, 16, 20, 30, 40, 50, 60].map((d) => axialKey(d, 0));

  it('returns null for an empty candidate list', () => {
    expect(pickStageObjective([], from, 0)).toBeNull();
  });

  it('stage 0 (lateFrac 0) picks a NEAR objective, not the farthest candidate', () => {
    const picked = pickStageObjective(spread, from, 0);
    const [q, r] = picked.split(',').map(Number);
    // Farthest candidate is at distance 60; a near (lateFrac 0) pick should land well short of it.
    expect(distance({ q, r }, from)).toBeLessThan(30);
  });

  it('the final stage (lateFrac 1) picks the single farthest candidate, matching the old always-farthest behavior', () => {
    const picked = pickStageObjective(spread, from, 1);
    expect(picked).toBe(pickFarObjective(spread, from));
  });

  it('the escalation curve is real: later lateFrac values pick meaningfully farther objectives than stage 0', () => {
    const distOf = (k) => { const [q, r] = k.split(',').map(Number); return distance({ q, r }, from); };
    const d0 = distOf(pickStageObjective(spread, from, 0));
    const dMid = distOf(pickStageObjective(spread, from, 0.5));
    const dFinal = distOf(pickStageObjective(spread, from, 1));
    expect(dMid).toBeGreaterThan(d0);
    expect(dFinal).toBeGreaterThan(dMid);
  });

  it('respects minDistance as a floor on the TARGET, even for a near (stage 0) pick', () => {
    // maxD=7, so a raw 20%-of-max target would be ~1.4 — the minDistance floor of 6 pulls the
    // target up to 6, so the candidate AT distance 6 (not the closer ones) should be picked.
    const nearby = [axialKey(1, 0), axialKey(2, 0), axialKey(6, 0), axialKey(7, 0)];
    const picked = pickStageObjective(nearby, from, 0, 6);
    expect(picked).toBe(axialKey(6, 0));
  });

  // Regression (found post-merge, real bug not flakiness): `targetD` was floored at
  // `minDistance`, but the "closest candidate to the target" search wasn't itself restricted to
  // candidates clearing that floor — if the nearest available candidate to a floored target
  // happened to sit UNDER minDistance (because it was numerically closer to the target than any
  // candidate that actually cleared the floor), it still got picked, silently violating the
  // floor the caller asked for. maxD=20 so target=max(6, 0.2*20=4)=6; among [3, 5, 20], distance
  // 5 is numerically closest to 6 (diff 1) but sits BELOW minDistance, while 20 is the only
  // candidate that actually clears it — the returned candidate's OWN distance must clear
  // minDistance, not just have shaped the target that produced it.
  it('never returns a candidate whose OWN distance falls under minDistance, even if it is numerically closest to the (floored) target', () => {
    const gappy = [axialKey(3, 0), axialKey(5, 0), axialKey(20, 0)];
    const picked = pickStageObjective(gappy, from, 0, 6);
    const [q, r] = picked.split(',').map(Number);
    expect(distance({ q, r }, from)).toBeGreaterThanOrEqual(6);
    expect(picked).toBe(axialKey(20, 0));
  });

  it('falls back to the overall closest-to-target candidate if NONE clear minDistance at all', () => {
    const allTooClose = [axialKey(1, 0), axialKey(2, 0), axialKey(3, 0)];
    // maxD=3, target=max(6, 0.2*3=0.6)=6 — nothing here clears 6, so the fallback picks whatever
    // is numerically closest to the target among the whole set (distance 3, diff 3, is closest).
    const picked = pickStageObjective(allTooClose, from, 0, 6);
    expect(picked).toBe(axialKey(3, 0));
  });

  it('degrades gracefully with very few standing candidates (no separate fallback needed)', () => {
    const onlyTwo = [axialKey(2, 0), axialKey(3, 0)];
    const picked = pickStageObjective(onlyTwo, from, 0);
    expect(onlyTwo).toContain(picked);
  });

  it('is deterministic given the same inputs (no RNG)', () => {
    expect(pickStageObjective(spread, from, 0.5)).toBe(pickStageObjective(spread, from, 0.5));
  });

  it('STAGE_OBJECTIVE_NEAR_FRACTION is meaningfully smaller than STAGE_OBJECTIVE_FAR_FRACTION', () => {
    expect(STAGE_OBJECTIVE_NEAR_FRACTION).toBeGreaterThan(0);
    expect(STAGE_OBJECTIVE_NEAR_FRACTION).toBeLessThan(0.5);
    expect(STAGE_OBJECTIVE_FAR_FRACTION).toBe(1);
  });

  // End-to-end check using the SAME curve the live game wires through mission.js/run.js: reusing
  // data/run.js's own `lateFraction(stageIndex)` across all STAGE_COUNT stages, confirm stage 0's
  // objective is meaningfully nearer than the final stage's, on a realistic candidate spread built
  // over an actual (trimmed, #138) full-run map shape.
  it('across the real run curve (data/run.js lateFraction), stage 0 is meaningfully nearer than the final stage', () => {
    const rng = mulberry32(0xF00D);
    const region = organicBoundary({ q: 0, r: 0 }, rng, {
      baseRadius: FULL_BUILD_BASE_RADIUS, variation: FULL_BUILD_VARIATION,
      longAxis: 0, aspectRatio: CORRIDOR_ASPECT_RATIO,
    });
    // A candidate outpost every hex along the long axis, out to the shape's edge. #158 shrank
    // MAX_WORLD_RADIUS enough that the old "every 3 hexes" stride left too few samples on this
    // much smaller map — every hex still reads as "a realistic candidate spread," just denser.
    const candidates = [];
    for (let d = 1; d < MAX_WORLD_RADIUS; d += 1) {
      if (region(d, 0)) candidates.push(axialKey(d, 0));
    }
    expect(candidates.length).toBeGreaterThan(5);

    const distOf = (k) => { const [q, r] = k.split(',').map(Number); return distance({ q, r }, from); };
    const stage0Dist = distOf(pickStageObjective(candidates, from, runLateFraction(0)));
    const lastStageDist = distOf(pickStageObjective(candidates, from, runLateFraction(STAGE_COUNT - 1)));
    const maxCandidateDist = Math.max(...candidates.map(distOf));

    // Stage 0's objective is a short trek relative to the map's overall reachable distance...
    // #158: at the deliberately much-smaller post-#158 map size, FAR_OBJECTIVE_MIN_DIST (6) can
    // land stage 0 EXACTLY on that floor (0.2 * maxCandidateDist rounds under it on a small map),
    // so this is <= rather than a strict <: still a short trek, just occasionally floor-limited.
    expect(stage0Dist).toBeLessThanOrEqual(maxCandidateDist * 0.4);
    // ...while the final stage reaches noticeably farther than stage 0 did.
    expect(lastStageDist).toBeGreaterThan(stage0Dist * 1.5);
  });
});
