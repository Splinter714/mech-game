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

// Build the two textures (`<texKey>_hull`, `<texKey>_turret`) for one non-mech unit, from its
// kind def (`def.art` selects the builder). No-op with a clear throw if the art key is unknown.
// #472 removed the second, "plated" texture set #300 built for an armored kind: enemies no
// longer wear their armor state on the sprite at all (it reads off the HUD's locked-enemy
// disc), so every kind has exactly ONE look and nothing re-points textures at runtime.
export function buildVehicleTextures(scene, texKey, def) {
  const builder = VEHICLE_ART[def.art];
  if (!builder) throw new Error(`buildVehicleTextures: unknown vehicle art '${def.art}'`);
  builder(scene, texKey, def);
}

export { VEHICLE_ART };
