// #510: mission offers presented at the base's scanner hex (MissionSelectScene) — a small set
// of distinct biome candidates the player picks from, instead of the blind auto-pick the base's
// scanner hex used before this existed. How many options to offer, and how "beating a run
// unlocks further runs" (#297) eventually gates them beyond biome access (#514), are both still
// open — this only builds the offer/pick surface, not a progression curve. Phaser-free and
// unit-tested, like every other src/data/* module.
import { BIOME_IDS, getBiome } from './biomes.js';

export const MISSION_OFFER_COUNT = 3;

// #514: biomes unlock in BIOME_IDS declaration order (grassland, desert, arctic, urban,
// volcanic) — the first is always available; each later one unlocks once the PREVIOUS biome's
// "deep mission" has been won. How many biomes ought to gate this way, and what a deep mission
// composes beyond "the harder run for this biome," are still open — this is deliberately the
// simplest possible gate (a count), not a real unlock graph.
export function unlockedBiomes(deepMissionsWon = 0) {
  const n = Math.max(1, Math.min(BIOME_IDS.length, deepMissionsWon + 1));
  return BIOME_IDS.slice(0, n);
}

// The current FRONTIER biome — the next one to unlock, whose deep mission hasn't been won yet.
// Only the frontier ever offers a deep mission; every biome already unlocked behind it only
// offers ordinary explore runs. Every biome is unlocked once deepMissionsWon reaches the end of
// BIOME_IDS, so there is no frontier left to gate.
export function isFrontierBiome(biomeId, deepMissionsWon = 0) {
  if (deepMissionsWon >= BIOME_IDS.length - 1) return false;
  const unlocked = unlockedBiomes(deepMissionsWon);
  return biomeId === unlocked[unlocked.length - 1];
}

// Pure: `count` distinct offers drawn from whichever biomes are unlocked, shuffled by `rng`
// (injected so this is deterministic under test). Deliberately NOT recency-weighted like
// `pickNextBiome` — that machinery exists to bias a single blind auto-pick away from repeats
// over many deploys; here the player sees and chooses between several options at once, so a
// plain shuffle is simpler and sufficient. The frontier biome's offer (if present in this
// batch) is flagged `isDeep` — winning it is what unlocks the next biome.
export function offerMissions(rng = Math.random, count = MISSION_OFFER_COUNT, deepMissionsWon = 0) {
  const ids = unlockedBiomes(deepMissionsWon);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.min(count, ids.length)).map((biomeId) => ({
    id: `mission-${biomeId}`, biomeId, label: getBiome(biomeId).name,
    isDeep: isFrontierBiome(biomeId, deepMissionsWon),
  }));
}
