// #81/#110/#111/#169 — pure world-generation coverage: the seeded terrain algorithm, the safe-zone
// geometry, the snaking-corridor spine + carving, the boundary ring, and the distance-biased
// objective picker used by stage advance. No Phaser here; these are the deterministic/parameterized
// pieces the arena mixin (scenes/arena/world.js, scenes/arena/run.js) is a thin wrapper around.
import { describe, it, expect } from 'vitest';
import {
  mulberry32, safeZoneKeys, generateTerrain, pickFarObjective, FAR_OBJECTIVE_MIN_DIST,
  pickStageObjective, STAGE_OBJECTIVE_NEAR_FRACTION, STAGE_OBJECTIVE_FAR_FRACTION,
  boundaryRingKeys, MAX_WORLD_RADIUS, BOUNDARY_RING_WIDTH, MIN_SPAWN_BOUNDARY_HEX_DIST,
  REQUIRED_VIEW_DEPTH_PX, HEX_STEP_PX,
  generateSpine, corridorHexSet, spineProgressHexOf,
  CORRIDOR_HALF_WIDTH_PX, CORRIDOR_LENGTH_PX, CORRIDOR_REAR_PAD_PX, HELIPAD_COUNT,
  BASE_COUNT, DOCKS_PER_BASE_MIN, DOCKS_PER_BASE_MAX, ALERT_TOWERS_PER_BASE_MIN,
  ALERT_TOWERS_PER_BASE_MAX, BASE_EARLY_KIND_POOL, BASE_LATE_KIND_POOL, baseLateFraction,
  placeBases, dockCountFor, TURRET_EMPLACEMENTS_PER_BASE_MIN, TURRET_EMPLACEMENTS_PER_BASE_MAX,
} from './worldgen.js';
import { getBiome } from './biomes.js';
import { TERRAIN } from './terrain.js';
import { axialKey, range, neighbors, distance, hexToPixel } from './hexgrid.js';
import { GAMEPLAY_ZOOM } from '../scenes/arena/shared.js';

const GRASSLAND = getBiome('grassland');
const DESERT = getBiome('desert');

// A simple analytic disc predicate, used to exercise the boundaryRingKeys/generateTerrain
// `included`-predicate fallback path without the (removed) organic-blob generator.
const disc = (radius) => (q, r) => distance({ q, r }, { q: 0, r: 0 }) <= radius;

// Build the live corridor exactly the way scenes/arena/world.js `_buildWorld` does, for a seed.
function buildCorridor(seed, halfWidth = CORRIDOR_HALF_WIDTH_PX) {
  const shapeRng = mulberry32(seed);
  const startAngle = shapeRng() * Math.PI * 2;
  const spine = generateSpine(shapeRng, { startAngle });
  const includedKeys = corridorHexSet(spine.points, halfWidth, safeZoneKeys({ q: 0, r: 0 }, 3));
  return { spine, includedKeys, startAngle };
}

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
    expect(keys.length).toBe(37);
  });

  it('is centred on an arbitrary hex, not always world origin', () => {
    const keys = safeZoneKeys({ q: 10, r: -5 }, 1);
    expect(keys).toContain(axialKey(10, -5));
    expect(keys).not.toContain(axialKey(0, 0));
  });
});

// #169: the snaking-corridor spine + carving.
describe('generateSpine (#169)', () => {
  it('is deterministic given the same seeded rng + options', () => {
    const a = generateSpine(mulberry32(42), { startAngle: 1 });
    const b = generateSpine(mulberry32(42), { startAngle: 1 });
    expect(a.points).toEqual(b.points);
  });

  it('passes exactly through world origin at u=0 (the spawn end)', () => {
    const spine = generateSpine(mulberry32(7), { startAngle: 2.1 });
    const at0 = spine.points.find((p) => Math.abs(p.u) < 1e-6);
    expect(at0).toBeDefined();
    expect(Math.hypot(at0.x, at0.y)).toBeLessThan(1e-6);
  });

  it('is a single non-self-intersecting path: main-axis progress u is strictly monotonic', () => {
    // A single-valued lateral offset over a monotonic main axis can never self-intersect or
    // double back — this pins the property the geometry relies on. Checked across seeds/headings.
    for (let seed = 0; seed < 50; seed++) {
      const spine = buildCorridor(seed).spine;
      for (let i = 1; i < spine.points.length; i++) {
        expect(spine.points[i].u).toBeGreaterThan(spine.points[i - 1].u);
      }
    }
  });

  it('spans from behind the spawn end to the full corridor length', () => {
    const spine = generateSpine(mulberry32(3), { startAngle: 0 });
    const us = spine.points.map((p) => p.u);
    // Extends behind the spawn end by ~rearPad (snapped out to the u=0-aligned sample grid).
    expect(Math.min(...us)).toBeLessThanOrEqual(-CORRIDOR_REAR_PAD_PX);
    expect(Math.min(...us)).toBeGreaterThan(-CORRIDOR_REAR_PAD_PX - HEX_STEP_PX);
    expect(Math.max(...us)).toBeGreaterThanOrEqual(CORRIDOR_LENGTH_PX - HEX_STEP_PX);
  });

  it('genuinely snakes: the spine wanders off a straight main axis', () => {
    // Project each point onto the perpendicular of its own start heading; a straight corridor
    // would stay at 0, a snake swings out to ~CORRIDOR_CURVINESS.
    const startAngle = 0.9;
    const spine = generateSpine(mulberry32(11), { startAngle });
    const perpX = -Math.sin(startAngle), perpY = Math.cos(startAngle);
    const maxPerp = Math.max(...spine.points.map((p) => Math.abs(p.x * perpX + p.y * perpY)));
    expect(maxPerp).toBeGreaterThan(120);
  });
});

describe('corridorHexSet (#169)', () => {
  it('always contains the spawn safe zone (force-included)', () => {
    const { includedKeys } = buildCorridor(5);
    for (const k of safeZoneKeys({ q: 0, r: 0 }, 3)) expect(includedKeys.has(k)).toBe(true);
  });

  it('is a single connected component (one continuous corridor, no islands)', () => {
    for (let seed = 0; seed < 30; seed++) {
      const { includedKeys } = buildCorridor(seed);
      const start = [...includedKeys][0];
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) {
        const [q, r] = stack.pop().split(',').map(Number);
        for (const n of neighbors(q, r)) {
          const nk = axialKey(n.q, n.r);
          if (includedKeys.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
        }
      }
      expect(seen.size).toBe(includedKeys.size);
    }
  });

  it('is genuinely narrow: far thinner than a disc that reaches as far', () => {
    const { includedKeys } = buildCorridor(1);
    // Max hex-distance the corridor reaches from origin.
    let reach = 0;
    for (const k of includedKeys) {
      const [q, r] = k.split(',').map(Number);
      reach = Math.max(reach, distance({ q, r }, { q: 0, r: 0 }));
    }
    const discArea = 3 * reach * reach; // ~hex count of a filled disc of that radius
    expect(includedKeys.size).toBeLessThan(discArea * 0.5);
  });
});

describe('spineProgressHexOf (#169)', () => {
  it('is ~0 at the spawn end and grows toward the far end', () => {
    const { spine } = buildCorridor(4);
    expect(Math.abs(spineProgressHexOf(spine, 0, 0))).toBeLessThan(1);
    // The far tip of the spine, as a hex, should read as a large progress. Inline nearest-hex of
    // the far pixel (hexToPixel-consistent axial rounding) to avoid importing more helpers here.
    const farPt = spine.points[spine.points.length - 1];
    const fq = Math.round((Math.sqrt(3) / 3 * farPt.x - 1 / 3 * farPt.y) / 48);
    const fr = Math.round((2 / 3 * farPt.y) / 48);
    expect(spineProgressHexOf(spine, fq, fr)).toBeGreaterThan(CORRIDOR_LENGTH_PX / HEX_STEP_PX * 0.6);
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

  it('buildingHp only holds destructible solid hexes (outposts + base infra like helipad/alertTower), never soft cover', () => {
    const { terrain, buildingHp, coverHp } = generateTerrain({ seed: 0x5eed, worldRadius: 20, biome: GRASSLAND });
    // #251: helipad is now destructible too, so buildingHp legitimately holds it alongside the
    // biome's real outpost — both are "solid" (non-soft-cover) destructibles; only outposts are
    // ever picked as the mission objective (isMissionObjective, exercised elsewhere). #269: the
    // alertTower base-infra hex is the same kind of destructible-but-not-a-mission-objective
    // set-dressing.
    for (const k of buildingHp.keys()) expect([GRASSLAND.outpost, 'helipad', 'alertTower']).toContain(terrain.get(k));
    for (const k of coverHp.keys()) expect(terrain.get(k)).toBe(GRASSLAND.cover);
  });

  describe('#251 helipad — static set-dressing stamped at world-gen time, decoupled from any spawn', () => {
    // The candidate hex for each of the HELIPAD_COUNT draws only actually becomes a helipad if
    // it's still plain ground by then (`isGround`) — same "best-effort, may occasionally skip a
    // draw" shape `_spawnOutpostAt` (world.js) already tolerates — so the count is a ceiling, not
    // a guarantee, but across a spread of seeds it should usually hit the full count and never
    // exceed it.
    it('stamps at most HELIPAD_COUNT helipad hexes, usually hitting the full count, biome-independent', () => {
      for (const biome of [GRASSLAND, DESERT]) {
        let sawFullCount = false;
        for (let seed = 0; seed < 30; seed++) {
          const { terrain } = generateTerrain({ seed, worldRadius: 25, biome });
          const count = [...terrain.values()].filter((id) => id === 'helipad').length;
          expect(count).toBeLessThanOrEqual(HELIPAD_COUNT);
          if (count === HELIPAD_COUNT) sawFullCount = true;
        }
        expect(sawFullCount).toBe(true);
      }
    });

    it('is reproducible for a given seed, same as every other feature', () => {
      const opts = { seed: 0x5eed, worldRadius: 20, biome: GRASSLAND };
      const a = generateTerrain(opts);
      const b = generateTerrain(opts);
      const helipadsOf = (t) => [...t].filter(([, id]) => id === 'helipad').map(([k]) => k).sort();
      expect(helipadsOf(a.terrain)).toEqual(helipadsOf(b.terrain));
    });

    // #251 (playtest follow-up): helipad is now destructible like any other base-infrastructure
    // hex — it's seeded into `buildingHp` (the "solid destructible" bucket; it isn't soft cover)
    // with its own hp so weapon fire/stomps can flatten it into rubble, same generic machinery
    // as a real outpost. It's excluded from ever being picked as THE mission objective via a
    // separate mechanism (`isMissionObjective`, exercised in terrain.test.js/mission-arena code),
    // not by staying out of `buildingHp` — see world.js `_objectiveHexKeys`.
    it('is destructible — seeded into buildingHp (never coverHp) with its own hp', () => {
      for (let seed = 0; seed < 10; seed++) {
        const { terrain, buildingHp, coverHp } = generateTerrain({ seed, worldRadius: 20, biome: GRASSLAND });
        for (const [k, id] of terrain) {
          if (id !== 'helipad') continue;
          expect(buildingHp.has(k)).toBe(true);
          expect(buildingHp.get(k)).toBe(TERRAIN.helipad.hp);
          expect(coverHp.has(k)).toBe(false);
        }
      }
    });
  });

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
        // #251: `helipad` is a normal stamped role now too — static set-dressing, not a hazard.
        // #269: `dock`/`alertTower` are the base-population system's own normal stamped roles.
        // `turretEmplacement` (playtest follow-up) is the same kind of normal stamped role.
        GRASSLAND.groundA, GRASSLAND.groundB, GRASSLAND.channel, GRASSLAND.cover, GRASSLAND.outpost,
        'helipad', 'dock', 'alertTower', 'turretEmplacement',
      ]);
      for (const id of terrain.values()) expect(validIds.has(id)).toBe(true);
    });

    it('stamps `boundaryRing` keys with the biome\'s `deep` id, unconditionally', () => {
      const ring = new Set([axialKey(50, 0), axialKey(51, 0)]);
      const { terrain } = generateTerrain({ seed: 0x5eed, worldRadius: 5, biome: DESERT, boundaryRing: ring });
      for (const k of ring) expect(terrain.get(k)).toBe(DESERT.deep);
    });
  });

  describe('playable-area masking', () => {
    it('via `included` predicate: excludes every hex outside it (no tile at all)', () => {
      const included = (q) => q >= 0; // an arbitrary "east half" mask
      const { terrain } = generateTerrain({ seed: 0x5eed, worldRadius: 20, biome: GRASSLAND, included });
      for (const [k] of terrain) {
        const [q] = k.split(',').map(Number);
        expect(q).toBeGreaterThanOrEqual(0);
      }
    });

    it('via `includedKeys`: the terrain map covers exactly the given corridor set (plus its boundary ring)', () => {
      const { includedKeys } = buildCorridor(2);
      const { terrain } = generateTerrain({
        seed: 0x5eed, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, includedKeys,
      });
      // Every corridor hex got a tile; every terrain hex is a corridor hex (no boundary ring passed).
      for (const k of includedKeys) expect(terrain.has(k)).toBe(true);
      for (const k of terrain.keys()) expect(includedKeys.has(k)).toBe(true);
    });

    it('an organic corridor produces a genuinely smaller hex count than the full disc', () => {
      const { includedKeys } = buildCorridor(3);
      const corridor = generateTerrain({ seed: 0x5eed, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, includedKeys });
      const fullDisc = generateTerrain({ seed: 0x5eed, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND });
      expect(corridor.terrain.size).toBeLessThan(fullDisc.terrain.size);
    });

    it('omitting both masks (the default) keeps the full worldRadius-disc behavior', () => {
      const opts = { seed: 0x5eed, worldRadius: 20, biome: GRASSLAND };
      const a = generateTerrain(opts);
      const b = generateTerrain({ ...opts, included: null, includedKeys: null });
      expect([...a.terrain.entries()]).toEqual([...b.terrain.entries()]);
    });

    it('the `outposts` override controls how many outpost seeds are placed', () => {
      const { includedKeys } = buildCorridor(9);
      const few = generateTerrain({ seed: 5, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, includedKeys, outposts: 1 });
      const many = generateTerrain({ seed: 5, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, includedKeys, outposts: 20 });
      expect(many.buildingHp.size).toBeGreaterThan(few.buildingHp.size);
    });
  });
});

// #169: the corridor is sized (via simulation, scripts/corridor-sim.mjs) so the boundary ring is
// reliably visible on the SIDES at the real GAMEPLAY_ZOOM=1.3 camera, while the safe-zone invariant
// (#110/#158) is never violated. These re-derive that at the data layer, mirroring what the live
// smoke test checks.
describe('#169 corridor sizing (boundary visible on the narrow sides; safe zone protected)', () => {
  const VIEWPORT_W = 1280, VIEWPORT_H = 720;
  const HALF_W = (VIEWPORT_W / 2) / GAMEPLAY_ZOOM;
  const HALF_H = (VIEWPORT_H / 2) / GAMEPLAY_ZOOM;

  // A shallow ringWidth is used purely for TEST SPEED — this only ever checks whether the ring's
  // NEAR edge falls inside the camera rectangle, identical whether the ring is 6 or 35 hexes deep.
  function boundaryOnScreen(ring, cx, cy) {
    for (const k of ring) {
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      if (x >= cx - HALF_W && x <= cx + HALF_W && y >= cy - HALF_H && y <= cy + HALF_H) return true;
    }
    return false;
  }

  it('at spawn, the boundary ring is on screen (inside the real 1280x720 @1.3x rectangle), across many seeds', () => {
    let onScreen = 0;
    const seeds = 500;
    for (let seed = 0; seed < seeds; seed++) {
      const { includedKeys } = buildCorridor(seed);
      const ring = boundaryRingKeys(null, { insideKeys: includedKeys, ringWidth: 6 });
      if (boundaryOnScreen(ring, 0, 0)) onScreen++;
    }
    // The 4000-seed sweep (scripts/corridor-sim.mjs) lands at ~99.8%; threshold set well under to
    // absorb this smaller sample. Far more reliable than #158's blob (90.6%) — a corridor is
    // wrapped by boundary on both sides AND behind the spawn end.
    expect(onScreen).toBeGreaterThanOrEqual(Math.floor(seeds * 0.95));
  }, 30000);

  it('the safe zone is never encroached: `deep` boundary stays clear of MIN_SPAWN_BOUNDARY_HEX_DIST of spawn', () => {
    let anyTooClose = false;
    for (let seed = 0; seed < 500 && !anyTooClose; seed++) {
      const { includedKeys } = buildCorridor(seed);
      const ring = boundaryRingKeys(null, { insideKeys: includedKeys, ringWidth: 4 });
      const D = MIN_SPAWN_BOUNDARY_HEX_DIST;
      for (const k of ring) {
        const [q, r] = k.split(',').map(Number);
        if ((Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2 <= D) { anyTooClose = true; break; }
      }
    }
    expect(anyTooClose).toBe(false);
  }, 20000);

  it('MAX_WORLD_RADIUS comfortably bounds the corridor\'s real worst-case reach from origin', () => {
    let worstReach = 0;
    for (let seed = 0; seed < 200; seed++) {
      const { includedKeys } = buildCorridor(seed);
      for (const k of includedKeys) {
        const [q, r] = k.split(',').map(Number);
        worstReach = Math.max(worstReach, distance({ q, r }, { q: 0, r: 0 }));
      }
    }
    expect(worstReach).toBeLessThanOrEqual(MAX_WORLD_RADIUS);
    // Not wastefully oversized either.
    expect(MAX_WORLD_RADIUS).toBeLessThan(worstReach + 25);
  }, 20000);
});

// #110/#126: the boundary ring — a biome-appropriate impassable hex ring just outside the playable
// area's own edge. Exercised here against a simple analytic disc region (the `included`-predicate
// fallback path) and, for the corridor path, via `insideKeys`.
describe('boundaryRingKeys (#110)', () => {
  it('every ring hex is adjacent to at least one included hex (hugs the shape\'s edge)', () => {
    const included = disc(8);
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
    const included = disc(8);
    const ring = boundaryRingKeys(included, { ringWidth: 2, boundingRadius: 14 });
    for (const k of ring) {
      const [q, r] = k.split(',').map(Number);
      expect(included(q, r)).toBe(false);
    }
  });

  it('a wider ringWidth produces a thicker (larger) ring', () => {
    const thin = boundaryRingKeys(disc(8), { ringWidth: 1, boundingRadius: 14 });
    const thick = boundaryRingKeys(disc(8), { ringWidth: 3, boundingRadius: 14 });
    expect(thick.size).toBeGreaterThan(thin.size);
  });

  it('via insideKeys, wraps the corridor set directly (no bounding-disc scan)', () => {
    const { includedKeys } = buildCorridor(6);
    const ring = boundaryRingKeys(null, { insideKeys: includedKeys, ringWidth: 1 });
    expect(ring.size).toBeGreaterThan(0);
    for (const k of ring) {
      expect(includedKeys.has(k)).toBe(false);
      const [q, r] = k.split(',').map(Number);
      expect(neighbors(q, r).some((n) => includedKeys.has(axialKey(n.q, n.r)))).toBe(true);
    }
  });

  describe('#126 boundary depth actually covers the worst-case camera view distance', () => {
    it('BOUNDARY_RING_WIDTH rendered depth (in px) covers REQUIRED_VIEW_DEPTH_PX', () => {
      const ringDepthPx = BOUNDARY_RING_WIDTH * HEX_STEP_PX;
      expect(ringDepthPx).toBeGreaterThanOrEqual(REQUIRED_VIEW_DEPTH_PX);
    });

    it('is the tightest hex count that still covers that depth (not a wasteful over-guess)', () => {
      const oneNarrower = (BOUNDARY_RING_WIDTH - 1) * HEX_STEP_PX;
      expect(oneNarrower).toBeLessThan(REQUIRED_VIEW_DEPTH_PX);
    });

    it('a full BFS-built ring at the default width is actually that deep in practice', () => {
      const included = disc(20);
      const ring = boundaryRingKeys(included, {
        ringWidth: BOUNDARY_RING_WIDTH, boundingRadius: 20 + BOUNDARY_RING_WIDTH + 4,
      });
      let q = 0;
      while (included(q, 0)) q++;
      let depth = 0;
      while (ring.has(axialKey(q, 0))) { q++; depth++; }
      expect(depth).toBeGreaterThanOrEqual(BOUNDARY_RING_WIDTH);
    });

    it('stays within a sane order of magnitude (a real depth fix, not a runaway perf regression)', () => {
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
    const near = axialKey(2, 0);
    const far = axialKey(10, 0);
    expect(pickFarObjective([near, far], from, 6)).toBe(far);
  });

  it('falls back to the single farthest candidate if none clear minDistance', () => {
    const from = { q: 0, r: 0 };
    const a = axialKey(1, 0);
    const b = axialKey(2, 0);
    expect(pickFarObjective([a, b], from, 50)).toBe(b);
  });

  it('is deterministic given the same inputs (no RNG)', () => {
    const from = { q: 1, r: -1 };
    const keys = [axialKey(4, 0), axialKey(-3, 2), axialKey(0, 5)];
    expect(pickFarObjective(keys, from, 3)).toBe(pickFarObjective(keys, from, 3));
  });

  it('a `distanceOf` metric overrides straight-line distance (e.g. spine progress)', () => {
    const from = { q: 0, r: 0 };
    const a = axialKey(2, 0), b = axialKey(10, 0);
    // Straight-line would pick b (far); an inverted metric makes a the "farthest".
    const inverted = (q) => -q;
    expect(pickFarObjective([a, b], from, 0, null, inverted)).toBe(a);
  });

  describe('with a reveal predicate', () => {
    const from = { q: 0, r: 0 };
    const inRegion = (q) => q >= 0;
    it('never picks a candidate outside the reveal region', () => {
      const picked = pickFarObjective([axialKey(3, 0), axialKey(-20, 0)], from, 6, inRegion);
      expect(picked).toBe(axialKey(3, 0));
    });
    it('returns null if no candidate lies inside the reveal region', () => {
      expect(pickFarObjective([axialKey(-4, 0), axialKey(-9, 2)], from, 6, inRegion)).toBeNull();
    });
  });

  it('the default minDistance IS the shared FAR_OBJECTIVE_MIN_DIST floor', () => {
    const from = { q: 0, r: 0 };
    expect(pickFarObjective([axialKey(2, 0), axialKey(10, 0)], from)).toBe(axialKey(10, 0));
    expect(FAR_OBJECTIVE_MIN_DIST).toBeGreaterThan(0);
  });
});

describe('pickStageObjective (#138)', () => {
  const from = { q: 0, r: 0 };
  const spread = [1, 4, 8, 12, 16, 20, 30, 40, 50, 60].map((d) => axialKey(d, 0));

  it('returns null for an empty candidate list', () => {
    expect(pickStageObjective([], from, 0)).toBeNull();
  });

  it('stage 0 (lateFrac 0) picks a NEAR objective, not the farthest candidate', () => {
    const picked = pickStageObjective(spread, from, 0);
    const [q, r] = picked.split(',').map(Number);
    expect(distance({ q, r }, from)).toBeLessThan(30);
  });

  it('the final stage (lateFrac 1) picks the single farthest candidate', () => {
    expect(pickStageObjective(spread, from, 1)).toBe(pickFarObjective(spread, from));
  });

  it('the escalation curve is real: later lateFrac values pick meaningfully farther objectives', () => {
    const distOf = (k) => { const [q, r] = k.split(',').map(Number); return distance({ q, r }, from); };
    const d0 = distOf(pickStageObjective(spread, from, 0));
    const dMid = distOf(pickStageObjective(spread, from, 0.5));
    const dFinal = distOf(pickStageObjective(spread, from, 1));
    expect(dMid).toBeGreaterThan(d0);
    expect(dFinal).toBeGreaterThan(dMid);
  });

  it('respects minDistance as a floor on the TARGET, even for a near (stage 0) pick', () => {
    const nearby = [axialKey(1, 0), axialKey(2, 0), axialKey(6, 0), axialKey(7, 0)];
    expect(pickStageObjective(nearby, from, 0, 6)).toBe(axialKey(6, 0));
  });

  it('never returns a candidate whose OWN distance falls under minDistance', () => {
    const gappy = [axialKey(3, 0), axialKey(5, 0), axialKey(20, 0)];
    const picked = pickStageObjective(gappy, from, 0, 6);
    const [q, r] = picked.split(',').map(Number);
    expect(distance({ q, r }, from)).toBeGreaterThanOrEqual(6);
    expect(picked).toBe(axialKey(20, 0));
  });

  it('falls back to the overall closest-to-target candidate if NONE clear minDistance at all', () => {
    const allTooClose = [axialKey(1, 0), axialKey(2, 0), axialKey(3, 0)];
    expect(pickStageObjective(allTooClose, from, 0, 6)).toBe(axialKey(3, 0));
  });

  it('is deterministic given the same inputs (no RNG)', () => {
    expect(pickStageObjective(spread, from, 0.5)).toBe(pickStageObjective(spread, from, 0.5));
  });

  it('STAGE_OBJECTIVE_NEAR_FRACTION is meaningfully smaller than STAGE_OBJECTIVE_FAR_FRACTION', () => {
    expect(STAGE_OBJECTIVE_NEAR_FRACTION).toBeGreaterThan(0);
    expect(STAGE_OBJECTIVE_NEAR_FRACTION).toBeLessThan(0.5);
    expect(STAGE_OBJECTIVE_FAR_FRACTION).toBe(1);
  });

  // #169/#269: measured ALONG THE SPINE via a `distanceOf` metric, objectives march
  // monotonically down the corridor across a 0→1 escalation curve. #269 retired run.js's
  // `lateFraction`/`STAGE_COUNT` (the old fixed-5-stage squad system) — this test now supplies
  // its own local N-step 0→1 curve (`pickStageObjective` itself is generic over any 0..1
  // `lateFrac` input, so it doesn't care where the fraction comes from) rather than depending on
  // the now-retired run.js exports, so this stays a pure worldgen.js-only test.
  it('across a 0→1 escalation curve, objectives progress monotonically DOWN THE SPINE end-to-end', () => {
    const N_STEPS = 5;
    const stepFraction = (i) => (N_STEPS <= 1 ? 0 : i / (N_STEPS - 1));
    let allMonotonic = true, checked = 0;
    for (let seed = 0; seed < 60; seed++) {
      const { spine, includedKeys } = buildCorridor(seed);
      const progressOf = (q, r) => spineProgressHexOf(spine, q, r);
      // A realistic candidate spread: every ~5th corridor hex stands in for a generated outpost.
      const candidates = [...includedKeys].filter((_, i) => i % 5 === 0);
      const progOf = (k) => { const [q, r] = k.split(',').map(Number); return progressOf(q, r); };
      const steps = [];
      for (let s = 0; s < N_STEPS; s++) {
        const k = pickStageObjective(candidates, from, stepFraction(s), FAR_OBJECTIVE_MIN_DIST, null, progressOf);
        steps.push(progOf(k));
      }
      checked++;
      for (let s = 1; s < steps.length; s++) if (steps[s] < steps[s - 1]) allMonotonic = false;
      // Step 0 is near the spawn end; the final step reaches well down the corridor.
      const maxProg = Math.max(...candidates.map(progOf));
      expect(steps[0]).toBeLessThan(maxProg * 0.5);
      expect(steps[N_STEPS - 1]).toBeGreaterThan(steps[0] * 1.5);
    }
    expect(checked).toBeGreaterThan(50);
    expect(allMonotonic).toBe(true);
  });
});

describe('placeBases (#269 §3: base population world-gen placement)', () => {
  const B = GRASSLAND;
  function buildAllRing(radius = 12) {
    return range({ q: 0, r: 0 }, radius);
  }

  it('places BASE_COUNT bases, each with docks in range and a pre-assigned kindId+count', () => {
    const rng = mulberry32(777);
    const all = buildAllRing();
    const T = new Map();
    for (const h of all) T.set(axialKey(h.q, h.r), B.groundA);
    const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };
    const { bases, alertTowers } = placeBases(rng, all, T, isGround, BASE_COUNT);

    expect(bases.length).toBe(BASE_COUNT);
    for (const base of bases) {
      expect(base.docks.length).toBeGreaterThanOrEqual(1);
      expect(base.docks.length).toBeLessThanOrEqual(DOCKS_PER_BASE_MAX);
      for (const d of base.docks) {
        expect(T.get(axialKey(d.q, d.r))).toBe('dock');
        expect(typeof d.kindId).toBe('string');
        expect([...BASE_EARLY_KIND_POOL, ...BASE_LATE_KIND_POOL]).toContain(d.kindId);
        // #269 playtest follow-up: every dock now carries a count too.
        expect(Number.isInteger(d.count)).toBe(true);
        expect(d.count).toBeGreaterThanOrEqual(1);
      }
      // #269 playtest follow-up: turret emplacements are their own placement, tagged on the base.
      expect(base.turrets.length).toBeGreaterThanOrEqual(0);
      expect(base.turrets.length).toBeLessThanOrEqual(TURRET_EMPLACEMENTS_PER_BASE_MAX);
      for (const t of base.turrets) {
        expect(T.get(axialKey(t.q, t.r))).toBe('turretEmplacement');
      }
    }
    for (const t of alertTowers) {
      expect(T.get(axialKey(t.q, t.r))).toBe('alertTower');
    }
    // Total alert towers is within the expected per-base band (best-effort — placement can miss
    // a candidate hex on a crowded map, so this is an upper bound, not an exact count).
    expect(alertTowers.length).toBeLessThanOrEqual(BASE_COUNT * ALERT_TOWERS_PER_BASE_MAX);
  });

  it('#269 playtest follow-up: drone and turret never appear in the dock kind pools', () => {
    expect(BASE_EARLY_KIND_POOL).not.toContain('drone');
    expect(BASE_EARLY_KIND_POOL).not.toContain('turret');
    expect(BASE_LATE_KIND_POOL).not.toContain('drone');
    expect(BASE_LATE_KIND_POOL).not.toContain('turret');
  });

  it('#269 playtest follow-up: dockCountFor gives tanks 2-3, helicopters exactly 2, everything else 1', () => {
    const lowRng = () => 0;      // floors every roll to its minimum
    const highRng = () => 0.999; // ceilings every roll to just under its max
    expect(dockCountFor('tank', lowRng)).toBe(2);
    expect(dockCountFor('tank', highRng)).toBe(3);
    expect(dockCountFor('helicopter', lowRng)).toBe(2);
    expect(dockCountFor('helicopter', highRng)).toBe(2);
    expect(dockCountFor('quadruped', lowRng)).toBe(1);
    expect(dockCountFor('quadruped', highRng)).toBe(1);
  });

  it('never overwrites a hex that is no longer plain ground', () => {
    const rng = mulberry32(42);
    const all = buildAllRing();
    const T = new Map();
    for (const h of all) T.set(axialKey(h.q, h.r), B.groundA);
    // Pre-mark a chunk of the map as an outpost so placeBases must route around it.
    const preMarked = new Set();
    for (const h of range({ q: 0, r: 0 }, 3)) { T.set(axialKey(h.q, h.r), 'building'); preMarked.add(axialKey(h.q, h.r)); }
    const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };
    const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT);
    for (const base of bases) {
      for (const d of base.docks) expect(preMarked.has(axialKey(d.q, d.r))).toBe(false);
      for (const t of base.turrets) expect(preMarked.has(axialKey(t.q, t.r))).toBe(false);
    }
  });

  it('stratifies base centres along progress-of-run instead of drawing uniformly across the whole map (playtest follow-up)', () => {
    // A long, thin "corridor" of hexes ordered along q (progress proxy = q itself via distance
    // from origin along a line), so we can assert base i's centre progress falls in the i-th
    // roughly-equal third of the range, matching an intentionally adversarial seed.
    const all = [];
    for (let q = 0; q <= 300; q++) all.push({ q, r: 0 });
    const T = new Map();
    for (const h of all) T.set(axialKey(h.q, h.r), B.groundA);
    const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };
    const progressOf = (h) => h.q;   // straight line, so q IS the progress metric exactly

    for (const seed of [1, 2, 3, 42, 777, 99999]) {
      const rng = mulberry32(seed);
      const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT, progressOf);
      expect(bases.length).toBe(BASE_COUNT);
      const centreQs = bases.map((b) => b.center.q);
      const segSize = Math.floor(all.length / BASE_COUNT);
      // Base 0 lands in the first segment, the last base in the final segment.
      expect(centreQs[0]).toBeLessThan(segSize);
      expect(centreQs[BASE_COUNT - 1]).toBeGreaterThanOrEqual(segSize * (BASE_COUNT - 1));
      // Bases are ordered by progress matching their index (monotonic non-decreasing).
      for (let i = 1; i < centreQs.length; i++) {
        expect(centreQs[i]).toBeGreaterThanOrEqual(centreQs[i - 1]);
      }
    }
  });

  it('falls back to distance-from-origin as the progress proxy when no progressOf is given, still stratifying', () => {
    const rng = mulberry32(555);
    const all = buildAllRing(20);
    const T = new Map();
    for (const h of all) T.set(axialKey(h.q, h.r), B.groundA);
    const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };
    const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT);
    const dists = bases.map((b) => distance(b.center, { q: 0, r: 0 }));
    for (let i = 1; i < dists.length; i++) {
      expect(dists[i]).toBeGreaterThanOrEqual(dists[i - 1]);
    }
  });

  it('on the real snaking corridor, base centres are stratified by spine progress (not just raw distance from origin)', () => {
    const { spine, includedKeys } = buildCorridor(4242);
    const all = [...includedKeys].map((k) => { const [q, r] = k.split(',').map(Number); return { q, r }; });
    const T = new Map();
    for (const h of all) T.set(axialKey(h.q, h.r), B.groundA);
    const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };
    const rng = mulberry32(4242);
    const progressOf = (h) => spineProgressHexOf(spine, h.q, h.r);
    const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT, progressOf);

    expect(bases.length).toBe(BASE_COUNT);
    const progresses = bases.map((b) => spineProgressHexOf(spine, b.center.q, b.center.r));
    const allProgress = all.map((h) => spineProgressHexOf(spine, h.q, h.r));
    const minP = Math.min(...allProgress), maxP = Math.max(...allProgress);
    const span = maxP - minP;
    // Base 0's centre sits in the first third of the corridor's progress range; the last base's
    // centre sits in the final third — not scattered anywhere, per the playtest complaint.
    expect(progresses[0]).toBeLessThan(minP + span / 3);
    expect(progresses[BASE_COUNT - 1]).toBeGreaterThan(maxP - span / 3);
    // Ordered by progress, matching index (and thus matching baseLateFraction's difficulty ramp).
    for (let i = 1; i < progresses.length; i++) {
      expect(progresses[i]).toBeGreaterThanOrEqual(progresses[i - 1]);
    }
  });

  it('generateTerrain passes the corridor spine through so bases stratify along the real curving run', () => {
    const { spine, includedKeys } = buildCorridor(8080);
    const includedSet = includedKeys;
    const included = (q, r) => includedSet.has(axialKey(q, r));
    const { bases } = generateTerrain({
      seed: 8080, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, included, includedKeys, spine,
    });
    expect(bases.length).toBe(BASE_COUNT);
    const progresses = bases.map((b) => spineProgressHexOf(spine, b.center.q, b.center.r));
    for (let i = 1; i < progresses.length; i++) {
      expect(progresses[i]).toBeGreaterThanOrEqual(progresses[i - 1]);
    }
  });

  it('baseLateFraction ramps 0→1 across the bases, escalating dock composition', () => {
    expect(baseLateFraction(0, BASE_COUNT)).toBe(0);
    expect(baseLateFraction(BASE_COUNT - 1, BASE_COUNT)).toBe(1);
    expect(baseLateFraction(0, 1)).toBe(0);   // guards the /0 edge case
  });

  it('BASE_EARLY_KIND_POOL/BASE_LATE_KIND_POOL are non-mech ENEMY_KINDS ids, never cluster expansions', () => {
    const disallowed = new Set(['swarm', 'turretNest', 'infantryMob']);
    for (const id of [...BASE_EARLY_KIND_POOL, ...BASE_LATE_KIND_POOL]) {
      expect(disallowed.has(id)).toBe(false);
    }
  });

  it('generateTerrain returns bases/alertTowers consistent with the final terrain map', () => {
    const { terrain, bases, alertTowers } = generateTerrain({
      seed: 123, worldRadius: 14, biome: GRASSLAND, safeCenter: { q: 0, r: 0 },
    });
    expect(bases.length).toBe(BASE_COUNT);
    for (const base of bases) {
      for (const d of base.docks) expect(terrain.get(axialKey(d.q, d.r))).toBe('dock');
      for (const t of base.turrets) expect(terrain.get(axialKey(t.q, t.r))).toBe('turretEmplacement');
    }
    for (const t of alertTowers) expect(terrain.get(axialKey(t.q, t.r))).toBe('alertTower');
  });

  // #269 playtest follow-up: is an alert tower's placement (rings 3-5 out from its base centre)
  // actually reachable on the corridor's natural path, or could it land off to the side the
  // player would never drive near? `placeBases` only ever stamps a candidate hex that's already
  // IN `T` (built from the live corridor's own hex set, scenes/arena/world.js `_buildWorld`) —
  // so every placed tower is, by construction, already inside the drivable corridor. This test
  // exercises the REAL corridor-carving path (buildCorridor, same as world.js) across many seeds
  // and confirms every placed alert tower's pixel position sits within CORRIDOR_HALF_WIDTH_PX of
  // the corridor's own spine — i.e. never further from the driving path than any other in-map
  // feature can be, not stranded off to one side.
  it('places alert towers only within the corridor\'s own half-width of its spine (never off-path)', () => {
    function perpDistToSpine(points, x, y) {
      let best = Infinity;
      for (let i = 0; i < points.length - 1; i++) {
        const x0 = points[i].x, y0 = points[i].y, x1 = points[i + 1].x, y1 = points[i + 1].y;
        const dx = x1 - x0, dy = y1 - y0;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
        const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
        if (d < best) best = d;
      }
      return best;
    }
    let checked = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const { spine, includedKeys } = buildCorridor(seed * 101 + 3);
      const { alertTowers } = generateTerrain({
        seed, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, safeCenter: { q: 0, r: 0 }, includedKeys,
      });
      for (const t of alertTowers) {
        const { x, y } = hexToPixel(t.q, t.r);
        // A small slack (+HEX_STEP_PX) accounts for the hex being counted "in" the corridor if
        // its centre is within reach even when its exact centre sits a fraction past the strict
        // half-width (corridorHexSet includes a hex if ANY part of it is close enough).
        expect(perpDistToSpine(spine.points, x, y)).toBeLessThanOrEqual(CORRIDOR_HALF_WIDTH_PX + HEX_STEP_PX);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);   // sanity: the sweep actually placed towers to check
  });

  // #269 playtest follow-up: confirms placement isn't wildly unreliable — most requested towers
  // (ALERT_TOWERS_PER_BASE_MIN..MAX per base) actually land somewhere, even though the 10-try
  // rejection sampling against a real corridor can occasionally miss a candidate ring entirely.
  it('places most of the requested alert towers across a sweep of real corridors (not a rare fluke)', () => {
    let totalMaxPossible = 0, totalPlaced = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const { includedKeys } = buildCorridor(seed * 101 + 3);
      const { bases, alertTowers } = generateTerrain({
        seed, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, safeCenter: { q: 0, r: 0 }, includedKeys,
      });
      totalMaxPossible += bases.length * ALERT_TOWERS_PER_BASE_MAX;
      totalPlaced += alertTowers.length;
    }
    expect(totalPlaced).toBeGreaterThan(totalMaxPossible * 0.5);
  });
});
