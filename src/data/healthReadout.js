// #448: the switchable health readout.
//
// The bar readout (the bottom-left block of vertical bars, `integrityLayout` in hudLayout.js)
// answered the first half of the issue by deleting every numeral from the HUD — the bar fill alone
// carries armor / structure / shield. The second half asked for ALTERNATE readouts to compare
// against it in play rather than in a mockup, so this module holds them as pure geometry:
//
//   'none'      — no integrity readout at all: the mech's own art (shield opacity, destroyed-part
//                 stumps) carries it. Was the DEFAULT from the 2026-07-23 playtest until #495's
//                 'fused' won its own comparison and took the slot over (see 'fused' below and
//                 `READOUT_MODES`'s own comment) — still fully live, still first in line after
//                 'fused' in the H cycle, just no longer what a fresh run or empty registry opens on.
//   'bars'      — the bar block (laid out by hudLayout.js `integrityLayout`; named here only
//                 so the mode cycle has something to return to).
//   'paperdoll' — one rounded rect per damage-tracked location, arranged as a mech silhouette
//                 (arm, torso, torso, arm). Each segment stays FULLY FILLED and its COLOUR rides a
//                 health ramp for that part's STRUCTURE (dark blue → purple → red as it drops,
//                 `structureColor`); per-segment OUTLINE = that part's armor (drawn as a perimeter
//                 that drains around the frame, so an outline can show a FRACTION at all), and ONE
//                 outline around the whole doll = the mech's shield. Since the #448 playtest ALL
//                 THREE layers ride that same ramp, each by its OWN fraction (armor and shield
//                 coloured in HudScene, structure here), so the readout speaks one colour language.
//   'fused'     — #495: the DEFAULT as of the mode's own 2nd playtest round (see `READOUT_MODES`'s
//                 comment for why). No separate block at all — armor/structure/shield fuse directly onto the
//                 four weapon skill tiles. Per-tile WASH = structure (`structureColor`, painted
//                 over the tile's own art rather than a separate cell); per-tile DRAIN = armor —
//                 a top-to-bottom "draining tank" rect (`armorDrainRect`, below), because Jackson
//                 wanted armor to read as depleting DOWN the tile, not around its edge. #495's
//                 SECOND playtest round moved this drain BEHIND the tile in z-order instead of
//                 painted over its face (HudScene's `_paintFusedReadout`/`panel.armorBackGfx` — the
//                 geometry here is unchanged, only which layer HudScene paints it into); and ONE
//                 whole-mech shield BRACKET wrapping the top+sides of the whole row
//                 (`shieldArcLayout`, below — its own shape: two mirrored paths, not `ringSweep`'s
//                 single clockwise sweep and not paperdoll's rectangular perimeter — rewritten from
//                 an ellipse to a rounded-rectangle walk in the same 2nd playtest round). Structure
//                 still rides the structure-colour ramp, same as paperdoll; armor rides the target
//                 disc's own fixed armor tone instead (see `armorDrainRect`'s own note) so it reads
//                 as a distinct layer from structure rather than a second copy of the same ramp.
//
// An earlier fourth mode, the Diablo/PoE-style ORB readout, was built for that comparison and
// DELETED after it (Jackson: "remove the circle option") — layout, fill polygon, paint path and
// tests, so no dead art path is left behind.
//
// Everything here is pure: positions and polylines. HudScene only paints to these numbers,
// the same contract `integrityLayout` already had, so every mode shares one console frame and
// one baseline. Every layout returns the SAME shape — `{ x, w, top, bottom, headerY, labelY,
// segments, shieldLabel }` — because the console shell (#452) frames whatever the panel laid out,
// and a mode swap must not need the shell to know which mode it is framing.

import { INTEGRITY_BARS, CONSOLE, ARMOR_PEEK_PAD } from './hudLayout.js';
import { getCoreItem } from './coreItems.js';

// The cycle order. 'fused' is FIRST because it is the default. 'none' held that spot through the
// #448 experiment ("a fresh run starts with no integrity display at all, does the mech's own art
// carry it on its own?") and 'orbs' was built, compared, and fully deleted the same way once it
// lost that comparison (see the module doc up top). #495 ran the same experiment again for fused:
// once it was playtested and refined through two rounds of fixes (rectangular shield bracket,
// armor peeking from behind the tile, the HP-flicker pass), Jackson picked it as the one to keep
// on by default — so it takes the first slot the way 'none' and, before it, nothing else did. H
// still walks the full cycle (fused → none → bars → paperdoll → fused) and every mode stays live;
// only which one a fresh run/registry starts on changed.
export const READOUT_MODES = ['fused', 'none', 'bars', 'paperdoll'];

export const READOUT_LABELS = {
  none: 'NONE',
  bars: 'BARS',
  paperdoll: 'PAPER DOLL',
  fused: 'FUSED',
};

// Anything unrecognised reads as the DEFAULT rather than throwing or blanking the HUD. That covers
// an empty registry on the first frame and, specifically, a stored 'orbs' from a session before the
// orb readout was deleted: it falls back to NONE instead of leaving the HUD on a mode that no longer
// has a layout or a paint path.
export function normalizeReadoutMode(mode) {
  return READOUT_MODES.includes(mode) ? mode : READOUT_MODES[0];
}

export function nextReadoutMode(mode) {
  const i = READOUT_MODES.indexOf(mode);
  return READOUT_MODES[(i < 0 ? 0 : i + 1) % READOUT_MODES.length];
}

export function readoutLabel(mode) {
  return READOUT_LABELS[normalizeReadoutMode(mode)];
}

// ── NONE ─────────────────────────────────────────────────────────────────────────────────────
//
// No integrity readout at all — the DEFAULT mode, so this collapsed console is the COMMON case
// rather than the exception. It still has to return the SAME shape as the other modes, because
// the console shell (#452) frames whatever a panel laid out and must not learn which mode it is
// framing — so this is a ZERO-WIDTH block on the tile row's own baseline. `consoleBand` drops the
// block-to-tiles gap for a zero-width block (see hudLayout.js), so the console collapses to
// exactly its tile row rather than leaving a hole where the bars used to be.
//
// `headerY` is deliberately the baseline rather than a line above it: the header text is not drawn
// in this mode, and a header line reserved for nothing would make the console taller by 16px for
// an empty band — the exact hole this mode has to avoid.
export function noneLayout({ anchorX = 0, bottomY = 0 } = {}) {
  return {
    mode: 'none',
    x: anchorX, w: 0,
    top: bottomY, bottom: bottomY,
    labelY: bottomY,
    headerY: bottomY,
    segments: [],
    shieldLabel: null,
  };
}

// ── PAPER DOLL ───────────────────────────────────────────────────────────────────────────────
//
// A mech silhouette: a narrow arm rect, two torso rects, a narrow arm rect, in the same
// left-to-right body order the skill tiles and the bar block already use. Arms hang from the
// SHOULDER line (top-aligned, shorter than the torsos) so the block reads as a body rather than a
// bar chart with uneven heights.
export const PAPER_DOLL = {
  armW: 17,          // an arm segment's nominal width
  torsoW: 25,        // a torso segment's nominal width
  gap: 5,            // between segments
  armH: 0.74,        // an arm's height, as a fraction of the torso's (the full bar height)
  outlinePad: 8,     // how far the whole-mech SHIELD outline stands off the doll
  minScale: 0.55,    // never squeeze narrower than this, matching the bar block's floor
};

// Which nominal width a location gets. Arms are the narrow ones; everything else is a torso.
function dollSegW(loc) {
  return /arm$/i.test(loc) ? PAPER_DOLL.armW : PAPER_DOLL.torsoW;
}

export function paperDollLayout(locs, { anchorX, bottomY, availW = 0, side = 'left' }) {
  const S = INTEGRITY_BARS;
  const P = PAPER_DOLL;
  const n = locs.length;
  const inner = locs.reduce((sum, loc) => sum + dollSegW(loc), 0) + Math.max(0, n - 1) * P.gap;
  const nominal = inner + P.outlinePad * 2;
  const scale = Math.max(P.minScale, Math.min(1, (availW > 0 ? availW : nominal) / nominal));
  const pad = P.outlinePad * scale;
  const gap = P.gap * scale;
  const w = inner * scale + pad * 2;
  const x = side === 'right' ? anchorX - w : anchorX;
  const bottom = bottomY - S.labelH;
  const top = bottom - S.barH;
  const armH = S.barH * P.armH;
  let cursor = x + pad;
  const segments = locs.map((loc) => {
    const sw = dollSegW(loc) * scale;
    const arm = /arm$/i.test(loc);
    const seg = {
      loc,
      x: cursor,
      // Arms hang from the shoulder: same TOP as the torsos, shorter, so their bottoms stop above
      // the torso's — that shape is the whole reason this reads as a doll.
      y: top,
      w: sw,
      h: arm ? armH : S.barH,
      cx: cursor + sw / 2,
    };
    cursor += sw + gap;
    return seg;
  });
  return {
    mode: 'paperdoll',
    x, w, top, bottom,
    labelY: bottom + 2,
    headerY: top - S.headerH,
    segments,
    // The ONE outline around ALL segments together — the whole-mech shield.
    outline: { x, y: top - pad, w, h: (bottom - top) + pad * 2 },
    // The shield IS that outline, so it needs no caption of its own down on the label line.
    shieldLabel: null,
  };
}

// ── STRUCTURE COLOUR RAMP (paper doll) ─────────────────────────────────────────────────────────
//
// Playtest follow-up (2026-07-23): in the paper doll a part's STRUCTURE is no longer a drain/fill
// level — the segment stays fully filled and its COLOUR slides along a health gradient as structure
// drops. Full structure is a DARK blue, it cools through purple, and empties to red; the destroyed
// end-state is drawn separately (dark dead cell + the red cross), so this ramp only colours a LIVE
// part and never has to double as the "gone" state.
//
// Jackson asked for "more steps than just 3 colors", i.e. a CONTINUOUS gradient rather than three
// snapped bands — at 70% structure a part must read as a distinct in-between colour. We interpolate
// in HSL, sweeping the HUE from blue (~200°) up through purple (~280°) to red (~358°). A straight
// RGB lerp from blue to red passes through a muddy grey midpoint (the blue and red channels cross
// with nothing between them), whereas riding the hue keeps every midpoint a saturated blue-violet /
// violet / magenta-red — no dead zone. Saturation and lightness are lerped alongside the hue so the
// low end reads as a heavier, more urgent red than the bright light-blue top.
//
// Anchor stops (structure fraction → HSL). More than the three named colours only to SHAPE the
// curve — the output is continuous between them:
export const STRUCTURE_RAMP = [
  { at: 1.0, h: 205, s: 0.85, l: 0.44 },   // full structure  → DARK blue (#448 playtest: was l:0.66)
  { at: 0.5, h: 278, s: 0.68, l: 0.56 },   // half            → purple
  { at: 0.0, h: 358, s: 0.82, l: 0.50 },   // near-dead        → red
];

// HSL (h in degrees 0..360, s/l in 0..1) → 0xRRGGBB integer, the form Phaser's fillStyle wants.
export function hslToInt(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  const to = (v) => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

// The paper-doll structure colour for a part at `frac` (structure / maxStructure, 0..1). Continuous:
// endpoints hit the ramp's own extremes exactly, and any value between two anchors is the HSL lerp
// between them, so the colour marches monotonically from light yellow down to red as a part is worn
// away — no discrete banding.
export function structureColor(frac) {
  const f = Math.max(0, Math.min(1, frac));
  const stops = STRUCTURE_RAMP;   // ordered high `at` → low `at`
  // At or above the top anchor, and at or below the bottom, clamp to that anchor.
  if (f >= stops[0].at) return hslToInt(stops[0].h, stops[0].s, stops[0].l);
  const last = stops[stops.length - 1];
  if (f <= last.at) return hslToInt(last.h, last.s, last.l);
  for (let i = 0; i < stops.length - 1; i++) {
    const hi = stops[i], lo = stops[i + 1];
    if (f <= hi.at && f >= lo.at) {
      const t = (f - lo.at) / (hi.at - lo.at);   // 0 at the low anchor, 1 at the high one
      const lerp = (a, b) => b + (a - b) * t;    // a = hi (t→1), b = lo (t→0)
      return hslToInt(lerp(hi.h, lo.h), lerp(hi.s, lo.s), lerp(hi.l, lo.l));
    }
  }
  return hslToInt(last.h, last.s, last.l);
}

// A rectangle's perimeter, walked for the first `frac` of its length, as a polyline. This is what
// lets an OUTLINE carry a fraction at all: the armor (or shield) outline is stroked as a run that
// drains around the frame instead of a solid box that can only be on or off.
//
// Starts at the BOTTOM-LEFT corner and runs clockwise on screen (up the left side, across the top,
// down the right, back along the bottom) so a part's armor empties in one continuous direction and
// the last thing to go is the bottom edge nearest the label. Returns [] below one point of length,
// and the closed loop at frac >= 1.
export function perimeterRun(rect, frac) {
  const { x, y, w, h } = rect;
  const f = Math.max(0, Math.min(1, frac));
  if (f <= 0 || w <= 0 || h <= 0) return [];
  const corners = [
    { x, y: y + h },        // start: bottom-left
    { x, y },               // top-left
    { x: x + w, y },        // top-right
    { x: x + w, y: y + h }, // bottom-right
    { x, y: y + h },        // back to the start
  ];
  const total = 2 * (w + h);
  let remaining = f * total;
  const pts = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const a = pts[pts.length - 1], b = corners[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= 0) continue;
    if (remaining >= len) {
      pts.push(b);
      remaining -= len;
      continue;
    }
    const t = remaining / len;
    pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    return pts;
  }
  return pts;
}

// ── ARMOR DRAIN (fused) ─────────────────────────────────────────────────────────────────────
//
// #495 playtest (Jackson: "armor should not deplete AROUND the ability, it should deplete from
// top to bottom"): replaces the fused readout's original per-tile PERIMETER (`perimeterRun`, run
// against the tile's own rect — still what paperdoll's segment outline uses) with a DRAINING TANK
// rect instead. Full armor covers the tile top-to-bottom; as armor drains, the covered band's TOP
// edge recedes downward, so what survives sits at the BOTTOM and shrinks upward as armor is lost
// — never sideways, never around a frame.
//
// #495 SECOND playtest round (Jackson: "it should be beneath the ability square in z-order, not a
// ring on the ability square" — the drain was being painted as a face OVERLAY on top of the tile,
// which is what was reading as a ring/circular quality to him): this geometry is unchanged, but
// HudScene now paints it into a layer BEHIND the tile (`panel.armorBackGfx`, drawn before the tile
// row so Phaser's own draw order puts it there) and against a rect padded OUT past the tile's own
// edges (see `_paintFusedReadout`'s `ARMOR_PEEK_PAD`) rather than the tile's exact footprint — so
// the opaque tile plate on top occludes the middle and only a thin margin peeks out around/under
// the tile's own edges, receding top-to-bottom exactly as this function already computes.
//
// Pure geometry only: given a rect (the tile's own, or — since the 2nd round — a padded rect
// around it) and the live armor fraction (0..1), returns the overlay's own `{ x, y, w, h }` — full
// width, bottom pinned to the given rect's own bottom edge, top at `rect.y + rect.h * (1 - frac)`
// — plus `full`, true only at frac >= 1 (kept as a fact about the fraction; HudScene's 2nd-round
// paint no longer branches its own corner rounding on it, since a fraction-dependent shape was
// exactly what read as ring-like the first time).
export function armorDrainRect(rect, frac) {
  const f = Math.max(0, Math.min(1, frac ?? 0));
  const h = f * rect.h;
  return { x: rect.x, y: rect.y + (rect.h - h), w: rect.w, h, full: f >= 1 };
}

// ── SHIELD ARC (fused) ──────────────────────────────────────────────────────────────────────
//
// #495: the fused readout's shield is a BRACKET wrapping the top+sides of the whole tile row —
// not a per-tile ring (shield is a single whole-mech pool, `mechPools().shield`), not `ringSweep`
// (hudLayout.js — a single clockwise sweep built for the small target-disc rings), and not the
// paper doll's shield (a full rectangular PERIMETER outline that runs around all four sides). This
// is TWO MIRRORED PATHS sharing one point at 12 o'clock over the row's own centre: as the fraction
// drops each one retracts independently back toward that shared point, so a half-shield reads as
// "the canopy pulled back on both edges" rather than one sweep across like a gauge. (Function name
// kept as `shieldArcLayout`/`SHIELD_ARC` — only the path's own SHAPE changed below, not what calls
// it or what it's for.)
//
// #495 SECOND playtest round (Jackson: "the shape of the shield should match wrapping the
// rectangle of ability squares, not so rounded"): the first cut rode an ELLIPSE, centred below the
// row and reached by independent radii — which read as a dome/canopy, not a bracket wrapping the
// tiles. This walks the tile row's own bounding box instead: straight up each side, a small
// rounded corner, straight across the top — the same "plated console" corner language the tile
// plates (`paintTilePlate`, ui/skillTiles.js) and the console shell (`CONSOLE.radius`,
// hudLayout.js) already use, so the bracket reads as part of that same aesthetic rather than a
// circular/elliptical curve. ONLY the path's shape changed this round — the fraction-to-position
// math (each side retracts from its own OUTER end toward the shared apex as the fraction drops)
// is untouched: the first round's center-out depletion direction was already confirmed correct.
export const SHIELD_ARC = {
  // #526-followup (point 1/2): the ability row's own OUTER edge (X's left / Y's right — see
  // ui/skillTiles.js `weaponAbilityRows`) is the BARE weapon row's own span (Jackson's explicit
  // "1.5+1+1.5=4 weapon-tile-widths, matching the weapon row below it" sizing — no armor pad in
  // that count). The notch/bracket, though, is measured off `HudScene`'s `panel.tileBox`, which
  // IS widened by the armor backing's own peek pad (point 2) so the console/shield floor clears
  // the wider armor footprint. For the ability row to still get an EQUAL margin against the notch
  // on every side (point 1's "uniform padding all around"), `overhang` has to make up exactly the
  // difference: `16 - ARMOR_PEEK_PAD` nets out to the same 16px gap the vertical `rise` below
  // uses, once you add back the armor pad tileBox already carries (`ARMOR_PEEK_PAD + overhang ===
  // 16` always, however big the armor pad is) — see `CONSOLE.padX` (hudLayout.js) for the other
  // half of that same cancellation (the console shell's own edge nets out to the same 16 too).
  overhang: 16 - ARMOR_PEEK_PAD,
  // #495 playtest (Jackson: "the shield arc should wrap the row of four ability buttons"): the
  // ends land at the row's own BOTTOM edge (1.0 = full row height) rather than ~55% down it, so
  // each side genuinely wraps the tiles' full height instead of just arching over their tops — a
  // capsule/bracket enclosing the row, not a partial droop. Untouched by the 2nd round's rewrite.
  sideDrop: 1.0,
  // #526-followup (new playtest pass, point 1: "the trapezoidal top cut can be pulled down lower
  // — a shallower/shorter slice"): was 26. Now equal to `overhang` on purpose — see
  // `FUSED_DOME_RISE` below and HudScene's ability-row placement, where making this match
  // `overhang` (and the console's own `padTop`-derived clearance) is what gives the ability tiles
  // EQUAL margin on every side (left/right/top) against the notch, instead of a taller vertical
  // gap that didn't match the horizontal one.
  rise: 16,       // how far above the row's own top edge the bracket's top rail sits
  // #495 2nd round: a SMALL rounding where a vertical side meets the top rail — enough to read as
  // this game's plated-console aesthetic (tile corners round at 9px, the console shell's own
  // corner at 14px) without reading as circular/elliptical at a glance. `bracketGeometry` clamps
  // this per-row so a very short or narrow tile row can never make the corner overlap itself.
  corner: 14,
  steps: 10,      // polyline resolution per half-path (mirrors `perimeterRun`'s plain-polyline idiom)
};

// The bracket's own geometry for a given tile-row rect: the vertical run's top/bottom, the two
// side x's, the shared centre-x the top rail runs to, and the corner radius — clamped so it can
// never exceed the space actually available (a defensive floor for an unusually short/narrow row,
// not something normal HUD sizes ever hit).
//
// #526 (playtest: "shield opacity should be a gradient, strongest facing the panel and weakest
// facing away"): `pad` grows the bracket OUTWARD — bigger overhang/rise, same `bottomY` — without
// touching the shape's own corner language. HudScene draws several copies of the SAME fixed shape
// at increasing `pad`/decreasing alpha to fake that gradient (plain Graphics has no true gradient
// stroke); `pad` defaults to 0, so every existing call site is byte-identical to before.
function bracketGeometry(rect, pad = 0) {
  const S = SHIELD_ARC;
  const bottomY = rect.y + rect.h * S.sideDrop;
  const topY = rect.y - (S.rise + pad);
  const leftX = rect.x - (S.overhang + pad);
  const rightX = rect.x + rect.w + (S.overhang + pad);
  const cx = rect.x + rect.w / 2;
  const r = Math.max(0, Math.min(S.corner, bottomY - topY, cx - leftX));
  return { bottomY, topY, leftX, rightX, cx, r };
}

// One point on one side's path (`side`: 'left' | 'right'), at normalised distance `u` (0..1) — 0
// is the OUTER end (down at the row's own bottom edge), 1 is the shared apex (top-centre, where
// both sides' paths meet). The path is three pieces walked in order — straight up the side, a
// quarter-turn around the rounded corner, straight in along the top rail to centre — and `u` is
// distributed across them by actual path LENGTH, so a point sliding along `u` moves at a roughly
// constant rate instead of snapping quickly through the short corner piece.
function bracketPoint(geo, side, u) {
  const { bottomY, topY, leftX, rightX, cx, r } = geo;
  const uc = Math.max(0, Math.min(1, u));
  // The shared apex is a fixed point regardless of which side is asking — return it directly
  // (rather than arriving at it via the accumulated-length arithmetic below) so both sides land
  // on the EXACT same float, not two values a rounding error apart. HudScene's track/left/right
  // polylines rely on the two sides meeting at one literal point.
  if (uc >= 1) return { x: cx, y: topY };
  const dir = side === 'left' ? 1 : -1;
  const outerX = side === 'left' ? leftX : rightX;
  if (uc <= 0) return { x: outerX, y: bottomY };
  const Lv = Math.max(0, bottomY - (topY + r));            // straight run up the side
  const Lc = r * (Math.PI / 2);                             // the rounded corner
  const Lh = Math.max(0, Math.abs(cx - (outerX + dir * r))); // straight run along the top to centre
  const total = Lv + Lc + Lh;
  if (total <= 0) return { x: outerX, y: bottomY };
  const d = uc * total;
  if (d <= Lv) return { x: outerX, y: bottomY - d };
  if (d <= Lv + Lc) {
    // Standard rounded-rect corner: a quarter circle centred `r` in from the side and `r` down
    // from the top rail. Left sweeps from pointing at the side (angle π) to pointing straight up
    // (3π/2); right mirrors it (0 sweeping to -π/2) — the same pair of corners `strokeRoundedRect`
    // draws for a rect's own top-left/top-right, just walked here as a polyline of our own.
    const ccx = outerX + dir * r, ccy = topY + r;
    const t = (d - Lv) / Lc;
    const angle = side === 'left' ? Math.PI + t * (Math.PI / 2) : -t * (Math.PI / 2);
    return { x: ccx + r * Math.cos(angle), y: ccy + r * Math.sin(angle) };
  }
  const local = d - Lv - Lc;
  return { x: outerX + dir * r + dir * local, y: topY };
}

// A polyline from `u0` to `u1` on one side's path, in `steps` segments — the same "hand back a
// drawable polyline" idiom `perimeterRun` uses, so HudScene paints both with `strokePoints`.
function bracketArc(rect, side, u0, u1, steps, pad = 0) {
  const geo = bracketGeometry(rect, pad);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const u = u0 + (u1 - u0) * (i / steps);
    pts.push(bracketPoint(geo, side, u));
  }
  return pts;
}

// The bracket's full closed OUTLINE (both sides' complete paths, joined at the shared apex) for a
// given rect — the fixed SHAPE, independent of the live shield fraction. `pad` (see
// `bracketGeometry`) grows it outward for the #526 opacity-gradient layers; the default (0) is
// exactly what `shieldArcLayout`'s own `track` used to compute inline, and is also what #526
// reuses to give the FUSED tile panel's own background the same nipped-corner shape as the shield
// meter sitting above it (HudScene `_paintConsole`), so the two read as one continuous console
// outline instead of a differently-shaped panel under a differently-shaped frame.
export function bracketOutline(rect, pad = 0) {
  const S = SHIELD_ARC;
  return [
    ...bracketArc(rect, 'left', 0, 1, S.steps, pad),
    ...bracketArc(rect, 'right', 1, 0, S.steps, pad).slice(1),
  ];
}

// `rect` is the tile row's own bounding box (HudScene's `panel.tileBox`, off `ui/skillTiles.js`
// `tileRow`). `frac` is the shield's live fraction (`mechPools().shield`, 0..1). Returns the
// ALWAYS-drawn dim TRACK — the full bracket, both sides fully extended, the same "empty space
// stays legible" rule every other layer's backing follows — plus the two mirrored LIT paths:
// empty at frac 0, reaching the shared apex at frac 1.
//
// #495 playtest (Jackson: shield should deplete from the MIDDLE out, not the sides in): each lit
// path is anchored at its OUTER end (`u = 0`, the side stub nearest the tile row's own edge) and
// grows TOWARD the shared apex (`u = 1`) as the fraction rises. So at frac 1 both paths reach all
// the way to the apex (the full bracket); as the shield drains the reach shrinks back toward the
// outer end, opening a gap at top-centre first and widening it outward, until at frac 0 nothing is
// left at all. Untouched by the 2nd round's shape rewrite — `u` replaces the old arc angle
// one-for-one, so this indexing (index 0 = fixed outer stub, last = growth toward the apex) still
// holds.
//
// #526 (playtest: "the shield should stay on its full-shape outline even when depleted, not
// distort as it drains"): `track` was already frac-independent — the real fix was on the PAINT
// side (HudScene now draws it thicker and at several gradient layers so it actually reads as an
// always-present shape rather than a near-invisible hairline next to the bright partial fill).
// `pad` (optional, defaults to 0 = old behaviour exactly) is what lets HudScene draw those extra
// gradient layers as the SAME shape grown outward, instead of a different shape.
export function shieldArcLayout(rect, frac, pad = 0) {
  const S = SHIELD_ARC;
  const f = Math.max(0, Math.min(1, frac ?? 0));
  return {
    track: bracketOutline(rect, pad),
    left: f > 0 ? bracketArc(rect, 'left', 0, f, S.steps, pad) : [],
    right: f > 0 ? bracketArc(rect, 'right', 0, f, S.steps, pad) : [],
  };
}

// ── FUSED ────────────────────────────────────────────────────────────────────────────────────
//
// #495: armor/structure/shield painted DIRECTLY onto the four skill tiles rather than a separate
// block beside them (see HudScene's `_paintFusedReadout` for the paint — this module only holds
// the shield-dome geometry above and this shape). Like NONE this is a ZERO-WIDTH block: there is
// nothing beside the tile row to lay out, because the readout lives ON the tiles. Unlike NONE,
// HudScene still reserves a header-line's worth of room above the row — pulled up by
// `FUSED_DOME_RISE` — so the console shell's own height leaves room for the shield dome to arc
// into instead of clipping it against the plate's top edge.
// #526-followup (point 1): headroom the console shell has to reserve ABOVE the ability row so the
// notch's own peak (`SHIELD_ARC.rise` above the row) doesn't poke out past the shell's flat top —
// exactly `SHIELD_ARC.rise` minus the shell's own `CONSOLE.padTop` (the generic "breathing room"
// every mode already reserves above its header line), so the shell's top edge lands EXACTLY on
// the notch's peak with no extra rim and no overflow either way. Was a flat `rise + 8` measured
// off the WEAPON row (before the ability row existed above it) — stale once the ability row moved
// above the weapons, which is what let the notch's peak poke out past the shell (the bug behind
// point 6's "bend doesn't track the panel" report — see HudScene's `_makePanel`).
export const FUSED_DOME_RISE = Math.max(0, SHIELD_ARC.rise - CONSOLE.padTop);

export function fusedLayout({ anchorX = 0, bottomY = 0 } = {}) {
  return {
    mode: 'fused',
    x: anchorX, w: 0,
    top: bottomY, bottom: bottomY,
    labelY: bottomY,
    headerY: bottomY,
    segments: [],
    shieldLabel: null,
  };
}

// The three layers a mech shows as WHOLE-MECH pools, summed over its damage-tracked parts — the
// paper doll's shield outline reads its `shield`/`hasShield`. `locs` scopes the sum to exactly the
// locations the readout draws, so the pools and the bar block can never disagree about what "your
// armor" means. Pure; mirrors hudLayout.js
// `bodyPools` (which reads a TARGET's body, including flat-hp vehicles) for the player's own mech.
export function mechPools(mech, locs) {
  let hp = 0, maxHp = 0, armor = 0, maxArmor = 0;
  for (const loc of locs) {
    const p = mech?.parts?.[loc];
    if (!p) continue;
    hp += Math.max(0, p.hp ?? 0); maxHp += p.maxHp ?? 0;
    armor += Math.max(0, p.armor ?? 0); maxArmor += p.maxArmor ?? 0;
  }
  const hasShield = mech?.hasShield?.() ?? false;
  const shieldHp = mech?.shieldTotalHp?.() ?? mech?.shield?.hp ?? 0;
  const shieldMax = mech?.shield?.max ?? 0;
  return {
    hp: maxHp > 0 ? Math.min(1, hp / maxHp) : 0,
    armor: maxArmor > 0 ? Math.min(1, armor / maxArmor) : 0,
    hasArmor: maxArmor > 0,
    // The temp pool (#381) can push the shield past its base max; the outline clamps rather than
    // growing, because unlike the bar there is no room above it to grow INTO.
    shield: hasShield && shieldMax > 0 ? Math.min(1, shieldHp / shieldMax) : 0,
    hasShield,
  };
}

// ── CORE METER (fused shield line, generalised) ────────────────────────────────────────────────
//
// New playtest ask (alongside points 6/7's shield bend/gradient fix): the fused readout's whole-
// row bracket used to be hardcoded to shield HP. Passive/core items other than Shield (#494's
// Anti-Missile Defense today, whatever else lands in `coreItems.js` later) also want to ride that
// same visual — AMS as its own recharge progress, e.g. — so this reads whichever value makes
// sense for whatever is actually mounted in the core slot, rather than always asking for shield.
//
// Deliberately MINIMAL plumbing: each `CORE_ITEMS` entry that wants a meter owns a pure
// `meterFrac(mech)` function (see coreItems.js) — this is just the dispatcher that looks up the
// mounted item and calls it, degrading to "no meter" (`has: false`) for an empty slot, an unknown/
// stale mount, or an item with no `meterFrac` of its own. `_paintFusedReadout` (HudScene.js) feeds
// the returned `frac` into the exact same `shieldArcLayout`/`bracketOutline` geometry a literal
// shield used to — the bracket itself has never cared what the fraction MEANS, only that it's a
// 0..1 number, so no change was needed there at all.
//
// Not attempted here (flagged as follow-up rather than guessed at): a fully generic (value, max)
// pair with its own formatting/label per item, multiple simultaneous core meters, or retrofitting
// every OTHER readout mode (bars/paperdoll/target-disc rings) off literal `mechPools().shield` —
// this pass only generalises the ONE call site (the fused bracket) that was asked about.
export function coreMeter(mech) {
  const id = mech?.coreMounts?.core ?? null;
  const item = id ? getCoreItem(id) : null;
  if (!item?.meterFrac) return { has: false, frac: 0 };
  const frac = item.meterFrac(mech);
  return frac == null ? { has: false, frac: 0 } : { has: true, frac: Math.max(0, Math.min(1, frac)) };
}
