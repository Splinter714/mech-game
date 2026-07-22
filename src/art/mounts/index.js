// Weapon-mount art registry — the "what a mounted weapon looks like on the body" dispatcher.
// TWO-LEVEL lookup, both via bracket dispatch (no per-variant branching):
//   1. WEAPON_MOUNT_ART[weaponId] — a BESPOKE silhouette so each individual weapon reads
//      distinctly at a glance (Pulse Laser vs Rail Lance vs Flamethrower, …).
//   2. MOUNT_ART[category]       — the generic per-CATEGORY fallback, so a weapon WITHOUT
//      its own draw fn still gets a category-appropriate shape. Adding a new weapon never
//      requires art — it inherits its category silhouette until someone gives it a bespoke
//      one. (content-is-data ethos.)
// Each draw fn shares the signature `(sg, T, bx, frontY, s, n, cap)` and glows its weapon's
// CATEGORY neon colour, so faction/type still reads even on a bespoke shape.
// **Add a category mount = a new file + one appended line in MOUNT_ART. Add a bespoke weapon
// mount = one appended entry in WEAPON_MOUNT_ART (in ./weapons.js).**
import { neonFor, muzzleOffNeon, CENTER } from '../mechPrims.js';
import { draw as missile } from './missile.js';
import { draw as melee } from './melee.js';
import { draw as ballistic } from './ballistic.js';
import { draw as support } from './support.js';
import { draw as energy } from './energy.js';
import { WEAPON_MOUNT_ART } from './weapons.js';

export const MOUNT_ART = { missile, melee, ballistic, support, energy };
export { WEAPON_MOUNT_ART };

// Draw one mounted weapon's hardware. Prefer the weapon's bespoke silhouette; fall back to
// its category's generic shape; fall back again to energy for an unknown category. All three
// are bracket lookups so the shared dispatcher never branches on a variant literal.
// #433: `muzzleOff` bakes the EXTINGUISHED variant — the weapon's silhouette is identical, but
// its emissive glow ramp is swapped for the theme's dark tones (muzzleOffNeon), so every mount's
// muzzle/lens/cell reads as unlit. One switch here covers all 13 weapons (bespoke + generic)
// with no per-mount changes, since they all colour their glow from the shared `n` ramp.
export function drawWeaponMount(sg, T, weaponId, catId, bx, frontY, s, muzzleOff = false) {
  const n = muzzleOff ? muzzleOffNeon(T) : neonFor(catId);
  const cap = frontY + CENTER - 2;            // keep the muzzle inside the canvas
  const drawFn = WEAPON_MOUNT_ART[weaponId] ?? MOUNT_ART[catId] ?? MOUNT_ART.energy;
  drawFn(sg, T, bx, frontY, s, n, cap);
}
