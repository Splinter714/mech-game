// Broodwalker art (#130) — a slow, tanky four-legged ground unit: a squat armoured HULL
// standing on FOUR splayed mechanical legs (distinct from tank's paired tracks), topped by a
// boxy TURRET with a forward gun barrel (aims at the player independently, same hull-vs-turret
// decoupling as the tank/turret pattern) plus a rear "deploy hatch" detail that hints at the
// drones/infantry it periodically releases (the actual deploy mechanic lives in data —
// enemyKinds.js `deployEveryMs`/`deployCap` — and behavior — enemyBehaviors.js
// `quadrupedBehavior` — this file only draws the silhouette).
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC, poly } from '../mechPrims.js';
import { VEHICLE as V, accentGlow } from './palette.js';

// Hull + four splayed legs, drawn pointing "up" (−y = forward). A wide four-point stance (front
// pair angled forward, rear pair angled back) reads as a quadruped rather than tank tracks.
function drawHull(sg, accent) {
  // Ground shadow — wide, to match the four-point footprint.
  ellipseC(sg, 0, 5, 32, 28, V.deep, 0.35);

  // Four stubby mechanical legs with foot pads.
  const legs = [
    { x: -17, y: -12 }, { x: 17, y: -12 },   // front-left / front-right
    { x: -18, y: 13 }, { x: 18, y: 13 },     // rear-left / rear-right
  ];
  for (const { x, y } of legs) {
    roundC(sg, x, y, 7, 15, V.outline, 3);
    roundC(sg, x, y, 5, 12, V.tread, 2.5);
    for (const ly of [-4, 1, 6]) rectC(sg, x, y + ly, 4.6, 1.4, V.treadHi, 0.85);   // leg-strut rungs
    ellipseC(sg, x, y + 8, 4.6, 3, V.deep, 0.65);   // foot pad
  }

  // Central hull tub between the four legs.
  poly(sg, [[-11, -12], [11, -12], [12, 12], [-12, 12]], V.outline);
  poly(sg, [[-9.5, -11], [9.5, -11], [10.5, 11], [-10.5, 11]], V.bodyDk);
  poly(sg, [[-8, -10], [8, -10], [8.5, -2], [-8.5, -2]], V.body);
  poly(sg, [[-6.5, -10], [6.5, -10], [7, -5.5], [-7, -5.5]], V.bodyHi);
  // Rear engine/vent deck.
  rectC(sg, 0, 8, 13, 6, V.bodyDk);
  for (const y of [6.5, 8, 9.5]) rectC(sg, 0, y, 11, 1, V.tread, 0.8);
  // Hazard accent stripe.
  rectC(sg, 0, -9, 9, 1.4, accent, 0.7);
}

// Rotating turret: a flatter, boxier housing than tank's rounded cast turret (distinct
// silhouette), a rear "deploy hatch" panel, a sensor eye, and a forward gun barrel.
function drawTurret(sg, accent) {
  const A = accentGlow(accent);
  // Turret housing.
  roundC(sg, 0, 1, 19, 15, V.outline, 4);
  roundC(sg, 0, 1, 16, 12, V.body, 3.5);
  roundC(sg, 0, 0, 12, 8, V.bodyHi, 3);
  // Rear deploy hatch — a darker recessed panel with an accent seam, hinting at the unit
  // releasing drones/infantry from its back.
  roundC(sg, 0, 9, 10, 6, V.deep, 2);
  rectC(sg, 0, 9, 7, 1.4, accent, 0.75);
  // Sensor eye (accent "danger" glow).
  ellipseC(sg, -4, -2, 3, 2.6, V.outline);
  ellipseC(sg, -4, -2, 1.7, 1.4, A.core, 0.95);
  // Mantlet + forward gun barrel.
  rectC(sg, 0, -9, 7, 5, V.outline);
  rectC(sg, 0, -18, 4.4, 20, V.outline);
  rectC(sg, 0, -18, 2.6, 20, V.tread);
  rectC(sg, -0.8, -18, 0.8, 18, V.treadHi, 0.7);
  // Muzzle glow.
  ellipseC(sg, 0, -28, 2.4, 1.9, A.hot, 0.85);
  ellipseC(sg, 0, -28, 3.8, 2.9, A.halo, 0.3);
}

export function drawQuadruped(scene, key, def) {
  const accent = def.themeColor ?? V.rim;
  const D = DESIGN * ART_SCALE;
  gen(scene, `${key}_hull`, D, D, (g) => drawHull(scaledGraphics(g), accent));
  gen(scene, `${key}_turret`, D, D, (g) => drawTurret(scaledGraphics(g), accent));
}
