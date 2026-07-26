// Recon Drone art — a small, cheap hovering quad-rotor: a tiny central pod with four stubby
// arms ending in fast spinning rotors, and a single glowing sensor eye. Individually weak, so
// it's drawn small and light; the swarm's numbers do the work. The HULL is the airframe (arms +
// pod); the TURRET is a subtle spinning-rotor overlay so a few frames of rotation read as "the
// rotors are turning." Flyers draw a drop shadow in the scene (they're elevated).
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, ellipseC, poly } from '../mechPrims.js';
import { VEHICLE as V, accentGlow, haloEllipse, haloPoly, EDGE_W, VEHICLE_EDGE } from './palette.js';

const ARMS = [[-8, -8], [8, -8], [-8, 8], [8, 8]];   // the four rotor-boom tips (design coords)

// The airframe: an X of booms, a central pod, and a forward-facing sensor eye. `palette` is the
// body/shadow/rim colour set (defaults to the shared pale enemy VEHICLE palette); #497 passes a
// dark player-owned one (art/vehicles/palette.js `vehicleDarkPalette`) so the friendly Drone
// Launcher summon reuses this exact silhouette in "one of ours" colours instead of a new design.
function drawFrame(sg, accent, palette = V) {
  const A = accentGlow(accent);
  // Cross booms — the X the whole body reads as.
  // #379 follow-up (owner playtest 2026-07-22, size + shield-on-body-only both confirmed): "the
  // drone's own BODY OUTLINE lines should be a thicker stroke without extending their length."
  // So the three stacked strokes below all get WIDER (~1.35x) while ARMS — which is what sets
  // where each boom ends — is untouched, i.e. the X gets beefier, not longer. The stack order is
  // unchanged (white legibility halo → dark outline → light rim highlight), and each width grows
  // in step so the dark outline band genuinely reads thicker rather than just being swallowed by
  // a fatter halo. Deliberately NOT touched: the shield glow (arena/shieldOutline.js, which
  // traces this silhouette) and the rotor blade streaks in drawRotors below.
  for (const [x, y] of ARMS) {
    // #129: legibility halo — a wider white stroke UNDER the dark outline stroke, so the boom
    // still has a visible edge on dark terrain (where the dark outline alone would vanish).
    // #421: and a wider DARK stroke under THAT, so the boom equally holds an edge on light
    // terrain (snow/sand), where the white halo is the thing that vanishes. Same pairing the
    // haloRound/haloPoly helpers apply to every other vehicle silhouette shape.
    sg.raw.lineStyle((5.4 + EDGE_W * 2) * ART_SCALE, VEHICLE_EDGE, 1);
    sg.raw.lineBetween((DESIGN / 2) * ART_SCALE, (DESIGN / 2) * ART_SCALE, (DESIGN / 2 + x) * ART_SCALE, (DESIGN / 2 + y) * ART_SCALE);
    sg.raw.lineStyle(5.4 * ART_SCALE, palette.halo, 1);
    sg.raw.lineBetween((DESIGN / 2) * ART_SCALE, (DESIGN / 2) * ART_SCALE, (DESIGN / 2 + x) * ART_SCALE, (DESIGN / 2 + y) * ART_SCALE);
    sg.raw.lineStyle(3.6 * ART_SCALE, palette.outline, 1);
    sg.raw.lineBetween((DESIGN / 2) * ART_SCALE, (DESIGN / 2) * ART_SCALE, (DESIGN / 2 + x) * ART_SCALE, (DESIGN / 2 + y) * ART_SCALE);
    sg.raw.lineStyle(1.8 * ART_SCALE, palette.rim, 0.9);
    sg.raw.lineBetween((DESIGN / 2) * ART_SCALE, (DESIGN / 2) * ART_SCALE, (DESIGN / 2 + x) * ART_SCALE, (DESIGN / 2 + y) * ART_SCALE);
    // Rotor hub at each tip.
    haloEllipse(sg, x, y, 3.9, 3.9);   // #129
    ellipseC(sg, x, y, 3, 3, palette.tread);
    ellipseC(sg, x, y, 1.6, 1.6, A.core, 0.8);
  }
  // Central pod. #379 follow-up (2nd pass — the playtest read the BODY as still full-size after
  // the first ~30% trim, because only the rotors looked smaller). The core X-body the booms
  // attach to is now cut ~40% MORE from that first pass (roughly half the original footprint),
  // so the drone reads as a genuinely small-bodied unit hanging under a same-size rotor span.
  // The rotor booms (ARMS, ±8) and their rotor discs are untouched. The shield-glow rim traces
  // this same hull silhouette, so it hugs the leaner body automatically
  // (shieldOutlineParts: ['hull'] in enemyKinds.js).
  // #379 3rd pass (owner playtest 2026-07-21: "slightly too thin") — widened ~30% from the
  // 2nd-pass trim above (x-extent only; length/y unchanged) so the pod reads as a beefier
  // body rather than a sliver, without undoing the earlier small-footprint fix.
  // #379 4th pass (same "thicker body outline, same length" ask as the booms above): the pod has
  // no stroke of its own — its outline IS the dark polygon peeking out from under the lit body
  // face. The two OUTER polys (halo + outline) keep their exact coordinates, so the pod's
  // footprint and the shield rim tracing it are unchanged; only the INNER lit face is pulled in,
  // which widens that dark band from ~0.6 to ~0.9 design units without the body growing at all.
  haloPoly(sg, [[-3.5, -2.3], [3.5, -2.3], [4.0, 2.3], [-4.0, 2.3]]);   // #129
  poly(sg, [[-2.6, -1.7], [2.6, -1.7], [3.1, 1.7], [-3.1, 1.7]], palette.outline);
  poly(sg, [[-1.7, -0.95], [1.7, -0.95], [2.2, 0.95], [-2.2, 0.95]], palette.bodyHi);
  // Forward sensor eye (accent glow), pointing −y — pulled in to sit on the smaller pod's nose.
  ellipseC(sg, 0, -1.6, 1.5, 1.4, palette.outline);
  ellipseC(sg, 0, -1.6, 0.9, 0.85, A.core, 0.95);
  ellipseC(sg, 0, -1.6, 2.1, 1.9, A.halo, 0.25);
  // A tiny under-slung gun barrel.
  rectC(sg, 0, -5, 1.2, 3.4, palette.tread);
}

// Spinning rotor disc overlay: faint translucent blur rings at each tip. As the scene rotates
// this sprite the blur reads as spinning blades. `palette` mirrors drawFrame's default/override.
function drawRotors(sg, palette = V) {
  for (const [x, y] of ARMS) {
    ellipseC(sg, x, y, 5.5, 5.5, palette.rimHi, 0.16);
    // A couple of blade streaks.
    rectC(sg, x, y, 10, 1, palette.rimHi, 0.28);
    rectC(sg, x, y, 1, 10, palette.rimHi, 0.18);
  }
}

// `def.palette` (#497) lets a caller override the body colour set — the friendly Drone Launcher
// summon passes a dark player-owned one (vehicleDarkPalette) built in scenes/arena/friendlyDrones.js
// so it reuses this exact silhouette instead of a new design. Every ENEMY_KINDS drone entry omits
// it and keeps the shared pale VEHICLE palette (V) unchanged.
export function drawDrone(scene, key, def) {
  const accent = def.themeColor ?? V.rim;
  const palette = def.palette ?? V;
  const D = DESIGN * ART_SCALE;
  gen(scene, `${key}_hull`, D, D, (g) => drawFrame(scaledGraphics(g), accent, palette));
  gen(scene, `${key}_turret`, D, D, (g) => drawRotors(scaledGraphics(g), palette));
}
