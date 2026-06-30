// Shared mech-art primitives + palettes. The low-level draw helpers (all in mech-local
// design coords: origin = centre, -y up) and the faction/glow palettes, factored out of
// mechArt.js so the per-category weapon-mount art (./mounts/) and per-kind chassis decor
// (./decor/) can reuse them without importing the orchestrator (avoids a cycle).
import { ART_SCALE, scaledGraphics } from './_frames.js';

export { scaledGraphics };
export const DESIGN = 64;              // design-grid canvas size (square)
export const CENTER = DESIGN / 2;

// Faction palettes. `rounded` swaps the plate primitive (chamfered ↔ rounded). Tones run
// outline (edge) → deep/ao (shadow) → faceDk/faceMid/face (panels) → rim/rimHi (light).
const THEMES = {
  player: {
    rounded: false,
    outline: 0x0b0e14, deep: 0x1b212b, ao: 0x10131a, recess: 0x14181f, housing: 0x14181f,
    lower: 0x252c38, faceDk: 0x2a323e, faceMid: 0x2e3543, face: 0x3a4250,
    rim: 0x4b5666, rimHi: 0x566273, joint: 0x181d27, grime: 0x0e1219, char: 0x17120f,
  },
  enemy: {
    rounded: true, bubbly: true,
    outline: 0x2b3441, deep: 0x9aa7b6, ao: 0x8b97a6, recess: 0x96a3b2, housing: 0x5a6675,
    lower: 0xc3ccd6, faceDk: 0xb6c2cf, faceMid: 0xd3dae2, face: 0xe7ecf1,
    rim: 0xf6f9fb, rimHi: 0xffffff, joint: 0x8b97a6, grime: 0x96a3b2, char: 0x4a3a36,
  },
};
export const themeFor = (opts) => THEMES[opts?.theme] ?? THEMES.player;

// The mech's own power glow (not a weapon).
export const REACTOR = { halo: 0x7a2ed6, core: 0xb15cff, hot: 0xecd6ff, edge: 0x8a4ad6 };

// Per weapon-category glow ramps {halo, core, hot, edge}. Cores mirror CATEGORIES.color.
export const NEON = {
  energy:    { halo: 0x1390c8, core: 0x38d9ff, hot: 0xe6fbff, edge: 0x7fe6ff },
  ballistic: { halo: 0xc8801a, core: 0xffb24a, hot: 0xffe6b0, edge: 0xffcf85 },
  missile:   { halo: 0xc81f72, core: 0xff4fa3, hot: 0xffd0e6, edge: 0xff8cc2 },
  melee:     { halo: 0x9aa0ad, core: 0xcfd6e0, hot: 0xffffff, edge: 0xf2f4f7 },
  support:   { halo: 0x1f9c54, core: 0x6dff9e, hot: 0xd6ffe6, edge: 0xa6ffc6 },
};
export const neonFor = (catId) => NEON[catId] ?? NEON.melee;

// ── Low-level draw helpers (all in mech-local design coords: origin = centre, -y up).

// Filled polygon from [x,y] pairs.
export function poly(sg, pts, fill, alpha = 1) {
  sg.fillStyle(fill, alpha);
  sg.fillPoints(pts.map(([x, y]) => ({ x: CENTER + x, y: CENTER + y })), true);
}
// Centred filled rect.
export function rectC(sg, cx, cy, w, h, fill, alpha = 1) {
  sg.fillStyle(fill, alpha);
  sg.fillRect(CENTER + cx - w / 2, CENTER + cy - h / 2, w, h);
}
// Centred rounded rect (via the raw super-sampled graphics).
export function roundC(sg, cx, cy, w, h, fill, r, alpha = 1) {
  sg.fillStyle(fill, alpha);
  const k = ART_SCALE, rr = Math.min(r, w / 2, h / 2);
  sg.raw.fillRoundedRect((CENTER + cx - w / 2) * k, (CENTER + cy - h / 2) * k, w * k, h * k, rr * k);
}
// Centred filled ellipse (used for soft glow pools).
export function ellipseC(sg, cx, cy, w, h, fill, alpha = 1) {
  sg.fillStyle(fill, alpha);
  sg.fillEllipse(CENTER + cx, CENTER + cy, w, h);
}
// Octagon (chamfered rect) point list — the angular plate primitive.
export function chamfer(cx, cy, w, h, c) {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  return [[x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c],
          [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c]];
}

// A shaded armour plate: dark outline, mid face, a top highlight rim catching overhead
// light, a lower ambient-occlusion shadow, and an optional panel seam. Angular for the
// player theme, rounded for the enemy theme.
export function plate(sg, T, cx, cy, w, h, opts = {}) {
  const fill = opts.fill ?? T.face;
  // Bubbly: each part is a glossy blob — an ellipse with a soft bottom shadow and a
  // bright highlight spot up top so it reads like an inflated/ceramic pod.
  if (T.bubbly) {
    ellipseC(sg, cx, cy, w + 1.4, h + 1.4, T.outline);
    ellipseC(sg, cx, cy, w, h, fill);
    ellipseC(sg, cx, cy + h * 0.24, w * 0.8, h * 0.4, T.ao, 0.35);
    ellipseC(sg, cx - w * 0.13, cy - h * 0.2, w * 0.42, h * 0.32, opts.rim ?? T.rim, 0.9);
    ellipseC(sg, cx - w * 0.16, cy - h * 0.26, w * 0.18, h * 0.14, T.rimHi);
    return;
  }
  let inset;
  if (T.rounded) {
    const r = Math.min(w, h) * 0.34;
    roundC(sg, cx, cy, w + 1.2, h + 1.2, T.outline, r + 0.4);
    roundC(sg, cx, cy, w, h, fill, r);
    inset = Math.min(w, h) * 0.16;
  } else {
    const c = opts.chamfer ?? Math.min(w, h) * 0.22;
    poly(sg, chamfer(cx, cy, w + 1.2, h + 1.2, c + 0.4), T.outline);
    poly(sg, chamfer(cx, cy, w, h, c), fill);
    inset = c;
  }
  rectC(sg, cx, cy - h / 2 + h * 0.085, w - 2 * inset, h * 0.15, opts.rim ?? T.rim);
  rectC(sg, cx, cy + h / 2 - h * 0.08, w - 2 * inset, h * 0.13, T.ao, 0.5);
  if (opts.seam !== false) rectC(sg, cx, cy + h * 0.05, w * 0.58, Math.max(0.8, h * 0.04), T.grime, 0.7);
}

// Layered point-glow: wide faint halo → tighter halo → bright core → hot centre.
export function glowDot(sg, cx, cy, r, n) {
  sg.fillStyle(n.halo, 0.22); sg.fillCircle(CENTER + cx, CENTER + cy, r * 2.2);
  sg.fillStyle(n.halo, 0.5);  sg.fillCircle(CENTER + cx, CENTER + cy, r * 1.35);
  sg.fillStyle(n.core, 1);    sg.fillCircle(CENTER + cx, CENTER + cy, r);
  sg.fillStyle(n.hot, 1);     sg.fillCircle(CENTER + cx, CENTER + cy, r * 0.42);
}
// Emissive bar (reactor spine / vent slits): halo spill → core → hot streak.
export function glowBar(sg, cx, cy, w, h, n) {
  rectC(sg, cx, cy, w * 1.9 + 1.4, h * 1.5 + 1.4, n.halo, 0.38);
  rectC(sg, cx, cy, w, h, n.core, 1);
  rectC(sg, cx, cy, w * 0.36, h * 0.7, n.hot, 1);
}

// A weapon barrel: a glossy ellipse (bubbly), a rounded bar (rounded), or a plain dark
// bar (angular). Shared by the ballistic/support/energy mounts.
export function barrel(sg, T, cx, cy, w, h) {
  return T.bubbly
    ? ellipseC(sg, cx, cy, w * 1.5, h, T.faceDk)
    : T.rounded
    ? roundC(sg, cx, cy, w, h, T.faceDk, Math.min(w, h) * 0.45)
    : rectC(sg, cx, cy, w, h, T.faceDk);
}

// A destroyed location: a charred lump with faint embers.
export function stump(sg, T, cx, cy, w, h) {
  const m = Math.min(w, h);
  if (T.bubbly) {
    ellipseC(sg, cx, cy, w * 0.62, h * 0.5, T.outline);
    ellipseC(sg, cx, cy, w * 0.56, h * 0.44, T.char);
  } else if (T.rounded) {
    roundC(sg, cx, cy, w * 0.62, h * 0.5, T.outline, m * 0.18);
    roundC(sg, cx, cy, w * 0.56, h * 0.44, T.char, m * 0.16);
  } else {
    poly(sg, chamfer(cx, cy, w * 0.62, h * 0.5, m * 0.14), T.outline);
    poly(sg, chamfer(cx, cy, w * 0.56, h * 0.44, m * 0.14), T.char);
  }
  sg.fillStyle(0x7a2a12, 0.6); sg.fillCircle(CENTER + cx, CENTER + cy, m * 0.12);
  sg.fillStyle(0xd6601e, 0.5); sg.fillCircle(CENTER + cx, CENTER + cy, m * 0.06);
}
