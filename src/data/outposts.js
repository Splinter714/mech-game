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
export function claimOutpost(outposts, { id, type, coord, biomeId }) {
  if (outposts.some((o) => o.id === id)) return outposts;
  return [...outposts, { id, type, coord, biomeId, upgradeLevel: 0, threatState: 'safe' }];
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
