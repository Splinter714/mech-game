// #511/#512: claimable outposts — the "existence + status only" record from the #297 design
// conversation: what a held outpost IS (type, upgrade level, threat state), never a snapshot of
// the world around it. Pure claim/upgrade/lose transitions; persistence lives in save.js
// (OUTPOSTS_STORAGE_KEY), same load/save-pair pattern as unlocked weapons.
//
// Deliberately thin: resource-income and repair-range-extension MECHANICS (what an outpost
// actually DOES once held) are still open design questions per #297 — this only builds the
// claim/persist plumbing a later stage hangs real effects off of. The outpost-threat system
// (#509 Stage 5) is what ever moves `threatState` off 'safe'.

export const OUTPOST_TYPES = ['resource', 'repair'];
export const MAX_UPGRADE_LEVEL = 2;

// A freshly claimed outpost. `id` must be caller-supplied and stable (a base cleared in a given
// biome/run, not a reusable slot) — claiming an id that's already held is a no-op, not a
// re-claim, so callers don't need to check first.
//
// #517/#518/#519: `baseId` (optional) is the WORLDGEN base index this claim is for
// (`data/worldgen.js` base ids — `"base0"`, `"base1"`, …). Terrain regenerates from a fresh
// random seed every deploy, so a base's absolute `coord` is never stable across sorties — its
// INDEX along the corridor is the only thing that survives regeneration, and that's what
// `data/baseCapture.js`/`data/regionalBases.js` match a claim back against at the next deploy.
// `coord` is kept as-is (still just the informational snapshot #511/#512 always saved).
export function claimOutpost(outposts, { id, type, coord, biomeId, baseId = null }) {
  if (outposts.some((o) => o.id === id)) return outposts;
  return [
    ...outposts,
    // #512/#511: `repairBuilt`/`resourceBuilt` start false on every fresh claim — a claimed base
    // is just held, it doesn't get either building's function until the player opts in and
    // spends scrap on it (data/repairOutposts.js `buildRepairOutpost`, data/resourceOutposts.js
    // `buildResourceOutpost`). Both flags live on the SAME record and are independent — a base can
    // hold neither, either, or both buildings at once; there's deliberately no generic "buildings"
    // list/framework here, just one flag per concrete building type, per the issues' own framing.
    // Always present (never omitted) so callers can rely on the field rather than checking for
    // `undefined`, same convention as baseCapture.js's `captured` flag.
    {
      id,
      type,
      coord,
      biomeId,
      baseId,
      upgradeLevel: 0,
      threatState: 'safe',
      deploysHeld: 0,
      repairBuilt: false,
      resourceBuilt: false,
    },
  ];
}

// #511/#512: the shared claimed-base lookup — matched by (biomeId, baseId), the stable
// cross-deploy identity data/baseCapture.js's `capturedBaseIdsFor` already keys off, NOT the
// outpost's own `id` field (which embeds the deploy count it was claimed on — see `claimOutpost`
// above — so it isn't a lookup key across deploys/visits). Both repairOutposts.js and
// resourceOutposts.js build their per-building queries on top of this ONE lookup rather than each
// keeping their own copy, so the two building types can't drift on how a "held base" is found.
export function outpostForBase(outposts, biomeId, baseId) {
  return (outposts ?? []).find((o) => o.biomeId === biomeId && o.baseId === baseId) ?? null;
}

export function upgradeOutpost(outposts, id, maxLevel = MAX_UPGRADE_LEVEL) {
  return outposts.map((o) => (o.id === id ? { ...o, upgradeLevel: Math.min(maxLevel, o.upgradeLevel + 1) } : o));
}

// A lost outpost simply reverts to unclaimed — per the #297 design conversation, identity
// doesn't need to survive a loss (upgrades don't either), so retaking it later is just
// claimOutpost() again, not a distinct "recapture" transition.
export function loseOutpost(outposts, id) {
  return outposts.filter((o) => o.id !== id);
}

export function outpostsByType(outposts, type) {
  return outposts.filter((o) => o.type === type);
}

// #509 Stage 5: outpost threat. Rolled each time the base's mission-select surface opens
// (MissionSelectScene) — a random chance per SAFE outpost flips it to 'attacked'. `rate` is an
// explicit param, not a baked-in constant, so the actual odds stay tunable — they're an open
// design question per #297, not decided here. An already-'attacked' outpost is left alone (no
// re-roll) so repeated visits without resolving it can't flicker it back to safe.
const DEFAULT_THREAT_ROLL_RATE = 0.15;

export function rollOutpostThreat(outposts, rng = Math.random, rate = DEFAULT_THREAT_ROLL_RATE) {
  return outposts.map((o) => (o.threatState === 'safe' && rng() < rate ? { ...o, threatState: 'attacked' } : o));
}

// #509 Stage 5: the instant loss check for an outpost the player did NOT deploy to defend. The
// formula here — a flat base chance reduced per upgrade level — is a clearly-tunable
// PLACEHOLDER, not a design decision (the real formula, and what exactly counts as "defending,"
// are both still open per #297). Survives → reverts to 'safe'; loses → reverts to unclaimed
// (loseOutpost) exactly like any other loss.
const BASE_LOSS_CHANCE = 0.5;
const LOSS_CHANCE_REDUCTION_PER_LEVEL = 0.15;

export function resolveUndefendedLoss(outposts, id, rng = Math.random) {
  const target = outposts.find((o) => o.id === id);
  if (!target || target.threatState !== 'attacked') return outposts;
  const lossChance = Math.max(0, BASE_LOSS_CHANCE - target.upgradeLevel * LOSS_CHANCE_REDUCTION_PER_LEVEL);
  if (rng() < lossChance) return loseOutpost(outposts, id);
  return outposts.map((o) => (o.id === id ? { ...o, threatState: 'safe' } : o));
}

// Resolve every currently-attacked outpost at once — called when the player commits to a
// mission (launchMission.js) without it being a defense of that specific outpost, since there
// is no dedicated "defend" mission type yet (#510 follow-up work).
export function resolveAllUndefendedLosses(outposts, rng = Math.random) {
  return outposts
    .filter((o) => o.threatState === 'attacked')
    .reduce((acc, o) => resolveUndefendedLoss(acc, o.id, rng), outposts);
}

// ── #519: REGARRISON — a claimed base/regional base can be retaken by escalating PERCENTAGE
// CHANCE PER DEPLOYMENT rather than real time. No timestamps, no wall-clock: a base just tracks
// how many deployments it has survived since it was last captured/reset (`deploysHeld`), and each
// deployment that touches it rolls `chance = min(cap, base + step * deploysHeld)` — locked
// constants, owner-confirmed: base 15%, step 15%/deploy, cap 90%.
export const REGARRISON_BASE_CHANCE = 0.15;
export const REGARRISON_STEP_CHANCE = 0.15;
export const REGARRISON_CAP_CHANCE = 0.90;

export function regarrisonChance(deploysHeld = 0) {
  return Math.min(REGARRISON_CAP_CHANCE, REGARRISON_BASE_CHANCE + REGARRISON_STEP_CHANCE * deploysHeld);
}

// One base's roll for one deployment that touches it. On success: revert the claim — the same
// "identity doesn't survive a loss" transition `loseOutpost` already models (drops
// threatState/upgradeLevel/deploysHeld along with the whole record), so the player has to reclear
// and re-establish it, exactly like any other lost outpost. On failure: the base holds, and its
// counter increments — raising the odds for NEXT time. Unknown id is a no-op (mirrors every other
// single-outpost transition in this file).
export function rollRegarrison(outposts, id, rng = Math.random) {
  const target = outposts.find((o) => o.id === id);
  if (!target) return outposts;
  const chance = regarrisonChance(target.deploysHeld ?? 0);
  if (rng() < chance) return loseOutpost(outposts, id);
  return outposts.map((o) => (o.id === id ? { ...o, deploysHeld: (o.deploysHeld ?? 0) + 1 } : o));
}

// Roll regarrison for every currently-claimed base in the biome about to be deployed into — "each
// deployment that touches that base" (#519) is every base whose corridor is about to be rebuilt
// for this sortie, i.e. every claimed base sharing this `biomeId`. Bases in OTHER biomes are
// untouched (a deployment into grassland can't threaten a desert claim). Mirrors
// `resolveAllUndefendedLosses`'s "resolve every affected record in one pass" shape.
export function rollRegarrisonForBiome(outposts, biomeId, rng = Math.random) {
  return outposts
    .filter((o) => o.biomeId === biomeId)
    .reduce((acc, o) => rollRegarrison(acc, o.id, rng), outposts);
}
