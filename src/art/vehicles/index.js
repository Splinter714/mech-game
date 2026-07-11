// Non-mech VEHICLE art registry. Each enemy kind (data/enemyKinds.js) names an `art` key; this
// maps that key to a builder that draws the unit's `<key>_hull` + `<key>_turret` textures. The
// arena calls buildVehicleTextures(scene, texKey, def) on spawn. Adding a new non-mech unit's
// art = one entry here + its draw module — dispatch is a registry lookup, never a variant branch.
import { drawTurret } from './turret.js';
import { drawTank } from './tank.js';
import { drawDrone } from './drone.js';
import { drawHelicopter } from './helicopter.js';
import { drawInfantry } from './infantry.js';

const VEHICLE_ART = {
  turret: drawTurret,
  tank: drawTank,
  drone: drawDrone,
  helicopter: drawHelicopter,
  infantry: drawInfantry,
};

// Build the two textures (`<texKey>_hull`, `<texKey>_turret`) for one non-mech unit, from its
// kind def (`def.art` selects the builder). No-op with a clear throw if the art key is unknown.
export function buildVehicleTextures(scene, texKey, def) {
  const builder = VEHICLE_ART[def.art];
  if (!builder) throw new Error(`buildVehicleTextures: unknown vehicle art '${def.art}'`);
  builder(scene, texKey, def);
}

export { VEHICLE_ART };
