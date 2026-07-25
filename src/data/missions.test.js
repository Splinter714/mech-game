import { describe, it, expect } from 'vitest';
import { BIOME_IDS, getBiome } from './biomes.js';
import {
  offerMissions, unlockedBiomes, isFrontierBiome, gatedBiomeCount, UNLOCK_ALL_BIOMES,
  MISSION_OFFER_COUNT,
} from './missions.js';

describe('#510 offerMissions', () => {
  it('offers MISSION_OFFER_COUNT distinct, real biome ids by default', () => {
    const offers = offerMissions(() => 0.5);
    expect(offers).toHaveLength(Math.min(MISSION_OFFER_COUNT, BIOME_IDS.length));
    const biomeIds = offers.map((o) => o.biomeId);
    expect(new Set(biomeIds).size).toBe(biomeIds.length);   // no duplicates
    for (const id of biomeIds) expect(BIOME_IDS).toContain(id);
  });

  it('each offer carries a stable id and the biome\'s display name', () => {
    const offers = offerMissions(() => 0);
    for (const o of offers) {
      expect(o.id).toBe(`mission-${o.biomeId}`);
      expect(o.label).toBe(getBiome(o.biomeId).name);
    }
  });

  it('is deterministic for a fixed rng — same sequence in, same offers out', () => {
    const seq = [0.1, 0.6, 0.3, 0.9, 0.2];
    let i = 0;
    const rng = () => seq[i++ % seq.length];
    let j = 0;
    const rng2 = () => seq[j++ % seq.length];
    expect(offerMissions(rng)).toEqual(offerMissions(rng2));
  });

  it('clamps count to the number of unlocked biomes', () => {
    const offers = offerMissions(() => 0.5, BIOME_IDS.length + 10);
    expect(offers).toHaveLength(unlockedBiomes().length);
  });
});

// #514 TEMPORARY: every biome is unlocked from the start (UNLOCK_ALL_BIOMES) while development
// wants to see them all — these tests document THAT current behavior so flipping the flag back
// off is an obvious, visible break here, not a silent drift. The real gate math underneath is
// tested separately below via `gatedBiomeCount`, independent of the override.
describe('#514 UNLOCK_ALL_BIOMES override (temporary, mirrors shop.js UNLOCK_ALL)', () => {
  it('is currently on', () => {
    expect(UNLOCK_ALL_BIOMES).toBe(true);
  });

  it('unlockedBiomes ignores deepMissionsWon entirely while the override is on', () => {
    expect(unlockedBiomes(0)).toEqual(BIOME_IDS);
    expect(unlockedBiomes(999)).toEqual(BIOME_IDS);
  });

  it('isFrontierBiome never flags anything while the override is on', () => {
    for (const id of BIOME_IDS) expect(isFrontierBiome(id, 0)).toBe(false);
  });
});

describe('#514 gatedBiomeCount — the real gate math, independent of UNLOCK_ALL_BIOMES', () => {
  it('only the first biome is available with no deep missions won', () => {
    expect(gatedBiomeCount(0)).toBe(1);
  });

  it('each deep-mission win unlocks exactly one more biome, in order', () => {
    for (let n = 0; n < BIOME_IDS.length; n++) expect(gatedBiomeCount(n)).toBe(n + 1);
  });

  it('never exceeds every biome, however high the count', () => {
    expect(gatedBiomeCount(999)).toBe(BIOME_IDS.length);
  });
});
