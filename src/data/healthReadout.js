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
//                 (arm, torso, torso, arm). Per-segment FILL = that part's HP, per-segment OUTLINE
//                 = that part's armor (drawn as a perimeter that drains around the frame, so an
//                 outline can show a FRACTION at all), and ONE outline around the whole doll = the
//                 mech's shield, exactly as the issue describes it.
//
// A fourth mode, the Diablo/PoE-style ORB readout, was built for that comparison and DELETED after
// it (Jackson: "remove the circle option") — layout, fill polygon, paint path and tests, so no dead
// art path is left behind.
//
// Everything here is pure: positions and polylines. HudScene only paints to these numbers,
// the same contract `integrityLayout` already had, so every mode shares one console frame and
// one baseline. Every layout returns the SAME shape — `{ x, w, top, bottom, headerY, labelY,
// segments, shieldLabel }` — because the console shell (#452) frames whatever the panel laid out,
// and a mode swap must not need the shell to know which mode it is framing.

import { INTEGRITY_BARS } from './hudLayout.js';

// The cycle order. 'none' is FIRST because it is the default — a fresh run starts with no integrity
// display at all, which is the experiment: whether the mech's own art carries it. H then walks the
// two surviving readouts and comes back.
export const READOUT_MODES = ['none', 'bars', 'paperdoll'];

export const READOUT_LABELS = {
  none: 'NONE',
  bars: 'BARS',
  paperdoll: 'PAPER DOLL',
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
