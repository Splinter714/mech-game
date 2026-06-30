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
import { MOUNT_LOCATIONS } from '../data/anatomy.js';
import { isWeapon } from '../data/items.js';
import { getWeapon } from '../data/weapons.js';
import {
  DESIGN, themeFor, REACTOR, poly, rectC, roundC, ellipseC, chamfer, plate, glowBar, stump,
} from './mechPrims.js';
import { drawWeaponMount } from './mounts/index.js';
import { drawDecor } from './decor/index.js';

// The low-level primitives + palettes live in ./mechPrims.js; the per-category weapon-mount
// art in ./mounts/ and the per-kind chassis decor in ./decor/ (registries). This file keeps
// the layout + orchestration: mechLayout, drawTurret/drawHull, and the texture builders.
export { ART_SCALE, DESIGN };

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
    head:        { x: 0,                       y: -L * 0.24 + L * sh.headDy, w: W * 0.34 * sh.head,      h: L * 0.22 * sh.head },
    cockpit:     { x: 0,                       y: -L * 0.27 + L * sh.headDy, w: W * 0.18 * sh.head,      h: L * 0.10 * sh.head },
    centerTorso: { x: 0,                       y: -L * 0.05,           w: W * 0.50 * sh.torso,     h: L * 0.44 },
    leftTorso:   { x: -shoulder,               y: -L * 0.03,           w: W * 0.30 * sh.sideTorso, h: L * 0.38 },
    rightTorso:  { x:  shoulder,               y: -L * 0.03,           w: W * 0.30 * sh.sideTorso, h: L * 0.38 },
    leftArm:     { x: -W * 0.72 * sh.armSpread, y: -L * 0.08 + L * sh.armDy, w: W * 0.22 * sh.armW,   h: L * 0.46 * sh.armH },
    rightArm:    { x:  W * 0.72 * sh.armSpread, y: -L * 0.08 + L * sh.armDy, w: W * 0.22 * sh.armW,   h: L * 0.46 * sh.armH },
    leftLeg:     { x: -W * 0.17 * sh.legSpread, y:  L * 0.15 * sh.legDrop, w: W * 0.24 * sh.legW,  h: L * 0.32 * sh.legH },
    rightLeg:    { x:  W * 0.17 * sh.legSpread, y:  L * 0.15 * sh.legDrop, w: W * 0.24 * sh.legW,  h: L * 0.32 * sh.legH },
  };
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
      drawWeaponMount(sg, T, wpn?.category ?? 'energy', bx, front, s);
    });
  }
}

// Legs (feet) + pelvis + skirts. `frame` 0..3 is the stompy walk cycle; the legs
// alternate forward/back. Body bob is applied in the scene, not here.
function drawHull(sg, mech, frame, T) {
  const lay = mechLayout(mech);
  const a = mech.chassis.art;
  const s = a.bodyLen / 38;
  const shift = a.bodyLen * 0.09;     // stride: legs swing less so feet don't jut out far
  const lDir = frame === 1 ? -1 : frame === 3 ? 1 : 0;
  const rDir = frame === 1 ? 1 : frame === 3 ? -1 : 0;

  // Pelvis block ties the legs together (sits under the torso, tucked up so it's mostly
  // occluded from the top-down view).
  plate(sg, T, 0, a.bodyLen * 0.10, a.bodyWid * 0.5, a.bodyLen * 0.13, { fill: T.deep, seam: false });

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
      ellipseC(sg, sx, a.bodyLen * 0.11, a.bodyWid * 0.34, a.bodyLen * 0.13, T.outline);
      ellipseC(sg, sx, a.bodyLen * 0.11, a.bodyWid * 0.3, a.bodyLen * 0.11, T.faceMid);
      ellipseC(sg, sx - a.bodyWid * 0.05, a.bodyLen * 0.08, a.bodyWid * 0.12, a.bodyLen * 0.04, T.rim, 0.9);
      continue;
    }
    poly(sg, [[sx - a.bodyWid * 0.16, a.bodyLen * 0.06], [sx + a.bodyWid * 0.16, a.bodyLen * 0.06],
              [sx + a.bodyWid * 0.13, a.bodyLen * 0.17], [sx - a.bodyWid * 0.19, a.bodyLen * 0.17]], T.outline);
    poly(sg, [[sx - a.bodyWid * 0.15, a.bodyLen * 0.06], [sx + a.bodyWid * 0.15, a.bodyLen * 0.06],
              [sx + a.bodyWid * 0.12, a.bodyLen * 0.16], [sx - a.bodyWid * 0.18, a.bodyLen * 0.16]], T.faceMid);
    rectC(sg, sx - a.bodyWid * 0.015, a.bodyLen * 0.08, a.bodyWid * 0.26, Math.max(0.8, 0.6 * s), T.rim);
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
