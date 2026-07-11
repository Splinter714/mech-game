// Recon Drone art — a small, cheap hovering quad-rotor: a tiny central pod with four stubby
// arms ending in fast spinning rotors, and a single glowing sensor eye. Individually weak, so
// it's drawn small and light; the swarm's numbers do the work. The HULL is the airframe (arms +
// pod); the TURRET is a subtle spinning-rotor overlay so a few frames of rotation read as "the
// rotors are turning." Flyers draw a drop shadow in the scene (they're elevated).
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, ellipseC, poly } from '../mechPrims.js';
import { VEHICLE as V, accentGlow } from './palette.js';

const ARMS = [[-8, -8], [8, -8], [-8, 8], [8, 8]];   // the four rotor-boom tips (design coords)

// The airframe: an X of booms, a central pod, and a forward-facing sensor eye.
function drawFrame(sg, accent) {
  const A = accentGlow(accent);
  // Cross booms.
  for (const [x, y] of ARMS) {
    // #129: legibility halo — a wider white stroke UNDER the dark outline stroke, so the boom
    // still has a visible edge on dark terrain (where the dark outline alone would vanish).
    sg.raw.lineStyle(4 * ART_SCALE, V.halo, 1);
    sg.raw.lineBetween((DESIGN / 2) * ART_SCALE, (DESIGN / 2) * ART_SCALE, (DESIGN / 2 + x) * ART_SCALE, (DESIGN / 2 + y) * ART_SCALE);
    sg.raw.lineStyle(2.4 * ART_SCALE, V.outline, 1);
    sg.raw.lineBetween((DESIGN / 2) * ART_SCALE, (DESIGN / 2) * ART_SCALE, (DESIGN / 2 + x) * ART_SCALE, (DESIGN / 2 + y) * ART_SCALE);
    sg.raw.lineStyle(1.4 * ART_SCALE, V.rim, 0.9);
    sg.raw.lineBetween((DESIGN / 2) * ART_SCALE, (DESIGN / 2) * ART_SCALE, (DESIGN / 2 + x) * ART_SCALE, (DESIGN / 2 + y) * ART_SCALE);
    // Rotor hub at each tip.
    ellipseC(sg, x, y, 3.9, 3.9, V.halo);   // #129
    ellipseC(sg, x, y, 3, 3, V.tread);
    ellipseC(sg, x, y, 1.6, 1.6, A.core, 0.8);
  }
  // Central pod.
  poly(sg, [[-6.4, -5.4], [6.4, -5.4], [7.4, 5.4], [-7.4, 5.4]], V.halo);   // #129
  poly(sg, [[-5, -4], [5, -4], [6, 4], [-6, 4]], V.outline);
  poly(sg, [[-4, -3], [4, -3], [5, 3], [-5, 3]], V.bodyHi);
  // Forward sensor eye (accent glow), pointing −y.
  ellipseC(sg, 0, -3, 2.6, 2.4, V.outline);
  ellipseC(sg, 0, -3, 1.5, 1.4, A.core, 0.95);
  ellipseC(sg, 0, -3, 3.6, 3.2, A.halo, 0.25);
  // A tiny under-slung gun barrel.
  rectC(sg, 0, -6, 1.4, 4, V.tread);
}

// Spinning rotor disc overlay: faint translucent blur rings at each tip. As the scene rotates
// this sprite the blur reads as spinning blades.
function drawRotors(sg) {
  for (const [x, y] of ARMS) {
    ellipseC(sg, x, y, 5.5, 5.5, V.rimHi, 0.16);
    // A couple of blade streaks.
    rectC(sg, x, y, 10, 1, V.rimHi, 0.28);
    rectC(sg, x, y, 1, 10, V.rimHi, 0.18);
  }
}

export function drawDrone(scene, key, def) {
  const accent = def.themeColor ?? V.rim;
  const D = DESIGN * ART_SCALE;
  gen(scene, `${key}_hull`, D, D, (g) => drawFrame(scaledGraphics(g), accent));
  gen(scene, `${key}_turret`, D, D, (g) => drawRotors(scaledGraphics(g)));
}
