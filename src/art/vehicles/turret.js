// Sentry Turret art — a static emplacement: a squat armoured, sandbagged base (the HULL,
// which never rotates) with a stubby rotating gun housing + barrel on top (the TURRET, which
// tracks the player). Reads as "rooted gun tower" — wider at the base, gun sticking forward.
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC, poly, glowBar } from '../mechPrims.js';
import { VEHICLE as V, accentGlow } from './palette.js';

// The immobile base: an octagonal armoured pad with bolt studs and an ammo drum, sitting low.
function drawBase(sg, accent) {
  // Ground shadow / footing.
  ellipseC(sg, 0, 8, 30, 12, V.deep, 0.9);
  // Octagonal base plate.
  poly(sg, [[-13, 2], [-8, -4], [8, -4], [13, 2], [13, 10], [8, 16], [-8, 16], [-13, 10]], V.outline);
  poly(sg, [[-11, 3], [-7, -2], [7, -2], [11, 3], [11, 9], [7, 14], [-7, 14], [-11, 9]], V.bodyDk);
  poly(sg, [[-9, 3], [-6, -1], [6, -1], [9, 3], [9, 8], [6, 12], [-6, 12], [-9, 8]], V.body);
  // Bolt studs around the rim (armoured foundation read).
  for (const [x, y] of [[-9, 4], [9, 4], [-7, 12], [7, 12], [0, -2]]) ellipseC(sg, x, y, 2.2, 2.2, V.rim);
  // Ammo drum on the base (warm accent so it reads as ordnance).
  roundC(sg, -8, 10, 8, 6, V.tread, 2);
  rectC(sg, -8, 10, 6, 3.5, accent, 0.8);
}

// The rotating gun: a rounded housing + a heavy forward barrel with a hot muzzle.
function drawGun(sg, accent) {
  const A = accentGlow(accent);
  // Housing (the pivoting mass).
  roundC(sg, 0, 0, 16, 13, V.outline, 4);
  roundC(sg, 0, 0, 13, 10, V.bodyHi, 3.5);
  roundC(sg, 0, -1, 9, 6, V.rim, 3);
  // A sensor eye — the accent "danger" glow.
  ellipseC(sg, 0, -1, 4, 3.5, V.outline);
  ellipseC(sg, 0, -1, 2.6, 2.4, A.core, 0.95);
  // Heavy barrel forward (−y).
  rectC(sg, 0, -13, 6, 20, V.outline);
  rectC(sg, 0, -13, 3.6, 20, V.tread);
  rectC(sg, -1.4, -13, 1, 18, V.treadHi, 0.8);
  // Muzzle glow.
  ellipseC(sg, 0, -22, 3, 2.4, A.hot, 0.9);
  ellipseC(sg, 0, -22, 4.5, 3.4, A.halo, 0.35);
}

export function drawTurret(scene, key, def) {
  const accent = def.themeColor ?? V.rim;
  const D = DESIGN * ART_SCALE;
  gen(scene, `${key}_hull`, D, D, (g) => drawBase(scaledGraphics(g), accent));
  gen(scene, `${key}_turret`, D, D, (g) => drawGun(scaledGraphics(g), accent));
}
