// Battle Tank art — a ground vehicle: a long armoured HULL flanked by two heavy tracks
// (the hull faces its travel direction), topped by a rotating TURRET with a long forward
// barrel (aims at the player independently). Reads unmistakably as a tank: tracks down each
// side, a boxy sloped glacis at the front, a rounded turret with a big gun.
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC, poly, armorShell } from '../mechPrims.js';
import { VEHICLE as V, accentGlow } from './palette.js';

// Hull + two tracks, drawn pointing "up" (−y = forward). The front is a sloped glacis (tough
// frontal facing); the tracks are dark ribbed bands down each side.
// #294 (playtest: "tanks need to be less wide so they're more rectangular, less square"): the
// old silhouette was ~36.6px wide by ~35.6px tall (near-1:1) once the tracks' outer edges were
// counted — that read as squat/square rather than a tank's long low profile. Narrowed the track
// offset/width and the hull tub's x-extent, and lengthened both the tracks and hull tub's
// y-extent, so the outer silhouette is now ~29px wide by ~44px tall (~1:1.5, clearly
// longer-than-wide) while keeping the same visual language (tracks down each side, sloped
// glacis front, rear engine deck) — a proportion tweak, not a redesign.
// #328: EXPORTED so the Carrier (art/vehicles/carrier.js) can draw the literal same tank body
// rather than forking a near-copy of it — Jackson asked to "re-use tank art exactly, but minus
// the tank turret." Any future tweak to the tank's silhouette therefore lands on both units by
// construction; there is no second copy of this to keep in sync.
export function drawTankHull(sg, accent, armored = false) {
  // Ground shadow.
  ellipseC(sg, 0, 5, 28, 38, V.deep, 0.35);

  // Tracks (left + right dark ribbed bands running fore-aft).
  for (const sx of [-10, 10]) {
    roundC(sg, sx, 2, 9, 44, V.halo, 3.8);   // #129: legibility halo (outer ring)
    roundC(sg, sx, 2, 7.6, 42.4, V.outline, 3);
    roundC(sg, sx, 2, 5.4, 40, V.tread, 2.5);
    // Track lugs (rungs) — a stack of light ticks so it reads as a moving belt.
    for (let y = -17; y <= 19; y += 4) rectC(sg, sx, y, 5.4, 1.6, V.treadHi, 0.9);
    // Road wheels hint (darker circles under the lugs).
    for (const y of [-11, 1, 13]) ellipseC(sg, sx, y, 2.6, 2.6, V.deep, 0.7);
  }

  // Central hull tub between the tracks.
  poly(sg, [[-8.6, -18], [8.6, -18], [9.6, 20], [-9.6, 20]], V.halo);   // #129
  poly(sg, [[-7.4, -16], [7.4, -16], [8.2, 17], [-8.2, 17]], V.outline);
  poly(sg, [[-6.6, -15], [6.6, -15], [7.2, 16], [-7.2, 16]], V.bodyDk);
  // Sloped glacis plate at the FRONT (tough frontal facing) — a lighter trapezoid up top.
  poly(sg, [[-6, -16], [6, -16], [6.6, -7], [-6.6, -7]], V.body);
  poly(sg, [[-5, -16], [5, -16], [5.4, -11], [-5.4, -11]], V.bodyHi);
  // Rear engine deck with grilles.
  rectC(sg, 0, 13, 12, 9, V.bodyDk);
  for (const y of [11, 13, 15]) rectC(sg, 0, y, 10, 1, V.tread, 0.8);
  // A hazard accent stripe on the glacis.
  rectC(sg, 0, -13, 8, 1.4, accent, 0.7);
  // #300: while the unit's armor pool is > 0, overlay the SHARED plating primitive (mechPrims'
  // `armorShell` — the very same function the player mech and enemy mechs draw) over the hull
  // tub, so a reworked armor look propagates everywhere in one edit. Sized to the tub's own
  // silhouette (not the tracks — treads read as running gear, not plating).
  if (armored) armorShell(sg, 0, 0.5, 15.5, 33);
}

// Rotating turret: a rounded cast body, a mantlet, a long forward gun, and a commander hatch.
function drawTurret(sg, accent, armored = false) {
  const A = accentGlow(accent);
  // Turret body.
  roundC(sg, 0, 0, 21.6, 18.6, V.halo, 6.8);   // #129: legibility halo (outer ring)
  roundC(sg, 0, 0, 20, 17, V.outline, 6);
  roundC(sg, 0, 0, 17, 14, V.body, 5);
  roundC(sg, 0, -1, 13, 9, V.bodyHi, 4);
  // Commander cupola / hatch.
  ellipseC(sg, 4, 3, 6, 5, V.bodyDk);
  ellipseC(sg, 4, 3, 3.6, 3.2, V.rim, 0.9);
  // Sighting optic (accent eye).
  ellipseC(sg, -4, -2, 3.2, 2.8, V.outline);
  ellipseC(sg, -4, -2, 1.8, 1.6, A.core, 0.95);
  // Mantlet + long gun (forward, −y). The gun juts well past the turret body's own halo ring,
  // out into open ground, so it needs its own halo pass too.
  rectC(sg, 0, -10, 9.6, 7.6, V.halo);   // #129
  rectC(sg, 0, -10, 8, 6, V.outline);
  rectC(sg, 0, -20, 6.6, 23.6, V.halo);   // #129
  rectC(sg, 0, -20, 5, 22, V.outline);
  rectC(sg, 0, -20, 3, 22, V.tread);
  rectC(sg, -0.9, -20, 0.8, 20, V.treadHi, 0.7);
  // Muzzle brake + hot tip.
  rectC(sg, 0, -30, 6.6, 5.1, V.halo);   // #129
  rectC(sg, 0, -30, 5, 3.5, V.bodyDk);
  ellipseC(sg, 0, -31, 2.6, 2, A.hot, 0.85);
  ellipseC(sg, 0, -31, 4, 3, A.halo, 0.3);
  // #300: shared plating overlay on the turret mass (see drawHull) — the gun barrel is left
  // bare, same reasoning as the tracks.
  if (armored) armorShell(sg, 0, 0, 17, 14);
}

// `opts.armored` (#300) draws the shared armorShell plating over the hull tub + turret body.
export function drawTank(scene, key, def, opts = {}) {
  const accent = def.themeColor ?? V.rim;
  const armored = !!opts.armored;
  const D = DESIGN * ART_SCALE;
  gen(scene, `${key}_hull`, D, D, (g) => drawTankHull(scaledGraphics(g), accent, armored));
  gen(scene, `${key}_turret`, D, D, (g) => drawTurret(scaledGraphics(g), accent, armored));
}
