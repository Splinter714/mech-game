// #517: the REGIONAL BASE per biome — a separate, lighter record from the claimed-outpost list
// (data/outposts.js). The first base a player chooses to establish in a biome becomes that
// biome's regional base; every later established base in the same biome is an ordinary outpost
// (data/outposts.js already models THAT half). This file only tracks the single pointer worldgen
// reads to decide where a redeploy into an already-visited biome should start — "biomeId →
// regional base coord/established", per the issue.
//
// Same array-of-plain-objects + pure-transition shape as outposts.js, persisted alongside it
// (save.js) but deliberately its own record: an outpost can be lost and reclaimed (#519
// regarrison) without ever touching whether it was ever anyone's regional base. `baseId` is the
// worldgen base index ("base0", "base1", …) — see outposts.js's `claimOutpost` comment for why
// that, not `coord`, is the stable cross-deploy identity. `coord` is kept as an informational
// snapshot only, same convention as outposts.js.
//
// #517 follow-up: playtest overturned the original design decision above (kept here for
// history) — losing the regional base to #519 regarrison now CLEARS this pointer for the
// biome (`clearRegionalBase` below), so the next deploy falls back to the ordinary drop-pod/
// staging spawn (world.js's existing "no regional base yet" path) instead of dropping the
// player at a gate that's hostile again. Called from launchMission.js right after a regarrison
// roll reverts a base that happens to be the biome's current regional base.

// The first established base in a biome wins; a later `establishRegionalBase` call for a biome
// that already has one is a no-op (mirrors `claimOutpost`'s "claiming an already-held id" no-op).
export function establishRegionalBase(regionalBases, { biomeId, baseId, coord }) {
  if (regionalBases.some((r) => r.biomeId === biomeId)) return regionalBases;
  return [...regionalBases, { biomeId, baseId, coord }];
}

export function regionalBaseFor(regionalBases, biomeId) {
  return regionalBases.find((r) => r.biomeId === biomeId) ?? null;
}

// #517 follow-up: drop the biome's regional-base pointer entirely — used when that base is lost
// (regarrison, or any future loss path), so the biome reads as "no regional base yet" again and
// worldgen falls back to the generic drop-pod/staging spawn. A biome with no pointer is a no-op,
// same convention as loseOutpost() on an unknown id.
export function clearRegionalBase(regionalBases, biomeId) {
  return regionalBases.filter((r) => r.biomeId !== biomeId);
}
