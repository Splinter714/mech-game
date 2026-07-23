// Shared palette + tiny helpers for the non-mech VEHICLE art (turret / tank / drone /
// helicopter). These units now read as the SAME sleek WHITE faction as the player + enemy
// mechs (mirrors the `enemy` mech theme in mechPrims.js: dark outline, pale ceramic panels,
// a bright rim) rather than a separate dark industrial one. Each kind still passes its own
// `accent` colour (from ENEMY_KINDS.themeColor) so they differ from ONE ANOTHER on the
// "danger" bits (gun glow, sensor eye, rotor hub) — just on a light body now.
//
// Contrast: the biomes include arctic/snow (light terrain). A white body could vanish on
// snow, so the SILHOUETTE is carried by the dark `outline` (drawn around every plate) plus a
// darker `deep` used for the ground/drop shadow — both read against snow AND dark volcanic
// terrain. `tread` stays a mid-dark grey so tracks/barrels/guns pop off the pale panels.
// Design coords match mechPrims (origin = centre, −y = forward), so builders can reuse
// rectC/roundC/ellipseC/poly.

import { poly, rectC, roundC, ellipseC } from '../mechPrims.js';

export const VEHICLE = {
  outline: 0x2b3441,      // dark blue-grey edge — carries the silhouette on snow + volcanic
  // #129: an extra near-white ring drawn OUTSIDE `outline` on every exterior silhouette shape.
  // `outline` alone reads fine against LIGHT terrain (snow, sand) but nearly matches DARK
  // terrain (volcanic ash, night grass/urban) in tone, so the silhouette vanished there — see
  // the long comment on mechPrims.js's `HALO` for the full reasoning. `halo` mirrors that same
  // fixed colour so vehicles and mechs use one consistent legibility treatment.
  halo: 0xfbfdff,
  deep: 0x39424f,         // shadow / underside / ground-drop shadow (kept dark so it reads on snow)
  bodyDk: 0xb6c2cf,       // lower body panel (subtle grey shading)
  body: 0xd3dae2,         // main body panel (pale)
  bodyHi: 0xeef2f6,       // upper body panel (near-white highlight)
  rim: 0xf6f9fb,          // top highlight rim (overhead light)
  rimHi: 0xffffff,        // brightest edge
  tread: 0x5a6675,        // tank track / barrel / dark mechanical (mid-dark, pops off white)
  treadHi: 0x8b97a6,      // track lug / barrel highlight
  glass: 0x51616f,        // cockpit glass (cool tint, darker so the canopy reads)
};

// #421: the halo above is a bright ring, which does nothing on a bright biome — on snow/sand a
// pale vehicle wrapped in a white ring reads as a blob with a hairline dark `outline` buried
// inside it. Every halo shape is now drawn as a PAIR: a near-black edge ring first, the bright
// halo on top of it. Whatever the ground tone, one of the two is always in strong contrast.
// The helpers below are the ONLY way vehicle art should draw a halo shape, so the pairing can't
// drift apart per call site. `EDGE_W` is the dark ring's thickness in design units — deliberately
// thin (≈1.4 display px at arena scale); this is a contrast edge, not a cartoon outline.
export const EDGE_W = 1.0;
export const VEHICLE_EDGE = 0x121821;   // matches mechPrims HALO_EDGE

// Rounded rect / ellipse / rect halo shapes: the same box grown by EDGE_W on every side.
export function haloRound(sg, cx, cy, w, h, r) {
  roundC(sg, cx, cy, w + EDGE_W * 2, h + EDGE_W * 2, VEHICLE_EDGE, r + EDGE_W);
  roundC(sg, cx, cy, w, h, VEHICLE.halo, r);
}
export function haloEllipse(sg, cx, cy, w, h) {
  ellipseC(sg, cx, cy, w + EDGE_W * 2, h + EDGE_W * 2, VEHICLE_EDGE);
  ellipseC(sg, cx, cy, w, h, VEHICLE.halo);
}
export function haloRect(sg, cx, cy, w, h) {
  rectC(sg, cx, cy, w + EDGE_W * 2, h + EDGE_W * 2, VEHICLE_EDGE);
  rectC(sg, cx, cy, w, h, VEHICLE.halo);
}
// Polygon halo shape. The dark copy pushes each vertex OUTWARD by EDGE_W on each axis (sign of
// its offset from the shape's mean point), which grows a convex hull/quad by a constant margin
// laterally AND lengthwise — unlike scaling, which would grow a long thin boom mostly along its
// length and leave the sides unchanged.
export function haloPoly(sg, pts) {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  poly(sg, pts.map(([x, y]) => [x + Math.sign(x - mx) * EDGE_W, y + Math.sign(y - my) * EDGE_W]), VEHICLE_EDGE);
  poly(sg, pts, VEHICLE.halo);
}

// A warm-accent glow ramp derived from a kind's accent colour, for the "hot" bits.
export function accentGlow(accent) {
  return { core: accent, hot: 0xffe6c0, halo: accent };
}
