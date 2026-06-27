// Weapon categories — Axis 1 of the weapon model (loadout identity / economy). This
// is separate from a weapon's delivery profile (Axis 2, in weapons.js), so e.g.
// plasma and laser are both `energy` but behave nothing alike. A category decides the
// shared economy: does it burn ammo? run hot? what hardpoint colour represents it?

export const CATEGORIES = {
  ballistic: { id: 'ballistic', label: 'Ballistic', usesAmmo: true,  color: 0xc9b27a },
  missile:   { id: 'missile',   label: 'Missile',   usesAmmo: true,  color: 0xd06a52 },
  energy:    { id: 'energy',    label: 'Energy',    usesAmmo: false, color: 0x5ec8e0 },
  melee:     { id: 'melee',     label: 'Melee',     usesAmmo: false, color: 0xa0a4ab },
  support:   { id: 'support',   label: 'Support',   usesAmmo: false, color: 0x7bd17b },
};

export const CATEGORY_IDS = Object.keys(CATEGORIES);

export function getCategory(id) {
  return CATEGORIES[id];
}
