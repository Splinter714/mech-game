// Unified item lookup — #188: this used to merge weapons + equipment (abilities), but
// equipment.js was removed (jumpJet/bubbleShield replaced by a hardcoded L3/Space built-in —
// Sprint under #188, the Dash in data/dash.js since #261). Every mountable item is a weapon
// now, so this is just a thin wrapper
// over WEAPONS; kept as its own module so the Mech model / loadout validator / garage UI
// don't need to care which catalog an id came from if that ever changes again.

import { WEAPONS } from './weapons.js';

export const ALL_ITEMS = { ...WEAPONS };

export function getItem(id) {
  return ALL_ITEMS[id];
}

// A weapon is any item that came from the weapon catalog (has a `category` + delivery).
export function isWeapon(id) {
  return id in WEAPONS;
}
