// Mech anatomy: the body locations every mech is built from, plus the rules for what
// counts as a kill. This is pure data + small pure helpers (no Phaser), so it's fully
// unit-tested (Mech.test.js) and shared by the model, the garage, and the arena alike.
//
// Each DAMAGE-TRACKED location has its own armor (outer) + internal structure (inner):
// damage eats armor first, then structure; structure at 0 = the part is destroyed. This
// is the BattleTech model and is what makes partial destruction read cleanly.
//
// #128: "damage-tracked" and "mountable skill slot" are DELIBERATELY separate concepts,
// not two views of one list. `head`/`cockpit`/`centerTorso` used to be both — the sole
// health-tracked, instant-kill locations — but a playtest found that let a mech die from
// one hit to center-mass before its arm/torso weapons ever got blown off. Head/cockpit/
// centerTorso are now COSMETIC ONLY (drawn unconditionally by mechArt.js, never shown as
// destroyed): they carry no armor/structure and can't be targeted or destroyed. See
// LOCATIONS (damage) vs MOUNT_LOCATIONS (mountable) below.
//
// #188: centerTorso used to ALSO be the one mountable "ability" skill slot (jumpJet/
// bubbleShield, L3/Space). That's gone — L3/Space is now hardcoded to a built-in Sprint
// (data/sprint.js) every mech always has, never mounted/chosen — so centerTorso dropped
// out of MOUNT_LOCATIONS entirely and is purely cosmetic now, same as head/cockpit.

// Locations that track armor/structure and can be destroyed. Legs aren't here either:
// top-down they sit behind the torso, so they're purely the walk animation and aren't
// health-tracked or targetable.
export const LOCATIONS = ['leftTorso', 'rightTorso', 'leftArm', 'rightArm'];

// Display metadata for every anatomical location, including the cosmetic-only ones
// (head/cockpit/centerTorso) so UI that wants a label/short code for them still has one.
// `mountable` drives MOUNT_LOCATIONS below; it is NOT the same axis as damage-tracking.
// #188: centerTorso is no longer mountable (it used to be the one ability slot) — it's
// cosmetic only now, same as head/cockpit.
export const LOCATION_INFO = {
  head:        { label: 'Head',         short: 'H',  mountable: false, internal: false },
  cockpit:     { label: 'Cockpit',      short: 'C',  mountable: false, internal: true  },
  centerTorso: { label: 'Center Torso', short: 'CT', mountable: false, internal: false },
  leftTorso:   { label: 'Left Torso',   short: 'LT', mountable: true,  internal: false },
  rightTorso:  { label: 'Right Torso',  short: 'RT', mountable: true,  internal: false },
  leftArm:     { label: 'Left Arm',     short: 'LA', mountable: true,  internal: false },
  rightArm:    { label: 'Right Arm',    short: 'RA', mountable: true,  internal: false },
};

// All mountable location ids (the four weapon slots), for catalogs/UI that iterate mount
// points. Computed from LOCATION_INFO (not LOCATIONS) — kept as a derived list rather than
// a hardcoded array so a future mountable-but-not-damage-tracked location just needs a
// `mountable: true` flag here.
export const MOUNT_LOCATIONS = Object.keys(LOCATION_INFO).filter((id) => LOCATION_INFO[id].mountable);

// The arms — the only locations a melee weapon can mount in.
export const MELEE_LOCATIONS = ['leftArm', 'rightArm'];

// Skill slots: the four arm/side-torso slots hold weapons (bound to triggers/bumpers). The
// head is NOT a skill slot — it's not targetable either any more (#128). #188: there is no
// ability slot any more — L3/Space is a hardcoded built-in (Sprint, data/sprint.js), not a
// mountable item, so WEAPON_SLOTS and MOUNT_LOCATIONS are now the same four locations.
export const WEAPON_SLOTS = ['leftArm', 'rightArm', 'leftTorso', 'rightTorso'];

// Destroying one of these single locations is an instant kill. Empty since #128 retired
// the head/cockpit/centerTorso one-hit-kill rule in favor of LETHAL_GROUPS below; kept as
// a mechanism in case a future single-location instant-kill part is ever added.
export const LETHAL_LOCATIONS = [];

// Destroying ALL locations in any one of these groups is a kill. #128: losing BOTH side
// torsos is now the kill condition — DESTROY_CASCADE (below) already takes both arms with
// them, so by the time this triggers every WEAPON_SLOTS location is gone too, matching
// "you should experience your weapons getting blown off before dying."
export const LETHAL_GROUPS = [['leftTorso', 'rightTorso']];

// When a side torso is destroyed it takes the attached arm with it (the arm loses its
// shoulder). Kept for callers that want the raw link.
export const TORSO_ARM_LINK = { leftTorso: 'leftArm', rightTorso: 'rightArm' };

// Destroying a location also destroys these dependent locations (applied recursively):
// a side torso takes its arm. Data-driven so new links are just another entry. (The old
// head→cockpit link is gone with #128 — neither is damage-tracked any more.)
export const DESTROY_CASCADE = {
  leftTorso: ['leftArm'],
  rightTorso: ['rightArm'],
};

// Is a part destroyed? Pure: a part with structure <= 0 (or that no longer exists).
export function partDestroyed(part) {
  return !part || part.structure <= 0;
}

// Given a map of location id → part state, is the mech destroyed? Encodes the kill
// rule: every location in any lethal group destroyed (#128: both side torsos), or any
// single lethal location destroyed (currently none).
export function mechDestroyed(parts) {
  for (const id of LETHAL_LOCATIONS) {
    if (partDestroyed(parts[id])) return true;
  }
  for (const group of LETHAL_GROUPS) {
    if (group.every((id) => partDestroyed(parts[id]))) return true;
  }
  return false;
}
