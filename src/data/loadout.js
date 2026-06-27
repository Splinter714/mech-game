// Pure loadout validation + derived build stats. No Phaser, no Mech instance — these
// operate on a chassis def + a plain `mounts` map (location id → array of item ids),
// so they're trivially unit-tested and reused by both the Mech model and the garage
// UI. The single hard constraint is slot capacity per location; tonnage was removed in
// favour of slot-only balancing, and hardpoint typing is intentionally permissive.

import { getItem } from './items.js';
import { LOCATION_INFO } from './anatomy.js';

export function itemSlots(id) {
  return getItem(id)?.slots ?? 0;
}

export function usedSlots(mounts, locationId) {
  return (mounts[locationId] ?? []).reduce((sum, id) => sum + itemSlots(id), 0);
}

export function slotCapacity(chassis, locationId) {
  return chassis.locations[locationId]?.slots ?? 0;
}

export function freeSlots(chassis, mounts, locationId) {
  return slotCapacity(chassis, locationId) - usedSlots(mounts, locationId);
}

// Can `itemId` be mounted in `locationId` given the current build? Returns
// { ok, reason } so the UI can explain a blocked mount.
export function canMount(chassis, mounts, locationId, itemId) {
  const item = getItem(itemId);
  if (!item) return { ok: false, reason: 'unknown item' };
  const info = LOCATION_INFO[locationId];
  if (!info || !info.mountable) return { ok: false, reason: 'not a mount point' };
  if (itemSlots(itemId) > freeSlots(chassis, mounts, locationId)) {
    return { ok: false, reason: 'not enough slots' };
  }
  return { ok: true };
}

// Validate a whole build. Returns ok + a list of human-readable errors + the
// per-location slot usage the garage shows.
export function validateLoadout(chassis, mounts) {
  const errors = [];
  const slotUsage = {};
  for (const loc of Object.keys(chassis.locations)) {
    const used = usedSlots(mounts, loc);
    const cap = slotCapacity(chassis, loc);
    slotUsage[loc] = { used, cap };
    if (used > cap) errors.push(`${loc} slots ${used}/${cap}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    slotUsage,
  };
}
