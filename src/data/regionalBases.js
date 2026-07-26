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
// DESIGN DECISION (surfaced, not assumed): once set, a biome's regional-base pointer is NOT
// cleared if that base is later lost to #519 regarrison. A redeploy still spawns at ITS gate —
// the player arrives to find their forward base overrun and has to retake it, rather than falling
// back to the drop-pod treatment. The issue text doesn't cover this interaction; this is the
// simplest rule that keeps worldgen deterministic without adding a second "was this ever
// established" flag, and it reads as a real narrative beat rather than a special case.

// The first established base in a biome wins; a later `establishRegionalBase` call for a biome
// that already has one is a no-op (mirrors `claimOutpost`'s "claiming an already-held id" no-op).
export function establishRegionalBase(regionalBases, { biomeId, baseId, coord }) {
  if (regionalBases.some((r) => r.biomeId === biomeId)) return regionalBases;
  return [...regionalBases, { biomeId, baseId, coord }];
}

export function regionalBaseFor(regionalBases, biomeId) {
  return regionalBases.find((r) => r.biomeId === biomeId) ?? null;
}
