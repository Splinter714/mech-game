// Mech anatomy: the eight body locations every mech is built from, plus the rules
// for what counts as a kill. This is pure data + small pure helpers (no Phaser), so
// it's fully unit-tested (Mech.test.js) and shared by the model, the garage, and the
// arena alike.
//
// Each location tracks its own armor (outer) + internal structure (inner): damage
// eats armor first, then structure; structure at 0 = the part is destroyed. This is
// the BattleTech model and is what makes partial destruction read cleanly.

// Location ids, in a stable order. `cockpit` is a small critical *inside* the head —
// it has its own tiny structure, and destroying the head destroys it too.
export const LOCATIONS = [
  'head', 'cockpit', 'centerTorso', 'leftTorso', 'rightTorso',
  'leftArm', 'rightArm', 'leftLeg', 'rightLeg',
];

// Display metadata + which locations are skill slots (can mount a weapon or ability).
// Each mountable location is ONE skill slot bound to a fixed fire button, so the six
// upper-body locations are the hardpoints; the legs are mobility only and the cockpit
// is an internal critical, neither of which mounts anything.
export const LOCATION_INFO = {
  head:        { label: 'Head',         short: 'H',  mountable: true,  internal: false },
  cockpit:     { label: 'Cockpit',      short: 'C',  mountable: false, internal: true  },
  centerTorso: { label: 'Center Torso', short: 'CT', mountable: true,  internal: false },
  leftTorso:   { label: 'Left Torso',   short: 'LT', mountable: true,  internal: false },
  rightTorso:  { label: 'Right Torso',  short: 'RT', mountable: true,  internal: false },
  leftArm:     { label: 'Left Arm',     short: 'LA', mountable: true,  internal: false },
  rightArm:    { label: 'Right Arm',    short: 'RA', mountable: true,  internal: false },
  leftLeg:     { label: 'Left Leg',     short: 'LL', mountable: false, internal: false },
  rightLeg:    { label: 'Right Leg',    short: 'RL', mountable: false, internal: false },
};

// The arms — the only locations a melee weapon can mount in.
export const MELEE_LOCATIONS = ['leftArm', 'rightArm'];

// Skill slots split by what they accept: the four arm/side-torso slots hold weapons
// (bound to triggers/bumpers); the head and centre torso hold abilities (bound to the
// stick clicks R3/L3) — a lock-on and an equipment ability, not guns.
export const WEAPON_SLOTS = ['leftArm', 'rightArm', 'leftTorso', 'rightTorso'];
export const ABILITY_SLOTS = ['centerTorso', 'head'];

// Destroying one of these single locations is an instant kill.
export const LETHAL_LOCATIONS = ['head', 'cockpit', 'centerTorso'];

// Destroying ALL locations in any one of these groups is a kill (both legs gone =
// the mech can't stand). Modeled as groups so adding "all four hover pods" later is
// just another entry.
export const LETHAL_GROUPS = [['leftLeg', 'rightLeg']];

// When a side torso is destroyed it takes the attached arm with it (the arm loses its
// shoulder). Kept for callers that want the raw link.
export const TORSO_ARM_LINK = { leftTorso: 'leftArm', rightTorso: 'rightArm' };

// Destroying a location also destroys these dependent locations (applied recursively):
// a side torso takes its arm; the head takes the cockpit inside it. Data-driven so new
// links are just another entry.
export const DESTROY_CASCADE = {
  head: ['cockpit'],
  leftTorso: ['leftArm'],
  rightTorso: ['rightArm'],
};

// Locations that mount weapons, for catalogs/UI that iterate mount points.
export const MOUNT_LOCATIONS = LOCATIONS.filter((id) => LOCATION_INFO[id].mountable);

// Is a part destroyed? Pure: a part with structure <= 0 (or that no longer exists).
export function partDestroyed(part) {
  return !part || part.structure <= 0;
}

// Given a map of location id → part state, is the mech destroyed? Encodes the kill
// rule: head OR cockpit OR centerTorso destroyed, OR every location in a lethal group
// destroyed (both legs).
export function mechDestroyed(parts) {
  for (const id of LETHAL_LOCATIONS) {
    if (partDestroyed(parts[id])) return true;
  }
  for (const group of LETHAL_GROUPS) {
    if (group.every((id) => partDestroyed(parts[id]))) return true;
  }
  return false;
}
