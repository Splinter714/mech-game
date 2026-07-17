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
// removed) — Sprint is a hardcoded toggle, not a mounted item, so its cues live here in the
// generic UI domain instead of a bespoke ability-cue system.
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
    { id: 'powerupPickupOvercharge', label: 'Pickup: Overcharge', stages: [['play', 'PLAY']] },
    { id: 'powerupPickupOverdrive', label: 'Pickup: Overdrive', stages: [['play', 'PLAY']] },
    { id: 'powerupPickupOverclock', label: 'Pickup: Overclock', stages: [['play', 'PLAY']] },
    { id: 'powerupPickupArmorPatch', label: 'Pickup: Armor Patch', stages: [['play', 'PLAY']] },
    { id: 'powerupPickupShield', label: 'Pickup: Shield', stages: [['play', 'PLAY']] },
    { id: 'sprintOn', label: 'Sprint On', stages: [['play', 'PLAY']] },
    { id: 'sprintOff', label: 'Sprint Off', stages: [['play', 'PLAY']] },
    { id: 'partDestroyed', label: 'Part Destroyed', stages: [['play', 'PLAY']] },
    { id: 'mechDestroyed', label: 'Mech Destroyed', stages: [['play', 'PLAY']] },
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
