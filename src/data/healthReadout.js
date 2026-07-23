// #448: THREE health readouts, switchable live.
//
// The shipped readout (the bottom-left block of vertical bars, `integrityLayout` in hudLayout.js)
// answered the first half of the issue by deleting every numeral from the HUD — the bar fill alone
// carries armor / structure / shield. The second half asked for two ALTERNATE readouts to compare
// against it in play rather than in a mockup, so this module adds them as pure geometry:
//
//   'bars'      — the shipped block (laid out by hudLayout.js `integrityLayout`; named here only
//                 so the mode cycle has something to return to).
//   'orbs'      — Diablo/PoE-style globes: three circles that drain from the top down. Deliberately
//                 AGGREGATE (one HP globe, one armor globe, one shield globe) — a globe per body
//                 location would be six of them and read as a bubble chart, and the ARPG readout
//                 being compared against is one-pool-per-globe by nature.
//   'paperdoll' — one rounded rect per damage-tracked location, arranged as a mech silhouette
//                 (arm, torso, torso, arm). Per-segment FILL = that part's HP, per-segment OUTLINE
//                 = that part's armor (drawn as a perimeter that drains around the frame, so an
//                 outline can show a FRACTION at all), and ONE outline around the whole doll = the
//                 mech's shield, exactly as the issue describes it.
//
// Everything here is pure: positions, radii and polylines. HudScene only paints to these numbers,
// the same contract `integrityLayout` already had, so all three modes share one console frame and
// one baseline. Every layout returns the SAME shape — `{ x, w, top, bottom, headerY, labelY,
// segments, shieldLabel, extraLabels }` — because the console shell (#452) frames whatever the
// panel laid out, and a mode swap must not need the shell to know which mode it is framing.

import { INTEGRITY_BARS } from './hudLayout.js';

// The cycle order. 'bars' is first because it is the SHIPPED readout — a fresh run always starts
// on it, and cycling always comes back to it.
export const READOUT_MODES = ['bars', 'orbs', 'paperdoll'];

export const READOUT_LABELS = {
  bars: 'BARS',
  orbs: 'ORBS',
  paperdoll: 'PAPER DOLL',
};

// Anything unrecognised (an old saved value, an empty registry on the first frame) reads as the
// shipped readout rather than throwing or blanking the HUD.
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

// ── ORBS ─────────────────────────────────────────────────────────────────────────────────────
//
// Three globes on the same baseline the bars sit on, in the same left-to-right reading order the
// bar block uses (HP, armor, then the whole-mech shield last). The shield's slot is reserved even
// on a build with no shield, for the same reason the bar block reserves its shield bar: a
// shieldless build must not shift everything else sideways.
export const ORBS = {
  gap: 12,       // between globes
  maxR: 33,      // biggest a globe gets (its diameter is capped by the bar block's height too)
  minR: 13,      // ...and the smallest, in a cramped co-op half
  order: ['hp', 'armor', 'shield'],
};

// Same contract as `integrityLayout`: `anchorX` is the block's OUTER edge on its own side of the
// screen, `bottomY` the baseline it shares with the skill tiles, `availW` the room between them
// (0/absent = unmeasured ⇒ full size).
export function orbLayout({ anchorX, bottomY, availW = 0, side = 'left' }) {
  const S = INTEGRITY_BARS;
  const n = ORBS.order.length;
  const fullR = Math.min(ORBS.maxR, S.barH / 2);
  const nominal = n * 2 * fullR + (n - 1) * ORBS.gap;
  const scale = Math.max(
    ORBS.minR / fullR,
    Math.min(1, (availW > 0 ? availW : nominal) / nominal),
  );
  const r = fullR * scale;
  const gap = ORBS.gap * scale;
  const w = n * 2 * r + (n - 1) * gap;
  const x = side === 'right' ? anchorX - w : anchorX;
  const bottom = bottomY - S.labelH;
  const cy = bottom - r;
  const top = cy - r;
  const labelY = bottom + 2;
  const orbs = ORBS.order.map((key, i) => ({ key, cx: x + r + i * (2 * r + gap), cy, r }));
  return {
    mode: 'orbs',
    x, w, top, bottom, r, orbs,
    labelY,
    headerY: top - S.headerH,
    // No per-LOCATION segments in this mode by design (see the module note) — so the generic
    // per-part label loop in HudScene simply does nothing, and the three globe captions ride the
    // `extraLabels`/`shieldLabel` channels every mode shares.
    segments: [],
    shieldLabel: { x: orbs[2].cx, y: labelY },
    extraLabels: [
      { text: 'HP', x: orbs[0].cx, y: labelY },
      { text: 'AR', x: orbs[1].cx, y: labelY },
    ],
  };
}

// The filled part of a globe, as a polygon. A globe drains from the TOP down (an ARPG orb is a
// vessel of liquid), so the fill is the circular segment BELOW the water line — which is why this
// has to be a polygon rather than a rect: the fill's width narrows as it empties, and that
// narrowing is most of what makes an orb read as an orb.
//
// Returns [] when empty, and the whole disc (as a polygon) when full. Screen coords: +y is down.
export function orbFillPolygon(cx, cy, r, frac, steps = 28) {
  const f = Math.max(0, Math.min(1, frac));
  if (f <= 0 || r <= 0) return [];
  const yLine = cy + r - 2 * r * f;
  const s = Math.max(-1, Math.min(1, (yLine - cy) / r));
  const theta = Math.asin(s);          // angle (from +x, +y down) where the water line cuts the disc
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = theta + (Math.PI - 2 * theta) * (i / steps);
    pts.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
  }
  return pts;
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
    extraLabels: [],
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

// The three layers a mech shows in the AGGREGATE readouts (orbs), summed over its damage-tracked
// parts. `locs` scopes the sum to exactly the locations the readout draws, so the globes and the
// bar block can never disagree about what "your armor" means. Pure; mirrors hudLayout.js
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
    // The temp pool (#381) can push the shield past its base max; the globe/outline clamps rather
    // than growing, because unlike the bar there is no room above it to grow INTO.
    shield: hasShield && shieldMax > 0 ? Math.min(1, shieldHp / shieldMax) : 0,
    hasShield,
  };
}
