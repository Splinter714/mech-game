// Pure loadout validation + derived build stats. No Phaser, no Mech instance — these
// operate on a chassis def + a plain `mounts` map (location id → array of item ids),
// so they're trivially unit-tested and reused by both the Mech model and the garage
// UI. The two hard constraints are slot capacity per location and the chassis tonnage
// budget; hardpoint typing is intentionally permissive in Milestone 1.

import { getItem } from './items.js';
import { LOCATION_INFO } from './anatomy.js';

export function itemSlots(id) {
  return getItem(id)?.slots ?? 0;
}

export function itemTonnage(id) {
  return getItem(id)?.tonnage ?? 0;
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

export function totalTonnage(mounts) {
  let t = 0;
  for (const loc of Object.keys(mounts)) {
    for (const id of mounts[loc]) t += itemTonnage(id);
  }
  return t;
}

export function freeTonnage(chassis, mounts) {
  return chassis.maxTonnage - totalTonnage(mounts);
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
  if (itemTonnage(itemId) > freeTonnage(chassis, mounts)) {
    return { ok: false, reason: 'over tonnage' };
  }
  return { ok: true };
}

// Validate a whole build. Returns ok + a list of human-readable errors + derived
// numbers the garage shows (used/free tonnage and per-location slot usage).
export function validateLoadout(chassis, mounts) {
  const errors = [];
  const usedTonnage = totalTonnage(mounts);
  if (usedTonnage > chassis.maxTonnage) {
    errors.push(`over tonnage: ${usedTonnage}/${chassis.maxTonnage}t`);
  }
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
    usedTonnage,
    freeTonnage: chassis.maxTonnage - usedTonnage,
    slotUsage,
  };
}
