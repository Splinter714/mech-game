// Mount-silhouette textures — a still of each weapon's ON-MECH hardware (the same bespoke/
// category silhouette drawWeaponMount() paints on the body). The weapon-catalog card uses
// these as the EMITTER the live-fire preview shoots from (ui/weaponCardList.js rotates the
// image +90° so the up-pointing barrel aims right, base-pivoted at the muzzle), so a card's
// shots leave the actual gun rather than a generic grey nub. Keyed `wmount_<id>`, one per
// weapon, drawn with the player theme. Abilities have no mount hardware, so they get no
// emitter (the card shows their signature fx instead) — this only builds weapon mounts.

import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, themeFor } from '../mechPrims.js';
import { drawWeaponMount } from './index.js';
import { WEAPONS, WEAPON_IDS } from '../../data/weapons.js';

export function mountIconKey(id) { return `wmount_${id}`; }

// bx=0 centres the weapon horizontally; MOUNT_FRONT_Y sits the base just below centre so the
// barrel grows up into the top half. `s` scales the design-px sizes up to roughly fill the
// 64px design canvas — tuned so the longest weapon (rail lance) still clears the top edge and
// the shortest (pulse laser) isn't lost. NOTE: MOUNT_FRONT_Y is the base offset the card's
// MOUNT_BASE_OY origin is derived from — keep the two in sync if you retune the framing.
const MOUNT_S = 2.6;
export const MOUNT_FRONT_Y = 13;

export function buildMountIconTextures(scene) {
  const T = themeFor({ theme: 'player' });
  for (const id of WEAPON_IDS) {
    const wpn = WEAPONS[id];
    gen(scene, mountIconKey(id), DESIGN * ART_SCALE, DESIGN * ART_SCALE,
      (g) => drawWeaponMount(scaledGraphics(g), T, id, wpn?.category ?? 'energy', 0, MOUNT_FRONT_Y, MOUNT_S));
  }
}
