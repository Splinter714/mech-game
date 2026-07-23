// #310: Wall Lance art — the rail-lance gun mounted on a base wall's parapet.
//
// THE DESIGN PROBLEM this solves is that a free-standing sentry-turret silhouette reads as a thing standing
// ON THE GROUND: it has a ground shadow, a wide octagonal footing, sandbag mass. Reused as-is on a
// wall it would look like a turret that happened to be standing in front of the wall — which is
// exactly the wrong read, because the whole mechanic is that this gun belongs to the span and dies
// with it. So the hull here is not a ground base plate: it is a RING COLLAR bedded into the
// parapet, with no ground shadow and no footprint wider than the wall line it sits on.
//
// #429 (owner: "the base doesn't sit right against the wall" — flush): the hull used to be a
// directional trapezoid bracket, drawn wider at the bottom as if gripping a parapet BELOW it. That
// can never sit flush, for two reasons that are both about how the gun is actually placed:
//   - The mount is seated ON the span's centreline (`TURRET_MOUNT_OFFSET_PX = 0`, wallEdges.js) and
//     deliberately straddles it so the gun can fire inboard OR outboard. A shape with a "bottom"
//     is claiming one side of the wall is the ground side; neither side is.
//   - The hull NEVER rotates to match its span. A wall gun spawns at a fixed `angle` and has
//     `turnRate: 0` (enemyKinds.js), while the ring's spans run at every hex bearing — so a
//     directional bracket lands at an arbitrary angle to the wall line it is meant to be bolted to.
// So the fix is a ROTATIONALLY SYMMETRIC hull rather than a re-aimed one: a full circular collar,
// concentric with the gun's pivot, sized so its outer edge (r = 15 design units ≈ 6.9 world px at
// this kind's display scale) lands on the wall's own 7px half-thickness. It reads flush on every
// span bearing, from every angle the gun is trained at, with no placement-side change at all.
//
// The gun is a long thin RAIL: twin parallel rails with a charge glow running between them, rather
// than a heavy solid autocannon barrel. It should read as an energy weapon at a glance, and read
// as LONG — the barrel is the tell that this thing out-ranges you.
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC, armorShell } from '../mechPrims.js';
import { VEHICLE as V, accentGlow } from './palette.js';

// The collar mount (the HULL — never rotates, and after #429 never needs to). Deliberately NO
// ground shadow ellipse: this thing is not on the ground. A circular armoured collar bedded into
// the wall band, ringed by the bolts that pin it through the wall plate and by the accent-lit
// capacitor band that ties mount and gun into one weapon system.
//
// Every element here is rotationally symmetric ON PURPOSE — the four bolts sit on the diagonals,
// the capacitor is a full band rather than a bar across one face. That is what makes the mount
// read as flush no matter which bearing its span runs at (see the header note).
function drawMount(sg, accent, armored = false) {
  // Halo pass first, oversized, behind the outline shapes (#129 legibility convention).
  ellipseC(sg, 0, 0, 33.2, 33.2, V.halo);
  // r = 15: the collar's outer edge lands on the wall's own half-thickness, so it sits flush
  // inside the span's band instead of overhanging either face.
  ellipseC(sg, 0, 0, 30, 30, V.outline);
  ellipseC(sg, 0, 0, 26.8, 26.8, V.bodyDk);
  // The accent-lit capacitor band — where the lance's charge is stored. A full ring, so it reads
  // the same whichever way the gun is trained.
  ellipseC(sg, 0, 0, 24.4, 24.4, accent, 0.7);
  ellipseC(sg, 0, 0, 22.6, 22.6, V.tread);
  ellipseC(sg, 0, 0, 21.2, 21.2, V.body);
  // Four heavy bolts pinning the collar through the parapet plate — the "this is fastened to the
  // wall, not standing on it" detail, now on the diagonals so the ring stays symmetric.
  for (const [x, y] of [[-8.7, -8.7], [8.7, -8.7], [-8.7, 8.7], [8.7, 8.7]]) {
    ellipseC(sg, x, y, 3.6, 3.6, V.outline);
    ellipseC(sg, x, y, 2.2, 2.2, V.rim);
  }
  if (armored) armorShell(sg, 0, 0, 28, 28);
}

// The rotating rail gun: a full-circle turret ring and a long twin-rail barrel with a charge
// line. #429: the pivot used to be a rounded RECTANGLE, which against the wall read as a lopsided
// semicircle rather than a clean rotating mount. It's a true circle now — deliberately kept
// SMALLER than the hull's collar, so the fixed collar shows as a ring of parapet all the way
// around it and the gun reads as swivelling INSIDE its mount rather than capping it.
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
