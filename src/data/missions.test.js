import { describe, it, expect } from 'vitest';
import { BIOME_IDS, getBiome } from './biomes.js';
import { offerMissions, unlockedBiomes, isFrontierBiome, MISSION_OFFER_COUNT } from './missions.js';

const ALL_UNLOCKED = BIOME_IDS.length - 1;   // deepMissionsWon needed to unlock every biome

describe('#510 offerMissions (all biomes unlocked)', () => {
  it('offers MISSION_OFFER_COUNT distinct, real biome ids by default', () => {
    const offers = offerMissions(() => 0.5, MISSION_OFFER_COUNT, ALL_UNLOCKED);
    expect(offers).toHaveLength(MISSION_OFFER_COUNT);
    const biomeIds = offers.map((o) => o.biomeId);
    expect(new Set(biomeIds).size).toBe(biomeIds.length);   // no duplicates
    for (const id of biomeIds) expect(BIOME_IDS).toContain(id);
  });

  it('each offer carries a stable id and the biome\'s display name', () => {
    const offers = offerMissions(() => 0, MISSION_OFFER_COUNT, ALL_UNLOCKED);
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
    expect(offerMissions(rng, MISSION_OFFER_COUNT, ALL_UNLOCKED)).toEqual(offerMissions(rng2, MISSION_OFFER_COUNT, ALL_UNLOCKED));
  });

  it('clamps count to the number of available biomes', () => {
    const offers = offerMissions(() => 0.5, BIOME_IDS.length + 10, ALL_UNLOCKED);
    expect(offers).toHaveLength(BIOME_IDS.length);
  });

  it('once every biome is unlocked, no offer is flagged deep', () => {
    const offers = offerMissions(() => 0.5, MISSION_OFFER_COUNT, ALL_UNLOCKED);
    expect(offers.every((o) => !o.isDeep)).toBe(true);
  });
});

describe('#514 biome gating', () => {
  it('unlockedBiomes: only the first biome is available with no deep missions won', () => {
    expect(unlockedBiomes(0)).toEqual([BIOME_IDS[0]]);
  });

  it('unlockedBiomes: each deep-mission win unlocks exactly one more biome, in order', () => {
    for (let n = 0; n < BIOME_IDS.length; n++) {
      expect(unlockedBiomes(n)).toEqual(BIOME_IDS.slice(0, n + 1));
    }
  });

  it('unlockedBiomes: never exceeds every biome, however high the count', () => {
    expect(unlockedBiomes(999)).toEqual(BIOME_IDS);
  });

  it('isFrontierBiome: the last unlocked biome is the frontier, everything else is not', () => {
    expect(isFrontierBiome(BIOME_IDS[0], 0)).toBe(true);
    expect(isFrontierBiome(BIOME_IDS[1], 1)).toBe(true);
    expect(isFrontierBiome(BIOME_IDS[0], 1)).toBe(false);   // already cleared, behind the frontier
  });

  it('isFrontierBiome: nothing is the frontier once every biome is unlocked', () => {
    for (const id of BIOME_IDS) expect(isFrontierBiome(id, ALL_UNLOCKED)).toBe(false);
  });

  it('offerMissions only ever offers unlocked biomes', () => {
    const offers = offerMissions(() => 0.5, MISSION_OFFER_COUNT, 0);
    expect(offers).toHaveLength(1);
    expect(offers[0].biomeId).toBe(BIOME_IDS[0]);
  });

  it('the frontier biome\'s offer is flagged isDeep; nothing else is', () => {
    const offers = offerMissions(() => 0.5, MISSION_OFFER_COUNT, 1);   // 2 biomes unlocked
    expect(offers).toHaveLength(2);
    const frontier = offers.find((o) => o.biomeId === BIOME_IDS[1]);
    const cleared = offers.find((o) => o.biomeId === BIOME_IDS[0]);
    expect(frontier.isDeep).toBe(true);
    expect(cleared.isDeep).toBe(false);
  });
});
