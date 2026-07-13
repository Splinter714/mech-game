// #177: the minimal registration mechanism for a NON-weapon sound domain — a plain array of
// `{ id, label, stages }` descriptors, parallel in shape to how weapons.js's WEAPONS registry
// already implicitly supplies an id+stage-list to WeaponSfxPanel (see setWeapon/setTarget in
// src/ui/weaponSfxPanel.js). `stages` is the same `[[key, sectionLabel], ...]` shape the panel
// already uses for the weapon fire/trajectory/impact list.
//
// This does NOT wire up any real UI sound events yet (equip/menu-nav/deploy/etc. — that's
// #178's job, once real sound cues for those moments exist). It only proves the panel/storage
// plumbing is generic: a domain entry here can be handed to WeaponSfxPanel#setTarget exactly
// like a weapon id, and its (id, stage) overrides round-trip through sfxOverrides.js/
// bakedSfx.js the same way. `ui_test` is a placeholder proving id — not a real sound, not
// referenced by any scene.
export const SFX_DOMAINS = {
  ui: [
    { id: 'ui_test', label: 'UI TEST (placeholder — #178 will add real UI cues)', stages: [['nav', 'NAV (menu navigation)']] },
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
