// Gunship / VTOL art — a fast attack helicopter: a sleek forward-pointing FUSELAGE with a
// bubble cockpit, stub wings carrying missile pods, a tail boom with a tail rotor, and a big
// MAIN ROTOR disc on top that spins. The HULL is the airframe (fuselage + wings + tail); the
// TURRET is the main rotor disc (rotated each frame so it reads as spinning). A flyer, so the
// scene draws a large drop shadow beneath it — the headline "this one is up in the air" cue.
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC, poly } from '../mechPrims.js';
import { VEHICLE as V, accentGlow, haloRound, haloPoly, haloRect, haloEllipse } from './palette.js';

// Airframe pointing "up" (−y = nose forward): nose/cockpit, main body, stub wings + missile
// pods, tail boom + tail rotor.
function drawAirframe(sg, accent) {
  const A = accentGlow(accent);
  // Tail boom (runs backward, +y) with a fin + tail rotor. #129: a legibility-halo pass drawn
  // first, oversized, behind every exterior V.outline shape below (see mechPrims.js's `HALO`).
  haloPoly(sg, [[-3.6, 3.2], [3.6, 3.2], [2.4, 23.2], [-2.4, 23.2]]);
  poly(sg, [[-2.5, 4], [2.5, 4], [1.6, 22], [-1.6, 22]], V.outline);
  poly(sg, [[-1.8, 4], [1.8, 4], [1.1, 21], [-1.1, 21]], V.bodyDk);
  haloPoly(sg, [[-2.4, 15.2], [2.4, 15.2], [5.2, 25.2], [-1.8, 25.2]]);
  poly(sg, [[-1.6, 16], [1.6, 16], [4, 24], [-1, 24]], V.body);   // tail fin
  // Tail rotor.
  rectC(sg, 2, 22, 1, 9, V.tread);
  ellipseC(sg, 2, 22, 1.6, 1.6, V.rim);

  // Stub wings with missile pods (the streak launchers).
  for (const sx of [-1, 1]) {
    haloPoly(sg, [[sx * 3.4, -3.6], [sx * 13.6, -1.4], [sx * 13.6, 5.6], [sx * 3.4, 5.6]]);   // #129
    poly(sg, [[sx * 3, -2], [sx * 12, 0], [sx * 12, 4], [sx * 3, 4]], V.outline);
    poly(sg, [[sx * 3.5, -1], [sx * 11, 0.5], [sx * 11, 3], [sx * 3.5, 3]], V.bodyHi);
    // Missile pod (a small barrelled block, warm accent tips).
    haloRound(sg, sx * 11, 2, 6.6, 7.6, 2.8);   // #129
    roundC(sg, sx * 11, 2, 5, 6, V.tread, 2);
    for (const dy of [-1.5, 1.5]) ellipseC(sg, sx * 11, 2 + dy, 1, 1, A.core, 0.9);
  }

  // Main fuselage body.
  haloPoly(sg, [[-6.4, -9.6], [6.4, -9.6], [7.4, 7.6], [-7.4, 7.6]]);   // #129
  poly(sg, [[-5, -8], [5, -8], [6, 6], [-6, 6]], V.outline);
  poly(sg, [[-4, -7], [4, -7], [5, 5], [-5, 5]], V.body);
  poly(sg, [[-3.5, -6], [3.5, -6], [4, 2], [-4, 2]], V.bodyHi);
  // Nose chin gun.
  haloRect(sg, 0, -13, 4, 8.6);   // #129
  rectC(sg, 0, -13, 2.4, 7, V.outline);
  rectC(sg, 0, -13, 1.4, 7, V.tread);
  ellipseC(sg, 0, -17, 2, 1.6, A.hot, 0.85);

  // Bubble cockpit canopy (glass) up front.
  haloEllipse(sg, 0, -7, 7.4, 7.4);   // #129
  ellipseC(sg, 0, -7, 6, 6, V.outline);
  ellipseC(sg, 0, -7, 4.6, 5, V.glass);
  ellipseC(sg, -1.4, -8.5, 1.8, 2, V.rimHi, 0.7);   // glare
  // Rotor mast hub (centre) — the turret rotor pivots around here.
  ellipseC(sg, 0, -1, 3, 3, V.tread);
  ellipseC(sg, 0, -1, 1.6, 1.6, V.rim);
}

// Main rotor disc: two long blades + a translucent blur ring. Rotated each frame in the scene.
function drawRotor(sg) {
  // Blur disc.
  ellipseC(sg, 0, -1, 30, 30, V.rimHi, 0.1);
  ellipseC(sg, 0, -1, 26, 26, V.rimHi, 0.06);
  // Two blades crossing the hub.
  rectC(sg, 0, -1, 58, 2.4, V.outline, 0.55);
  rectC(sg, 0, -1, 58, 1.2, V.rimHi, 0.6);
  rectC(sg, 0, -1, 2.4, 20, V.outline, 0.4);
}

export function drawHelicopter(scene, key, def) {
  const accent = def.themeColor ?? V.rim;
  const D = DESIGN * ART_SCALE;
  gen(scene, `${key}_hull`, D, D, (g) => drawAirframe(scaledGraphics(g), accent));
  gen(scene, `${key}_turret`, D, D, (g) => drawRotor(scaledGraphics(g)));
}
