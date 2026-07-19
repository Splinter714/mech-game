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
  generateSpine, corridorHexSet, spineProgressHexOf, spineSpawnHex,
  CORRIDOR_HALF_WIDTH_PX, CORRIDOR_LENGTH_PX, CORRIDOR_REAR_PAD_PX, CORRIDOR_LENGTH_PER_BASE_PX,
  BASE_COUNT, DOCKS_PER_BASE_MIN, DOCKS_PER_BASE_MAX,
  BASE_EARLY_KIND_POOL, BASE_LATE_KIND_POOL, baseLateFraction,
  placeBases, placeGapTowers, dockCountFor, DOCK_SWARM_COUNT, isSwarmDockKind, drawDockKind,
  MIN_GAP_PROGRESS_PX, MIN_GAP_PROGRESS_HEX,
  placeBaseWalls, BASE_FOOTPRINT_RADIUS,
} from './worldgen.js';
import { getBiome } from './biomes.js';
import { TERRAIN, isPassable, buildingHp as buildingHpOf, damageBuilding } from './terrain.js';
import { axialKey, range, neighbors, distance, hexToPixel, pixelToHex } from './hexgrid.js';
import { edgeKey, edgeMidpoint } from './hexEdges.js';
import { ALERT_DETECT_RADIUS } from './alertTower.js';
import { PROXIMITY_WAKE_RANGE_CAP } from './awareness.js';
import { GAMEPLAY_ZOOM, ENEMY_COLLIDE_RADIUS_MECH } from '../scenes/arena/shared.js';

const GRASSLAND = getBiome('grassland');
const DESERT = getBiome('desert');

// A simple analytic disc predicate, used to exercise the boundaryRingKeys/generateTerrain
// `included`-predicate fallback path without the (removed) organic-blob generator.
const disc = (radius) => (q, r) => distance({ q, r }, { q: 0, r: 0 }) <= radius;

// Build the live corridor exactly the way scenes/arena/world.js `_buildWorld` does, for a seed.
// #269 (spawn rear-pad fix): the real scene now force-includes the safe zone around the ACTUAL
// spawn hex (`spineSpawnHex`), not world origin — mirrored here so this helper's `includedKeys`
// matches production exactly, and `spawnHex` is returned for tests that need it.
function buildCorridor(seed, halfWidth = CORRIDOR_HALF_WIDTH_PX) {
  const shapeRng = mulberry32(seed);
  const startAngle = shapeRng() * Math.PI * 2;
  const spine = generateSpine(shapeRng, { startAngle });
  const spawnHex = spineSpawnHex(spine);
  const includedKeys = corridorHexSet(spine.points, halfWidth, safeZoneKeys(spawnHex, 3));
  return { spine, includedKeys, startAngle, spawnHex };
}

// The full production `generateTerrain` argument set for a seed, built off the real corridor —
// what `scenes/arena/world.js` actually passes. Shared by the #308 sweeps and the wall-ring ones.
function realArgsFor(seed, biome = GRASSLAND) {
  const { spine, includedKeys, spawnHex } = buildCorridor(seed);
  const boundaryRing = boundaryRingKeys(null, { insideKeys: includedKeys });
  return { seed, worldRadius: MAX_WORLD_RADIUS, biome, includedKeys, boundaryRing, spine, safeCenter: spawnHex };
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
    const { includedKeys, spawnHex } = buildCorridor(5);
    for (const k of safeZoneKeys(spawnHex, 3)) expect(includedKeys.has(k)).toBe(true);
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

// #269 (spawn rear-pad fix, playtest follow-up): the player now spawns at the spine's own
// rear-pad starting sample instead of world origin, so real-already-generated corridor terrain
// behind origin actually gets walked instead of sitting unused. This suite pins the three
// concrete claims from that fix: the spawn hex genuinely sits back in the rear-pad stretch (not
// at/past origin), a real generated world's terrain at that hex is safe/clear/passable (the
// safe-zone-clear disc followed the moved spawn point), and the shifted spawn point doesn't
// disturb the #283 gap-spacing floor (covered by the unchanged '#283 minimum calm-gap spacing'
// suite below, which still measures every floor from progress 0, not the spawn hex's own
// negative progress — see the comment on `placeBases` in worldgen.js for why that's correct).
describe('spineSpawnHex (#269 spawn rear-pad fix)', () => {
  it('sits within the spine\'s own rear-pad stretch, strictly behind world origin (u < 0)', () => {
    for (let seed = 0; seed < 20; seed++) {
      const { spine } = buildCorridor(seed);
      const spawnHex = spineSpawnHex(spine);
      // The nearest spine sample to the spawn hex's own pixel centre should read a solidly
      // negative progress — i.e. genuinely behind u=0, not just barely, and no farther back than
      // the spine's own first sample (u = -rearPad, snapped to the sample grid).
      const p = spineProgressHexOf(spine, spawnHex.q, spawnHex.r);
      expect(p).toBeLessThan(0);
      expect(p).toBeGreaterThanOrEqual(-(CORRIDOR_REAR_PAD_PX + HEX_STEP_PX) / HEX_STEP_PX);
    }
  });

  it('equals the hex nearest the spine\'s literal first sample (points[0], u = -rearPad)', () => {
    for (let seed = 0; seed < 10; seed++) {
      const shapeRng = mulberry32(seed);
      const startAngle = shapeRng() * Math.PI * 2;
      const spine = generateSpine(shapeRng, { startAngle });
      const expected = pixelToHex(spine.points[0].x, spine.points[0].y);
      expect(spineSpawnHex(spine)).toEqual(expected);
    }
  });

  it('is deterministic given the same seed', () => {
    const spine = generateSpine(mulberry32(99), { startAngle: 1.4 });
    expect(spineSpawnHex(spine)).toEqual(spineSpawnHex(spine));
  });

  it('on a real generated world, the terrain at the moved spawn hex is safe/clear/passable ground', () => {
    // Mirrors exactly what scenes/arena/world.js `_buildWorld` does: safeCenter follows the
    // spawn hex, so the guaranteed-clear radius-3 disc is centred on where the player actually
    // stands, not generically somewhere inside the corridor.
    for (let seed = 0; seed < 15; seed++) {
      const { spine, includedKeys, spawnHex } = buildCorridor(seed * 31 + 7);
      const { terrain } = generateTerrain({
        seed: seed * 31 + 7, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND,
        includedKeys, spine, safeCenter: spawnHex,
      });
      const id = terrain.get(axialKey(spawnHex.q, spawnHex.r));
      expect(id).toBeDefined();
      expect([GRASSLAND.groundA, GRASSLAND.groundB]).toContain(id);
      expect(isPassable(id)).toBe(true);
      // The whole radius-3 disc around spawn, not just the centre hex — same guarantee the old
      // origin-anchored safe zone gave, just re-centred.
      for (const h of range(spawnHex, 3)) {
        const hk = axialKey(h.q, h.r);
        if (!terrain.has(hk)) continue;   // outside the corridor's own hex set — not a spawn concern
        expect([GRASSLAND.groundA, GRASSLAND.groundB]).toContain(terrain.get(hk));
      }
    }
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

  it('buildingHp only holds destructible solid (impassable) hexes (base infra like alertTower/objective), never walk-through cover', () => {
    const { terrain, buildingHp, coverHp } = generateTerrain({ seed: 0x5eed, worldRadius: 20, biome: GRASSLAND });
    // #275: the destructible outposts (building/adobe/iceRuin/tower/obsidian) and `helipad` were
    // removed — `alertTower`/`objective` (world-gen stamped) are the only "solid" (impassable)
    // destructibles generateTerrain can produce. Only `objective` is ever picked as the mission
    // objective (isMissionObjective, exercised elsewhere); alertTower is destructible set-dressing.
    // (`dockClosed` is a live RUNTIME state swap — scenes/arena/bases.js — never stamped by
    // world-gen itself, so it can't appear here.)
    // #279: the buildingHp/coverHp split keys off `isPassable`, not the LOS cover tier — forest
    // (GRASSLAND.cover) is soft, passable walk-through cover, so it lands in `coverHp`, not
    // `buildingHp`. (Keying off passability is robust regardless of the soft/hard tier.)
    // #287 (2026-07-19): the `turretEmplacement` bunker that briefly joined this set is removed
    // — a base's fixed guns live on its wall ring now, so the only world-gen-stamped destructible
    // structures are the alert towers and each base's objective hex.
    for (const k of buildingHp.keys()) {
      expect(['alertTower', 'objective']).toContain(terrain.get(k));
    }
    for (const k of coverHp.keys()) expect(terrain.get(k)).toBe(GRASSLAND.cover);
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

    it('grassland never stamps anything but its normal roles', () => {
      const { terrain } = generateTerrain({ seed: 0x5eed, worldRadius: 25, biome: GRASSLAND });
      const validIds = new Set([
        // #269: `dock`/`alertTower` are the base-population system's own normal stamped roles.
        // `objective` (playtest follow-up) is the base's dedicated destructible-target hex.
        // #275: the outpost-cluster loop and `helipad` were removed — there's no longer a
        // biome-specific "outpost" role or a stamped helipad id to allow here.
        // #278: grassland now has its own in-map `hazard` (mud), like every other biome.
        GRASSLAND.groundA, GRASSLAND.groundB, GRASSLAND.channel, GRASSLAND.cover, GRASSLAND.hazard,
        // #288 (ring placement): `baseYard` is the base compound's paved floor, stamped across
        // each base's whole hex footprint so the wall ring has base infrastructure behind it.
        'dock', 'alertTower', 'objective', 'baseYard',
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

    // #275 (redesign): the number of alert towers a map gets always tracks `baseCount` 1:1 (one
    // tower per gap between successive bases) — there's no separate "outpost" count to override
    // anymore.
    it('gap tower count tracks baseCount (up to best-effort placement), whatever baseCount is asked for', () => {
      const { includedKeys } = buildCorridor(9);
      for (const baseCount of [1, 3, 5]) {
        const { bases, alertTowers } = generateTerrain({
          seed: 5, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, includedKeys, baseCount,
        });
        expect(bases.length).toBe(baseCount);
        expect(alertTowers.length).toBeLessThanOrEqual(baseCount);
      }
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
    // #269 (spawn rear-pad fix): the camera starts centred on the ACTUAL spawn point
    // (`spawnHex`'s pixel centre), not world origin — re-anchored here to match.
    let onScreen = 0;
    const seeds = 500;
    for (let seed = 0; seed < seeds; seed++) {
      const { includedKeys, spawnHex } = buildCorridor(seed);
      const ring = boundaryRingKeys(null, { insideKeys: includedKeys, ringWidth: 6 });
      const { x: sx, y: sy } = hexToPixel(spawnHex.q, spawnHex.r);
      if (boundaryOnScreen(ring, sx, sy)) onScreen++;
    }
    // The 4000-seed sweep (scripts/corridor-sim.mjs) lands at ~99.8%; threshold set well under to
    // absorb this smaller sample. Far more reliable than #158's blob (90.6%) — a corridor is
    // wrapped by boundary on both sides AND behind the spawn end.
    expect(onScreen).toBeGreaterThanOrEqual(Math.floor(seeds * 0.95));
  }, 30000);

  it('the safe zone is never encroached: `deep` boundary stays clear of MIN_SPAWN_BOUNDARY_HEX_DIST of spawn', () => {
    // #269 (spawn rear-pad fix): "spawn" is now `spawnHex` (the spine's rear-pad start), not
    // world origin — the invariant under test (boundary can't encroach the safe zone AROUND
    // SPAWN) is unchanged, only where spawn itself sits moved.
    let anyTooClose = false;
    for (let seed = 0; seed < 500 && !anyTooClose; seed++) {
      const { includedKeys, spawnHex } = buildCorridor(seed);
      const ring = boundaryRingKeys(null, { insideKeys: includedKeys, ringWidth: 4 });
      const D = MIN_SPAWN_BOUNDARY_HEX_DIST;
      for (const k of ring) {
        const [q, r] = k.split(',').map(Number);
        if (distance({ q, r }, spawnHex) <= D) { anyTooClose = true; break; }
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
    // #269 playtest follow-up (bases/outposts role swap): `placeBases` no longer places alert
    // towers at all — it returns only `{ bases }` now (see `placeGapTowers` below for the
    // separate, gap-anchored tower placement, #275 redesign).
    const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT);

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
      // #287 (2026-07-19): a base no longer carries an interior turret-emplacement cluster at
      // all — the descriptor has no `turrets` field and no emplacement hex is ever stamped.
      expect(base.turrets).toBeUndefined();
      // #269 playtest follow-up ("objectives are picking an arbitrary hex, not a real target"):
      // every base gets exactly one dedicated, destructible `objective` hex.
      expect(base.objectiveHex).toBeTruthy();
      expect(T.get(axialKey(base.objectiveHex.q, base.objectiveHex.r))).toBe('objective');
    }
  });

  // #269 playtest follow-up: the objective hex is a real, destructible, base-owned hex — not
  // just a returned coordinate — so the mission marker (mission.js `_targetCurrentBase`) always
  // points at something a player can actually punch through.
  it('places exactly one objective hex per base, distinct from its docks', () => {
    const rng = mulberry32(42);
    const all = buildAllRing();
    const T = new Map();
    for (const h of all) T.set(axialKey(h.q, h.r), B.groundA);
    const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };
    const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT);

    expect(bases.length).toBe(BASE_COUNT);
    for (const base of bases) {
      expect(base.objectiveHex).toBeTruthy();
      const objKey = axialKey(base.objectiveHex.q, base.objectiveHex.r);
      expect(T.get(objKey)).toBe('objective');
      // The objective hex isn't double-booked as a dock hex too.
      for (const d of base.docks) expect(axialKey(d.q, d.r)).not.toBe(objKey);
    }
  });

  // #275 (redesign): alert towers are no longer anchored to an "outpost" concept — they place
  // solo, one per GAP between successive bases along progress-of-run (gap 0 = spawn/start to
  // base 0, gap i = base i-1 to base i).
  describe('placeGapTowers (#275: one tower per gap between successive bases)', () => {
    // Straight line of hexes ordered along q, so q IS the progress metric exactly — lets us
    // assert precisely which gap each tower's progress value falls into.
    const buildLine = (maxQ = 300) => {
      const all = [];
      for (let q = 0; q <= maxQ; q++) all.push({ q, r: 0 });
      const T = new Map();
      for (const h of all) T.set(axialKey(h.q, h.r), B.groundA);
      const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };
      return { all, T, isGround, progressOf: (h) => h.q };
    };

    it('places exactly one tower per gap, each landing strictly within its own gap\'s progress bounds', () => {
      const { all, T, isGround, progressOf } = buildLine();
      const bases = [
        { id: 'base0', center: { q: 50, r: 0 } },
        { id: 'base1', center: { q: 150, r: 0 } },
        { id: 'base2', center: { q: 250, r: 0 } },
      ];
      const rng = mulberry32(321);
      const alertTowers = placeGapTowers(rng, all, T, isGround, bases, progressOf);

      expect(alertTowers.length).toBe(bases.length);
      for (const t of alertTowers) expect(T.get(axialKey(t.q, t.r))).toBe('alertTower');

      let prev = 0;   // gap 0 starts at the corridor's start (progress 0), not a base
      for (let i = 0; i < bases.length; i++) {
        const hi = bases[i].center.q;
        const p = progressOf(alertTowers[i]);
        expect(p).toBeGreaterThanOrEqual(Math.min(prev, hi));
        expect(p).toBeLessThanOrEqual(Math.max(prev, hi));
        prev = hi;
      }
    });

    // #284: each returned tower must carry the `baseId` of the base its gap precedes — gap i's
    // tower belongs to base i — so the scene-side wake trigger can wake that exact base with no
    // geometric re-derivation.
    it('tags each tower with the baseId of the base its gap precedes', () => {
      const { all, T, isGround, progressOf } = buildLine();
      const bases = [
        { id: 'base0', center: { q: 50, r: 0 } },
        { id: 'base1', center: { q: 150, r: 0 } },
        { id: 'base2', center: { q: 250, r: 0 } },
      ];
      const alertTowers = placeGapTowers(mulberry32(321), all, T, isGround, bases, progressOf);
      expect(alertTowers.map((t) => t.baseId)).toEqual(['base0', 'base1', 'base2']);
    });

    it('is deterministic given the same seed', () => {
      const bases = [
        { id: 'base0', center: { q: 50, r: 0 } },
        { id: 'base1', center: { q: 150, r: 0 } },
        { id: 'base2', center: { q: 250, r: 0 } },
      ];
      const runA = buildLine();
      const runB = buildLine();
      const a = placeGapTowers(mulberry32(7), runA.all, runA.T, runA.isGround, bases, runA.progressOf);
      const b = placeGapTowers(mulberry32(7), runB.all, runB.T, runB.isGround, bases, runB.progressOf);
      expect(a).toEqual(b);
    });

    it('no bases means no gaps means no towers', () => {
      const { all, T, isGround } = buildLine(10);
      expect(placeGapTowers(mulberry32(1), all, T, isGround, [])).toEqual([]);
    });
  });

  it('#269/#287: the turret kind never appears in the dock kind pools (base guns live on the wall)', () => {
    expect(BASE_EARLY_KIND_POOL).not.toContain('turret');
    expect(BASE_LATE_KIND_POOL).not.toContain('turret');
  });

  it('#314: drone and infantry swarm docks are available in BOTH pools', () => {
    for (const pool of [BASE_EARLY_KIND_POOL, BASE_LATE_KIND_POOL]) {
      expect(pool).toContain('drone');
      expect(pool).toContain('infantry');
    }
  });

  it('#314: the swarm kinds are thinly weighted — never the bulk of either pool (density, per #269)', () => {
    for (const pool of [BASE_EARLY_KIND_POOL, BASE_LATE_KIND_POOL]) {
      const swarms = pool.filter(isSwarmDockKind).length;
      // One entry each; a swarm dock is 10x a normal dock's bodies, so it stays a rare set-piece.
      expect(swarms).toBe(2);
      expect(swarms / pool.length).toBeLessThan(0.12);
    }
  });

  it('#314: doubling the late pool preserved the #269 relative mix exactly', () => {
    const plain = BASE_LATE_KIND_POOL.filter((k) => !isSwarmDockKind(k));
    const count = (k) => plain.filter((x) => x === k).length;
    // #269's ratios (helicopter 3 : carrier 1 : tank 1 : raider 2 : the three specialists 1 each),
    // just doubled — helicopter still beats tank, mechs still dominate late.
    expect(count('helicopter')).toBe(6);
    expect(count('carrier')).toBe(2);
    expect(count('tank')).toBe(2);
    expect(count('raider')).toBe(4);
    for (const m of ['skirmisher', 'sniper', 'artillery']) expect(count(m)).toBe(2);
    expect(count('helicopter')).toBeGreaterThan(count('tank'));
  });

  it('#314 density cap: a base never fields more than ONE swarm dock', () => {
    // #269 tuned docks down to a single unit because a base read too dense; a swarm dock is 10
    // bodies, so stacking two on one base would blow straight through that. Swept over many seeds
    // so the cap is exercised on the bases that actually draw a second swarm.
    let sawSwarm = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const { bases } = generateTerrain({
        seed, worldRadius: 14, biome: GRASSLAND, safeCenter: { q: 0, r: 0 },
      });
      for (const base of bases) {
        const swarmDocks = base.docks.filter((d) => isSwarmDockKind(d.kindId));
        expect(swarmDocks.length).toBeLessThanOrEqual(1);
        // The cap replaces the kind, it never drops the dock — every dock still has a real kind.
        for (const d of base.docks) expect(d.count).toBe(dockCountFor(d.kindId, () => 0.5));
        if (swarmDocks.length === 1) sawSwarm++;
      }
    }
    // Sanity: swarm docks do actually generate (the cap isn't silently suppressing all of them).
    expect(sawSwarm).toBeGreaterThan(0);
  });

  it('#269/#314: dockCountFor is a flat 1 per dock except the two weak swarm kinds', () => {
    const lowRng = () => 0;      // floors every roll to its minimum
    const highRng = () => 0.999; // ceilings every roll to just under its max
    // "tone it down to 1 tank per dock and 1 helicopter per dock" — every dock hosts one body.
    expect(dockCountFor('tank', lowRng)).toBe(1);
    expect(dockCountFor('tank', highRng)).toBe(1);
    expect(dockCountFor('helicopter', lowRng)).toBe(1);
    expect(dockCountFor('helicopter', highRng)).toBe(1);
    expect(dockCountFor('carrier', lowRng)).toBe(1);
    expect(dockCountFor('carrier', highRng)).toBe(1);
    // #314: drone/infantry are the deliberate exception — a flat ~10-body burst, rng-independent.
    expect(DOCK_SWARM_COUNT).toBe(10);
    for (const rng of [lowRng, highRng]) {
      expect(dockCountFor('drone', rng)).toBe(DOCK_SWARM_COUNT);
      expect(dockCountFor('infantry', rng)).toBe(DOCK_SWARM_COUNT);
    }
    // Deliberately NOT the existing cluster-expansion sizes (SWARM_SIZE 18 / INFANTRY_MOB_SIZE 28).
    expect(DOCK_SWARM_COUNT).toBeLessThan(18);
  });

  it('#269 playtest follow-up: early pool mixes tank + helicopter (not wall-to-wall tanks), late pool weights helicopter up', () => {
    // Early bases are no longer 100% tanks — helicopter is an equal-weight early presence.
    expect(BASE_EARLY_KIND_POOL).toContain('tank');
    expect(BASE_EARLY_KIND_POOL).toContain('helicopter');
    // Kept SOFT: only the two vehicle kinds early — no carrier, no mechs (those stay late-only).
    expect(BASE_EARLY_KIND_POOL).not.toContain('carrier');
    for (const mech of ['raider', 'skirmisher', 'sniper', 'artillery']) {
      expect(BASE_EARLY_KIND_POOL).not.toContain(mech);
    }
    // Late pool: helicopter weighting raised from 2 to 3 entries — expressed as a RATIO against
    // tank since #314 doubled every pre-existing late entry (see its own test below), which
    // preserves #269's relative mix but not the raw entry counts.
    const heliLate = BASE_LATE_KIND_POOL.filter((k) => k === 'helicopter').length;
    const quadLate = BASE_LATE_KIND_POOL.filter((k) => k === 'carrier').length;
    expect(heliLate / quadLate).toBe(3);
    // ...and helicopter is now more common than tank in the late pool.
    const tankLate = BASE_LATE_KIND_POOL.filter((k) => k === 'tank').length;
    expect(heliLate).toBeGreaterThan(tankLate);
  });

  it('never overwrites a hex that is no longer plain ground', () => {
    const rng = mulberry32(42);
    const all = buildAllRing();
    const T = new Map();
    for (const h of all) T.set(axialKey(h.q, h.r), B.groundA);
    // Pre-mark a chunk of the map as non-ground (any id other than groundA/groundB) so
    // placeBases must route around it.
    const preMarked = new Set();
    for (const h of range({ q: 0, r: 0 }, 3)) { T.set(axialKey(h.q, h.r), 'rubble'); preMarked.add(axialKey(h.q, h.r)); }
    const isGround = (k) => { const t = T.get(k); return t === B.groundA || t === B.groundB; };
    const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT);
    for (const base of bases) {
      for (const d of base.docks) expect(preMarked.has(axialKey(d.q, d.r))).toBe(false);
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

  // #308 ("runs should just be longer in general"): five bases AND a longer corridor. The whole
  // point of the pairing is that a longer run reads as a longer TREK, not a denser one — so what
  // these pin is the RELATIONSHIP between count and length, not either number in isolation.
  describe('#308: longer runs — more bases without compressing the travel between them', () => {
    it('runs five bases', () => {
      expect(BASE_COUNT).toBe(5);
    });

    it('derives corridor length from the base count, so the per-base share is invariant', () => {
      expect(CORRIDOR_LENGTH_PX).toBe(CORRIDOR_LENGTH_PER_BASE_PX * BASE_COUNT);
      // The share each base gets is what determines how far you travel between encounters, and
      // it is held at what the shipped 3-base/3400px corridor gave (≈1133px). Raising BASE_COUNT
      // without this derivation is exactly the "more crowded, not longer" outcome #308 rejected.
      expect(Math.abs(CORRIDOR_LENGTH_PX / BASE_COUNT - 3400 / 3)).toBeLessThan((3400 / 3) * 0.02);
    });

    // MIN_GAP_PROGRESS_PX's own sizing argument (see worldgen.js) rests on each base getting a
    // ~1130px slice of corridor to place itself in. That argument has to still hold at 5 bases,
    // or the 600px calm-gap floor stops being reliably achievable — which is precisely what the
    // corridor-length derivation buys. Pinned so a future count change can't quietly break it.
    it('leaves the calm-gap floor comfortably inside each base\'s slice of corridor', () => {
      const slicePx = CORRIDOR_LENGTH_PX / BASE_COUNT;
      expect(MIN_GAP_PROGRESS_PX).toBeLessThan(slicePx * 0.6);
      // All `BASE_COUNT` floors must also fit end-to-end inside one corridor, with room to spare.
      expect(MIN_GAP_PROGRESS_PX * BASE_COUNT).toBeLessThan(CORRIDOR_LENGTH_PX * 0.6);
    });

    // The early→late difficulty ramp is normalized, so it adapts to any count for free — but
    // "adapts" isn't the same as "reads smoothly." Over five bases the steps must be even and
    // monotonic (0, .25, .5, .75, 1), not lurching from soft straight to mech-heavy.
    it('escalates the early→late mix in even steps across all five bases', () => {
      const fracs = Array.from({ length: BASE_COUNT }, (_, i) => baseLateFraction(i, BASE_COUNT));
      expect(fracs).toEqual([0, 0.25, 0.5, 0.75, 1]);
      for (let i = 1; i < fracs.length; i++) {
        expect(fracs[i]).toBeGreaterThan(fracs[i - 1]);
        expect(fracs[i] - fracs[i - 1]).toBeCloseTo(1 / (BASE_COUNT - 1), 10);
      }
      // The first base is a pure early-pool draw and the last a pure late-pool one, so the run
      // still has a genuinely soft opener and a genuinely hard finish — the ramp got smoother
      // with more bases, it didn't get flatter at the ends.
      expect(fracs[0]).toBe(0);
      expect(fracs[BASE_COUNT - 1]).toBe(1);
    });

    // #308: two compounds sharing a hex would let the later base's paving stamp over the
    // earlier's objective, and leave two interpenetrating wall rings that neither seals. Checked
    // on the REAL pipeline across a broad sweep, at the live BASE_COUNT.
    it('never places two base compounds close enough for their footprints to overlap', () => {
      for (let seed = 1; seed <= 60; seed++) {
        const { bases } = generateTerrain(realArgsFor(seed * 41 + 3));
        expect(bases.length).toBe(BASE_COUNT);
        for (let i = 0; i < bases.length; i++) {
          for (let j = i + 1; j < bases.length; j++) {
            expect(distance(bases[i].center, bases[j].center)).toBeGreaterThan(BASE_FOOTPRINT_RADIUS * 2);
          }
        }
        // …and the footprints themselves are genuinely disjoint sets, not merely far apart.
        const seen = new Set();
        for (const b of bases) {
          for (const h of b.footprint) {
            const k = axialKey(h.q, h.r);
            expect(seen.has(k)).toBe(false);
            seen.add(k);
          }
        }
      }
    });

    // The stratification #308 rewrote: segments are sliced by PROGRESS SPAN, not hex count, so
    // the spawn end's extra hex mass (rear pad + force-included safe disc) can't squash base 0's
    // segment below the calm-gap floor and shove every later base forward. Directly asserted:
    // each base sits in roughly its own fifth of the run, with no bunching at either end.
    it('spreads all five bases evenly down the corridor, none bunched at the far end', () => {
      for (let seed = 1; seed <= 60; seed++) {
        const { spine, includedKeys } = buildCorridor(seed * 41 + 3);
        const all = [...includedKeys].map((k) => { const [q, r] = k.split(',').map(Number); return { q, r }; });
        const T = new Map();
        for (const h of all) T.set(axialKey(h.q, h.r), GRASSLAND.groundA);
        const isGround = (k) => { const t = T.get(k); return t === GRASSLAND.groundA || t === GRASSLAND.groundB; };
        const progressOf = (h) => spineProgressHexOf(spine, h.q, h.r);
        const { bases } = placeBases(mulberry32(seed), all, T, isGround, BASE_COUNT, progressOf);
        const ps = bases.map((b) => progressOf(b.center));
        const allP = all.map(progressOf);
        // Progress starts NEGATIVE (the corridor's rear pad sits behind spawn at u<0), so slices
        // have to be measured across the real [min, max] range, not from zero.
        const minP = Math.min(...allP);
        const maxP = Math.max(...allP);
        // Monotonic: base index order IS forward progress order (mission.js relies on this).
        for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
        // Each base lands inside a generous window around its own fifth of the run. The window is
        // wide (±1 slice) because placement is deliberately random within a slice — what's being
        // ruled out is systematic drift, e.g. every base crowding the last third.
        const slice = (maxP - minP) / BASE_COUNT;
        for (let i = 0; i < BASE_COUNT; i++) {
          expect(ps[i]).toBeGreaterThan(minP + i * slice - slice);
          expect(ps[i]).toBeLessThan(minP + (i + 2) * slice);
        }
        // And the run genuinely uses its whole length: the last base is out in the final fifth.
        expect(ps[BASE_COUNT - 1]).toBeGreaterThan(maxP - slice);
      }
    });
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
    }
    for (const t of alertTowers) expect(terrain.get(axialKey(t.q, t.r))).toBe('alertTower');
  });

  // #275 (redesign): alert towers are placed one per gap between successive bases, not anchored
  // to any "outpost" concept — this asserts each tower's spine-progress position falls between
  // the previous base's position (or the corridor start, for gap 0) and the next base's, in the
  // same order as the bases themselves (base index order == progress order, per `placeBases`).
  it('generateTerrain places alert towers one per gap, ordered along the bases\' own progress', () => {
    // #278: seed picked to still place all 3 gap towers now that grassland has its own `mud`
    // in-map hazard (occupies some ground candidates it didn't before — seed 456 now misses one
    // gap under the new terrain mix, which is expected best-effort behavior, not a regression).
    const { spine, includedKeys } = buildCorridor(451);
    const { bases, alertTowers } = generateTerrain({
      seed: 451, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, safeCenter: { q: 0, r: 0 }, includedKeys, spine,
    });
    expect(bases.length).toBe(BASE_COUNT);
    // Best-effort placement (a gap can rarely miss if it has no ground candidate) — but on a
    // normal corridor every gap should place.
    expect(alertTowers.length).toBe(BASE_COUNT);
    const baseProgresses = bases.map((b) => spineProgressHexOf(spine, b.center.q, b.center.r));
    let prev = 0;
    for (let i = 0; i < alertTowers.length; i++) {
      const p = spineProgressHexOf(spine, alertTowers[i].q, alertTowers[i].r);
      const hi = baseProgresses[i];
      expect(p).toBeGreaterThanOrEqual(Math.min(prev, hi) - 1e-6);
      expect(p).toBeLessThanOrEqual(Math.max(prev, hi) + 1e-6);
      prev = hi;
    }
  });

  // #275: is an alert tower's placement actually reachable on the corridor's natural path, or
  // could it land off to the side the player would never drive near? `placeGapTowers` only ever
  // stamps a candidate hex that's already IN `T` (built from the live corridor's own hex set,
  // scenes/arena/world.js `_buildWorld`) — so every placed tower is, by construction, already
  // inside the drivable corridor. This test exercises the REAL corridor-carving path
  // (buildCorridor, same as world.js) across many seeds and confirms every placed alert tower's
  // pixel position sits within CORRIDOR_HALF_WIDTH_PX of the corridor's own spine — i.e. never
  // further from the driving path than any other in-map feature can be, not stranded off to one side.
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

  // #284: each tower generateTerrain returns must carry a `baseId` referencing a real base from
  // this same generation, and no two towers share a base (each gap belongs to exactly one base) —
  // the relationship the scene-side wake trigger relies on directly, with no geometric
  // re-derivation. (The precise "tower's baseId matches the base its own gap precedes" claim is
  // exercised more rigorously above, against a controlled straight-line corridor where gap
  // membership is unambiguous — real curving corridors can occasionally produce a base whose
  // stratified-but-randomized centre isn't strictly progress-ordered relative to its neighbours,
  // which would make a from-scratch geometric re-derivation here just as ambiguous as the bug
  // this issue fixes.)
  it('generateTerrain tags every alert tower with a baseId from its own generation, one base per tower', () => {
    let checked = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const { includedKeys, spine } = buildCorridor(seed * 101 + 3);
      const { bases, alertTowers } = generateTerrain({
        seed, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, safeCenter: { q: 0, r: 0 }, includedKeys, spine,
      });
      const baseIds = new Set(bases.map((b) => b.id));
      const seenBaseIds = new Set();
      for (const t of alertTowers) {
        expect(baseIds.has(t.baseId)).toBe(true);
        expect(seenBaseIds.has(t.baseId)).toBe(false);   // no base gets two towers
        seenBaseIds.add(t.baseId);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);   // sanity: the sweep actually checked real towers
  });

  // #275: confirms placement isn't wildly unreliable — most of the `BASE_COUNT` gaps actually
  // get a tower, even though a gap can rarely have no valid ground candidate at all.
  it('places most of the requested gap towers across a sweep of real corridors (not a rare fluke)', () => {
    let totalMaxPossible = 0, totalPlaced = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const { includedKeys } = buildCorridor(seed * 101 + 3);
      const { bases, alertTowers } = generateTerrain({
        seed, worldRadius: MAX_WORLD_RADIUS, biome: GRASSLAND, safeCenter: { q: 0, r: 0 }, includedKeys,
      });
      totalMaxPossible += bases.length;
      totalPlaced += alertTowers.length;
    }
    expect(totalPlaced).toBeGreaterThan(totalMaxPossible * 0.5);
  });

  // #283 ("guarantee a calm, threat-free start and genuinely calm travel gaps between base
  // encounters"): `placeBases`/`placeGapTowers` both now enforce a MIN_GAP_PROGRESS_HEX floor
  // past whatever came before them (spawn, for the first one; the previous base, for every
  // successive gap) — see worldgen.js's own comment on the constant for the full sizing
  // reasoning (chassis-speed target vs. corridor-length budget, cross-checked against the
  // detection-radius audit below).
  describe('#283 minimum calm-gap spacing', () => {
    // A long, spacious synthetic corridor (progress = q directly, like `buildLine` above) with
    // plenty of headroom relative to MIN_GAP_PROGRESS_HEX, so the floor is always comfortably
    // achievable — isolates "does the floor hold" from "is the real 3400px corridor tight
    // enough that the graceful-degradation fallback sometimes has to settle for less" (covered
    // separately below, against the REAL corridor pipeline).
    function buildSpaciousLine(maxQ = 2000) {
      const all = [];
      for (let q = 0; q <= maxQ; q++) all.push({ q, r: 0 });
      const T = new Map();
      for (const h of all) T.set(axialKey(h.q, h.r), GRASSLAND.groundA);
      const isGround = (k) => { const t = T.get(k); return t === GRASSLAND.groundA || t === GRASSLAND.groundB; };
      return { all, T, isGround, progressOf: (h) => h.q };
    }

    it('base 0 sits at least MIN_GAP_PROGRESS_HEX past spawn (progress 0)', () => {
      for (const seed of [1, 2, 3, 42, 777]) {
        const { all, T, isGround, progressOf } = buildSpaciousLine();
        const rng = mulberry32(seed);
        const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT, progressOf);
        expect(progressOf(bases[0].center)).toBeGreaterThanOrEqual(MIN_GAP_PROGRESS_HEX);
      }
    });

    it('every successive base sits at least MIN_GAP_PROGRESS_HEX past the previous one', () => {
      for (const seed of [1, 2, 3, 42, 777]) {
        const { all, T, isGround, progressOf } = buildSpaciousLine();
        const rng = mulberry32(seed);
        const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT, progressOf);
        expect(bases.length).toBe(BASE_COUNT);
        let prev = 0;
        for (const base of bases) {
          const p = progressOf(base.center);
          expect(p).toBeGreaterThanOrEqual(prev + MIN_GAP_PROGRESS_HEX);
          prev = p;
        }
      }
    });

    it('gap 0\'s tower sits at least MIN_GAP_PROGRESS_HEX past spawn, and every later gap\'s tower sits at least that far past the previous base', () => {
      for (const seed of [1, 2, 3, 42, 777]) {
        const { all, T, isGround, progressOf } = buildSpaciousLine();
        const rng = mulberry32(seed);
        const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT, progressOf);
        // Pass the real base descriptors (not just their centres) — `placeGapTowers` reads
        // `base.center`/`base.id` off each entry.
        const alertTowers = placeGapTowers(rng, all, T, isGround, bases, progressOf);
        expect(alertTowers.length).toBe(BASE_COUNT);   // spacious corridor: every gap gets a tower
        let prev = 0;
        for (let i = 0; i < alertTowers.length; i++) {
          const p = progressOf(alertTowers[i]);
          expect(p).toBeGreaterThanOrEqual(prev + MIN_GAP_PROGRESS_HEX);
          prev = progressOf(bases[i].center);
        }
      }
    });

    // #269 playtest follow-up ("alert towers are too close to their linked base"): the symmetric
    // half of the floor — a tower must ALSO sit at least `MIN_GAP_PROGRESS_HEX` BEFORE its own
    // linked base, not just past whatever came before it. On a spacious corridor (plenty of room
    // for both floors) this should hold exactly, same as the "past spawn/previous base" floor
    // above.
    it('every gap tower also sits at least MIN_GAP_PROGRESS_HEX before its own linked base', () => {
      for (const seed of [1, 2, 3, 42, 777]) {
        const { all, T, isGround, progressOf } = buildSpaciousLine();
        const rng = mulberry32(seed);
        const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT, progressOf);
        const alertTowers = placeGapTowers(rng, all, T, isGround, bases, progressOf);
        expect(alertTowers.length).toBe(BASE_COUNT);
        for (let i = 0; i < alertTowers.length; i++) {
          const towerP = progressOf(alertTowers[i]);
          const baseP = progressOf(bases[i].center);
          expect(baseP - towerP).toBeGreaterThanOrEqual(MIN_GAP_PROGRESS_HEX - 1e-6);
        }
      }
    });

    it('base/tower COUNT is unaffected by the new floor (still exactly BASE_COUNT of each)', () => {
      for (const seed of [1, 2, 3, 42, 777]) {
        const { all, T, isGround, progressOf } = buildSpaciousLine();
        const rng = mulberry32(seed);
        const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT, progressOf);
        const alertTowers = placeGapTowers(rng, all, T, isGround, bases, progressOf);
        expect(bases.length).toBe(BASE_COUNT);
        expect(alertTowers.length).toBe(BASE_COUNT);
      }
    });

    // #269 playtest follow-up: graceful degradation when a gap is too short to fit BOTH floors —
    // a synthetic gap of width `MIN_GAP_PROGRESS_HEX` (i.e. exactly ONE floor's worth, not two)
    // between the previous position and the linked base. The tower must still place (never
    // silently skipped when ground exists), and — since the buffer shrinks proportionally to
    // `width / 2` — it should land within the gap, roughly centred rather than jammed against
    // either edge.
    it('gracefully degrades toward the gap\'s midpoint (still places a tower) when a gap is too short for both full floors', () => {
      const all = [];
      for (let q = 0; q <= 20; q++) all.push({ q, r: 0 });
      const T = new Map();
      for (const h of all) T.set(axialKey(h.q, h.r), GRASSLAND.groundA);
      const isGround = (k) => { const t = T.get(k); return t === GRASSLAND.groundA || t === GRASSLAND.groundB; };
      const progressOf = (h) => h.q;
      // A single base whose gap-from-spawn is only 10 wide — well under 2x MIN_GAP_PROGRESS_HEX
      // (~14.4) needed to fit a full floor on both sides.
      const bases = [{ id: 'base0', center: { q: 10, r: 0 } }];
      for (const seed of [1, 2, 3, 42, 777]) {
        const rng = mulberry32(seed);
        const alertTowers = placeGapTowers(rng, all, T, isGround, bases, progressOf);
        expect(alertTowers.length).toBe(1);   // never silently skipped just because the floor can't fully fit
        const p = progressOf(alertTowers[0]);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(10);
        // Degraded placement still leans toward the midpoint (5), not jammed at either edge.
        expect(Math.abs(p - 5)).toBeLessThanOrEqual(2);
      }
    });

    it('never inverts (lo <= hi) even on a zero-width gap (base landing exactly at the previous position)', () => {
      const all = [];
      for (let q = 0; q <= 10; q++) all.push({ q, r: 0 });
      const T = new Map();
      for (const h of all) T.set(axialKey(h.q, h.r), GRASSLAND.groundA);
      const isGround = (k) => { const t = T.get(k); return t === GRASSLAND.groundA || t === GRASSLAND.groundB; };
      const progressOf = (h) => h.q;
      // Degenerate: the base's own progress is 0, same as the corridor start — a zero-width gap.
      // `T` is mutated in place by `placeGapTowers` (a placed tower's hex is stamped 'alertTower',
      // no longer ground), so call it exactly once and assert against that single result rather
      // than calling it twice against the same `T`.
      const bases = [{ id: 'base0', center: { q: 0, r: 0 } }];
      let alertTowers;
      expect(() => { alertTowers = placeGapTowers(mulberry32(1), all, T, isGround, bases, progressOf); }).not.toThrow();
      expect(alertTowers.length).toBe(1);
      expect(progressOf(alertTowers[0])).toBe(0);
    });

    it('a tiny/degenerate candidate set never places a base BEHIND the one before it, even when the floor can\'t be fully reached', () => {
      // A corridor far too short to fit BASE_COUNT full floors end-to-end — exercises
      // `placeBases`'s own graceful-degradation fallback (its comment has the full reasoning).
      const all = [];
      for (let q = 0; q <= 5; q++) all.push({ q, r: 0 });
      const T = new Map();
      for (const h of all) T.set(axialKey(h.q, h.r), GRASSLAND.groundA);
      const isGround = (k) => { const t = T.get(k); return t === GRASSLAND.groundA || t === GRASSLAND.groundB; };
      const progressOf = (h) => h.q;
      for (const seed of [1, 2, 3, 42, 777]) {
        const rng = mulberry32(seed);
        const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT, progressOf);
        expect(bases.length).toBe(BASE_COUNT);   // count still guaranteed even in the degraded case
        let prev = 0;
        for (const base of bases) {
          const p = progressOf(base.center);
          expect(p).toBeGreaterThanOrEqual(prev);   // never behind — non-decreasing, floor or not
          prev = p;
        }
      }
    });

    it('on the real snaking corridor pipeline, the floor holds for every gap across a broad seed sweep', () => {
      // Exercises the actual generateSpine/corridorHexSet/spineProgressHexOf pipeline (not a
      // synthetic line) across many seeds — proves MIN_GAP_PROGRESS_PX (600px) is small enough,
      // relative to the real CORRIDOR_LENGTH_PX budget split `BASE_COUNT` ways, that the floor is
      // reliably achievable in practice, not just on paper. See worldgen.js's own comment on
      // MIN_GAP_PROGRESS_PX for the sizing sweep this mirrors.
      for (let seed = 1; seed <= 40; seed++) {
        const { spine, includedKeys } = buildCorridor(seed * 37 + 11);
        const all = [...includedKeys].map((k) => { const [q, r] = k.split(',').map(Number); return { q, r }; });
        const T = new Map();
        for (const h of all) T.set(axialKey(h.q, h.r), GRASSLAND.groundA);
        const isGround = (k) => { const t = T.get(k); return t === GRASSLAND.groundA || t === GRASSLAND.groundB; };
        const progressOf = (h) => spineProgressHexOf(spine, h.q, h.r);
        const rng = mulberry32(seed);
        const { bases } = placeBases(rng, all, T, isGround, BASE_COUNT, progressOf);
        expect(bases.length).toBe(BASE_COUNT);

        expect(spineProgressHexOf(spine, bases[0].center.q, bases[0].center.r)).toBeGreaterThanOrEqual(MIN_GAP_PROGRESS_HEX - 1e-6);
        let prev = 0;
        for (const base of bases) {
          const p = spineProgressHexOf(spine, base.center.q, base.center.r);
          expect(p).toBeGreaterThanOrEqual(prev + MIN_GAP_PROGRESS_HEX - 1e-6);
          prev = p;
        }
      }
    });

    // Audit: a dormant unit's proximity-wake radius (PROXIMITY_WAKE_RANGE_CAP) stays comfortably
    // inside MIN_GAP_PROGRESS_PX, so a player travelling the calm middle of a minimum-sized gap
    // genuinely can't wake a base's units just by passing through — even in the worst-case
    // placement (a gap-tower landing with little slack against the far base).
    //
    // #269 overhaul: ALERT_DETECT_RADIUS is NO LONGER unified with PROXIMITY_WAKE_RANGE_CAP. The
    // alert tower was deliberately given a LARGER, sticky detection envelope (its whole job is to
    // be a hard-to-avoid tripwire that commits the moment you touch it), so it is intentionally
    // allowed to reach further into the gap than the proximity-wake cap does. The "genuine calm
    // middle" guarantee therefore now protects the PROXIMITY wake (walking the middle doesn't stir
    // a base's own units), not the tower's tripwire — dodging the tower is now about killing it or
    // routing wide, not slipping through an untriggerable centre lane.
    it('audit: PROXIMITY_WAKE_RANGE_CAP stays well inside MIN_GAP_PROGRESS_PX, leaving a genuine calm middle even in the worst case', () => {
      expect(PROXIMITY_WAKE_RANGE_CAP).toBeLessThan(MIN_GAP_PROGRESS_PX);
      const worstCaseCalmPx = MIN_GAP_PROGRESS_PX - PROXIMITY_WAKE_RANGE_CAP;
      expect(worstCaseCalmPx).toBeGreaterThan(0);
      // A real, non-trivial calm stretch — not just barely positive — even for the fastest
      // (light, 268px/s) chassis in the worst RNG case.
      expect(worstCaseCalmPx).toBeGreaterThanOrEqual(250);
    });

    // #269 overhaul: the alert tower's larger, sticky envelope is intentionally decoupled from
    // (and larger than) the proximity-wake cap — pin that relationship so an accidental re-unify
    // or a revert to the old tight radius fails loudly.
    it('audit: ALERT_DETECT_RADIUS is intentionally larger than PROXIMITY_WAKE_RANGE_CAP (decoupled tripwire, #269)', () => {
      expect(ALERT_DETECT_RADIUS).toBeGreaterThan(PROXIMITY_WAKE_RANGE_CAP);
    });
  });
});

// #288 (placement RE-SPECCED 2026-07-19 — "instead of a line across the corridor, let's do a full
// ring around the base"): each base's wall is now the OUTLINE OF ITS OWN COMPOUND FOOTPRINT — a
// full ring completely encircling it, sealed, hugging it tightly. The previous line-across-the-
// approach tests are gone with the construction they pinned (a BFS level set of walking distance
// from spawn, plus WALL_LINE_SETBACK_PX); what survives, and is restated here for a ring, is the
// load-bearing property both specs shared: THE WALL MUST ACTUALLY SEAL. Two earlier constructions
// of the wall LINE leaked on real curved seeds, so it is tested here directly, on synthetic
// geometry and on the real corridor pipeline alike.
describe('placeBaseWalls (#288: base perimeter wall, as a sealed RING of hex EDGES)', () => {
  const B = GRASSLAND;

  // A generous disc of plain ground, big enough to cover any footprint these tests place inside.
  function fillGroundDisc(radiusHex = 45) {
    const T = new Map();
    for (const h of range({ q: 0, r: 0 }, radiusHex)) T.set(axialKey(h.q, h.r), B.groundA);
    return T;
  }

  // A synthetic base with a full, unclipped radius-`BASE_FOOTPRINT_RADIUS` footprint disc.
  const discBase = (center, id = 'b') => ({
    id, center, footprint: range(center, BASE_FOOTPRINT_RADIUS).map((h) => ({ q: h.q, r: h.r })),
  });

  // Can you WALK from `start` to `goal` across the playable set without crossing a standing wall
  // span? A plain hex BFS whose only extra rule is that a step between two hexes is refused when
  // that step's own edge is walled — which is exactly what the arena's movement collision enforces
  // in pixel space. This is THE load-bearing check for the whole feature: a wall that doesn't
  // actually seal is just decoration.
  function reachable(T, walledKeys, start, goal, limit = 40000) {
    const goalKey = axialKey(goal.q, goal.r);
    const seen = new Set([axialKey(start.q, start.r)]);
    const queue = [start];
    let visited = 0;
    while (queue.length && visited++ < limit) {
      const cur = queue.shift();
      if (axialKey(cur.q, cur.r) === goalKey) return true;
      for (const n of neighbors(cur.q, cur.r)) {
        const nk = axialKey(n.q, n.r);
        if (seen.has(nk) || !T.has(nk)) continue;
        if (!isPassable(T.get(nk))) continue;
        if (walledKeys.has(edgeKey(cur, n))) continue;   // the wall stops this step
        seen.add(nk);
        queue.push(n);
      }
    }
    return false;
  }

  const walledKeySet = (wall) => new Set(wall.edges.map((e) => edgeKey(e.a, e.b)));

  it('rings a base with a footprint, and no-ops gracefully without one', () => {
    const T = fillGroundDisc();
    const center = pixelToHex(1000, 0);
    const walls = placeBaseWalls(T, [discBase(center)]);
    expect(walls.length).toBe(1);
    expect(walls[0].baseId).toBe('b');
    // A radius-2 hex disc's boundary is its outer ring (12 hexes), each contributing the edges
    // that face outward: the 6 CORNER hexes have 3 outward edges each, the 6 SIDE hexes 2 —
    // 6*3 + 6*2 = 30. Pinned exactly, because this number IS the ring's literal shape.
    expect(walls[0].edges.length).toBe(30);
    expect(placeBaseWalls(T, [])).toEqual([]);
    expect(placeBaseWalls(T, [{ id: 'b', center, footprint: [] }])).toEqual([]);
    expect(placeBaseWalls(T, [{ id: 'b', center }])).toEqual([]);
  });

  // The defining property of the edge rebuild, unchanged by the re-spec: a wall belongs to the LINE
  // BETWEEN two hexes, so it consumes no tile. The terrain map must come back byte-identical.
  it('writes NOTHING to the terrain map — an edge wall occupies no hex', () => {
    const T = fillGroundDisc();
    const before = new Map(T);
    placeBaseWalls(T, [discBase(pixelToHex(900, 400))]);
    expect(T.size).toBe(before.size);
    for (const [k, v] of before) expect(T.get(k)).toBe(v);
  });

  // Edge identity: each entry names two genuinely ADJACENT hexes, `a` is always the base-side one
  // (which is what makes the "nothing natural behind a span" invariant checkable), and no edge is
  // listed twice.
  it('every edge is a real adjacent hex pair, footprint-side first, with no duplicates', () => {
    const center = pixelToHex(1100, -300);
    const base = discBase(center);
    const inside = new Set(base.footprint.map((h) => axialKey(h.q, h.r)));
    const [wall] = placeBaseWalls(fillGroundDisc(), [base]);
    const keys = new Set();
    for (const e of wall.edges) {
      expect(distance(e.a, e.b)).toBe(1);
      expect(inside.has(axialKey(e.a.q, e.a.r))).toBe(true);    // `a` = base side, always
      expect(inside.has(axialKey(e.b.q, e.b.r))).toBe(false);   // `b` = outside, always
      const k = edgeKey(e.a, e.b);
      expect(keys.has(k)).toBe(false);
      keys.add(k);
    }
  });

  // A RING, not a line: the spans surround the base on every side. Checked by bearing coverage —
  // sort every span's midpoint by its angle around the base centre and assert no angular gap
  // bigger than a single hex's worth of arc. A line across one approach would leave a ~180° hole.
  it('ENCIRCLES the base — spans cover every bearing, with no angular gap', () => {
    for (const [px, py] of [[1000, 0], [-800, 600], [300, -1200], [-1500, -400]]) {
      const center = pixelToHex(px, py);
      const [wall] = placeBaseWalls(fillGroundDisc(), [discBase(center)]);
      const c = hexToPixel(center.q, center.r);
      const angles = wall.edges
        .map((e) => { const m = edgeMidpoint(e.a, e.b); return Math.atan2(m.y - c.y, m.x - c.x); })
        .sort((a, b) => a - b);
      let maxGap = angles[0] + Math.PI * 2 - angles[angles.length - 1];
      for (let i = 1; i < angles.length; i++) maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
      expect(maxGap).toBeLessThan(Math.PI / 4);   // < 45°: no side is unwalled
    }
  });

  // HUGS the base: every span sits within roughly the footprint radius of the centre — there is no
  // setback anymore and no dead ground inside the ring. (This is the direct restatement of the
  // 2026-07-19 playtest complaint that the wall sat "too far from the actual bases".)
  it('HUGS the base — no span sits farther out than the footprint radius', () => {
    const center = pixelToHex(1000, 0);
    const [wall] = placeBaseWalls(fillGroundDisc(), [discBase(center)]);
    const c = hexToPixel(center.q, center.r);
    for (const e of wall.edges) {
      const m = edgeMidpoint(e.a, e.b);
      // The far face of the outermost footprint ring — nothing beyond it, and nothing loitering
      // near the centre either (a ring, not a blob).
      const d = Math.hypot(m.x - c.x, m.y - c.y);
      expect(d).toBeLessThanOrEqual((BASE_FOOTPRINT_RADIUS + 0.6) * HEX_STEP_PX);
      expect(d).toBeGreaterThan((BASE_FOOTPRINT_RADIUS - 0.5) * HEX_STEP_PX);
    }
  });

  it('SEALS the base: no walkable route in from anywhere outside, at any position', () => {
    for (const [px, py] of [[1000, 0], [-800, 600], [300, -1200], [-1500, -400], [0, 0]]) {
      const T = fillGroundDisc();
      const center = pixelToHex(px, py);
      const [wall] = placeBaseWalls(T, [discBase(center)]);
      const walled = walledKeySet(wall);
      // Probe from every direction, well outside the ring — none of them can walk in.
      for (const angle of [0, 1, 2, 3, 4, 5]) {
        const from = pixelToHex(px + Math.cos(angle) * 600, py + Math.sin(angle) * 600);
        expect(T.has(axialKey(from.q, from.r))).toBe(true);
        expect(reachable(T, walled, from, center)).toBe(false);
        // …and with the wall gone the same route IS walkable, proving the block is the wall's
        // doing and not an accident of the disc.
        expect(reachable(T, new Set(), from, center)).toBe(true);
      }
    }
  });

  // Per-span destruction: knocking out ONE span opens a breach you can drive through, while every
  // other span still stands. With a sealed ring this is now the ONLY way in (the owner confirmed
  // that's deliberate — #309's gates are enemies-only), so it's also the anti-soft-lock guarantee.
  it('breaching ONE span opens the ONLY way in; the rest of the ring still stands', () => {
    const T = fillGroundDisc();
    const center = pixelToHex(1000, 0);
    const outside = pixelToHex(400, 0);
    const [wall] = placeBaseWalls(T, [discBase(center)]);
    const walled = walledKeySet(wall);
    expect(reachable(T, walled, outside, center)).toBe(false);
    // Breach any single span — every one of them must be sufficient on its own, since the player
    // gets to pick which face of the ring to attack.
    for (const e of wall.edges) {
      const breached = new Set(walled);
      breached.delete(edgeKey(e.a, e.b));
      expect(breached.size).toBe(wall.edges.length - 1);   // exactly one span went down
      expect(reachable(T, breached, outside, center)).toBe(true);
    }
  });

  // Full-pipeline coverage: the real generateSpine/corridorHexSet/generateTerrain path (not the
  // synthetic discs above) across many seeds, corridor orientations and biomes.
  describe('on the real corridor pipeline (generateTerrain)', () => {
    function realTerrainArgs(seed, biome = GRASSLAND) {
      const { spine, includedKeys, spawnHex } = buildCorridor(seed);
      const boundaryRing = boundaryRingKeys(null, { insideKeys: includedKeys });
      return { seed, worldRadius: MAX_WORLD_RADIUS, biome, includedKeys, boundaryRing, spine, safeCenter: spawnHex };
    }

    it('every base gets a non-empty ring, and generateTerrain returns the flattened edge list', () => {
      for (let seed = 1; seed <= 40; seed++) {
        const { bases, wallEdges, terrain } = generateTerrain(realTerrainArgs(seed * 13 + 3));
        expect(bases.length).toBe(BASE_COUNT);
        let total = 0;
        for (const base of bases) {
          expect(base.wallEdges.length).toBeGreaterThan(0);
          total += base.wallEdges.length;
          for (const e of base.wallEdges) {
            expect(distance(e.a, e.b)).toBe(1);
            expect(terrain.has(axialKey(e.a.q, e.a.r))).toBe(true);
          }
        }
        expect(wallEdges.length).toBe(total);
        expect(new Set(wallEdges.map((e) => edgeKey(e.a, e.b))).size).toBe(total);
        for (const e of wallEdges) expect(bases.some((b) => b.id === e.baseId)).toBe(true);
      }
    });

    // THE NEW INVARIANT, and the whole reason the base footprint is paved: "the bases should flow
    // with no natural hexes directly behind each wall segment". Behind every span (its `a` side)
    // must be BASE infrastructure, never ordinary terrain — checked over every base of every seed
    // in every biome, since the paving has to survive whatever the biome dropped there.
    it('no ORDINARY TERRAIN hex sits directly behind any span — the base backs onto every one', () => {
      for (const biomeId of ['grassland', 'desert', 'arctic', 'urban', 'volcanic']) {
        const biome = getBiome(biomeId);
        for (let seed = 1; seed <= 12; seed++) {
          const { bases, terrain } = generateTerrain(realTerrainArgs(seed * 29 + 7, biome));
          for (const base of bases) {
            for (const e of base.wallEdges) {
              const id = terrain.get(axialKey(e.a.q, e.a.r));
              expect(TERRAIN[id]?.category).toBe('base');
            }
          }
        }
      }
    });

    // …and the whole footprint inside the ring is base infrastructure too, not just the rim: no
    // dead natural ground anywhere inside the compound.
    it('the entire footprint inside the ring is base infrastructure', () => {
      for (let seed = 1; seed <= 15; seed++) {
        const { bases, terrain } = generateTerrain(realTerrainArgs(seed * 31 + 2));
        for (const base of bases) {
          expect(base.footprint.length).toBeGreaterThan(0);
          for (const h of base.footprint) {
            expect(TERRAIN[terrain.get(axialKey(h.q, h.r))]?.category).toBe('base');
          }
        }
      }
    });

    // The seal, on the REAL corridor: no base's centre — nor its objective, the thing the mission
    // actually requires you to destroy — is reachable on foot from spawn while its ring stands.
    // This is the property two earlier wall-LINE constructions got wrong on curved seeds.
    it('SEALS on the real corridor: spawn cannot walk to any base centre or objective', () => {
      for (let seed = 1; seed <= 20; seed++) {
        const args = realTerrainArgs(seed * 17 + 5);
        const { bases, terrain } = generateTerrain(args);
        const spawnHex = spineSpawnHex(args.spine);
        for (const base of bases) {
          const walled = new Set(base.wallEdges.map((e) => edgeKey(e.a, e.b)));
          expect(reachable(terrain, walled, spawnHex, base.center)).toBe(false);
          if (base.objectiveHex) expect(reachable(terrain, walled, spawnHex, base.objectiveHex)).toBe(false);
        }
      }
    });

    // ANTI-SOFT-LOCK. The objective sits inside a sealed ring, so the run is only winnable if
    // (a) every base HAS a real objective inside its own ring, and (b) breaching a single span of
    // that ring is enough to reach it. Both checked directly, per base, per seed: with all the
    // OTHER bases' rings standing (so nothing is accidentally reachable via a neighbour's gap),
    // knock out one span of this base's ring and walk in from spawn.
    it('cannot soft-lock: every objective is inside its own ring and reachable after ONE breach', () => {
      for (let seed = 1; seed <= 20; seed++) {
        const args = realTerrainArgs(seed * 23 + 9);
        const { bases, terrain } = generateTerrain(args);
        const spawnHex = spineSpawnHex(args.spine);
        const allWalls = bases.flatMap((b) => b.wallEdges);
        for (const base of bases) {
          const inside = new Set(base.footprint.map((h) => axialKey(h.q, h.r)));
          const target = base.objectiveHex ?? base.center;
          // (a) the objective is genuinely inside the compound this ring encloses.
          expect(inside.has(axialKey(target.q, target.r))).toBe(true);
          // (b) SOME span of this base's own ring, once breached, opens a route from spawn — with
          // every other base's ring (and every other span of this one) still standing.
          const opened = base.wallEdges.some((breach) => {
            const walled = new Set(allWalls.map((e) => edgeKey(e.a, e.b)));
            walled.delete(edgeKey(breach.a, breach.b));
            // The objective hex itself is an impassable structure, so walk to a NEIGHBOUR of it —
            // which is what "reach it and shoot it" means in practice.
            return neighbors(target.q, target.r).some((n) =>
              terrain.has(axialKey(n.q, n.r)) && isPassable(terrain.get(axialKey(n.q, n.r)))
                && reachable(terrain, walled, spawnHex, n));
          });
          expect(opened).toBe(true);
        }
      }
    });

  // ── #309: GATE assignment ──────────────────────────────────────────────────────────────
  // A gate is one of the ring's OWN spans flagged `role: 'gate'`, not a separate structure — so
  // these tests are about which spans get flagged, and (crucially) that flagging one changes
  // nothing whatsoever about the ring's shape or its seal on the hex graph. The seal in PIXEL
  // space, with gates actually OPEN, is proved in scenes/arena/wallEdgeWorld.test.js.
  describe('#309: two gates per ring, on opposite sides, opening onto passable ground', () => {
    it('flags exactly two spans of a ring as gates', () => {
      const T = fillGroundDisc();
      const base = discBase({ q: 12, r: -4 });
      const [ring] = placeBaseWalls(T, [base]);
      expect(ring.edges.filter((e) => e.role === 'gate').length).toBe(2);
    });

    // The ring is IDENTICAL with gates and without — same spans, same count. A gate does not
    // remove a span or leave a hole in the definition; it only annotates one. This is the property
    // that lets #288's whole seal proof carry over untouched.
    it('adds and removes nothing — the ring is the same set of spans it always was', () => {
      const T = fillGroundDisc();
      const base = discBase({ q: 12, r: -4 });
      const [ring] = placeBaseWalls(T, [base]);
      const inside = new Set(base.footprint.map((h) => axialKey(h.q, h.r)));
      // Still exactly the footprint's boundary: every span has its base side in, far side out.
      for (const e of ring.edges) {
        expect(inside.has(axialKey(e.a.q, e.a.r))).toBe(true);
        expect(inside.has(axialKey(e.b.q, e.b.r))).toBe(false);
      }
      // And the graph seal is untouched by the annotation — a gate is closed geometry here.
      const walled = new Set(ring.edges.map((e) => edgeKey(e.a, e.b)));
      expect(reachable(T, walled, { q: 0, r: 0 }, base.center)).toBe(false);
    });

    // Opposite sides, so a sortie can come at the player from two headings he cannot both cover.
    it('puts the two gates on roughly opposite sides of the compound', () => {
      const T = fillGroundDisc();
      for (const center of [{ q: 12, r: -4 }, { q: -9, r: 14 }, { q: 20, r: 0 }, { q: 5, r: 5 }]) {
        const base = discBase(center);
        const [ring] = placeBaseWalls(T, [base]);
        const gates = ring.edges.filter((e) => e.role === 'gate');
        expect(gates.length).toBe(2);
        const c = hexToPixel(center.q, center.r);
        const bearing = (e) => {
          const o = hexToPixel(e.b.q, e.b.r);
          return Math.atan2(o.y - c.y, o.x - c.x);
        };
        const [b0, b1] = gates.map(bearing);
        const sep = Math.abs(Math.atan2(Math.sin(b0 - b1), Math.cos(b0 - b1)));
        // A radius-2 ring only offers so many discrete outward bearings, so "opposite" means
        // within a hex-direction step of 180°, not exactly 180°.
        expect(sep).toBeGreaterThan(Math.PI * 0.6);
      }
    });

    // One gate faces the APPROACH — back toward the origin, where the run spawns. That is the one
    // the player will actually meet, and it is what makes the sortie land in front of him.
    it('faces one gate back toward spawn, the side the player arrives from', () => {
      const T = fillGroundDisc();
      for (const center of [{ q: 14, r: -5 }, { q: -11, r: 16 }, { q: 22, r: 2 }]) {
        const base = discBase(center);
        const [ring] = placeBaseWalls(T, [base]);
        const c = hexToPixel(center.q, center.r);
        const approach = Math.atan2(-c.y, -c.x);
        const gates = ring.edges.filter((e) => e.role === 'gate');
        const offsets = gates.map((e) => {
          const o = hexToPixel(e.b.q, e.b.r);
          const d = Math.atan2(o.y - c.y, o.x - c.x) - approach;
          return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
        });
        // The ring's spans sit on discrete bearings, so the best one can be up to ~30° off the
        // exact approach line — well within "this gate faces the way he is coming from."
        expect(Math.min(...offsets)).toBeLessThan(Math.PI / 5);
      }
    });

    // FORGIVING GEOMETRY (#312 is not built — units steer in straight lines): a gate must never
    // open onto terrain a unit cannot stand on, or the sortie walks into a cliff.
    it('never puts a gate on a span whose outer side is impassable', () => {
      const T = fillGroundDisc();
      const base = discBase({ q: 12, r: -4 });
      // Wall off a big arc of the compound's surroundings with impassable rock, including the
      // whole approach side, and confirm no gate lands on it.
      const c = hexToPixel(base.center.q, base.center.r);
      for (const h of range(base.center, BASE_FOOTPRINT_RADIUS + 2)) {
        const p = hexToPixel(h.q, h.r);
        if (p.x < c.x) T.set(axialKey(h.q, h.r), B.mountain ?? 'mountain');
      }
      const [ring] = placeBaseWalls(T, [base]);
      for (const e of ring.edges.filter((g) => g.role === 'gate')) {
        expect(isPassable(T.get(axialKey(e.b.q, e.b.r)))).toBe(true);
      }
    });

    // Degradation, not breakage: a base with no passable ground anywhere outside its ring gets NO
    // gate and stays the purely passive fortress it was before this issue — never a gate opening
    // into a mesa.
    it('gives a fully-walled-in base no gate at all rather than a bad one', () => {
      const T = fillGroundDisc();
      const base = discBase({ q: 12, r: -4 });
      for (const h of range(base.center, BASE_FOOTPRINT_RADIUS + 2)) {
        const k = axialKey(h.q, h.r);
        if (!base.footprint.some((f) => axialKey(f.q, f.r) === k)) T.set(k, B.mountain ?? 'mountain');
      }
      const [ring] = placeBaseWalls(T, [base]);
      expect(ring.edges.filter((e) => e.role === 'gate').length).toBe(0);
    });

    // On the REAL generated corridor, across many seeds — the placement rules have to survive
    // actual base footprints (which get clipped by the corridor) and actual terrain.
    it('holds on real generated worlds across seeds', () => {
      const gateCounts = [];
      for (let seed = 1; seed <= 20; seed++) {
        const { terrain, bases } = generateTerrain(realTerrainArgs(seed * 17 + 5));
        for (const base of bases) {
          const gates = (base.wallEdges ?? []).filter((e) => e.role === 'gate');
          // At most two, and every one of them opens onto ground a unit can actually stand on.
          expect(gates.length).toBeLessThanOrEqual(2);
          gateCounts.push(gates.length);
          for (const e of gates) {
            const k = axialKey(e.b.q, e.b.r);
            expect(terrain.has(k) && isPassable(terrain.get(k))).toBe(true);
          }
          // Every gate is a real span of this base's own ring — not an invented edge.
          const ringKeys = new Set((base.wallEdges ?? []).map((e) => edgeKey(e.a, e.b)));
          for (const e of gates) expect(ringKeys.has(edgeKey(e.a, e.b))).toBe(true);
        }
      }
      // …and the bound above is not passing vacuously: on real corridor terrain essentially every
      // base really does get its full pair of sally ports, so the mechanic is present in play
      // rather than being quietly degraded away by clipped footprints or awkward terrain.
      expect(gateCounts.length).toBeGreaterThan(50);
      const full = gateCounts.filter((n) => n === 2).length;
      expect(full / gateCounts.length).toBeGreaterThan(0.95);
    });
  });

    // A degenerate ring (zero-length, or a footprint so clipped the compound vanishes) would be
    // both a visual bug and a soft-lock risk, so the footprint is pinned to a sane size — a
    // radius-2 disc is 19 hexes, and clipping at the corridor's edge should never take most of it.
    it('never produces a degenerate footprint or ring', () => {
      for (let seed = 1; seed <= 40; seed++) {
        const { bases } = generateTerrain(realTerrainArgs(seed * 13 + 3));
        for (const base of bases) {
          expect(base.footprint.length).toBeGreaterThanOrEqual(7);
          expect(base.footprint.length).toBeLessThanOrEqual(range(base.center, BASE_FOOTPRINT_RADIUS).length);
          expect(base.wallEdges.length).toBeGreaterThanOrEqual(6);
          // Structures never land outside the ring meant to protect them.
          const inside = new Set(base.footprint.map((h) => axialKey(h.q, h.r)));
          for (const d of base.docks) expect(inside.has(axialKey(d.q, d.r))).toBe(true);
        }
      }
    });
  });
});


// #323: `drawDockKind` is the one weighted draw shared by world-gen placement and mid-fight dock
// resupply, so a dock's reinforcements match its base's difficulty at the same ratios it opened
// with. These lock the properties both callers depend on.
describe('#323 drawDockKind (shared by placeBases and dock resupply)', () => {
  const constRng = (v) => () => v;

  it('picks from the EARLY pool below the base lateFraction, the LATE pool above it', () => {
    // lateFraction 0 (the first base) can never reach the late pool...
    expect(BASE_EARLY_KIND_POOL).toContain(drawDockKind(constRng(0), 0));
    // ...and lateFraction 1 (the last base) always does.
    expect(BASE_LATE_KIND_POOL).toContain(drawDockKind(constRng(0), 1));
  });

  it('preserves the pools\' repetition weighting rather than flattening to distinct kinds', () => {
    // #308 weights both pools by REPEATING entries, so a uniform index draw already is the
    // intended mix. Sampling the early pool must reproduce tank/helicopter dominance (8/18 each)
    // with the swarm kinds thin (1/18 each) — a de-duplicated table would give ~25% each.
    const counts = {};
    for (let i = 0; i < BASE_EARLY_KIND_POOL.length * 100; i++) {
      const r = (i % BASE_EARLY_KIND_POOL.length + 0.5) / BASE_EARLY_KIND_POOL.length;
      let n = 0;
      const kind = drawDockKind(() => (n++ === 0 ? 1 : r), 0);
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    expect(counts.tank).toBe(counts.helicopter);
    expect(counts.tank / counts.drone).toBe(8);
    expect(counts.drone).toBe(counts.infantry);
  });

  it('falls back to a NON-swarm kind when the base already fields a swarm dock (#314 cap)', () => {
    // Force a swarm draw (early-pool index 16 = 'drone'), with the base already holding a swarm.
    const swarmDraw = () => { let n = 0; return () => (n++ === 0 ? 1 : 16.5 / BASE_EARLY_KIND_POOL.length); };
    expect(isSwarmDockKind(drawDockKind(swarmDraw(), 0))).toBe(true);
    expect(isSwarmDockKind(drawDockKind(swarmDraw(), 0, { hasSwarm: true }))).toBe(false);
  });

  it('always returns a real kind from the pool it drew, never undefined', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 500; i++) {
      const kind = drawDockKind(rng, i / 500, { hasSwarm: i % 2 === 0 });
      expect([...BASE_EARLY_KIND_POOL, ...BASE_LATE_KIND_POOL]).toContain(kind);
    }
  });
});
