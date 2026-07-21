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
    rounded: true, bubbly: true, legibilityHalo: true,
    outline: 0x2b3441, deep: 0x9aa7b6, ao: 0x8b97a6, recess: 0x96a3b2, housing: 0x5a6675,
    lower: 0xc3ccd6, faceDk: 0xb6c2cf, faceMid: 0xd3dae2, face: 0xe7ecf1,
    rim: 0xf6f9fb, rimHi: 0xffffff, joint: 0x8b97a6, grime: 0x96a3b2, char: 0x4a3a36,
  },
};
// #348 (local co-op, player identification): an optional per-OWNER accent layered on top of a
// faction palette. Two mechs on the same side must be told apart at a glance, and the theme
// table is already the one place a mech's colour is decided — so rather than bolt on a parallel
// tinting mechanism, an `accent` recolours the palette's RIM tones (the lit top edges of every
// plate). That reads as "same machine, different unit markings" instead of "different faction":
// the body/shadow tones, the reactor purple and every weapon-category neon are untouched, so a
// loadout still reads exactly as it did. `accent` omitted/null returns the base theme object
// itself, unchanged and uncloned — which is what player 1 and every enemy get.
export const themeFor = (opts) => {
  const base = THEMES[opts?.theme] ?? THEMES.player;
  if (!opts?.accent) return base;
  return { ...base, rim: opts.accent, rimHi: opts.accent };
};

// The mech's own power glow (not a weapon).
export const REACTOR = { halo: 0x7a2ed6, core: 0xb15cff, hot: 0xecd6ff, edge: 0x8a4ad6 };

// #129: a fixed, near-white "legibility halo" — an extra silhouette ring drawn OUTSIDE a
// part's existing dark outline, enemy/vehicle-only (`T.legibilityHalo`/opt-in per call site).
// The existing dark outline already reads fine against LIGHT biome grounds (snow, sand): the
// bug is dark biome grounds (volcanic ash, night-dark grass/urban patches) where that dark
// outline is nearly the same tone as the terrain and the silhouette disappears. Rather than
// re-picking per-biome colours (would require a combinatorial retune of every enemy × every
// biome), this adds ONE more ring in a bright, fixed tone: on light terrain the inner dark
// outline still carries the edge (unchanged); on dark terrain this outer bright ring now
// does. The two rings together read against the whole 5-biome range without touching any
// enemy's identifying body/accent colour.
export const HALO = 0xfbfdff;

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
    if (T.legibilityHalo) ellipseC(sg, cx, cy, w + 2.8, h + 2.8, HALO);
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
    if (T.legibilityHalo) roundC(sg, cx, cy, w + 2.6, h + 2.6, HALO, r + 0.8);
    roundC(sg, cx, cy, w + 1.2, h + 1.2, T.outline, r + 0.4);
    roundC(sg, cx, cy, w, h, fill, r);
    inset = Math.min(w, h) * 0.16;
  } else {
    const c = opts.chamfer ?? Math.min(w, h) * 0.22;
    if (T.legibilityHalo) poly(sg, chamfer(cx, cy, w + 2.6, h + 2.6, c + 0.8), HALO);
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

// #246: a bright plating-shell overlay drawn OVER a part's base plate — four corner brackets
// (a circuit-board/bolted-plating read) in a fixed steel-blue tone, deliberately NOT a faction
// color so it reads as the same "still armored" language on both the player's dark gunmetal
// theme and the enemy's light rounded theme. This is what makes armor a VISIBLE trait on the
// mech itself (not just a HUD number): the caller only invokes this while the location's armor
// pool is > 0 (see mechArt.js drawArm/drawSideTorso) — once armor hits 0 the caller simply stops
// drawing it, and the bare plate underneath (no brackets) reads as "armor stripped." Binary
// present/absent (not a continuous fade) deliberately mirrors `stump`'s own all-or-nothing
// visual state and the existing "only rebuild the texture when a discrete state crosses"
// performance rule (see combat.js's `armorBrokeNow` reskin trigger) — a per-hit fade would
// require rebuilding this texture on every single hit instead of only when armor actually
// breaks/returns.
const ARMOR_SHELL = 0x9fe0ff;
export function armorShell(sg, cx, cy, w, h) {
  const bw = Math.max(1.1, Math.min(w, h) * 0.09);   // bracket arm thickness
  const len = Math.min(w, h) * 0.32;                  // bracket arm length
  const x0 = cx - w / 2 + bw / 2, x1 = cx + w / 2 - bw / 2;
  const y0 = cy - h / 2 + bw / 2, y1 = cy + h / 2 - bw / 2;
  const corners = [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]];
  for (const [sx, sy, dx, dy] of corners) {
    rectC(sg, sx + (dx * len) / 2, sy, len, bw, ARMOR_SHELL, 0.8);
    rectC(sg, sx, sy + (dy * len) / 2, bw, len, ARMOR_SHELL, 0.8);
  }
}

// A thick line segment (a rotated quad) between two design-coord points — used to draw the
// frayed cabling / struts inside a torn-open panel.
function thickLine(sg, x0, y0, x1, y1, t, fill, alpha = 1) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (t / 2), ny = (dx / len) * (t / 2);
  poly(sg, [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], fill, alpha);
}

// #401 — the ARMOR-STRIPPED state, replacing the #246 "brackets bolted on top of an armored
// plate" read. The new direction (owner's): the clean base plate IS the fully-armored look, so
// full armor draws NOTHING extra. When a location's ARMOR is gone but its STRUCTURE still lives
// (distinct from `stump`, which is full destruction), a jagged panel is TORN OFF this part to
// bare the internals underneath — a dark cavity, a lit powered core, strut/actuator hardware,
// frayed multicoloured cabling and a couple of spark glints. Baked into the part texture (rebuilt
// only when armor breaks/returns, per the existing `armorBrokeNow` reskin gate), so the "spark"
// is a fixed hot glint, not a per-frame animation. Deterministic jag offsets keep it stable.
const INTERNAL_DARK = 0x0a0d13;   // the shadowed void behind the peeled shell
const INTERNAL_STRUT = 0x363d47;  // actuators / structural ribs inside
const SPARK = { halo: 0xffb04a, core: 0xffd98a, hot: 0xffffff, edge: 0xffcf85 };
const WIRES = [0xd23b3b, 0xe0b23a, 0x3ba0e0, 0x46c07a];  // frayed cabling (R/Y/B/G)
export function exposedInternals(sg, T, cx, cy, w, h) {
  const m = Math.min(w, h);
  // Jagged torn cavity: an 8-point ring with alternating in/out radii so the rim reads as
  // bent-back, ripped plating rather than a clean-cut hole. Fixed jag => stable across rebuilds.
  const rw = w * 0.36, rh = h * 0.36;
  const jag = [1.0, 0.62, 0.94, 0.68, 1.04, 0.6, 0.9, 0.7];
  const cav = jag.map((k, i) => {
    const a = (i / jag.length) * Math.PI * 2 - Math.PI / 2;
    return [cx + Math.cos(a) * rw * k, cy + Math.sin(a) * rh * k];
  });
  // Peeled-back metal lip (a larger, lighter torn edge) then the dark interior void.
  poly(sg, cav.map(([x, y]) => [(x - cx) * 1.18 + cx, (y - cy) * 1.18 + cy]), T.faceDk);
  poly(sg, cav.map(([x, y]) => [(x - cx) * 1.08 + cx, (y - cy) * 1.08 + cy]), T.outline);
  poly(sg, cav, INTERNAL_DARK);
  // A faint powered glow deep in the cavity — reads as "live machine still running inside."
  ellipseC(sg, cx, cy + h * 0.04, rw * 1.1, rh * 0.9, REACTOR.halo, 0.28);
  // Structural struts / actuator ribs behind the wiring.
  thickLine(sg, cx - rw * 0.55, cy - rh * 0.7, cx - rw * 0.35, cy + rh * 0.75, m * 0.1, INTERNAL_STRUT);
  thickLine(sg, cx + rw * 0.5, cy - rh * 0.75, cx + rw * 0.4, cy + rh * 0.7, m * 0.1, INTERNAL_STRUT);
  // Frayed cabling: a few thin coloured runs across the cavity at varied angles.
  thickLine(sg, cx - rw * 0.7, cy - rh * 0.3, cx + rw * 0.6, cy + rh * 0.2, Math.max(0.7, m * 0.05), WIRES[0]);
  thickLine(sg, cx - rw * 0.4, cy + rh * 0.6, cx + rw * 0.55, cy - rh * 0.55, Math.max(0.7, m * 0.05), WIRES[1]);
  thickLine(sg, cx - rw * 0.15, cy - rh * 0.75, cx + rw * 0.1, cy + rh * 0.7, Math.max(0.6, m * 0.045), WIRES[2]);
  thickLine(sg, cx + rw * 0.1, cy + rh * 0.5, cx - rw * 0.6, cy + rh * 0.1, Math.max(0.6, m * 0.045), WIRES[3]);
  // A couple of hot spark glints where the shell tore free.
  glowDot(sg, cx + rw * 0.45, cy - rh * 0.4, Math.max(0.9, m * 0.07), SPARK);
  glowDot(sg, cx - rw * 0.5, cy + rh * 0.45, Math.max(0.7, m * 0.05), SPARK);
}

// A destroyed location: a charred lump with faint embers.
export function stump(sg, T, cx, cy, w, h) {
  const m = Math.min(w, h);
  if (T.bubbly) {
    if (T.legibilityHalo) ellipseC(sg, cx, cy, w * 0.62 + 1.4, h * 0.5 + 1.4, HALO);
    ellipseC(sg, cx, cy, w * 0.62, h * 0.5, T.outline);
    ellipseC(sg, cx, cy, w * 0.56, h * 0.44, T.char);
  } else if (T.rounded) {
    if (T.legibilityHalo) roundC(sg, cx, cy, w * 0.62 + 1.4, h * 0.5 + 1.4, HALO, m * 0.18 + 0.5);
    roundC(sg, cx, cy, w * 0.62, h * 0.5, T.outline, m * 0.18);
    roundC(sg, cx, cy, w * 0.56, h * 0.44, T.char, m * 0.16);
  } else {
    if (T.legibilityHalo) poly(sg, chamfer(cx, cy, w * 0.62 + 1.4, h * 0.5 + 1.4, m * 0.14 + 0.4), HALO);
    poly(sg, chamfer(cx, cy, w * 0.62, h * 0.5, m * 0.14), T.outline);
    poly(sg, chamfer(cx, cy, w * 0.56, h * 0.44, m * 0.14), T.char);
  }
  sg.fillStyle(0x7a2a12, 0.6); sg.fillCircle(CENTER + cx, CENTER + cy, m * 0.12);
  sg.fillStyle(0xd6601e, 0.5); sg.fillCircle(CENTER + cx, CENTER + cy, m * 0.06);
}
