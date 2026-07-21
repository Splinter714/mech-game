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
  DESIGN, themeFor, REACTOR, HALO, poly, rectC, roundC, ellipseC, chamfer, plate, glowBar, stump,
  exposedInternals,
} from './mechPrims.js';
import { drawWeaponMount } from './mounts/index.js';
import { drawDecor, DECOR_ART } from './decor/index.js';

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

// Off-centre weapon mounts (arms + side torsos) are drawn into their OWN textures (not baked
// into the static turret) so the scene can pivot each one at its joint toward the weapon-
// convergence point (#: shots from off-centre mounts angle inward; the art now angles with
// them). The PIVOT is the joint as a fraction of the part's height BEHIND the part centre
// (−y is forward, so the rear is +y) — the part swings its muzzle (front) inward around it.
// Arms are articulated limbs, so a big shoulder pivot reads naturally; side torsos are RIGID
// shoulder armour, so they cant only SLIGHTLY (their weapons are less off-centre, so their
// convergence angle is smaller anyway) and pivot nearer their own centre so the small rotation
// doesn't slide the plate out from under the centre torso.
export const ARM_LOCATIONS = ['leftArm', 'rightArm'];
export const SIDE_TORSO_LOCATIONS = ['leftTorso', 'rightTorso'];
// Every location that gets its own pivoting texture (drawn in this back-to-front order).
export const PIVOT_LOCATIONS = [...SIDE_TORSO_LOCATIONS, ...ARM_LOCATIONS];
// Exported (not just a local const) so shared.js's muzzle geometry (`partMuzzle`'s `pivotFrac`)
// can share the SAME joint fraction the sprite itself pivots around (#233 follow-up) — if this
// ever gets retuned for visual reasons, the muzzle math moves with it instead of drifting.
export const PART_PIVOT = { leftArm: 0.42, rightArm: 0.42, leftTorso: 0.30, rightTorso: 0.30 };

// Where a `${key}_<part>` sprite must sit and how it pivots, for a mech aimed along `angle`
// at display `scale`. `ox/oy` is the joint as an origin fraction (so setOrigin makes the
// sprite rotate around the joint); `dx/dy` is the joint's offset from the mech centre
// (add it to the mech's screen position); `rot` is the base rotation (caller adds the
// convergence tilt). At tilt 0 this reproduces the part's old baked-into-the-turret placement
// exactly. Mirrors the muzzle convention in locomotion._muzzle (forward = −y, right = +x).
export function partSpriteTransform(mech, loc, angle, scale) {
  const p = mechLayout(mech)[loc];
  const pivot = PART_PIVOT[loc] ?? 0.42;
  const sx = p.x, sy = p.y + p.h * pivot;             // joint in design coords
  const disp = scale * ART_SCALE;
  const f = -sy * disp, r = sx * disp;                // forward / right offset (world px)
  return {
    ox: 0.5 + sx / DESIGN, oy: 0.5 + sy / DESIGN,
    dx: f * Math.cos(angle) - r * Math.sin(angle),
    dy: f * Math.sin(angle) + r * Math.cos(angle),
    rot: angle + Math.PI / 2,
  };
}

// Back-compat alias — the arm-only name that existing call sites import.
export const armSpriteTransform = partSpriteTransform;

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

// One mount location's weapon hardware: a shape per mounted weapon, spread across the part,
// by category. Shared by the turret (torso/head mounts) and the arm textures (arm mounts).
function drawWeaponsAt(sg, mech, lay, loc, T, s) {
  if (mech.isPartDestroyed(loc)) return;
  const p = lay[loc];
  const weaponIds = mech.mounts[loc].filter(isWeapon);
  const n = weaponIds.length;
  const front = p.y - p.h / 2;
  weaponIds.forEach((id, i) => {
    const wpn = getWeapon(id);
    const bx = p.x + (i - (n - 1) / 2) * (p.w / Math.max(1, n));
    drawWeaponMount(sg, T, id, wpn?.category ?? 'energy', bx, front, s);
  });
}

// One arm (the weapon mount) — chunky plate + its weapons — in its OWN texture so the scene
// can pivot it toward convergence. Drawn at the same design coords as when it lived in the
// turret, so a straight (tilt-0) arm renders identically. `stump` if the arm is destroyed.
// #401: the clean base plate IS the fully-armored look — full armor draws NOTHING extra.
// Once the location's armor pool hits 0 (but the arm still has structure/hp), a jagged panel
// is TORN OFF to bare the internals (`exposedInternals`, mechPrims.js): wires/struts/sparks in
// a dark cavity, so armor loss reads as the shell being ripped open rather than plating
// vanishing. Full destruction still falls through to `stump`.
function drawArm(sg, mech, loc, T) {
  const lay = mechLayout(mech);
  const s = mech.chassis.art.bodyLen / 38;
  const p = lay[loc];
  if (mech.isPartDestroyed(loc)) { stump(sg, T, p.x, p.y, p.w, p.h); return; }
  plate(sg, T, p.x, p.y, p.w, p.h, { fill: T.faceMid });
  if (!mech.hasArmor(loc)) exposedInternals(sg, T, p.x, p.y, p.w, p.h);
  drawWeaponsAt(sg, mech, lay, loc, T, s);
}

// One side torso (a weapon mount) — plate + recessed vent + its weapons — in its OWN texture
// so the scene can cant it slightly toward convergence. Drawn at the same design coords as
// when it lived in the turret, so a straight (tilt-0) side torso renders identically. The
// shoulder PAULDRON (heavy chassis) is drawn HERE too, so it stays glued to the side torso as
// it cants; other decor (mast/vane/stack/spine) stays on the body. `stump` if destroyed.
// #401: same treatment as drawArm above — clean plate = armored, and once this torso's armor
// is stripped (even though it's still alive) a jagged panel tears off to bare its internals
// via `exposedInternals`, instead of the old brackets-on-top overlay.
function drawSideTorso(sg, mech, loc, T) {
  const lay = mechLayout(mech);
  const s = mech.chassis.art.bodyLen / 38;
  const p = lay[loc];
  if (mech.isPartDestroyed(loc)) { stump(sg, T, p.x, p.y, p.w, p.h); return; }
  plate(sg, T, p.x, p.y, p.w, p.h, { fill: T.face });
  if (!T.bubbly) rectC(sg, p.x, p.y + p.h * 0.16, p.w * 0.6, p.h * 0.12, T.recess);
  if (!mech.hasArmor(loc)) exposedInternals(sg, T, p.x, p.y, p.w, p.h);
  drawPauldronFor(sg, mech, lay, loc, T);
  drawWeaponsAt(sg, mech, lay, loc, T, s);
}

// Draw the shoulder pauldron(s) that belong to `loc` (side < 0 → leftTorso, > 0 → rightTorso),
// so it rides on the same pivoting texture as its side torso. The other decor kinds stay on
// the body (see drawDecor's `skip`).
function drawPauldronFor(sg, mech, lay, loc, T) {
  const side = loc === 'leftTorso' ? -1 : 1;
  for (const d of mech.chassis.art.decor || []) {
    if (d.kind === 'pauldron' && d.side === side) DECOR_ART.pauldron(sg, d, lay, T);
  }
}

// The body: centre torso + head + spine decor + centre/head weapons. NOT the arms or side
// torsos — those are separate pivoting textures (drawArm / drawSideTorso), drawn under this
// body sprite so it occludes their inner edges (the top-down read). Drawn facing up; weapons
// point forward (-y).
function drawTurret(sg, mech, T) {
  const lay = mechLayout(mech);
  const s = mech.chassis.art.bodyLen / 38;     // size relative to the medium baseline

  // Center torso: armour slab → core inset → dark reactor housing → purple reactor.
  // #128: no longer damage-tracked (no armor/structure of its own — it's still the
  // ability mount, just untied from destructibility) — always draws intact, never a
  // stump.
  const ct = lay.centerTorso;
  plate(sg, T, ct.x, ct.y, ct.w, ct.h, { fill: T.face, chamfer: Math.min(ct.w, ct.h) * 0.26, seam: false });
  if (T.bubbly) ellipseC(sg, ct.x, ct.y, ct.w * 0.6, ct.h * 0.78, T.faceMid);
  else if (T.rounded) roundC(sg, ct.x, ct.y, ct.w * 0.64, ct.h * 0.78, T.faceMid, Math.min(ct.w, ct.h) * 0.2);
  else poly(sg, chamfer(ct.x, ct.y, ct.w * 0.64, ct.h * 0.78, Math.min(ct.w, ct.h) * 0.2), T.faceMid);
  if (T.bubbly) ellipseC(sg, ct.x, ct.y, ct.w * 0.4, ct.h * 0.7, T.housing);            // reactor housing
  else rectC(sg, ct.x, ct.y, ct.w * 0.36, ct.h * 0.84, T.housing);
  glowBar(sg, ct.x, ct.y, ct.w * 0.14, ct.h * 0.74, REACTOR);                           // reactor spine
  glowBar(sg, ct.x, ct.y - ct.h * 0.22, ct.w * 0.32, ct.h * 0.07, REACTOR);             // vent
  glowBar(sg, ct.x, ct.y + ct.h * 0.18, ct.w * 0.32, ct.h * 0.07, REACTOR);             // vent

  // Head + cockpit optic + antenna. #128: neither is damage-tracked any more — always
  // draws intact, never a stump/charred cockpit.
  const hd = lay.head;
  plate(sg, T, hd.x, hd.y, hd.w, hd.h, { fill: T.faceMid, seam: false });
  rectC(sg, hd.x + hd.w * 0.42, hd.y - hd.h * 0.9, Math.max(0.7, 0.5 * s), hd.h * 0.7, T.rimHi); // antenna
  const cp = lay.cockpit;
  glowBar(sg, cp.x, cp.y, cp.w, cp.h * 0.7, REACTOR);

  // Structural decor (mast / vane / exhaust stacks) under the weapons. The shoulder PAULDRONS
  // are drawn on the side-torso textures instead (so they cant with the side torso), so skip
  // them here.
  drawDecor(sg, mech, lay, T, { skip: ['pauldron'] });

  // Weapon hardware for the centre/head mounts only — the ARM and SIDE-TORSO mounts are drawn
  // in their own pivoting textures (drawArm / drawSideTorso), so skip them here.
  for (const loc of MOUNT_LOCATIONS) {
    if (PIVOT_LOCATIONS.includes(loc)) continue;
    drawWeaponsAt(sg, mech, lay, loc, T, s);
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
      if (T.legibilityHalo) ellipseC(sg, sx, a.bodyLen * 0.11, a.bodyWid * 0.34 + 1.4, a.bodyLen * 0.13 + 1.4, HALO);
      ellipseC(sg, sx, a.bodyLen * 0.11, a.bodyWid * 0.34, a.bodyLen * 0.13, T.outline);
      ellipseC(sg, sx, a.bodyLen * 0.11, a.bodyWid * 0.3, a.bodyLen * 0.11, T.faceMid);
      ellipseC(sg, sx - a.bodyWid * 0.05, a.bodyLen * 0.08, a.bodyWid * 0.12, a.bodyLen * 0.04, T.rim, 0.9);
      continue;
    }
    if (T.legibilityHalo) poly(sg, [[sx - a.bodyWid * 0.17, a.bodyLen * 0.05], [sx + a.bodyWid * 0.17, a.bodyLen * 0.05],
              [sx + a.bodyWid * 0.14, a.bodyLen * 0.18], [sx - a.bodyWid * 0.2, a.bodyLen * 0.18]], HALO);
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
  // One texture per side torso + arm — the scene pivots each toward the weapon-convergence
  // point (side torsos subtly, arms more; see partSpriteTransform).
  for (const loc of SIDE_TORSO_LOCATIONS) {
    gen(scene, `${key}_${loc}`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
      (g) => drawSideTorso(scaledGraphics(g), mech, loc, T));
  }
  for (const loc of ARM_LOCATIONS) {
    gen(scene, `${key}_${loc}`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
      (g) => drawArm(scaledGraphics(g), mech, loc, T));
  }
}

// Re-draw after damage so destroyed parts become stumps / weapons vanish.
export function reskinMech(scene, key, mech, opts) {
  buildMechTextures(scene, key, mech, opts);
}
