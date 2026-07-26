// #529 — pure logic behind the Mech Lab's per-column 5-tab system (chassis/weapon/ability/
// passive/color), replacing the old scene-level "MECH LAB" tab-bar button. Kept separate from
// GarageScene.js (Phaser-heavy, not instantiable under Vitest) so the tab math itself is fully
// unit-tested, same split as ui/padNav.js.
//
// Per-column, not scene-global: each joined player's column tracks its OWN active tab (a plain
// `col.labTab` index GarageScene owns), consistent with everything else in the simultaneous
// multi-cursor Garage being per-player (own catalog, own selected slot, own colour). This module
// only supplies the shared step/lookup math both a mouse click and a per-column pad/keyboard
// cycle use.
import { WEAPON_SLOTS, ABILITY_SLOTS, CORE_SLOTS } from '../data/anatomy.js';

// The five tabs, in fixed display/cycle order.
export const LAB_TABS = [
  { id: 'chassis', label: 'CHASSIS' },
  { id: 'weapon', label: 'WEAPON' },
  { id: 'ability', label: 'ABILITY' },
  { id: 'passive', label: 'PASSIVE' },
  { id: 'color', label: 'COLOR' },
];

export const LAB_TAB_IDS = LAB_TABS.map((t) => t.id);

// Index of the tab whose catalog is a slot-kind catalog (weapon/ability/passive) — the three
// tabs that share the existing WeaponCardList-per-selected-slot mechanism. Chassis/color are the
// other two, with their own bespoke catalog-area UI.
export const SLOT_KIND_TO_TAB = { weapon: 1, ability: 2, core: 3 };

// The default slot a tab should focus when switched TO, if the column's currently-selected slot
// doesn't already belong to that tab's kind (e.g. switching from the ability tab to the weapon
// tab should land on a real weapon slot, not leave an ability slot selected under a weapon
// catalog). Chassis/color tabs have no slot at all.
export const TAB_DEFAULT_SLOT = {
  weapon: WEAPON_SLOTS[0],
  ability: ABILITY_SLOTS[0],
  passive: CORE_SLOTS[0],
};

// Step the active tab index forward/back, wrapping. `dir` is +1 (next) or -1 (previous).
export function nextLabTab(index, dir = 1) {
  const n = LAB_TABS.length;
  return ((index + dir) % n + n) % n;
}

// Which tab index a mount-location's slotKind ('weapon'|'ability'|'core') belongs to. Returns
// null for a kind with no matching tab (there is none today, but this stays defensive rather
// than silently returning tab 0).
export function labTabForSlotKind(kind) {
  return SLOT_KIND_TO_TAB[kind] ?? null;
}

// The tab id (not index) for a given index, defensively clamped.
export function labTabId(index) {
  return LAB_TABS[((index % LAB_TABS.length) + LAB_TABS.length) % LAB_TABS.length].id;
}
