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
  // Central pod. #379 follow-up (playtest: drone BODY too big relative to its rotors) — the
  // central pod is shrunk ~30% while the rotor booms (ARMS, ±8) and their rotor discs are left
  // exactly where they were, so the airframe reads as the same size but the body it carries is
  // noticeably smaller/leaner. The shield-glow rim traces this same hull silhouette, so it hugs
  // the leaner body automatically (shieldOutlineParts: ['hull'] in enemyKinds.js).
  poly(sg, [[-4.5, -3.8], [4.5, -3.8], [5.2, 3.8], [-5.2, 3.8]], V.halo);   // #129
  poly(sg, [[-3.5, -2.8], [3.5, -2.8], [4.2, 2.8], [-4.2, 2.8]], V.outline);
  poly(sg, [[-2.8, -2.1], [2.8, -2.1], [3.5, 2.1], [-3.5, 2.1]], V.bodyHi);
  // Forward sensor eye (accent glow), pointing −y — pulled in to sit on the smaller pod's nose.
  ellipseC(sg, 0, -2.2, 2, 1.9, V.outline);
  ellipseC(sg, 0, -2.2, 1.2, 1.1, A.core, 0.95);
  ellipseC(sg, 0, -2.2, 2.8, 2.5, A.halo, 0.25);
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
