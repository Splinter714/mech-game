// #310: Wall Lance art — the rail-lance gun mounted on a base wall's parapet.
//
// THE DESIGN PROBLEM this solves is that a free-standing sentry-turret silhouette reads as a thing standing
// ON THE GROUND: it has a ground shadow, a wide octagonal footing, sandbag mass. Reused as-is on a
// wall it would look like a turret that happened to be standing in front of the wall — which is
// exactly the wrong read, because the whole mechanic is that this gun belongs to the span and dies
// with it. So the hull here is not a base plate at all, it is a PINTLE MOUNT: a narrow bracket
// that reads as bolted THROUGH the parapet, with no ground shadow and no footprint wider than the
// wall line it sits on (wallArt.js draws the matching plinth on the span itself, so the two halves
// meet). Narrow and tall rather than wide and squat — the opposite of a squat sentry silhouette.
//
// The gun is a long thin RAIL: twin parallel rails with a charge glow running between them, rather
// than a heavy solid autocannon barrel. It should read as an energy weapon at a glance, and read
// as LONG — the barrel is the tell that this thing out-ranges you.
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC, poly, armorShell } from '../mechPrims.js';
import { VEHICLE as V, accentGlow } from './palette.js';

// The pintle mount (the HULL — never rotates). Deliberately NO ground shadow ellipse: this thing
// is not on the ground. A narrow trapezoid bracket, wider at the bottom where it grips the
// parapet, with the two mounting bolts that pin it through the wall plate.
function drawMount(sg, accent, armored = false) {
  // Halo pass first, oversized, behind the outline shapes (#129 legibility convention).
  poly(sg, [[-9.6, -3.6], [9.6, -3.6], [12.6, 11.6], [-12.6, 11.6]], V.halo);
  poly(sg, [[-8, -3], [8, -3], [11, 11], [-11, 11]], V.outline);
  poly(sg, [[-6.4, -1.6], [6.4, -1.6], [9, 9.4], [-9, 9.4]], V.bodyDk);
  poly(sg, [[-5, -1], [5, -1], [7, 8], [-7, 8]], V.body);
  // The two heavy bolts pinning the bracket through the parapet plate — the "this is fastened to
  // the wall, not standing on it" detail.
  for (const [x, y] of [[-6.4, 7], [6.4, 7]]) {
    ellipseC(sg, x, y, 2.6, 2.6, V.outline);
    ellipseC(sg, x, y, 1.6, 1.6, V.rim);
  }
  // A thin capacitor bank across the bracket's face, accent-lit — where the lance's charge is
  // stored. Small, but it's the cue that ties mount and gun into one weapon system.
  rectC(sg, 0, 3.4, 9, 2.6, V.tread);
  rectC(sg, 0, 3.4, 7.4, 1.3, accent, 0.75);
  if (armored) armorShell(sg, 0, 4, 18, 13);
}

// The rotating rail gun: a full-circle turret ring and a long twin-rail barrel with a charge
// line. #429: the pivot base used to be a rounded RECTANGLE, which against the wall read as a
// lopsided semicircle rather than a clean rotating mount. It's now a true circle — a
// rotating-turret ring sitting on top of the parapet — with a lit rim band so the ring reads as
// a distinct collar, not just a flat disc.
function drawRail(sg, accent, armored = false) {
  const A = accentGlow(accent);
  // Pivot ring — kept small, so the BARREL is still the dominant shape.
  ellipseC(sg, 0, 0, 15.6, 15.6, V.halo);
  ellipseC(sg, 0, 0, 14, 14, V.outline);
  ellipseC(sg, 0, 0, 12.4, 12.4, V.rim, 0.55);
  ellipseC(sg, 0, 0, 10.6, 10.6, V.bodyHi);
  // Targeting eye.
  ellipseC(sg, 0, -0.5, 3.4, 3, V.outline);
  ellipseC(sg, 0, -0.5, 2.2, 2, A.core, 0.95);
  // The twin rails, running well forward (−y). Long and thin — the range tell. Halo pass first,
  // since they jut far past the pivot block's own halo out into open ground.
  rectC(sg, 0, -17, 9.4, 29.6, V.halo);
  for (const x of [-3, 3]) {
    rectC(sg, x, -17, 3.4, 28, V.outline);
    rectC(sg, x, -17, 2, 27, V.tread);
    rectC(sg, x - 0.5, -17, 0.7, 25, V.treadHi, 0.75);
  }
  // The charge line running BETWEEN the rails — the accent glow that says "energy weapon", and
  // the visual the player learns to associate with "a lance is about to come out of that."
  rectC(sg, 0, -17, 2.6, 25, A.halo, 0.4);
  rectC(sg, 0, -17, 1.2, 24, A.hot, 0.85);
  // Muzzle bloom at the rails' tip.
  ellipseC(sg, 0, -31, 3.4, 2.6, A.hot, 0.9);
  ellipseC(sg, 0, -31, 5.2, 3.8, A.halo, 0.32);
  // Breech counterweight behind the pivot, so the gun reads as balanced on its pintle rather than
  // as a barrel glued to a box.
  roundC(sg, 0, 8, 8, 5, V.outline, 2);
  roundC(sg, 0, 8, 6.4, 3.6, V.bodyDk, 1.6);
  if (armored) armorShell(sg, 0, 0, 12, 10);
}

export function drawWallTurret(scene, key, def, opts = {}) {
  const accent = def.themeColor ?? V.rim;
  const armored = !!opts.armored;
  const D = DESIGN * ART_SCALE;
  gen(scene, `${key}_hull`, D, D, (g) => drawMount(scaledGraphics(g), accent, armored));
  gen(scene, `${key}_turret`, D, D, (g) => drawRail(scaledGraphics(g), accent, armored));
}
