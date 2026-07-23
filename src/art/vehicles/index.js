// Non-mech VEHICLE art registry. Each enemy kind (data/enemyKinds.js) names an `art` key; this
// maps that key to a builder that draws the unit's `<key>_hull` + `<key>_turret` textures. The
// arena calls buildVehicleTextures(scene, texKey, def) on spawn. Adding a new non-mech unit's
// art = one entry here + its draw module — dispatch is a registry lookup, never a variant branch.
import { drawWallTurret } from './wallTurret.js';
import { drawTank } from './tank.js';
import { drawDrone } from './drone.js';
import { drawHelicopter } from './helicopter.js';
import { drawInfantry } from './infantry.js';
import { drawCarrier } from './carrier.js';

const VEHICLE_ART = {
  wallTurret: drawWallTurret,   // #310: the parapet-mounted rail lance
  tank: drawTank,
  drone: drawDrone,
  helicopter: drawHelicopter,
  infantry: drawInfantry,
  carrier: drawCarrier,   // #328: the tank-bodied drone carrier (shares tank.js's hull)
};

// #300: an ARMORED kind (enemyKinds.js `armor` > 0 — tank, carrier) gets a SECOND texture set
// under this suffix, drawn with the shared `armorShell()` plating overlay. Vehicle textures are
// shared across every live unit of a kind (see enemies.js `vehicleTextureKey`), so a per-instance
// reskin like the mech's is impossible here — instead both looks are rasterised once up front and
// a unit simply RE-POINTS its sprites at the bare set the moment its armor pool empties. That's
// strictly cheaper than the mech path (no canvas work at all on an armor break) and keeps the
// "shared texture, never mutated out from under a sibling" invariant that file documents.
export const ARMORED_SUFFIX = '_armored';

// Which texture set a unit should be rendering: the plated one while it still has armor, the
// bare one once that pool is gone. Pure (no Phaser) so it's unit-tested directly. `body` is any
// object with the `hasArmor()` predicate (HpBody, and Mech-shaped things by accident of parity);
// a body without one (or with no armor at all) always resolves to the bare set.
export function vehicleTextureSet(baseKey, body) {
  return body?.hasArmor?.() ? baseKey + ARMORED_SUFFIX : baseKey;
}

// True if this kind carries an armor pool at all, i.e. whether an armored texture variant is
// worth generating. Data-driven — no per-kind literals here.
export function vehicleHasArmorArt(def) {
  return (def?.armor ?? 0) > 0;
}

// Build the two textures (`<texKey>_hull`, `<texKey>_turret`) for one non-mech unit, from its
// kind def (`def.art` selects the builder). No-op with a clear throw if the art key is unknown.
// #300: for an armored kind this builds BOTH sets — the bare one at `texKey` and the plated one
// at `texKey + ARMORED_SUFFIX`. An art builder that doesn't honour `opts.armored` simply draws
// the same thing twice (harmless): today tank + carrier are the armored kinds and both do.
export function buildVehicleTextures(scene, texKey, def) {
  const builder = VEHICLE_ART[def.art];
  if (!builder) throw new Error(`buildVehicleTextures: unknown vehicle art '${def.art}'`);
  builder(scene, texKey, def, { armored: false });
  if (vehicleHasArmorArt(def)) builder(scene, texKey + ARMORED_SUFFIX, def, { armored: true });
}

export { VEHICLE_ART };
