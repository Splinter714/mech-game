// #177: the minimal registration mechanism for a NON-weapon sound domain — a plain array of
// `{ id, label, stages }` descriptors, parallel in shape to how weapons.js's WEAPONS registry
// already implicitly supplies an id+stage-list to WeaponSfxPanel (see setWeapon/setTarget in
// src/ui/weaponSfxPanel.js). `stages` is the same `[[key, sectionLabel], ...]` shape the panel
// already uses for the weapon fire/trajectory/impact list.
//
// #178: real UI/pickup sound cues, wired into the actual moments (GarageScene's equip/
// deploy, tabBar.js + weaponCardList.js's menu navigation, and the arena's SCRAP/
// POWERUP pickups — see src/audio/sfx.js's UI_CUES for the procedural stubs and Audio.ui(id,
// stage) for the playback entry point). Each is a single one-shot cue, so every entry has
// exactly one stage, `play` — WeaponSfxPanel's generic (id, stage) override/bake plumbing
// (proven generic by #177) doesn't care that these aren't fire/trajectory/impact.
//
// #188: sprintOn/sprintOff replaced the old ability-specific dash/shield cues (equipment.js
// removed) — the movement ability is a hardcoded built-in, not a mounted item, so its cues live
// here in the generic UI domain instead of a bespoke ability-cue system. They are still live
// despite the name: Sprint is Overclock-only since #261 but still fires them on its
// auto-activation/expiry, and #261's Dash reuses the same pair for its burst start/end (see
// scenes/arena/firing.js `_handleSprint` / `_handleDash`).
//
// #196: the single shared `powerupPickup` entry was replaced with 5 per-powerup entries
// (one per src/data/powerups.js POWERUPS id) so each buff's "acquired" cue is independently
// overridable/bakeable via the owner's tuner panel, instead of all five sharing one slider.
// Naming follows the `powerupPickup<Id>` camelCase pattern (parallel to the existing
// `scrapPickup`/`powerupPickup` sibling ids) so they sort together in the tuner list.
//
// #201: three more distinct, independently-tunable triggers, replacing generic shared cues
// that used to piggyback on `Audio.explosion(...)`:
//   - `partDestroyed` — any body part breaking off (player OR enemy — Jackson only asked for
//     "losing mech parts" as one category, so this is a single shared trigger for both sides
//     rather than splitting player-part-loss from enemy-part-loss).
//   - `mechDestroyed` — specifically the PLAYER's own mech going down (MECH DOWN), distinct
//     from an enemy dying (which already has its own death-explosion-by-category system, #180/#184).
//
// #210: `runLost` was removed — Jackson felt it was basically redundant with mechDestroyed,
// fired right alongside it at the death moment. In its place, `returnToGarage` fires at the
// ACTUAL scene-transition moment (the delayed call back to GarageScene) and covers BOTH the
// win and loss outcomes — it's a cue for the transition itself ("heading back to the
// garage"), not a defeat-specific cue, so it pairs with `deploy` (the outbound trip) rather
// than living alongside the death/loss cues.
export const SFX_DOMAINS = {
  ui: [
    { id: 'equip', label: 'Equip Weapon', stages: [['play', 'PLAY']] },
    { id: 'deploy', label: 'Deploy', stages: [['play', 'PLAY']] },
    { id: 'returnToGarage', label: 'Return To Garage', stages: [['play', 'PLAY']] },
    { id: 'menuNav', label: 'Menu Navigation', stages: [['play', 'PLAY']] },
    { id: 'scrapPickup', label: 'Scrap Pickup', stages: [['play', 'PLAY']] },
    { id: 'powerupPickupOverdrive', label: 'Pickup: Overdrive', stages: [['play', 'PLAY']] },
    { id: 'powerupPickupOverclock', label: 'Pickup: Overclock', stages: [['play', 'PLAY']] },
    { id: 'powerupPickupArmorPatch', label: 'Pickup: Armor Patch', stages: [['play', 'PLAY']] },
    { id: 'powerupPickupShield', label: 'Pickup: Shield', stages: [['play', 'PLAY']] },
    { id: 'powerupPickupBarrage', label: 'Pickup: Barrage', stages: [['play', 'PLAY']] },
    { id: 'powerupPickupInfiniteFire', label: 'Pickup: Infinite Fire', stages: [['play', 'PLAY']] },
    // #484: the internal ids stay `sprintOn`/`sprintOff` (renaming them ripples through
    // firing.js + sfx.js trigger sites — out of scope), but the DISPLAY labels are relabeled to
    // what they actually drive today. Player sprint-triggering was removed (#261/#343); these
    // cues now fire on Dash burst start/end (firing.js `_handleDash`) — and sprintOn also serves
    // the reload chirp — plus Overclock's auto-sprint activation/expiry.
    { id: 'sprintOn', label: 'Movement / Dash On (+ reload chirp)', stages: [['play', 'PLAY']] },
    { id: 'sprintOff', label: 'Movement / Dash Off', stages: [['play', 'PLAY']] },
    { id: 'partDestroyed', label: 'Part Destroyed', stages: [['play', 'PLAY']] },
    { id: 'mechDestroyed', label: 'Mech Destroyed', stages: [['play', 'PLAY']] },
    // #479: the two GAIT cues. Registered as ordinary `ui`-domain (id, 'play') entries so they
    // appear in the AUDIO tab's SFX section (SFX_UI_GROUPS 'GAIT' below) and route through the same
    // override/bake authoring plumbing (WeaponSfxPanel) as every other UI cue. Their DEFAULT sound
    // is the synth-baked variant pool in bakedSfx.js (GAIT_SFX_ENTRIES), NOT a live per-play synth.
    { id: 'footstep', label: 'Footstep (plant)', stages: [['play', 'PLAY']] },
    { id: 'legLift', label: 'Leg Movement (lift)', stages: [['play', 'PLAY']] },
  ],
};

// Flat list of every non-weapon domain entry, across all domains — convenient for a future
// UI surface (#178) that needs to iterate "every non-weapon sound target" without caring which
// domain bucket it came from.
export const ALL_SFX_DOMAIN_ENTRIES = Object.values(SFX_DOMAINS).flat();

// Look up one entry by id across every registered domain, or null if none matches.
export function findSfxDomainEntry(id) {
  return ALL_SFX_DOMAIN_ENTRIES.find((e) => e.id === id) ?? null;
}

// #207: purely a DISPLAY grouping over SFX_DOMAINS.ui for the dev-only sfx tuner (#470: the
// AUDIO tab, scenes/AudioScene.js; it lived in the garage until then) —
// ids/labels/stages above are unchanged, and order within a group follows the id order here,
// not SFX_DOMAINS.ui's own order. It lives here rather than in the scene so it's a pure,
// importable module the unit tests can hold against SFX_DOMAINS.ui (#303: a Barrage id was
// added to this list without its SFX_DOMAINS.ui entry, and the panel crashed on `.label`).
export const SFX_UI_GROUPS = [
  { header: 'GENERAL UI', ids: ['equip', 'deploy', 'returnToGarage', 'menuNav'] },
  { header: 'PICKUPS', ids: ['scrapPickup', 'powerupPickupOverdrive', 'powerupPickupOverclock', 'powerupPickupArmorPatch', 'powerupPickupShield', 'powerupPickupBarrage', 'powerupPickupInfiniteFire'] },
  { header: 'MOVEMENT / DASH', ids: ['sprintOn', 'sprintOff'] },
  { header: 'DEATH / LOSS', ids: ['partDestroyed', 'mechDestroyed'] },
  { header: 'GAIT', ids: ['footstep', 'legLift'] },
];

// Resolve one SFX_UI_GROUPS id to its SFX_DOMAINS.ui entry, throwing a clear, id-naming error
// instead of handing back undefined for a caller to die on later.
export function resolveSfxUiEntry(id) {
  const entry = SFX_DOMAINS.ui.find((e) => e.id === id);
  if (!entry) {
    throw new Error(`SFX_UI_GROUPS references '${id}', which has no entry in SFX_DOMAINS.ui — add one in src/audio/sfxDomains.js`);
  }
  return entry;
}
