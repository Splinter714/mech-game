// Weapon categories — Axis 1 of the weapon model (loadout identity / economy). This
// is separate from a weapon's delivery profile (Axis 2, in weapons.js), so e.g.
// plasma and laser are both `energy` but behave nothing alike. A category decides the
// shared economy: does it burn ammo? run hot? what hardpoint colour represents it?

// `color` is the category's neon hue — drives both the catalog icons and the glow on
// mounted weapons (the mech art layers a halo/hot ramp around this core).
export const CATEGORIES = {
  ballistic: { id: 'ballistic', label: 'Ballistic', usesAmmo: true,  color: 0xffb24a },
  missile:   { id: 'missile',   label: 'Missile',   usesAmmo: true,  color: 0xff4fa3 },
  energy:    { id: 'energy',    label: 'Energy',    usesAmmo: false, color: 0x38d9ff },
  melee:     { id: 'melee',     label: 'Melee',     usesAmmo: false, color: 0xcfd6e0 },
  support:   { id: 'support',   label: 'Support',   usesAmmo: false, color: 0x6dff9e },
};

export const CATEGORY_IDS = Object.keys(CATEGORIES);

export function getCategory(id) {
  return CATEGORIES[id];
}
