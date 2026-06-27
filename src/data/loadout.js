// Pure loadout validation + derived build stats. No Phaser, no Mech instance — these
// operate on a chassis def + a plain `mounts` map (location id → array of item ids),
// so they're trivially unit-tested and reused by both the Mech model and the garage UI.
//
// The build model is six skill slots: each mountable location holds at most ONE item
// (a weapon or an ability), bound to a fixed fire button. Melee weapons only fit the
// arms. There is no tonnage and no multi-slot capacity — a location is simply full or
// empty.

import { getItem, isWeapon } from './items.js';
import { LOCATION_INFO, MELEE_LOCATIONS } from './anatomy.js';

// Each mountable location is a single skill slot.
export const SLOTS_PER_LOCATION = 1;

export function usedSlots(mounts, locationId) {
  return (mounts[locationId] ?? []).length;
}

export function slotCapacity(chassis, locationId) {
  return LOCATION_INFO[locationId]?.mountable ? SLOTS_PER_LOCATION : 0;
}

export function freeSlots(chassis, mounts, locationId) {
  return slotCapacity(chassis, locationId) - usedSlots(mounts, locationId);
}

export function isMelee(itemId) {
  return getItem(itemId)?.category === 'melee';
}

// Can `itemId` be mounted in `locationId` given the current build? Returns
// { ok, reason } so the UI can explain a blocked mount.
export function canMount(chassis, mounts, locationId, itemId) {
  const item = getItem(itemId);
  if (!item) return { ok: false, reason: 'unknown item' };
  const info = LOCATION_INFO[locationId];
  if (!info || !info.mountable) return { ok: false, reason: 'not a skill slot' };
  if (usedSlots(mounts, locationId) >= SLOTS_PER_LOCATION) {
    return { ok: false, reason: 'slot occupied' };
  }
  if (isMelee(itemId) && !MELEE_LOCATIONS.includes(locationId)) {
    return { ok: false, reason: 'melee only in arms' };
  }
  return { ok: true };
}

// Validate a whole build. Returns ok + a list of human-readable errors + the
// per-location slot usage the garage shows.
export function validateLoadout(chassis, mounts) {
  const errors = [];
  const slotUsage = {};
  for (const loc of Object.keys(LOCATION_INFO)) {
    if (!LOCATION_INFO[loc].mountable) continue;
    const used = usedSlots(mounts, loc);
    slotUsage[loc] = { used, cap: SLOTS_PER_LOCATION };
    if (used > SLOTS_PER_LOCATION) errors.push(`${loc} overfilled (${used})`);
    for (const id of mounts[loc] ?? []) {
      if (isMelee(id) && !MELEE_LOCATIONS.includes(loc)) errors.push(`${id} (melee) must be in an arm`);
    }
  }
  return { ok: errors.length === 0, errors, slotUsage };
}

// Total weapons mounted (skills can also be non-weapon abilities later).
export function weaponCount(mounts) {
  let n = 0;
  for (const loc of Object.keys(mounts)) {
    for (const id of mounts[loc] ?? []) if (isWeapon(id)) n++;
  }
  return n;
}
