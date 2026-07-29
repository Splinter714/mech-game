// Weapon categories — Axis 1 of the weapon model (loadout identity / economy). This
// is separate from a weapon's delivery profile (Axis 2, in weapons.js), so e.g.
// plasma and laser are both `energy` but behave nothing alike. A category decides the
// shared economy: what hardpoint colour represents it? Per-weapon ammo is the real firing
// constraint (`ammoMax` in weapons.js) — the category itself doesn't gate ammo.

// `color` is the category's neon hue — drives both the catalog icons and the glow on
// mounted weapons (the mech art layers a halo/hot ramp around this core).
export const CATEGORIES = {
  ballistic: { id: 'ballistic', label: 'Ballistic', color: 0xffb24a },
  missile:   { id: 'missile',   label: 'Missile',   color: 0xff4fa3 },
  energy:    { id: 'energy',    label: 'Energy',    color: 0x0088ff },
  support:   { id: 'support',   label: 'Support',   color: 0x6dff9e },
};

export const CATEGORY_IDS = Object.keys(CATEGORIES);

export function getCategory(id) {
  return CATEGORIES[id];
}
