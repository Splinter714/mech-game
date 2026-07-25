import { describe, it, expect } from 'vitest';
import { BIOME_IDS, getBiome } from './biomes.js';
import { offerMissions, MISSION_OFFER_COUNT } from './missions.js';

describe('#510 offerMissions', () => {
  it('offers MISSION_OFFER_COUNT distinct, real biome ids by default', () => {
    const offers = offerMissions(() => 0.5);
    expect(offers).toHaveLength(MISSION_OFFER_COUNT);
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

  it('clamps count to the number of available biomes', () => {
    const offers = offerMissions(() => 0.5, BIOME_IDS.length + 10);
    expect(offers).toHaveLength(BIOME_IDS.length);
  });
});
