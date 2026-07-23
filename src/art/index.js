// Texture-build registry. World/UI textures (hex tiles, category icons) are built once
// at boot here. Mech textures are loadout-dependent, so scenes build those per-mech
// via mechArt.buildMechTextures.

import { buildHexTextures } from './hexArt.js';
import { buildIconTextures } from './iconArt.js';
import { buildItemFxTextures } from './projectileArt.js';
import { buildMountIconTextures } from './mounts/icons.js';

export { buildMechTextures, reskinMech, mechLayout, DESIGN, ART_SCALE, ARM_LOCATIONS, SIDE_TORSO_LOCATIONS, PIVOT_LOCATIONS, PART_PIVOT, MUZZLE_GLOW_SUFFIX, HULL_FRAMES, PLAYER_HULL_FRAMES, strideDir, armSpriteTransform, partSpriteTransform } from './mechArt.js';
// Non-mech unit textures (wall turret / tank / drone / helicopter / carrier / infantry),
// built per-unit on spawn.
export { buildVehicleTextures } from './vehicles/index.js';
export { HEX_TEX_W, HEX_TEX_H } from './hexArt.js';
// Shared projectile/beam art — used live by the arena and as still icons by the garage.
export { drawProjectileBody, drawBeam, drawSlash, drawGroundFire, projectileKind, itemFxKey } from './projectileArt.js';
// Weapon-mount silhouette stills — the on-mech hardware, shown as the catalog card icon.
export { mountIconKey, MOUNT_FRONT_Y } from './mounts/icons.js';

// Build every boot-time texture (everything that doesn't depend on a specific mech
// build). Called once from BootScene.
export function buildBaseTextures(scene) {
  buildHexTextures(scene);
  buildIconTextures(scene);
  buildItemFxTextures(scene);
  buildMountIconTextures(scene);
}
