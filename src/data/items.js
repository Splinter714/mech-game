// Unified item lookup — #188 removed the old equipment.js (ability) catalog, leaving this a
// thin wrapper over WEAPONS alone for a long stretch. #506 brought mountable non-weapon items
// back (ABILITY_SLOTS, data/abilities.js), so this merges both catalogs — kept as its own module
// so the Mech model / loadout validator / UI code don't need to care which catalog an id came
// from. #496 briefly added a third passive/core catalog (data/coreItems.js) for Shield/
// Anti-Missile Defense; that's gone — shield is now an unconditional baseline every mech gets
// with no equip choice, and AMS moved into the ability system, so there are only two catalogs
// again.

import { WEAPONS } from './weapons.js';
import { ABILITIES } from './abilities.js';

export const ALL_ITEMS = { ...WEAPONS, ...ABILITIES };

export function getItem(id) {
  return ALL_ITEMS[id];
}

// A weapon is any item that came from the weapon catalog (has a `category` + delivery).
export function isWeapon(id) {
  return id in WEAPONS;
}

// #506 UI branch (skillTiles/weaponCardList): which catalog an id came from, so callers don't
// each re-derive it from WEAPONS/ABILITIES membership.
export function isAbility(id) {
  return id in ABILITIES;
}
