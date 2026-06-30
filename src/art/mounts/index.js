// Weapon-mount art registry — the generic "what a mounted weapon looks like on the body"
// dispatcher, keyed by weapon category. Each category lives in its own file exporting
// `draw(sg, T, bx, frontY, s, n, cap)`; this module computes the shared neon ramp + muzzle
// cap and dispatches. An unknown category falls back to `energy`. **Add a category mount =
// a new file + one appended line in MOUNT_ART.**
import { neonFor, CENTER } from '../mechPrims.js';
import { draw as missile } from './missile.js';
import { draw as melee } from './melee.js';
import { draw as ballistic } from './ballistic.js';
import { draw as support } from './support.js';
import { draw as energy } from './energy.js';

export const MOUNT_ART = { missile, melee, ballistic, support, energy };

// Each category gets a distinct silhouette so the loadout reads from the sprite, all
// pointing forward (-y) from `frontY`, glowing its neon colour.
export function drawWeaponMount(sg, T, catId, bx, frontY, s) {
  const n = neonFor(catId);
  const cap = frontY + CENTER - 2;            // keep the muzzle inside the canvas
  (MOUNT_ART[catId] ?? MOUNT_ART.energy)(sg, T, bx, frontY, s, n, cap);
}
