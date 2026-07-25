// Unified item lookup — #188 removed the old equipment.js (ability) catalog, leaving this a
// thin wrapper over WEAPONS alone for a long stretch. #506/#496 brought mountable non-weapon
// items back (ABILITY_SLOTS/CORE_SLOTS, data/abilities.js/data/coreItems.js), so this merges
// all three catalogs again — kept as its own module so the Mech model / loadout validator /
// UI code don't need to care which catalog an id came from.

import { WEAPONS } from './weapons.js';
import { ABILITIES } from './abilities.js';
import { CORE_ITEMS } from './coreItems.js';

export const ALL_ITEMS = { ...WEAPONS, ...ABILITIES, ...CORE_ITEMS };

export function getItem(id) {
  return ALL_ITEMS[id];
}

// A weapon is any item that came from the weapon catalog (has a `category` + delivery).
export function isWeapon(id) {
  return id in WEAPONS;
}

// #506 3-way UI branch (skillTiles/weaponCardList): which catalog an id came from, so callers
// don't each re-derive it from WEAPONS/ABILITIES/CORE_ITEMS membership.
export function isAbility(id) {
  return id in ABILITIES;
}

export function isCoreItem(id) {
  return id in CORE_ITEMS;
}
