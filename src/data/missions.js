// #510: mission offers presented at the base's scanner hex (MissionSelectScene). Deliberately
// thin for this first pass — there's no outpost/threat content yet (#511/#512/#513/#514 add
// that later), so the one real choice on the table today is WHICH BIOME to run, surfaced as a
// small set of distinct candidates instead of the blind auto-pick the base's scanner hex used
// before this existed. How many options to offer, and how "beating a run unlocks further runs"
// (#297) eventually gates them, are both still open — this only builds the offer/pick surface,
// not a progression curve. Phaser-free and unit-tested, like every other src/data/* module.
import { BIOME_IDS, getBiome } from './biomes.js';

export const MISSION_OFFER_COUNT = 3;

// Pure: `count` distinct biome offers, shuffled by `rng` (injected so this is deterministic
// under test). Deliberately NOT recency-weighted like `pickNextBiome` — that machinery exists
// to bias a single blind auto-pick away from repeats over many deploys; here the player sees
// and chooses between several options at once, so a plain shuffle is simpler and sufficient.
export function offerMissions(rng = Math.random, count = MISSION_OFFER_COUNT) {
  const ids = [...BIOME_IDS];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.min(count, ids.length)).map((biomeId) => ({
    id: `mission-${biomeId}`, biomeId, label: getBiome(biomeId).name,
  }));
}
