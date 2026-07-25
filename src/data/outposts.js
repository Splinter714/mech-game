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
