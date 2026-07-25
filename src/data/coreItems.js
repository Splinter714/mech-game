// Core-slot catalog (#496) — mountable items for the passive/always-on CORE_SLOTS (data/
// anatomy.js). Mirrors weapons.js/abilities.js's one-registry-entry-per-item shape. Shields
// used to be a fixed chassis baseline the player always got unconditionally (`PLAYER_SHIELD` in
// scenes/ArenaScene.js) — now they're an equip choice like any other item, so a build that skips
// the core slot has no shield at all and trades that survivability for something else.
// #494: Anti-Missile Defense — the second core item, competing with Shield for the same one
// slot (#496's original text: "shields are an option to equip or NOT, with other non-weapon
// alternative options" — this is that alternative). Passive/always-on like Shield: no button, no
// aim, just a standing point-defense system that shoots down nearby incoming enemy fire on its
// own cooldown while equipped. See scenes/arena/interceptor.js for the actual target-finding
// (needs the scene's live projectile list, so it can't live in this pure module) and
// data/Mech.js's canIntercept/triggerIntercept/tickInterceptorCooldown for the cooldown gate.
export const CORE_ITEMS = {
  shield: { name: 'Shield', max: 100 },
  antiMissile: { name: 'Anti-Missile Defense', range: 220, cooldown: 2.5 },
};

export function getCoreItem(id) {
  return CORE_ITEMS[id];
}

export function isCoreItem(id) {
  return id in CORE_ITEMS;
}

// Resolve a mech's core-slot choice into the `{ max }` shape Mech.configureShield expects. No
// core item mounted (or an unknown/stale one, e.g. from an old save) resolves to no shield at
// all rather than a fallback default — an empty core slot is a legal, deliberate build choice.
export function shieldConfigFor(coreMounts) {
  const id = coreMounts?.core;
  const item = id && getCoreItem(id);
  return { max: item?.max ?? 0 };
}
