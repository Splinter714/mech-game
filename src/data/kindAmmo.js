// #375: AMMO for non-mech (vehicle-path) enemy kinds — the second limiter on top of cadence
// (#241/#243) and trigger discipline (#243 `burstShots`/`burstRestMs`).
//
// Background. #372's ammo pass found that `turret` and `wallTurret` carried `ammoMax`/`ammoRegen`
// inside their `weaponOverride` blocks — wallTurret's with a comment explicitly describing volume
// TAPERING over a long fight — but the vehicle fire path (`_fireVehicleWeapon`) never called
// `consumeAmmo` at all. Mech-kind enemies (enemies.js scout/brawler/sniper/artillery) genuinely
// consume and regen; vehicle kinds were pure cadence. So the data was inert and the comments were
// fiction. The owner chose to make it real rather than delete it: "Make it real — turrets run dry
// too."
//
// What it buys: YOU CAN SUPPRESS A WALL BY MAKING IT SHOOT. Draw the fire, break contact, and the
// emplacement is measurably quieter for a while. That is a tactical lever the game did not have.
//
// SCOPE — emplaced kinds ONLY, and by explicit OPT-IN. The vehicle path also covers tank, drone,
// helicopter, carrier and infantry; making all of them ammo-limited would be a large unrequested
// combat change (a mobile enemy pausing mid-chase reads as a bug, not as suppression). So the gate
// is a kind-level `ammoLimited: true` flag rather than "does the resolved weapon happen to have a
// finite ammoMax" — the latter would silently rope in any kind whose base weapon carries a
// magazine. Today exactly two kinds opt in: `turret` and `wallTurret`, the rooted guns. Widening
// this later is one flag per kind plus tuned ammoMax/ammoRegen in its weaponOverride.
//
// The state lives per ENEMY and per weapon SLOT (`e.slotAmmo[slot]`), matching #305's slotCd /
// slotBurst — a magazine belongs to a gun, not to a unit. Fractional values are kept (regen is
// continuous, firing needs a whole round), exactly like Mech.js's ammo pool.

import { resolveWeapon } from './weapons.js';
import { kindWeaponSlots } from './kindWeapons.js';

// The magazine spec for one already-normalised slot of `def`, or null if this slot is not
// ammo-limited. Null covers all three "no magazine" cases: the kind never opted in, the resolved
// weapon has `ammoMax: null` (unlimited — melee), or it has no ammo fields at all.
export function slotAmmoSpec(def, mount) {
  if (!def?.ammoLimited || !mount) return null;
  const weapon = resolveWeapon(mount.weaponId, mount.weaponOverride);
  const max = weapon?.ammoMax;
  if (!(max > 0)) return null;
  return { max, regen: weapon.ammoRegen ?? 0 };
}

// Starting magazines for a freshly spawned unit: every ammo-limited slot begins FULL. A kind with
// no opt-in gets `{}`, which every query below reads as "unlimited" — so the non-emplaced kinds
// carry no extra state and take no extra branch.
export function initKindAmmo(def) {
  const out = {};
  for (const [slot, mount] of Object.entries(kindWeaponSlots(def))) {
    const spec = slotAmmoSpec(def, mount);
    if (spec) out[slot] = spec.max;
  }
  return out;
}

// Can this slot fire right now? A slot with no magazine (absent key) is always ready — that is
// what keeps every non-opted-in kind byte-identical in behaviour.
export function slotHasAmmo(ammo, slot) {
  const have = ammo?.[slot];
  return have == null || have >= 1;
}

// Spend one round for one TRIGGER PULL, not one per emission — a spread/stream weapon's shots all
// come from the same squeeze, same as Mech.consumeAmmo's n=1 per fire event. No-op for a slot
// without a magazine.
export function consumeSlotAmmo(ammo, slot, n = 1) {
  if (!ammo || ammo[slot] == null) return ammo;
  ammo[slot] = Math.max(0, ammo[slot] - n);
  return ammo;
}

// Per-frame top-up, `dt` in SECONDS (same convention as Mech.regenAmmo). Clamped at the slot's
// own ammoMax so a long lull cannot bank extra rounds beyond the magazine.
export function regenKindAmmo(def, ammo, dt) {
  if (!ammo) return ammo;
  for (const [slot, mount] of Object.entries(kindWeaponSlots(def))) {
    if (ammo[slot] == null) continue;
    const spec = slotAmmoSpec(def, mount);
    if (!spec) continue;
    ammo[slot] = Math.min(spec.max, ammo[slot] + spec.regen * dt);
  }
  return ammo;
}
