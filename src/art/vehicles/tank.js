// Battle Tank art — a ground vehicle: a long armoured HULL flanked by two heavy tracks
// (the hull faces its travel direction), topped by a rotating TURRET with a long forward
// barrel (aims at the player independently). Reads unmistakably as a tank: tracks down each
// side, a boxy sloped glacis at the front, a rounded turret with a big gun.
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC, poly } from '../mechPrims.js';
import { VEHICLE as V, accentGlow } from './palette.js';

// Hull + two tracks, drawn pointing "up" (−y = forward). The front is a sloped glacis (tough
// frontal facing); the tracks are dark ribbed bands down each side.
function drawHull(sg, accent) {
  // Ground shadow.
  ellipseC(sg, 0, 4, 34, 30, V.deep, 0.35);

  // Tracks (left + right dark ribbed bands running fore-aft).
  for (const sx of [-13, 13]) {
    roundC(sg, sx, 2, 9, 34, V.outline, 3);
    roundC(sg, sx, 2, 6.5, 32, V.tread, 2.5);
    // Track lugs (rungs) — a stack of light ticks so it reads as a moving belt.
    for (let y = -13; y <= 15; y += 4) rectC(sg, sx, y, 6.5, 1.6, V.treadHi, 0.9);
    // Road wheels hint (darker circles under the lugs).
    for (const y of [-9, -1, 7]) ellipseC(sg, sx, y, 3, 3, V.deep, 0.7);
  }

  // Central hull tub between the tracks.
  poly(sg, [[-9, -13], [9, -13], [10, 14], [-10, 14]], V.outline);
  poly(sg, [[-8, -12], [8, -12], [9, 13], [-9, 13]], V.bodyDk);
  // Sloped glacis plate at the FRONT (tough frontal facing) — a lighter trapezoid up top.
  poly(sg, [[-7, -13], [7, -13], [8, -4], [-8, -4]], V.body);
  poly(sg, [[-6, -13], [6, -13], [6.5, -8], [-6.5, -8]], V.bodyHi);
  // Rear engine deck with grilles.
  rectC(sg, 0, 9, 14, 8, V.bodyDk);
  for (const y of [7, 9, 11]) rectC(sg, 0, y, 12, 1, V.tread, 0.8);
  // A hazard accent stripe on the glacis.
  rectC(sg, 0, -11, 10, 1.4, accent, 0.7);
}

// Rotating turret: a rounded cast body, a mantlet, a long forward gun, and a commander hatch.
function drawTurret(sg, accent) {
  const A = accentGlow(accent);
  // Turret body.
  roundC(sg, 0, 0, 20, 17, V.outline, 6);
  roundC(sg, 0, 0, 17, 14, V.body, 5);
  roundC(sg, 0, -1, 13, 9, V.bodyHi, 4);
  // Commander cupola / hatch.
  ellipseC(sg, 4, 3, 6, 5, V.bodyDk);
  ellipseC(sg, 4, 3, 3.6, 3.2, V.rim, 0.9);
  // Sighting optic (accent eye).
  ellipseC(sg, -4, -2, 3.2, 2.8, V.outline);
  ellipseC(sg, -4, -2, 1.8, 1.6, A.core, 0.95);
  // Mantlet + long gun (forward, −y).
  rectC(sg, 0, -10, 8, 6, V.outline);
  rectC(sg, 0, -20, 5, 22, V.outline);
  rectC(sg, 0, -20, 3, 22, V.tread);
  rectC(sg, -0.9, -20, 0.8, 20, V.treadHi, 0.7);
  // Muzzle brake + hot tip.
  rectC(sg, 0, -30, 5, 3.5, V.bodyDk);
  ellipseC(sg, 0, -31, 2.6, 2, A.hot, 0.85);
  ellipseC(sg, 0, -31, 4, 3, A.halo, 0.3);
}

export function drawTank(scene, key, def) {
  const accent = def.themeColor ?? V.rim;
  const D = DESIGN * ART_SCALE;
  gen(scene, `${key}_hull`, D, D, (g) => drawHull(scaledGraphics(g), accent));
  gen(scene, `${key}_turret`, D, D, (g) => drawTurret(scaledGraphics(g), accent));
}
