// #375: AMMO for non-mech (vehicle-path) enemy kinds — the second limiter on top of cadence
// (#241/#243) and trigger discipline (#243 `burstShots`/`burstRestMs`).
//
// Background. #372's ammo pass found that `turret` and `wallTurret` carried `ammoMax`/`ammoRegen`
// inside their `weaponOverride` blocks — wallTurret's with a comment explicitly describing volume
// TAPERING over a long fight — but the vehicle fire path (`_fireVehicleWeapon`) never called
// `consumeAmmo` at all. The owner chose to make it real rather than delete it.
//
// #375 (redefined). The first pass modelled emplaced ammo as a continuous TAPER: a magazine that
// drained a round per pull and trickled back via `ammoRegen`. Meanwhile #402 reworked the PLAYER
// ammo model into a MAGAZINE + RELOAD: no trickle at all — a mag holds its rounds where firing left
// them, and once drained to empty it locks out for `RELOAD_SECONDS` and then snaps back to FULL.
// The owner's call: "it should work the same as the player version of the gun." So the taper is
// gone; an emplaced turret now suppresses exactly the way the player's own gun does — dump the
// magazine, wait out the reload, full mag returns. One shared mechanic, no bespoke economy, no
// `ammoRegen` trickle.
//
// What it buys is unchanged: YOU CAN SUPPRESS A WALL BY MAKING IT SHOOT. Draw the fire until the
// magazine runs dry and the emplacement goes quiet for the reload beat.
//
// SCOPE — emplaced kinds ONLY, by explicit OPT-IN. The vehicle path also covers tank, drone,
// helicopter, carrier and infantry; making all of them ammo-limited would be a large unrequested
// combat change (a mobile enemy pausing mid-chase reads as a bug, not as suppression). So the gate
// is a kind-level `ammoLimited: true` flag rather than "does the resolved weapon happen to have a
// finite ammoMax." Today exactly two kinds opt in: `turret` and `wallTurret`, the rooted guns.
// Widening this later is one flag per kind (its magazine size is just the resolved weapon's own
// `ammoMax`).
//
// State lives per ENEMY and per weapon SLOT, matching #305's slotCd / slotBurst — a magazine
// belongs to a gun, not to a unit. Two parallel maps, mirroring Mech.js's `ammo` + `reload`:
//   * `slotAmmo[slot]`   — rounds left in the magazine (whole numbers; no fractional trickle now).
//   * `slotReload[slot]` — remaining RELOAD seconds for that slot, 0 when not reloading. A slot
//     mid-reload sits at ammo 0, so the existing `slotHasAmmo` firing gate already blocks it.

import { resolveWeapon } from './weapons.js';
import { RELOAD_SECONDS } from './Mech.js';
import { kindWeaponSlots } from './kindWeapons.js';

// The magazine size for one already-normalised slot of `def`, or null if this slot is not
// ammo-limited. Null covers all three "no magazine" cases: the kind never opted in, the resolved
// weapon has `ammoMax: null` (unlimited — melee), or it has no ammo fields at all.
export function slotAmmoSpec(def, mount) {
  if (!def?.ammoLimited || !mount) return null;
  const weapon = resolveWeapon(mount.weaponId, mount.weaponOverride);
  const max = weapon?.ammoMax;
  if (!(max > 0)) return null;
  return { max };
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

// The reload-timer companion map: every ammo-limited slot starts at 0 (not reloading). Kept in
// lockstep with `initKindAmmo` so the two maps share the same keys. A kind with no opt-in gets
// `{}` — no timers, no per-frame work.
export function initKindReload(def) {
  const out = {};
  for (const [slot, mount] of Object.entries(kindWeaponSlots(def))) {
    if (slotAmmoSpec(def, mount)) out[slot] = 0;
  }
  return out;
}

// Can this slot fire right now? A slot with no magazine (absent key) is always ready — that is
// what keeps every non-opted-in kind byte-identical in behaviour. A slot mid-reload reads ammo 0
// here, so this same gate blocks it without a separate reload check at the call site.
export function slotHasAmmo(ammo, slot) {
  const have = ammo?.[slot];
  return have == null || have >= 1;
}

// Spend one round for one TRIGGER PULL, not one per emission — a spread/stream weapon's shots all
// come from the same squeeze, same as Mech.consumeAmmo's n=1 per fire event. Draining a slot to
// exactly empty AUTO-triggers its reload (mirrors Mech.consumeAmmo). No-op for a slot without a
// magazine. `reload` may be omitted (a caller/test that only asserts consumption) — the
// auto-reload simply won't arm.
export function consumeSlotAmmo(ammo, slot, n = 1, reload = null) {
  if (!ammo || ammo[slot] == null) return ammo;
  const before = ammo[slot];
  const after = Math.max(0, before - n);
  ammo[slot] = after;
  // Empty → start the reload lockout, guarded by `before > 0` so a slot already at 0 (mid-reload)
  // doesn't keep resetting its own timer on every pull.
  if (after === 0 && before > 0 && reload && reload[slot] != null) {
    reload[slot] = RELOAD_SECONDS;
  }
  return ammo;
}

// Per-frame reload upkeep, `dt` in SECONDS. A slot mid-reload counts its timer down and, the frame
// it reaches 0, snaps its magazine back to FULL. NO between-shots trickle: a slot that isn't
// reloading holds its ammo exactly where firing left it. Mirrors Mech.regenAmmo's reload branch.
export function tickKindReload(def, ammo, reload, dt) {
  if (!ammo || !reload) return ammo;
  for (const [slot, mount] of Object.entries(kindWeaponSlots(def))) {
    if (reload[slot] == null || reload[slot] <= 0) continue;
    const r = Math.max(0, reload[slot] - dt);
    reload[slot] = r;
    if (r === 0) {
      const spec = slotAmmoSpec(def, mount);
      if (spec) ammo[slot] = spec.max;   // reload complete → full magazine
    }
  }
  return ammo;
}
