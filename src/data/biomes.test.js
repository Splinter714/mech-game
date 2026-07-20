import { describe, it, expect } from 'vitest';
import { BIOMES, BIOME_IDS, DEFAULT_BIOME, getBiome, pickNextBiome, RECENCY_WINDOW } from './biomes.js';
import { TERRAIN, isPassable, blocksLOS, isDestructible, rubbleFor } from './terrain.js';

const ROLE_FIELDS = ['groundA', 'groundB', 'channel', 'deep', 'cover'];

describe('biome registry (#67)', () => {
  it('has the four new biomes plus grassland', () => {
    for (const id of ['grassland', 'desert', 'arctic', 'urban', 'volcanic']) {
      expect(BIOMES[id]).toBeDefined();
      expect(BIOMES[id].id).toBe(id);
      expect(typeof BIOMES[id].name).toBe('string');
    }
    expect(BIOME_IDS).toEqual(Object.keys(BIOMES));
  });

  it('every biome maps all roles to real terrain ids', () => {
    for (const b of Object.values(BIOMES)) {
      for (const f of ROLE_FIELDS) {
        expect(TERRAIN[b[f]], `${b.id}.${f} = ${b[f]}`).toBeDefined();
      }
    }
  });

  it('roles keep the same passability/LOS contract in every biome', () => {
    for (const b of Object.values(BIOMES)) {
      // Ground is open + fast-passable + no cover.
      for (const g of [b.groundA, b.groundB]) {
        expect(isPassable(g)).toBe(true);
        expect(blocksLOS(g)).toBe(false);
      }
      // Channel: passable, shoot-over (no LOS block).
      expect(isPassable(b.channel)).toBe(true);
      expect(blocksLOS(b.channel)).toBe(false);
      // Deep: impassable (the lake analog) — #110: boundary-ring-only, never in-map.
      expect(isPassable(b.deep)).toBe(false);
      // Cover: walk-through cover — passable AND blocks LOS. #351 made every biome's cover
      // INDESTRUCTIBLE (natural terrain is permanent scenery now); its cover CONTRACT is
      // deliberately unchanged, which is what this assertion pins. The rubble it would collapse
      // into is still declared and still passable/non-cover, ready if the flag is flipped back.
      expect(isPassable(b.cover)).toBe(true);
      expect(blocksLOS(b.cover)).toBe(true);
      expect(isDestructible(b.cover)).toBe(false);
      const rub = rubbleFor(b.cover);
      expect(TERRAIN[rub]).toBeDefined();
      expect(isPassable(rub)).toBe(true);     // you can drive over the debris
      expect(blocksLOS(rub)).toBe(false);
    }
  });

  // #110: every biome's LESSER in-map hazard (replacing the now boundary-only `deep`) must be
  // passable — it's a danger to slow you down, not a wall — and, when declared, a real
  // terrain id distinct from `deep` itself.
  it('every biome hazard (if declared) is passable and distinct from the boundary-only deep id', () => {
    for (const b of Object.values(BIOMES)) {
      if (!b.hazard) { expect(b.hasHazard).toBe(false); continue; }
      expect(TERRAIN[b.hazard]).toBeDefined();
      expect(isPassable(b.hazard)).toBe(true);
      expect(b.hazard).not.toBe(b.deep);
      expect(b.hasHazard).toBe(true);
    }
  });

  // #278: grassland was the last biome with `hazard: null` — every other biome already had a
  // distinct in-map hazard tile independent of its channel. It now has its own (`mud`).
  it('grassland has its own real in-map hazard, distinct from its channel', () => {
    expect(BIOMES.grassland.hazard).toBe('mud');
    expect(BIOMES.grassland.hasHazard).toBe(true);
    expect(BIOMES.grassland.hazard).not.toBe(BIOMES.grassland.channel);
  });

  // #278: urban's `channel` previously just reused its own `hazard` id (`debris`) — the one biome
  // sharing a single terrain id across two roles. It now has a distinct channel identity (`canal`).
  it("urban's channel is a distinct id from its own hazard", () => {
    expect(BIOMES.urban.channel).toBe('canal');
    expect(BIOMES.urban.hazard).toBe('debris');
    expect(BIOMES.urban.channel).not.toBe(BIOMES.urban.hazard);
  });

  // #278: every biome's 5 core roles (groundA/groundB/channel/cover/hazard) must be 5 DISTINCT
  // terrain ids — no biome should be missing a role, and no biome should share one id across two
  // roles (the bug urban's channel/hazard had before this issue).
  it("every biome's 5 core roles (groundA/groundB/channel/cover/hazard) are 5 distinct ids", () => {
    for (const b of Object.values(BIOMES)) {
      const roles = [b.groundA, b.groundB, b.channel, b.cover, b.hazard];
      for (const id of roles) expect(id, `${b.id} missing a role`).toBeTruthy();
      expect(new Set(roles).size, `${b.id} roles: ${roles.join(', ')}`).toBe(roles.length);
    }
  });

  it('every biome declares generation knobs', () => {
    for (const b of Object.values(BIOMES)) {
      expect(typeof b.coverClusters).toBe('number');
      expect(typeof b.hasChannel).toBe('boolean');
      expect(typeof b.hasHazard).toBe('boolean');
    }
  });

  // #275: a biome no longer declares an `outpost` role (or a per-biome outpost count) at all —
  // the destructible outpost terrain types were removed, and alert towers no longer anchor to
  // any outpost concept (data/worldgen.js `placeGapTowers`), so this asserts both fields are
  // genuinely gone rather than silently unused.
  it('biomes no longer declare an outpost role or a per-biome outpost count', () => {
    for (const b of Object.values(BIOMES)) {
      expect(b.outpost).toBeUndefined();
      expect(b.outposts).toBeUndefined();
    }
  });

  it('getBiome falls back to the default for an unknown id', () => {
    expect(getBiome('desert')).toBe(BIOMES.desert);
    expect(getBiome('nope')).toBe(BIOMES[DEFAULT_BIOME]);
    expect(getBiome(undefined)).toBe(BIOMES[DEFAULT_BIOME]);
    expect(DEFAULT_BIOME).toBe('grassland');
  });
});

// #217: biome selection — first deploy is uniform random, later deploys de-emphasize recently
// seen biomes but never make one impossible.
describe('pickNextBiome (#217)', () => {
  // Deterministic sequence rng for exact-branch assertions.
  const seqRng = (vals) => {
    let i = 0;
    return () => vals[i++ % vals.length];
  };

  it('with no history, picks uniformly across the full BIOME_IDS range (no fixed first biome)', () => {
    // rng() * BIOME_IDS.length -> floor picks index i for rng in [i/N, (i+1)/N).
    const n = BIOME_IDS.length;
    for (let i = 0; i < n; i++) {
      const r = (i + 0.5) / n;
      expect(pickNextBiome([], seqRng([r]))).toBe(BIOME_IDS[i]);
    }
    // Also sanity-check with the real RNG that every id is reachable over many draws.
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(pickNextBiome([], Math.random));
    expect(seen.size).toBe(n);
  });

  it('empty history is also used any time the caller has no prior picks (not just deploy 0)', () => {
    expect(BIOME_IDS.includes(pickNextBiome(undefined, () => 0.999))).toBe(true);
  });

  it('a biome picked last deploy has its weight heavily reduced vs. one unseen', () => {
    const justPicked = BIOME_IDS[0];
    const neverSeen = BIOME_IDS[1];
    const history = [justPicked];
    // Run many draws with real randomness and count how often each comes up.
    let justPickedCount = 0;
    let neverSeenCount = 0;
    const trials = 4000;
    for (let i = 0; i < trials; i++) {
      const pick = pickNextBiome(history, Math.random);
      if (pick === justPicked) justPickedCount++;
      if (pick === neverSeen) neverSeenCount++;
    }
    expect(neverSeenCount).toBeGreaterThan(justPickedCount * 2);
  });

  it('recency de-emphasis fades out after RECENCY_WINDOW deploys', () => {
    const id = BIOME_IDS[0];
    // Picked RECENCY_WINDOW deploys ago (falls outside the tracked window) -> full weight,
    // same odds as never seen. Build a history where every OTHER slot is filled with a
    // different biome so `id` only shows up once, at the front.
    const filler = BIOME_IDS[1];
    const staleHistory = [id, ...Array(RECENCY_WINDOW).fill(filler)];
    const freshHistory = [filler, ...Array(RECENCY_WINDOW - 1).fill(filler), id];
    let staleCount = 0;
    let freshCount = 0;
    const trials = 4000;
    for (let i = 0; i < trials; i++) {
      if (pickNextBiome(staleHistory, Math.random) === id) staleCount++;
      if (pickNextBiome(freshHistory, Math.random) === id) freshCount++;
    }
    // The stale (long-ago) pick should come up noticeably more often than the fresh (just-seen) one.
    expect(staleCount).toBeGreaterThan(freshCount * 1.5);
  });

  it('never makes any biome literally impossible to draw again, even right after it was picked', () => {
    // Worst case: every recent-window slot is the same biome.
    const history = Array(RECENCY_WINDOW).fill(BIOME_IDS[0]);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(pickNextBiome(history, Math.random));
    expect(seen.has(BIOME_IDS[0])).toBe(true);
    expect(seen.size).toBe(BIOME_IDS.length);
  });

  it('always returns a valid biome id, exercising the roll<=0 loop for every rng edge', () => {
    for (const r of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 0.9999999]) {
      expect(BIOME_IDS.includes(pickNextBiome([], () => r))).toBe(true);
      expect(BIOME_IDS.includes(pickNextBiome([BIOME_IDS[0], BIOME_IDS[1]], () => r))).toBe(true);
    }
  });
});
