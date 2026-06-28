// Texture-build registry. World/UI textures (hex tiles, category icons) are built once
// at boot here. Mech textures are loadout-dependent, so scenes build those per-mech
// via mechArt.buildMechTextures.

import { buildHexTextures } from './hexArt.js';
export { buildImageHexTexture } from './hexArt.js';
import { buildIconTextures } from './iconArt.js';
import { buildItemFxTextures } from './projectileArt.js';

export { buildMechTextures, reskinMech, mechLayout, DESIGN, ART_SCALE } from './mechArt.js';
export { HEX_TEX_W, HEX_TEX_H } from './hexArt.js';
// Shared projectile/beam art — used live by the arena and as still icons by the garage.
export { drawProjectileBody, drawBeam, projectileKind, itemFxKey } from './projectileArt.js';

// Build every boot-time texture (everything that doesn't depend on a specific mech
// build). Called once from BootScene.
export function buildBaseTextures(scene) {
  buildHexTextures(scene);
  buildIconTextures(scene);
  buildItemFxTextures(scene);
}
