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
import { bakeShellTextures } from '../_frames.js';
import { SHIELD_SHELL_PAD, SHIELD_SHELL_SUFFIX } from '../mechArt.js';
import { vehicleScaleFactor } from '../../data/unitScale.js';

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
  // #639: and again as a SHELL pass — the exact same builder re-run through
  // `bakeShellTextures`, which redirects every `gen` inside it to bake the DILATED version of
  // that draw under `<key>_shield` instead. That is the raster the shield / plasma-coat outline
  // draws (scenes/arena/shieldOutline.js), and re-running the builder rather than hand-listing
  // each sprite is what guarantees a vehicle can never end up with a shell for only some of its
  // sprites, or a new kind's art module ship without one — the drift #302 forbids, and exactly
  // what left every non-player unit on the pre-#422 scaled-duplicate look until now.
  // Runs once per kind+theme, on the first spawn of that kind (see enemies.js `_spawnKind`).
  bakeShellTextures(shellPadFor(def), SHIELD_SHELL_SUFFIX, () => builder(scene, texKey, def));
}

// How far to dilate ONE kind's shell, in design units. `SHIELD_SHELL_PAD` is tuned for a mech, and
// a mech draws at ARENA_MECH_SCALE flat — a vehicle draws at that times its own `scale`, so baking
// the same design-unit pad into a drone (0.35×) would put a third as much rim on screen as the
// player wears. Dividing by the kind's own scale factor cancels that out, so every unit in the game
// wears a rim of the SAME on-screen thickness, which is what "the same as the player's shield"
// actually means. Purely data-derived (`def.scale`), so no arena constant leaks into art code.
//
// Capped because the compensation runs away on the smallest units: the infantry trooper (0.19×)
// would want 5.3 design units of dilation, and its whole body is only a handful of units across —
// the shell would swallow the trooper rather than rim it. At 3× every other kind (helicopter and
// carrier 0.6, tank 0.4, drone 0.35, wall turret 0.34) is fully compensated and only infantry —
// which has no shield pool at all, so this is its plasma-coat outline only — is clamped.
const SHELL_PAD_MAX_MULT = 3;
function shellPadFor(def) {
  const factor = vehicleScaleFactor(def) || 1;
  return SHIELD_SHELL_PAD * Math.min(SHELL_PAD_MAX_MULT, 1 / factor);
}

export { VEHICLE_ART };
