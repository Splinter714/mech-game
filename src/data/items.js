// Unified item lookup over weapons + equipment. Both kinds share `id`, `slots`, and
// `tonnage`, so the Mech model, the loadout validator, and the garage UI can resolve
// any mounted item by id without caring which catalog it came from.

import { WEAPONS } from './weapons.js';
import { EQUIPMENT } from './equipment.js';

export const ALL_ITEMS = { ...EQUIPMENT, ...WEAPONS };

export function getItem(id) {
  return ALL_ITEMS[id];
}

// A weapon is any item that came from the weapon catalog (has a `category` + delivery).
export function isWeapon(id) {
  return id in WEAPONS;
}
