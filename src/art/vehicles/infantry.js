// Infantry Trooper art (#97) — a small ground-swarm unit, individually meaningless, drawn as a
// simple humanoid silhouette in the same white mech-faction palette as the other vehicles. Kept
// deliberately plain (a blob body + a small head + a stick rifle) since a mob of these renders
// tiny on screen — no point drawing detail nobody will see. The HULL is the body/legs (faces
// travel); the TURRET is just the rifle, so it swings to point at the player independently,
// mirroring the tank's hull-vs-turret split at trooper scale.
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC } from '../mechPrims.js';
import { VEHICLE as V, accentGlow } from './palette.js';

// The body: a squat rounded torso over two stubby legs, plus a small head. No arms — the rifle
// (drawn on the turret layer) reads as held across the body.
function drawBody(sg, accent) {
  const A = accentGlow(accent);
  // Ground contact shadow (small — a trooper barely casts one).
  ellipseC(sg, 0, 6, 6, 3, V.deep, 0.5);
  // Legs (two short dark stumps).
  rectC(sg, -2.4, 4, 2.2, 7, V.tread);
  rectC(sg, 2.4, 4, 2.2, 7, V.tread);
  // Torso.
  roundC(sg, 0, -1, 5, 7, V.outline, 2.5);
  roundC(sg, 0, -1.5, 3.6, 5.6, V.body, 2);
  roundC(sg, 0, -3, 3, 3, V.bodyHi, 1.5);
  // A faction accent chevron on the chest.
  rectC(sg, 0, -2, 3.2, 1, accent, 0.85);
  // Head (small round helmet).
  ellipseC(sg, 0, -8, 3, 3, V.outline);
  ellipseC(sg, 0, -8, 2, 2, V.bodyHi);
  // Visor glow (accent "danger" eye, tiny at this scale).
  ellipseC(sg, 0, -8, 1, 0.9, A.core, 0.9);
}

// The rifle: a short stick held forward, tracks the player independently of the body.
function drawRifle(sg, accent) {
  const A = accentGlow(accent);
  rectC(sg, 0, -6, 1.2, 12, V.tread);
  rectC(sg, -0.4, -6, 0.5, 10, V.treadHi, 0.7);
  ellipseC(sg, 0, -12, 1.2, 1, A.hot, 0.8);
}

export function drawInfantry(scene, key, def) {
  const accent = def.themeColor ?? V.rim;
  const D = DESIGN * ART_SCALE;
  gen(scene, `${key}_hull`, D, D, (g) => drawBody(scaledGraphics(g), accent));
  gen(scene, `${key}_turret`, D, D, (g) => drawRifle(scaledGraphics(g), accent));
}
