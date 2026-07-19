// Broodwalker art (#130) — a slow, tanky four-legged ground unit: a squat armoured HULL
// standing on FOUR splayed mechanical legs (distinct from tank's paired tracks), topped by a
// boxy TURRET with a forward gun barrel (aims at the player independently, same hull-vs-turret
// decoupling as the tank/turret pattern) plus a rear "deploy hatch" detail that hints at the
// drones/infantry it periodically releases (the actual deploy mechanic lives in data —
// enemyKinds.js `deployEveryMs`/`deployCap` — and behavior — enemyBehaviors.js
// `quadrupedBehavior` — this file only draws the silhouette).
//
// #152 (round-2 playtest, follow-up to #147): two fixes live here.
//   1. "Legs aren't attached to the body" — the old hull tub (half-width ~11-12) fell well
//      short of the leg hip anchors (x ±17/±18), leaving a visible gap between body and limb.
//      The hull tub below is enlarged to reach past every hip anchor, and the hips themselves
//      were pulled in slightly to sit ON the enlarged body's silhouette — so the body (drawn
//      AFTER the legs) visually swallows each leg's root instead of floating past its edge.
//   2. "No walk animation" — drawHull now takes a `frame` (0-3), mirroring the player mech's
//      stompy 4-frame gait (mechArt.js): frames 0/2 are the planted/neutral pose, 1/3 swing the
//      knee+foot (NOT the hip, which stays anchored to the body per fix #1) fore/aft. A
//      quadruped's natural gait moves DIAGONAL leg pairs together (front-left+rear-right vs
//      front-right+rear-left), not left/right in unison like the biped mech, so the swing here
//      is keyed by diagonal pair rather than by side.
//
// #247 (playtest): "legs should read like it's walking 90° off from how it looks now" — the
// per-leg reach + stride were originally drawn along the fore/aft (y) axis, so the Broodwalker
// read as striding straight ahead like a dog/spider. drawLeg's knee/foot offsets and the SWING
// term now run along the SIDEWAYS (x) axis instead, so the same diagonal-pair gait reads as a
// crab-like sideways scuttle. The hip anchors (hipX, hipY) — and therefore the hull/turret's
// actual facing and movement direction — are untouched; only the leg's own drawn reach/stride
// axis rotated.
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC, poly, armorShell } from '../mechPrims.js';
import { VEHICLE as V, accentGlow } from './palette.js';

// A single tapered leg segment (hip/knee -> knee/foot), drawn as an outline poly with a
// narrower fill poly on top (same layering idea as plate()) plus a thin highlight strip, so
// it reads as a jointed limb rather than a flat blocky silhouette.
function legSegment(sg, x1, y1, x2, y2, w1, w2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;   // unit perpendicular, for width offsets
  poly(sg, [
    [x1 + nx * (w1 + 0.8), y1 + ny * (w1 + 0.8)], [x1 - nx * (w1 + 0.8), y1 - ny * (w1 + 0.8)],
    [x2 - nx * (w2 + 0.8), y2 - ny * (w2 + 0.8)], [x2 + nx * (w2 + 0.8), y2 + ny * (w2 + 0.8)],
  ], V.outline);
  poly(sg, [
    [x1 + nx * w1, y1 + ny * w1], [x1 - nx * w1, y1 - ny * w1],
    [x2 - nx * w2, y2 - ny * w2], [x2 + nx * w2, y2 + ny * w2],
  ], V.tread);
  poly(sg, [
    [x1 + nx * w1 * 0.5, y1 + ny * w1 * 0.5], [x1 + nx * w1 * 0.1, y1 + ny * w1 * 0.1],
    [x2 + nx * w2 * 0.1, y2 + ny * w2 * 0.1], [x2 + nx * w2 * 0.5, y2 + ny * w2 * 0.5],
  ], V.treadHi, 0.7);
}

// A single articulated leg: hip -> knee -> foot, with a visible bend at the knee. #147: the
// old single blocky rounded rect (roundC + horizontal "rung" bars) read as a stubby tank
// tread, not a walking leg — this replaces it with two thinner tapered segments meeting at an
// angled knee joint, which is what actually reads as "leg" rather than "tread." #152: the HIP
// (hipX, hipY) always stays exactly where the body anchors it (never offset) so the leg reads
// as firmly attached; `swing` shifts only the knee+foot along the leg's own stride axis, for
// the walk-cycle animation. #247: that stride axis is now SIDEWAYS (x) instead of fore/aft (y)
// — `side` (±1, left/right) drives the leg's main reach + swing, `dir` (±1, front/rear) is now
// just a minor knee-bend offset — so the whole limb reads as reaching/striding to the side,
// crab-style, while the hip position itself (and the body it's anchored to) is unchanged.
function drawLeg(sg, hipX, hipY, side, swing = 0) {
  const dir = Math.sign(hipY) || 1;   // front legs kick the knee slightly forward, rear slightly back
  const kneeX = hipX + side * 7 + swing, kneeY = hipY + dir * 5;
  const footX = hipX + side * 15 + swing * 1.6, footY = hipY;   // the foot swings further than the knee
  legSegment(sg, hipX, hipY, kneeX, kneeY, 3.4, 2.6);   // upper leg — thicker at the hip
  legSegment(sg, kneeX, kneeY, footX, footY, 2.4, 1.7); // lower leg — thinner still
  ellipseC(sg, kneeX, kneeY, 2.4, 2.4, V.treadHi, 0.9);   // knee joint accent
  ellipseC(sg, kneeX, kneeY, 1.3, 1.3, V.outline);
  ellipseC(sg, footX, footY, 2.8, 4, V.deep, 0.65);       // foot pad — now wider across the stride axis
}

// #152: how far (px) a leg's knee+foot swing on the two mid-stride frames (1 and 3) — #247:
// sideways now, not fore/aft, per drawLeg's rotated stride axis.
// frames 0/2 are fully planted (swing 0). Big enough to visibly read as a walk cycle at gameplay
// scale (a too-subtle swing was the first draft's mistake), but the SLOW cadence (stepInterval,
// enemyKinds.js) is what actually sells "heavy lurch" — amplitude alone doesn't need to be tiny
// for that; a bigger, slower swing reads heavier than a small, slow one.
const SWING = 6;

// Diagonal-pair swing offset for one leg on a given walk-cycle frame. A real quadruped gait
// moves front-left+rear-right together and front-right+rear-left together (a "trot" diagonal),
// alternating which pair is planted vs swinging — so unlike the biped mech (which alternates
// left/right), this keys off diagonal pairing.
function legSwing(frame, legKey) {
  if (frame % 2 === 0) return 0;                         // frames 0/2: both pairs planted
  const pairA = legKey === 'fl' || legKey === 'rr';       // front-left + rear-right
  const extreme = frame === 1 ? 1 : -1;
  return (pairA ? extreme : -extreme) * SWING;
}

// Hull + four splayed legs, drawn pointing "up" (−y = forward). A wide four-point stance (front
// pair angled forward, rear pair angled back) reads as a quadruped rather than tank tracks.
// `frame` (0-3) drives the walk-cycle leg swing (see legSwing above); frame 0 is the neutral/
// static pose used everywhere a single texture is still expected (art previews, etc).
function drawHull(sg, accent, frame = 0, armored = false) {
  // Ground shadow — wide, to match the four-point footprint.
  ellipseC(sg, 0, 5, 32, 28, V.deep, 0.35);

  // Four articulated legs (hip -> knee -> foot) with foot pads. #152: hip anchors pulled in
  // from the old ±17/±18 to sit ON the enlarged hull tub's edge below (not past it), so there's
  // no gap between where the leg roots and where the body's silhouette ends.
  const legs = [
    { key: 'fl', x: -15, y: -13, side: -1 }, { key: 'fr', x: 15, y: -13, side: 1 },
    { key: 'rl', x: -16, y: 13, side: -1 }, { key: 'rr', x: 16, y: 13, side: 1 },
  ];
  for (const { key, x, y, side } of legs) drawLeg(sg, x, y, side, legSwing(frame, key));

  // Central hull tub between the four legs. #152: enlarged well past every leg hip anchor above
  // (was half-width ~11-12, hips sat out at ±17/±18 — a visible gap) so the body's own
  // silhouette now overlaps each leg's root, selling "legs attached to a much bigger body."
  poly(sg, [[-18, -15], [18, -15], [19, 15], [-19, 15]], V.outline);
  poly(sg, [[-16, -14], [16, -14], [17, 14], [-17, 14]], V.bodyDk);
  poly(sg, [[-13.5, -13], [13.5, -13], [14, -3], [-14, -3]], V.body);
  poly(sg, [[-11, -13], [11, -13], [11.5, -7.5], [-11.5, -7.5]], V.bodyHi);
  // Rear engine/vent deck.
  rectC(sg, 0, 10, 20, 7, V.bodyDk);
  for (const y of [8, 10, 12]) rectC(sg, 0, y, 17, 1.2, V.tread, 0.8);
  // Hazard accent stripe.
  rectC(sg, 0, -12, 14, 1.6, accent, 0.7);
  // #300: while the unit's armor pool is > 0, overlay the SHARED plating primitive
  // (mechPrims' `armorShell`, identical to the player/enemy mech's) over the hull tub. Legs are
  // left bare — they read as running gear, and the armor pool is unit-wide, not per-limb.
  if (armored) armorShell(sg, 0, 0, 34, 29);
}

// Rotating turret: a flatter, boxier housing than tank's rounded cast turret (distinct
// silhouette), a rear "deploy hatch" panel, a sensor eye, and a forward gun barrel.
function drawTurret(sg, accent, armored = false) {
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
  // #300: shared plating overlay on the turret housing (see drawHull).
  if (armored) armorShell(sg, 0, 1, 16, 12);
}

// #152: how many walk-cycle hull frames this unit draws (mirrors the player mech's 4-frame
// stompy gait — mechArt.js `<key>_hull_0..3`). Exported so enemyKinds.js's `legFrames` data
// field and the arena's animation code (enemies.js `_updateVehicle`) share one source of truth
// instead of duplicating the number "4".
export const QUADRUPED_LEG_FRAMES = 4;

// `opts.armored` (#300) draws the shared armorShell plating over the hull tub + turret housing
// (on EVERY walk-cycle frame, so the gait keeps animating while plated).
export function drawQuadruped(scene, key, def, opts = {}) {
  const accent = def.themeColor ?? V.rim;
  const armored = !!opts.armored;
  const D = DESIGN * ART_SCALE;
  // #152: a 4-frame walk cycle, same convention as the player mech's `<key>_hull_0..3` (see
  // mechArt.js buildMechTextures) — the arena swaps between these based on ground speed instead
  // of a single static hull texture, so the Broodwalker's legs visibly cycle as it walks.
  for (let f = 0; f < QUADRUPED_LEG_FRAMES; f++) {
    gen(scene, `${key}_hull_${f}`, D, D, (g) => drawHull(scaledGraphics(g), accent, f, armored));
  }
  gen(scene, `${key}_turret`, D, D, (g) => drawTurret(scaledGraphics(g), accent, armored));
}
