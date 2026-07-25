// #448: the switchable health readout.
//
// The bar readout (the bottom-left block of vertical bars, `integrityLayout` in hudLayout.js)
// answered the first half of the issue by deleting every numeral from the HUD — the bar fill alone
// carries armor / structure / shield. The second half asked for ALTERNATE readouts to compare
// against it in play rather than in a mockup, so this module holds them as pure geometry:
//
//   'none'      — no integrity readout at all: the mech's own art (shield opacity, destroyed-part
//                 stumps) carries it. The DEFAULT since the 2026-07-23 playtest.
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
//   'fused'     — #495: no separate block at all — armor/structure/shield fuse directly onto the
//                 four weapon skill tiles. Per-tile WASH = structure (`structureColor`, painted
//                 over the tile's own art rather than a separate cell); per-tile DRAIN = armor —
//                 a playtest follow-up replaced the original drain-around-the-frame perimeter
//                 (`perimeterRun`, still what paperdoll's outline uses) with `armorDrainRect`,
//                 below: a top-to-bottom "draining tank" overlay, because Jackson wanted armor to
//                 read as depleting DOWN the tile, not around its edge; and ONE whole-mech shield
//                 DOME arcing over the top+sides of the whole row (`shieldArcLayout`, below — a
//                 shape of its own: two mirrored arcs, not `ringSweep`'s single clockwise sweep and
//                 not paperdoll's rectangular perimeter). Structure still rides the structure-
//                 colour ramp, same as paperdoll; armor now rides the target disc's own fixed
//                 armor tone instead (see `armorDrainRect`'s own note) so it reads as a distinct
//                 layer from structure rather than a second copy of the same ramp.
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

import { INTEGRITY_BARS } from './hudLayout.js';

// The cycle order. 'none' is FIRST because it is the default — a fresh run starts with no integrity
// display at all, which is the experiment: whether the mech's own art carries it. H then walks the
// surviving readouts and comes back.
export const READOUT_MODES = ['none', 'bars', 'paperdoll', 'fused'];

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
// overlay instead. Full armor covers the tile top-to-bottom; as armor drains, the covered band's
// TOP edge recedes downward, so what survives visually sits at the tile's own BOTTOM and shrinks
// upward as armor is lost — never sideways, never around the frame.
//
// Pure geometry only: given the tile's own rect and the live armor fraction (0..1), returns the
// overlay's own `{ x, y, w, h }` — full width, bottom pinned to the tile's own bottom edge, top
// at `rect.y + rect.h * (1 - frac)` — plus `full`, true only at frac >= 1, so the paint step can
// round the overlay's TOP corners to match the tile's own plate only when the overlay truly
// covers the whole tile; a partial drain's top edge is a flat line, not a rounded corner, because
// that's the drain line itself — the only part of the shape that actually moves.
export function armorDrainRect(rect, frac) {
  const f = Math.max(0, Math.min(1, frac ?? 0));
  const h = f * rect.h;
  return { x: rect.x, y: rect.y + (rect.h - h), w: rect.w, h, full: f >= 1 };
}

// ── SHIELD ARC (fused) ──────────────────────────────────────────────────────────────────────
//
// #495: the fused readout's shield is a DOME/CANOPY over the top+sides of the whole tile row —
// not a per-tile ring (shield is a single whole-mech pool, `mechPools().shield`), not `ringSweep`
// (hudLayout.js — a single clockwise sweep built for the small target-disc rings), and not the
// paper doll's shield (a full rectangular PERIMETER outline). This is TWO MIRRORED ARCS sharing
// one apex at 12 o'clock over the row's own centre: as the fraction drops each one retracts
// independently back toward that apex, so a half-shield reads as "the canopy pulled back on both
// edges" rather than one arc sweeping across like a gauge.
//
// The dome rides an ELLIPSE (not a circle), centred at `ecy` — the row's own top edge dropped down
// by `sideDrop` — because the row is wide and short: a true circular semicircle over a ~4:1 rect
// would either barely clear the tiles or balloon absurdly high. Independent radii let the dome
// reach `overhang` px past the row's own edges and `rise` px above its top regardless of the row's
// own proportions.
export const SHIELD_ARC = {
  overhang: 16,   // how far past the row's own left/right edges the dome's ends reach
  rise: 26,       // how far above the row's own top edge the apex sits
  // #495 playtest (Jackson: "the shield arc should wrap the row of four ability buttons"): the
  // ends now land at the row's own BOTTOM edge (1.0 = full row height) rather than ~55% down it,
  // so each side genuinely wraps the tiles' full height instead of just arching over their tops
  // — a capsule/bracket enclosing the row, not a partial droop. The apex height is unaffected:
  // it's fixed at `rise` above the row's own top (`ecy - ry` below), independent of `sideDrop`.
  sideDrop: 1.0,
  steps: 10,      // polyline resolution per half-arc (mirrors `perimeterRun`'s plain-polyline idiom)
};

// One point on the dome's ellipse at angle `t` (radians, screen convention: 0 = +x, increasing
// CLOCKWISE, so -PI/2 is straight up — the apex both mirrored arcs retract toward).
function domePoint(cx, ecy, rx, ry, t) {
  return { x: cx + rx * Math.cos(t), y: ecy + ry * Math.sin(t) };
}

// A polyline from angle `a0` to `a1` in `steps` segments — the same "hand back a drawable
// polyline, not raw angles" idiom `perimeterRun` uses, so HudScene paints both with `strokePoints`.
function domeArc(cx, ecy, rx, ry, a0, a1, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + (a1 - a0) * (i / steps);
    pts.push(domePoint(cx, ecy, rx, ry, t));
  }
  return pts;
}

// `rect` is the tile row's own bounding box (HudScene's `panel.tileBox`, off `ui/skillTiles.js`
// `tileRow`). `frac` is the shield's live fraction (`mechPools().shield`, 0..1). Returns the
// ALWAYS-drawn dim TRACK — the full dome, both ends fully extended, the same "empty space stays
// legible" rule every other layer's backing follows — plus the two mirrored LIT arcs: empty at
// frac 0, a full quarter-turn each at frac 1.
//
// #495 playtest (Jackson: shield should deplete from the MIDDLE out, not the sides in): each lit
// arc is anchored at its OUTER end — `leftOuter`/`rightOuter`, the side stub nearest the tile
// row's own edge — and grows TOWARD the shared apex as the fraction rises. So at frac 1 both arcs
// reach all the way to the apex (the full dome); as the shield drains the reach shrinks back
// toward the outer end, opening a gap at top-centre first and widening it outward, until at frac 0
// nothing is left at all. This is the mirror image of the original cut, which anchored at the
// apex and grew OUTWARD — meaning a half-shield used to read as "the centre survived, the sides
// are gone," backwards from what a canopy retracting under fire should look like.
export function shieldArcLayout(rect, frac) {
  const S = SHIELD_ARC;
  const cx = rect.x + rect.w / 2;
  const ecy = rect.y + rect.h * S.sideDrop;
  const rx = rect.w / 2 + S.overhang;
  const ry = (ecy - rect.y) + S.rise;
  const apex = -Math.PI / 2;
  const quarter = Math.PI / 2;
  const leftOuter = apex - quarter;
  const rightOuter = apex + quarter;
  const f = Math.max(0, Math.min(1, frac ?? 0));
  const reach = f * quarter;
  return {
    cx, cy: ecy, rx, ry,
    track: [
      ...domeArc(cx, ecy, rx, ry, apex, leftOuter, S.steps).reverse(),
      ...domeArc(cx, ecy, rx, ry, apex, rightOuter, S.steps).slice(1),
    ],
    // Each lit arc runs OUTER → apex, so index 0 is always the fixed outer stub and the LAST
    // point is how far it has grown toward the shared apex — the opposite indexing from before.
    left: reach > 0 ? domeArc(cx, ecy, rx, ry, leftOuter, leftOuter + reach, S.steps) : [],
    right: reach > 0 ? domeArc(cx, ecy, rx, ry, rightOuter, rightOuter - reach, S.steps) : [],
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
export const FUSED_DOME_RISE = SHIELD_ARC.rise + 8;   // the dome's own rise + clearance for its glow

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
