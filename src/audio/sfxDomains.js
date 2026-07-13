// #177: the minimal registration mechanism for a NON-weapon sound domain — a plain array of
// `{ id, label, stages }` descriptors, parallel in shape to how weapons.js's WEAPONS registry
// already implicitly supplies an id+stage-list to WeaponSfxPanel (see setWeapon/setTarget in
// src/ui/weaponSfxPanel.js). `stages` is the same `[[key, sectionLabel], ...]` shape the panel
// already uses for the weapon fire/trajectory/impact list.
//
// #178: real UI/pickup sound cues, wired into the actual moments (GarageScene's equip/
// unequip/deploy, tabBar.js + weaponCardList.js's menu navigation, and the arena's SCRAP/
// POWERUP pickups — see src/audio/sfx.js's UI_CUES for the procedural stubs and Audio.ui(id,
// stage) for the playback entry point). Each is a single one-shot cue, so every entry has
// exactly one stage, `play` — WeaponSfxPanel's generic (id, stage) override/bake plumbing
// (proven generic by #177) doesn't care that these aren't fire/trajectory/impact.
//
// #188: sprintOn/sprintOff replaced the old ability-specific dash/shield cues (equipment.js
// removed) — Sprint is a hardcoded toggle, not a mounted item, so its cues live here in the
// generic UI domain instead of a bespoke ability-cue system.
export const SFX_DOMAINS = {
  ui: [
    { id: 'equip', label: 'Equip Weapon', stages: [['play', 'PLAY']] },
    { id: 'unequip', label: 'Unequip Weapon', stages: [['play', 'PLAY']] },
    { id: 'deploy', label: 'Deploy', stages: [['play', 'PLAY']] },
    { id: 'menuNav', label: 'Menu Navigation', stages: [['play', 'PLAY']] },
    { id: 'scrapPickup', label: 'Scrap Pickup', stages: [['play', 'PLAY']] },
    { id: 'powerupPickup', label: 'Powerup Pickup', stages: [['play', 'PLAY']] },
    { id: 'sprintOn', label: 'Sprint On', stages: [['play', 'PLAY']] },
    { id: 'sprintOff', label: 'Sprint Off', stages: [['play', 'PLAY']] },
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
