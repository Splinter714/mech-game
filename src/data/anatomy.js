// Mech anatomy: the body locations every mech is built from, plus the rules for what
// counts as a kill. This is pure data + small pure helpers (no Phaser), so it's fully
// unit-tested (Mech.test.js) and shared by the model, the garage, and the arena alike.
//
// Each DAMAGE-TRACKED location has its own armor (outer) + internal HP (inner, formerly
// called "structure" — #246 renamed the term throughout to plain language; the layering
// itself is unchanged): damage eats armor first, then HP; HP at 0 = the part is destroyed.
// This is the BattleTech model and is what makes partial destruction read cleanly.
//
// #128: "damage-tracked" and "mountable skill slot" are DELIBERATELY separate concepts,
// not two views of one list. `head`/`cockpit`/`centerTorso` used to be both — the sole
// health-tracked, instant-kill locations — but a playtest found that let a mech die from
// one hit to center-mass before its arm/shoulder weapons ever got blown off. Head/cockpit/
// centerTorso are now COSMETIC ONLY (drawn unconditionally by mechArt.js, never shown as
// destroyed): they carry no armor/structure and can't be targeted or destroyed. See
// LOCATIONS (damage) vs MOUNT_LOCATIONS (mountable) below.
//
// #188: centerTorso used to ALSO be the one mountable "ability" skill slot (jumpJet/
// bubbleShield, L3/Space). That's gone — L3/Space is now hardcoded to a built-in Dash
// (#261, data/dash.js) every mech always has, never mounted/chosen — so centerTorso dropped
// out of MOUNT_LOCATIONS entirely and is purely cosmetic now, same as head/cockpit.

// Locations that track armor/structure and can be destroyed. Legs aren't here either:
// top-down they sit behind the body, so they're purely the walk animation and aren't
// health-tracked or targetable.
//
// #586: the two SIDE locations are `leftShoulder`/`rightShoulder`. They were `leftTorso`/
// `rightTorso` until the owner's live-chat ask — "the left and right torsos [should be] left
// and right shoulders" — renamed them everywhere, ids included. `centerTorso` (cosmetic only)
// is a DIFFERENT location and deliberately keeps its name. Old saves are rewritten on load by
// the roster `migrate` hook in data/rosters.js.
export const LOCATIONS = ['leftShoulder', 'rightShoulder', 'leftArm', 'rightArm'];

// Display metadata for every anatomical location, including the cosmetic-only ones
// (head/cockpit/centerTorso) so UI that wants a label/short code for them still has one.
// `mountable` drives MOUNT_LOCATIONS below; it is NOT the same axis as damage-tracking.
// #188: centerTorso is no longer mountable (it used to be the one ability slot) — it's
// cosmetic only now, same as head/cockpit.
export const LOCATION_INFO = {
  head:        { label: 'Head',         short: 'H',  mountable: false, internal: false },
  cockpit:     { label: 'Cockpit',      short: 'C',  mountable: false, internal: true  },
  centerTorso: { label: 'Center Torso', short: 'CT', mountable: false, internal: false },
  // #586 short codes: LS/RS, not the LT/RT these slots used to carry. LT/RT are ALSO the pad
  // labels SKILL_BINDS (input/Controls.js) prints on the two ARM tiles (the triggers), so the old
  // codes had the HUD showing "LT" under the left-shoulder integrity bar and "LT" on the left-ARM
  // button at the same time. LS/RS are the conventional stick-click names elsewhere, but this game
  // never displays those — it calls the stick clicks L3/R3, and only as alternate ability binds —
  // so LS/RS collide with nothing the player actually sees.
  leftShoulder:  { label: 'Left Shoulder',  short: 'LS', mountable: true,  internal: false },
  rightShoulder: { label: 'Right Shoulder', short: 'RS', mountable: true,  internal: false },
  leftArm:       { label: 'Left Arm',       short: 'LA', mountable: true,  internal: false },
  rightArm:      { label: 'Right Arm',      short: 'RA', mountable: true,  internal: false },
};

// All mountable location ids (the four weapon slots), for catalogs/UI that iterate mount
// points. Computed from LOCATION_INFO (not LOCATIONS) — kept as a derived list rather than
// a hardcoded array so a future mountable-but-not-damage-tracked location just needs a
// `mountable: true` flag here.
export const MOUNT_LOCATIONS = Object.keys(LOCATION_INFO).filter((id) => LOCATION_INFO[id].mountable);

// The arms — the only locations a melee weapon can mount in.
export const MELEE_LOCATIONS = ['leftArm', 'rightArm'];

// Ability slots: independently-bound, non-weapon activated slots — one per gamepad face
// button (Controls.js ABILITY_BINDS). Deliberately NOT a body location: abilities carry no
// armor/structure and aren't drawn on the mech, so they live in their own list rather than
// folding into LOCATION_INFO/MOUNT_LOCATIONS. Dash (previously a hardcoded L3/Space built-in
// every mech always had) is now the first mountable ability — see data/abilities.js — so an
// ability slot can be empty.
//
// Down from four (Y/B/A/X) to two (Jackson, confirmed): "active core abilities should just be
// two and bound to X and Y, leaving A for a generic interact we may need, and maybe B for
// reload." A is RESERVED — no ability, no other function, just left unbound for a future
// concrete use — and B moved to RELOAD_BIND (Controls.js) instead of an ability. A save with
// an old abilityA/abilityB mount is handled for free: Mech's constructor only ever iterates
// THIS list when hydrating `abilityMounts`, so a stale abilityA/abilityB key in saved JSON is
// simply never read (see Mech.js) — no explicit migration code needed.
export const ABILITY_SLOTS = ['abilityY', 'abilityX'];

// Each slot's position (unit offsets, Y up / negative) for UI layout — flanking the core tile
// left/right rather than the old four-point diamond, since two points don't make one. Left/
// right (not top/bottom) so the pair reads as a symmetric row with the passive core tile
// nested between them, matching the HUD/garage's horizontal tile strip.
export const ABILITY_SLOT_LAYOUT = {
  abilityY: { dx: -1, dy: 0 },
  abilityX: { dx: 1, dy: 0 },
};

// Skill slots: the four arm/shoulder slots hold weapons (bound to triggers/bumpers). The
// head is NOT a skill slot — it's not targetable either any more (#128). #188: there is no
// ability slot any more — L3/Space is a hardcoded built-in (Sprint, data/sprint.js), not a
// mountable item, so WEAPON_SLOTS and MOUNT_LOCATIONS are now the same four locations.
export const WEAPON_SLOTS = ['leftArm', 'rightArm', 'leftShoulder', 'rightShoulder'];

// Which of the two mountable-slot families does `loc` belong to? Shared by the HUD and the
// Garage instead of each reimplementing the same branch (#506 HUD diamond / Garage mounting UI).
// Returns null for anything that isn't a mountable slot at all. There used to be a third
// "core" family (#496's passive Shield/AMS slot); shield is now an unconditional baseline every
// mech gets with no equip choice, and AMS moved into the ability system, so the core slot type
// is gone entirely — only weapon and ability slots remain.
export function slotKind(loc) {
  if (WEAPON_SLOTS.includes(loc)) return 'weapon';
  if (ABILITY_SLOTS.includes(loc)) return 'ability';
  return null;
}

// Destroying one of these single locations is an instant kill. Empty since #128 retired
// the head/cockpit/centerTorso one-hit-kill rule in favor of LETHAL_GROUPS below; kept as
// a mechanism in case a future single-location instant-kill part is ever added.
export const LETHAL_LOCATIONS = [];

// Destroying ALL locations in any one of these groups is a kill. #128: losing BOTH
// shoulders is now the kill condition — DESTROY_CASCADE (below) already takes both arms with
// them, so by the time this triggers every WEAPON_SLOTS location is gone too, matching
// "you should experience your weapons getting blown off before dying."
export const LETHAL_GROUPS = [['leftShoulder', 'rightShoulder']];

// When a shoulder is destroyed it takes the attached arm with it (the arm has nothing left to
// hang from). Kept for callers that want the raw link.
export const SHOULDER_ARM_LINK = { leftShoulder: 'leftArm', rightShoulder: 'rightArm' };

// Destroying a location also destroys these dependent locations (applied recursively):
// a shoulder takes its arm. Data-driven so new links are just another entry. (The old
// head→cockpit link is gone with #128 — neither is damage-tracked any more.)
export const DESTROY_CASCADE = {
  leftShoulder: ['leftArm'],
  rightShoulder: ['rightArm'],
};

// Is a part destroyed? Pure: a part with hp <= 0 (or that no longer exists).
export function partDestroyed(part) {
  return !part || part.hp <= 0;
}

// Given a map of location id → part state, is the mech destroyed? Encodes the kill
// rule: every location in any lethal group destroyed (#128: both shoulders), or any
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
