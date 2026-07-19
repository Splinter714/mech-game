// #305: the MULTI-WEAPON seam for non-mech enemy kinds.
//
// Background. Until now a kind carried exactly ONE weapon: a top-level `weaponId` plus an
// optional `weaponOverride` delta (#243), with `fireRange` and the `burstShots`/`burstRestMs`
// trigger discipline sitting alongside them. `_fireVehicleWeapon` (scenes/arena/enemies.js) did
// `resolveWeapon(def.weaponId, def.weaponOverride)` and that was the whole story.
//
// #305 needs a kind that picks its weapon AT FIRE TIME from its own tactical state — the gunship
// fires dumbfire rockets while its nose is on the player and its door gun while it's broadside.
// So a kind now needs to carry several weapons and name which one is live this frame.
//
// The model: a kind declares an optional `weapons` map of SLOTS.
//
//   weapons: {
//     nose:  { weaponId: 'clusterRocket', weaponOverride: {...}, fireRange: 520 },
//     flank: { weaponId: 'machineGun', weaponOverride: { delivery: { count: 2 } },
//              fireRange: 460, burstShots: 15, burstRestMs: 1200 },
//   },
//   defaultWeaponSlot: 'flank',
//
// A slot key is a MOUNT/ROLE name ("the nose gun", "the door gun"), never a weapon name — which
// is what keeps #243's principle intact: behaviours and scene code reference slots, and the
// weapon ids themselves stay entirely inside this data file. `_fireVehicleWeapon` still contains
// no weapon-id literal; it now contains no slot-key literal either.
//
// Every field that was per-KIND and weapon-shaped (`weaponId`, `weaponOverride`, `fireRange`,
// `burstShots`, `burstRestMs`) is per-SLOT here, because they all describe one gun. A kind with
// no `weapons` map is normalised into a single slot named DEFAULT_SLOT built from its existing
// top-level fields, so every single-weapon kind (turret/tank/drone/infantry) is
// byte-identically unchanged and needs no edit. That normalisation is the ONLY compatibility
// shim; there is no parallel single-weapon code path anywhere downstream.
//
// Consequences the callers must honour (both spelled out in #305):
//   * CADENCE is per SLOT. `_fireInterval` still derives it from the RESOLVED weapon (#241/#243),
//     but the countdown itself is now keyed by slot (`e.slotCd[slot]`) so a unit alternating
//     weapons doesn't have the rocket's 1.1s cycle suppress the machine gun's 56ms one.
//   * TRIGGER DISCIPLINE (burst counters) is per slot too (`e.slotBurst[slot]`), for the same
//     reason — a burst window belongs to a gun, not to a unit.
//   * The FIRE-CUE throttle (`_allowEnemyFireCue`) is already keyed by weapon id, and distinct
//     slots hold distinct weapons, so it keeps working per weapon for free.

export const DEFAULT_SLOT = 'main';

// Build the slot map for a kind. Multi-weapon kinds return their declared `weapons`; single-
// weapon kinds return one synthesised DEFAULT_SLOT entry. Each entry is normalised to the full
// shape so callers never have to know which form the kind used.
export function kindWeaponSlots(def) {
  if (def?.weapons) {
    const out = {};
    for (const [slot, spec] of Object.entries(def.weapons)) out[slot] = normalize(slot, spec);
    return out;
  }
  // #328: an UNARMED kind (the Carrier — no `weapons` map AND no top-level `weaponId`) has zero
  // slots, not one empty slot. That's what makes `kindWeaponSlot` return null and
  // `kindMaxFireRange` return undefined for it, instead of handing callers a slot whose weaponId
  // is undefined and letting `resolveWeapon` blow up somewhere downstream.
  if (!def?.weaponId) return {};
  return { [DEFAULT_SLOT]: normalize(DEFAULT_SLOT, def ?? {}) };
}

function normalize(slot, spec) {
  return {
    slot,
    weaponId: spec.weaponId,
    weaponOverride: spec.weaponOverride ?? null,
    fireRange: spec.fireRange,
    burstShots: spec.burstShots,
    burstRestMs: spec.burstRestMs,
    // #305: a gun bolted to the airframe rather than mounted on a slewing turret — it aims and
    // fires along the unit's HULL angle, and won't fire until the hull itself is on target.
    // See aimAndFire in scenes/arena/enemyBehaviors.js.
    fixedForward: !!spec.fixedForward,
  };
}

// The slot a unit should fire from right now. `wanted` is whatever the behaviour asked for
// (`e.weaponSlot`); an absent/unknown request falls back to the kind's `defaultWeaponSlot`, then
// to the first declared slot — so a behaviour that never sets a slot (every kind but the gunship)
// just gets the kind's one gun, exactly as before. Returns null only for a kind with no weapon
// at all.
export function kindWeaponSlot(def, wanted) {
  const slots = kindWeaponSlots(def);
  if (wanted && slots[wanted]) return slots[wanted];
  const fallback = def?.defaultWeaponSlot;
  if (fallback && slots[fallback]) return slots[fallback];
  return Object.values(slots)[0] ?? null;
}

// The widest engagement range across ALL of a kind's slots. Used for anything that asks "how far
// out does this unit matter" independent of which gun is live — today the awareness/detection
// radius in `_spawnKind`, which must key off the kind's longest reach, not an arbitrary slot's.
export function kindMaxFireRange(def) {
  let best;
  for (const s of Object.values(kindWeaponSlots(def))) {
    if (s.fireRange != null && (best == null || s.fireRange > best)) best = s.fireRange;
  }
  return best;
}
