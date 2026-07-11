// Infantry Trooper art (#97, reworked #104) — a small ground-swarm unit, individually
// meaningless, drawn in the same white mech-faction palette as the other vehicles. #104
// playtest correction: the original thin-stick-limbs silhouette read as "lines" rather than a
// trooper at the ~0.38 render scale a mob actually plays at — a handful of 1-2px-wide strokes
// just vanish/alias at that size. Reworked into one bulky, single-silhouette BLOB (legs merge
// straight into the torso, the head merges straight into the top of the torso — no thin gaps
// or narrow necks/limbs anywhere) sized to fill noticeably more of the design canvas, mirroring
// what actually reads at small scale elsewhere in this engine (the drone's chunky central pod +
// thick cross-boom strokes, not its thin rotor-blur overlay). The HULL is the body/legs blob
// (faces travel); the TURRET is just the rifle, so it swings to point at the player
// independently, mirroring the tank's hull-vs-turret split at trooper scale.
import { gen, scaledGraphics, ART_SCALE } from '../_frames.js';
import { DESIGN, rectC, roundC, ellipseC } from '../mechPrims.js';
import { VEHICLE as V, accentGlow } from './palette.js';

// Shares mechPrims' standard DESIGN=64 canvas (and its CENTER-based coordinate helpers) like
// every other vehicle builder — the shapes below just use a noticeably bigger fraction of that
// canvas than the original art did (see the rework note above), rather than a different canvas
// size, so `rectC`/`roundC`/`ellipseC`'s shared centring stays correct.

// The body: one continuous rounded blob — a wide stubby base (legs+feet fused, no gap) rising
// into a chunky torso, with the head merging directly on top. No arms; the rifle (drawn on the
// turret layer) reads as held across the body.
function drawBody(sg, accent) {
  const A = accentGlow(accent);
  // Ground contact shadow — sized to the wider footprint below.
  ellipseC(sg, 0, 9, 9, 4, V.deep, 0.5);
  // Base/legs: one wide, thick blob (a stubby planted stance) merging straight into the torso —
  // no separate thin leg lines to disappear at small scale. #129: at this unit's tiny render
  // scale the legibility halo matters MORE, not less — add it first, oversized.
  roundC(sg, 0, 6, 10.6, 9.6, V.halo, 4.3);
  roundC(sg, 0, 6, 9, 8, V.outline, 3.5);
  roundC(sg, 0, 5.5, 7.4, 6.4, V.tread, 3);
  // Torso: one big rounded blob, deliberately bulkier than a strict human silhouette so it
  // reads as solid mass even shrunk to a few px on screen.
  roundC(sg, 0, -2, 12.1, 15.6, V.halo, 5.8);   // #129
  roundC(sg, 0, -2, 10.5, 14, V.outline, 5);
  roundC(sg, 0, -2.5, 9, 12.4, V.body, 4.4);
  roundC(sg, 0, -5.5, 7.4, 7, V.bodyHi, 3.2);
  // Faction accent chevron on the chest — a wide bar, not a thin stripe.
  roundC(sg, 0, -2.5, 6.2, 2.6, accent, 1.2, 0.9);
  // Head: overlaps directly into the top of the torso (no thin neck) — a bigger round helmet.
  ellipseC(sg, 0, -12, 6.4, 6.2, V.halo);   // #129
  ellipseC(sg, 0, -12, 5, 4.8, V.outline);
  ellipseC(sg, 0, -12, 3.7, 3.5, V.bodyHi);
  // Visor glow (accent "danger" eye).
  ellipseC(sg, 0, -12, 2, 1.7, A.core, 0.95);
  ellipseC(sg, 0, -12, 3.2, 2.6, A.halo, 0.3);
}

// The rifle: a short, thick bar held forward, tracks the player independently of the body.
function drawRifle(sg, accent) {
  const A = accentGlow(accent);
  rectC(sg, 0, -9, 2.6, 18, V.tread);
  rectC(sg, -0.7, -9, 1, 15, V.treadHi, 0.7);
  ellipseC(sg, 0, -18, 2, 1.7, A.hot, 0.85);
  ellipseC(sg, 0, -18, 3.2, 2.7, A.halo, 0.3);
}

export function drawInfantry(scene, key, def) {
  const accent = def.themeColor ?? V.rim;
  const D = DESIGN * ART_SCALE;
  gen(scene, `${key}_hull`, D, D, (g) => drawBody(scaledGraphics(g), accent));
  gen(scene, `${key}_turret`, D, D, (g) => drawRifle(scaledGraphics(g), accent));
}
