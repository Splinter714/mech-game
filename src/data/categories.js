// Weapon categories — Axis 1 of the weapon model (loadout identity / economy). This
// is separate from a weapon's delivery profile (Axis 2, in weapons.js), so e.g.
// plasma and laser are both `energy` but behave nothing alike. A category decides the
// shared economy: what hardpoint colour represents it? Per-weapon ammo is the real firing
// constraint (`ammoMax` in weapons.js) — the category itself doesn't gate ammo.

// `color` is the category's neon hue — drives both the catalog icons and the glow on
// mounted weapons (the mech art layers a halo/hot ramp around this core).
export const CATEGORIES = {
  ballistic: { id: 'ballistic', label: 'Ballistic',     color: 0xffb24a },
  missile:   { id: 'missile',   label: 'Missile',       color: 0xff4fa3 },
  // #618: label-only rename (Energy -> Laser) now that Plasma has split off into its own
  // category below — `energy` still covers the laser family (pulseLaser/beamLaser/
  // chargeLance). The id/object key stays `energy` on purpose (it's load-bearing all over
  // weapons.js and saved builds); only the display text changes.
  energy:    { id: 'energy',    label: 'Laser',         color: 0x0088ff },
  support:   { id: 'support',   label: 'Support',       color: 0x6dff9e },
  // #618: new category — reuses PLASMA_COAT_COLOR (scenes/arena/shieldOutline.js), the exact
  // violet already hand-tuned onto Plasma Coater's DoT specifically to read as "not the energy
  // cyan". causticLobber/plasmaCoater/plasmaCannon/plasmaLance.
  plasma:    { id: 'plasma',    label: 'Plasma',        color: 0xa04dff },
  // #618: new category — reuses Flamethrower's own already-tuned flame outer colour
  // (art/projectiles/flame.js). napalm/flamethrower. Flagged by the owner as sitting close to
  // Ballistic's warm orange (0xffb24a) — if the two read as too similar in the catalog UI,
  // that's the first thing to revisit.
  fire:      { id: 'fire',      label: 'Fire',          color: 0xff7a18 },
  // #622: new category — Chain Bolt / Link Pylons. Jackson: "electric light blue", deliberately
  // lighter/more cyan than Laser's saturated 0x0088ff so the two families don't read the same at
  // a glance (an earlier yellow-white proposal was corrected to this).
  lightning: { id: 'lightning', label: 'Lightning',     color: 0x8fe8ff },
};

export const CATEGORY_IDS = Object.keys(CATEGORIES);

export function getCategory(id) {
  return CATEGORIES[id];
}
