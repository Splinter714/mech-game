// Procedural top-down mech art. A mech is drawn as two stacked sprites so the turret
// can aim independently of the legs (tank feel):
//   <key>_hull_0..3 — legs (feet) + pelvis + skirts. 4-frame stompy walk cycle; this
//                     sprite rotates to face the movement direction.
//   <key>_turret    — side/center torsos + arms + head + weapon hardware. Rotates to
//                     face the aim (within the chassis' turret arc).
// Both are drawn pointing "up" (north / -y) and centred. Because the turret is stacked
// ON TOP of the hull, the torso naturally occludes the leg tops — that overhead
// occlusion is what sells the top-down read. Parts are drawn from the live Mech: a
// destroyed location becomes a charred stump and its weapons vanish.
//
// Two visual THEMES distinguish the factions:
//   player — "gritty cyberpunk": dark weathered ANGULAR gunmetal plates (hard chamfers).
//   enemy  — "sleek": light/white ROUNDED panels.
// Both share the glow language, which is theme-independent:
//   purple — the mech's OWN power: reactor spine, cockpit optic, leg thrusters.
//   neon   — each weapon glows its CATEGORY colour (energy cyan, ballistic amber,
//            missile pink, melee white, support green), so loadout reads at a glance.

import { gen, scaledGraphics, ART_SCALE } from './_frames.js';
import { CATEGORIES } from '../data/categories.js';
import { MOUNT_LOCATIONS } from '../data/anatomy.js';
import { isWeapon } from '../data/items.js';
import { getWeapon } from '../data/weapons.js';

export { ART_SCALE };
export const DESIGN = 64;              // design-grid canvas size (square)
const CENTER = DESIGN / 2;

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
const themeFor = (opts) => THEMES[opts?.theme] ?? THEMES.player;

// The mech's own power glow (not a weapon).
const REACTOR = { halo: 0x7a2ed6, core: 0xb15cff, hot: 0xecd6ff, edge: 0x8a4ad6 };

// Per weapon-category glow ramps {halo, core, hot, edge}. Cores mirror CATEGORIES.color.
const NEON = {
  energy:    { halo: 0x1390c8, core: 0x38d9ff, hot: 0xe6fbff, edge: 0x7fe6ff },
  ballistic: { halo: 0xc8801a, core: 0xffb24a, hot: 0xffe6b0, edge: 0xffcf85 },
  missile:   { halo: 0xc81f72, core: 0xff4fa3, hot: 0xffd0e6, edge: 0xff8cc2 },
  melee:     { halo: 0x9aa0ad, core: 0xcfd6e0, hot: 0xffffff, edge: 0xf2f4f7 },
  support:   { halo: 0x1f9c54, core: 0x6dff9e, hot: 0xd6ffe6, edge: 0xa6ffc6 },
};
const neonFor = (catId) => NEON[catId] ?? NEON.melee;

// ── Low-level draw helpers (all in mech-local design coords: origin = centre, -y up).

// Filled polygon from [x,y] pairs.
function poly(sg, pts, fill, alpha = 1) {
  sg.fillStyle(fill, alpha);
  sg.fillPoints(pts.map(([x, y]) => ({ x: CENTER + x, y: CENTER + y })), true);
}
// Centred filled rect.
function rectC(sg, cx, cy, w, h, fill, alpha = 1) {
  sg.fillStyle(fill, alpha);
  sg.fillRect(CENTER + cx - w / 2, CENTER + cy - h / 2, w, h);
}
// Centred rounded rect (via the raw super-sampled graphics).
function roundC(sg, cx, cy, w, h, fill, r, alpha = 1) {
  sg.fillStyle(fill, alpha);
  const k = ART_SCALE, rr = Math.min(r, w / 2, h / 2);
  sg.raw.fillRoundedRect((CENTER + cx - w / 2) * k, (CENTER + cy - h / 2) * k, w * k, h * k, rr * k);
}
// Centred filled ellipse (used for soft glow pools).
function ellipseC(sg, cx, cy, w, h, fill, alpha = 1) {
  sg.fillStyle(fill, alpha);
  sg.fillEllipse(CENTER + cx, CENTER + cy, w, h);
}
// Octagon (chamfered rect) point list — the angular plate primitive.
function chamfer(cx, cy, w, h, c) {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  return [[x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c],
          [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c]];
}

// A shaded armour plate: dark outline, mid face, a top highlight rim catching overhead
// light, a lower ambient-occlusion shadow, and an optional panel seam. Angular for the
// player theme, rounded for the enemy theme.
function plate(sg, T, cx, cy, w, h, opts = {}) {
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
function glowDot(sg, cx, cy, r, n) {
  sg.fillStyle(n.halo, 0.22); sg.fillCircle(CENTER + cx, CENTER + cy, r * 2.2);
  sg.fillStyle(n.halo, 0.5);  sg.fillCircle(CENTER + cx, CENTER + cy, r * 1.35);
  sg.fillStyle(n.core, 1);    sg.fillCircle(CENTER + cx, CENTER + cy, r);
  sg.fillStyle(n.hot, 1);     sg.fillCircle(CENTER + cx, CENTER + cy, r * 0.42);
}
// Emissive bar (reactor spine / vent slits): halo spill → core → hot streak.
function glowBar(sg, cx, cy, w, h, n) {
  rectC(sg, cx, cy, w * 1.9 + 1.4, h * 1.5 + 1.4, n.halo, 0.38);
  rectC(sg, cx, cy, w, h, n.core, 1);
  rectC(sg, cx, cy, w * 0.36, h * 0.7, n.hot, 1);
}

// A destroyed location: a charred lump with faint embers.
function stump(sg, T, cx, cy, w, h) {
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

// Per-chassis SHAPE — proportion/stance multipliers on the baseline layout so each weight
// class reads as a structurally different build (not one shape scaled), #24. All default
// to 1 (the medium baseline); a chassis overrides via `art.shape`. `armSpread` widens BOTH
// the shoulders (side torsos) and the arms; `legSpread`/`legDrop` set the stance.
const DEFAULT_SHAPE = {
  head: 1, torso: 1, sideTorso: 1,
  armW: 1, armH: 1, armSpread: 1,
  legW: 1, legH: 1, legSpread: 1, legDrop: 1,
  // Positional offsets (fraction of bodyLen, -y = forward) that rearrange the layout, not
  // just its thickness: a scout's head/arms ride forward, a bruiser's sit back/low.
  headDy: 0, armDy: 0,
};
const shapeOf = (mech) => ({ ...DEFAULT_SHAPE, ...(mech.chassis.art.shape || {}) });

// Per-location anchors + box sizes in mech-local design coords (origin = centre, -y =
// forward). Scenes also read this to place per-part hit-areas + damage labels, so the
// keys and rough boxes are stable. Derived from chassis body dims AND its shape so a light
// reads spindly and a heavy reads broad/blocky.
export function mechLayout(mech) {
  const a = mech.chassis.art;
  const L = a.bodyLen, W = a.bodyWid;
  const sh = shapeOf(mech);
  const shoulder = W * 0.42 * sh.armSpread;   // side-torso x; arms sit just outboard
  return {
    head:        { x: 0,                       y: -L * 0.42 + L * sh.headDy, w: W * 0.34 * sh.head,      h: L * 0.22 * sh.head },
    cockpit:     { x: 0,                       y: -L * 0.46 + L * sh.headDy, w: W * 0.18 * sh.head,      h: L * 0.10 * sh.head },
    centerTorso: { x: 0,                       y: -L * 0.05,           w: W * 0.50 * sh.torso,     h: L * 0.44 },
    leftTorso:   { x: -shoulder,               y: -L * 0.03,           w: W * 0.30 * sh.sideTorso, h: L * 0.38 },
    rightTorso:  { x:  shoulder,               y: -L * 0.03,           w: W * 0.30 * sh.sideTorso, h: L * 0.38 },
    leftArm:     { x: -W * 0.72 * sh.armSpread, y: -L * 0.08 + L * sh.armDy, w: W * 0.22 * sh.armW,   h: L * 0.46 * sh.armH },
    rightArm:    { x:  W * 0.72 * sh.armSpread, y: -L * 0.08 + L * sh.armDy, w: W * 0.22 * sh.armW,   h: L * 0.46 * sh.armH },
    leftLeg:     { x: -W * 0.17 * sh.legSpread, y:  L * 0.24 * sh.legDrop, w: W * 0.24 * sh.legW,  h: L * 0.42 * sh.legH },
    rightLeg:    { x:  W * 0.17 * sh.legSpread, y:  L * 0.24 * sh.legDrop, w: W * 0.24 * sh.legW,  h: L * 0.42 * sh.legH },
  };
}

// ── Weapon hardware. Each category gets a distinct silhouette so the loadout reads
//    from the sprite, all pointing forward (-y) from `frontY`, glowing its neon colour.
function drawWeapon(sg, T, catId, bx, frontY, s) {
  const n = neonFor(catId);
  const cap = frontY + CENTER - 2;            // keep the muzzle inside the canvas
  const barrel = (cx, cy, w, h) => T.bubbly
    ? ellipseC(sg, cx, cy, w * 1.5, h, T.faceDk)
    : T.rounded
    ? roundC(sg, cx, cy, w, h, T.faceDk, Math.min(w, h) * 0.45)
    : rectC(sg, cx, cy, w, h, T.faceDk);

  if (catId === 'missile') {
    const w = 5.4 * s, h = Math.min(6.5 * s, cap), cy = frontY - h / 2;
    if (T.bubbly) ellipseC(sg, bx, cy, w * 1.1, h, T.faceDk);
    else if (T.rounded) roundC(sg, bx, cy, w, h, T.faceDk, 1.6);
    else { poly(sg, chamfer(bx, cy, w + 1, h + 1, 1), T.outline); poly(sg, chamfer(bx, cy, w, h, 1), T.faceDk); }
    for (const dx of [-1, 1]) for (const dy of [0, 1]) {           // 2×2 launch cells
      const cxx = bx + dx * w * 0.22, cyy = frontY - h * (0.28 + dy * 0.32);
      rectC(sg, cxx, cyy, w * 0.26, h * 0.18, n.halo, 0.5);
      rectC(sg, cxx, cyy, w * 0.18, h * 0.12, n.core, 1);
    }
    return;
  }
  if (catId === 'melee') {
    const L = Math.min(11 * s, cap), w = 3 * s;
    poly(sg, [[bx - w / 2, frontY], [bx + w / 2, frontY], [bx, frontY - L]], T.faceMid);
    poly(sg, [[bx - w * 0.18, frontY], [bx + w * 0.18, frontY], [bx, frontY - L]], n.core, 0.9);
    glowDot(sg, bx, frontY - L, 1.4 * s, n);
    return;
  }
  if (catId === 'ballistic') {
    const L = Math.min(10 * s, cap), w = 1.9 * s, off = 1.5 * s;
    rectC(sg, bx, frontY - L * 0.5 + 1, (w + off) * 2.1, 2.4 * s, T.deep);     // muzzle housing
    for (const dx of [-1, 1]) {
      barrel(bx + dx * off, frontY - L / 2, w, L);
      glowDot(sg, bx + dx * off, frontY - L + 0.5, 1.5 * s, n);
    }
    return;
  }
  if (catId === 'support') {
    const L = Math.min(7 * s, cap);
    barrel(bx, frontY - L * 0.4, 2 * s, L * 0.8);
    glowDot(sg, bx, frontY - L, 2.6 * s, n);
    return;
  }
  // energy (default): slim barrel + a big glowing emitter lens.
  const L = Math.min(11 * s, cap), w = 2.2 * s;
  barrel(bx, frontY - L / 2, w, L);
  rectC(sg, bx - w * 0.42, frontY - L / 2, w * 0.22, L, n.edge, 0.7);          // edge light
  glowDot(sg, bx, frontY - L, 2.6 * s, n);
}

// Per-chassis structural decor (`art.decor`) — non-functional silhouette elements that
// change the LAYOUT, not just the proportions: a bruiser's shoulder pauldrons, a scout's
// sensor mast, rear exhaust stacks. Data-driven so a new chassis ornament is one entry.
function drawDecor(sg, mech, lay, T) {
  const a = mech.chassis.art;
  for (const d of a.decor || []) {
    if (d.kind === 'pauldron') {                 // big angular shoulder block (heavy)
      const st = lay[d.side < 0 ? 'leftTorso' : 'rightTorso'];
      const w = st.w * 1.15, h = st.h * 0.52;
      const cx = st.x + d.side * st.w * 0.28, cy = st.y - st.h * 0.36;
      plate(sg, T, cx, cy, w, h, { fill: T.faceDk, chamfer: Math.min(w, h) * 0.34, seam: false });
      rectC(sg, cx, cy, w * 0.5, h * 0.18, T.recess);
    } else if (d.kind === 'mast') {              // tall sensor antenna + glowing tip (light)
      const hd = lay.head;
      const mx = hd.x + (d.side ?? -1) * hd.w * 0.18;
      rectC(sg, mx, hd.y - hd.h * 1.3, Math.max(0.8, hd.w * 0.07), hd.h * 1.8, T.rim);
      glowDot(sg, mx, hd.y - hd.h * 2.1, 1.1, NEON.energy);
    } else if (d.kind === 'stack') {             // rear exhaust pair with embers
      const st = lay[d.side < 0 ? 'leftTorso' : 'rightTorso'];
      const cx = st.x, cy = st.y + st.h * 0.5;
      rectC(sg, cx, cy, st.w * 0.4, st.h * 0.22, T.deep);
      glowBar(sg, cx, cy + st.h * 0.06, st.w * 0.22, st.h * 0.06, { halo: 0xc8801a, core: 0xff7a18, hot: 0xffd56b });
    }
  }
}

// Torsos + arms + head + weapons. Drawn facing up; weapons point forward (-y).
function drawTurret(sg, mech, T) {
  const lay = mechLayout(mech);
  const s = mech.chassis.art.bodyLen / 38;     // size relative to the medium baseline

  // Side torsos behind the centre, each with a recessed vent.
  for (const loc of ['leftTorso', 'rightTorso']) {
    const p = lay[loc];
    if (mech.isPartDestroyed(loc)) { stump(sg, T, p.x, p.y, p.w, p.h); continue; }
    plate(sg, T, p.x, p.y, p.w, p.h, { fill: T.face });
    if (!T.bubbly) rectC(sg, p.x, p.y + p.h * 0.16, p.w * 0.6, p.h * 0.12, T.recess);
  }

  // Arms (the weapon mounts) — chunkier plates.
  for (const loc of ['leftArm', 'rightArm']) {
    const p = lay[loc];
    if (mech.isPartDestroyed(loc)) { stump(sg, T, p.x, p.y, p.w, p.h); continue; }
    plate(sg, T, p.x, p.y, p.w, p.h, { fill: T.faceMid });
  }

  // Center torso: armour slab → core inset → dark reactor housing → purple reactor.
  const ct = lay.centerTorso;
  if (mech.isPartDestroyed('centerTorso')) {
    stump(sg, T, ct.x, ct.y, ct.w, ct.h);
  } else {
    plate(sg, T, ct.x, ct.y, ct.w, ct.h, { fill: T.face, chamfer: Math.min(ct.w, ct.h) * 0.26, seam: false });
    if (T.bubbly) ellipseC(sg, ct.x, ct.y, ct.w * 0.6, ct.h * 0.78, T.faceMid);
    else if (T.rounded) roundC(sg, ct.x, ct.y, ct.w * 0.64, ct.h * 0.78, T.faceMid, Math.min(ct.w, ct.h) * 0.2);
    else poly(sg, chamfer(ct.x, ct.y, ct.w * 0.64, ct.h * 0.78, Math.min(ct.w, ct.h) * 0.2), T.faceMid);
    if (T.bubbly) ellipseC(sg, ct.x, ct.y, ct.w * 0.4, ct.h * 0.7, T.housing);            // reactor housing
    else rectC(sg, ct.x, ct.y, ct.w * 0.36, ct.h * 0.84, T.housing);
    glowBar(sg, ct.x, ct.y, ct.w * 0.14, ct.h * 0.74, REACTOR);                           // reactor spine
    glowBar(sg, ct.x, ct.y - ct.h * 0.22, ct.w * 0.32, ct.h * 0.07, REACTOR);             // vent
    glowBar(sg, ct.x, ct.y + ct.h * 0.18, ct.w * 0.32, ct.h * 0.07, REACTOR);             // vent
  }

  // Head + cockpit optic + antenna.
  const hd = lay.head;
  if (mech.isPartDestroyed('head')) {
    stump(sg, T, hd.x, hd.y, hd.w, hd.h);
  } else {
    plate(sg, T, hd.x, hd.y, hd.w, hd.h, { fill: T.faceMid, seam: false });
    rectC(sg, hd.x + hd.w * 0.42, hd.y - hd.h * 0.9, Math.max(0.7, 0.5 * s), hd.h * 0.7, T.rimHi); // antenna
    const cp = lay.cockpit;
    if (mech.isPartDestroyed('cockpit')) rectC(sg, cp.x, cp.y, cp.w, cp.h, T.char);
    else glowBar(sg, cp.x, cp.y, cp.w, cp.h * 0.7, REACTOR);
  }

  // Structural decor (shoulder pauldrons / mast / exhausts) under the weapons.
  drawDecor(sg, mech, lay, T);

  // Weapon hardware: one shape per mounted weapon, spread across the part, by category.
  for (const loc of MOUNT_LOCATIONS) {
    if (mech.isPartDestroyed(loc)) continue;
    const p = lay[loc];
    const weaponIds = mech.mounts[loc].filter(isWeapon);
    const n = weaponIds.length;
    const front = p.y - p.h / 2;
    weaponIds.forEach((id, i) => {
      const wpn = getWeapon(id);
      const bx = p.x + (i - (n - 1) / 2) * (p.w / Math.max(1, n));
      drawWeapon(sg, T, wpn?.category ?? 'energy', bx, front, s);
    });
  }
}

// Legs (feet) + pelvis + skirts. `frame` 0..3 is the stompy walk cycle; the legs
// alternate forward/back. Body bob is applied in the scene, not here.
function drawHull(sg, mech, frame, T) {
  const lay = mechLayout(mech);
  const a = mech.chassis.art;
  const s = a.bodyLen / 38;
  const shift = a.bodyLen * 0.12;
  const lDir = frame === 1 ? -1 : frame === 3 ? 1 : 0;
  const rDir = frame === 1 ? 1 : frame === 3 ? -1 : 0;

  // Pelvis block ties the legs together (sits under the torso).
  plate(sg, T, 0, a.bodyLen * 0.18, a.bodyWid * 0.5, a.bodyLen * 0.18, { fill: T.deep, seam: false });

  for (const [loc, dir] of [['leftLeg', lDir], ['rightLeg', rDir]]) {
    const p = lay[loc];   // legs are animation-only now — never destroyed
    const fy = p.y + dir * shift;
    ellipseC(sg, p.x, fy + p.h * 0.4, p.w * 1.1, p.h * 0.3, REACTOR.halo, 0.4);   // thruster wash
    ellipseC(sg, p.x, fy + p.h * 0.42, p.w * 0.5, p.h * 0.16, REACTOR.core, 0.8); // thruster core
    plate(sg, T, p.x, fy, p.w, p.h, { fill: T.lower, rim: T.rim, seam: false });
    if (!T.bubbly) {
      rectC(sg, p.x, fy - p.h * 0.4, p.w * 0.86, p.h * 0.16, T.faceMid);          // toe cap (forward)
      rectC(sg, p.x, fy - p.h * 0.46, p.w * 0.5, p.h * 0.1, T.joint);             // ankle actuator
      rectC(sg, p.x + p.w * 0.38, fy + p.h * 0.05, Math.max(0.8, 0.6 * s), p.h * 0.5, T.grime, 0.7);
    }
  }

  // Hip skirts over the inner-top of each leg (read as "legs tuck under the body").
  const legSpread = a.shape?.legSpread ?? 1;
  for (const dx of [-1, 1]) {
    const sx = dx * a.bodyWid * 0.24 * legSpread;
    if (T.bubbly) {
      ellipseC(sg, sx, a.bodyLen * 0.18, a.bodyWid * 0.34, a.bodyLen * 0.18, T.outline);
      ellipseC(sg, sx, a.bodyLen * 0.18, a.bodyWid * 0.3, a.bodyLen * 0.15, T.faceMid);
      ellipseC(sg, sx - a.bodyWid * 0.05, a.bodyLen * 0.13, a.bodyWid * 0.12, a.bodyLen * 0.05, T.rim, 0.9);
      continue;
    }
    poly(sg, [[sx - a.bodyWid * 0.16, a.bodyLen * 0.1], [sx + a.bodyWid * 0.16, a.bodyLen * 0.1],
              [sx + a.bodyWid * 0.13, a.bodyLen * 0.26], [sx - a.bodyWid * 0.19, a.bodyLen * 0.26]], T.outline);
    poly(sg, [[sx - a.bodyWid * 0.15, a.bodyLen * 0.1], [sx + a.bodyWid * 0.15, a.bodyLen * 0.1],
              [sx + a.bodyWid * 0.12, a.bodyLen * 0.25], [sx - a.bodyWid * 0.18, a.bodyLen * 0.25]], T.faceMid);
    rectC(sg, sx - a.bodyWid * 0.015, a.bodyLen * 0.12, a.bodyWid * 0.26, Math.max(0.8, 0.6 * s), T.rim);
  }
}

// Build (or re-skin in place) all textures for one mech under `key`. `opts.theme`
// ('player' | 'enemy') picks the faction palette/shape.
export function buildMechTextures(scene, key, mech, opts) {
  const T = themeFor(opts);
  for (let f = 0; f < 4; f++) {
    gen(scene, `${key}_hull_${f}`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
      (g) => drawHull(scaledGraphics(g), mech, f, T));
  }
  gen(scene, `${key}_turret`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
    (g) => drawTurret(scaledGraphics(g), mech, T));
}

// Re-draw after damage so destroyed parts become stumps / weapons vanish.
export function reskinMech(scene, key, mech, opts) {
  buildMechTextures(scene, key, mech, opts);
}
