// Procedural top-down mech art. A mech is drawn as two stacked sprites so the turret
// can aim independently of the legs (tank feel):
//   <key>_hull_0..3 — the legs + hips. 4-frame walk cycle for the stompy gait; this
//                     sprite rotates to face the movement direction.
//   <key>_turret    — center/side torsos + arms + head + weapon barrels. Rotates to
//                     face the aim (within the chassis' turret arc).
// Both are drawn pointing "up" (north / -y) and centered, so the scene rotates each
// around its centre. Parts are drawn from the live Mech: a destroyed location becomes
// a charred stump and its weapons vanish, which is how partial destruction reads.

import { gen, scaledGraphics, ART_SCALE } from './_frames.js';
import { CATEGORIES } from '../data/categories.js';
import { LOCATIONS, MOUNT_LOCATIONS } from '../data/anatomy.js';
import { isWeapon } from '../data/items.js';
import { getWeapon } from '../data/weapons.js';

export { ART_SCALE };
export const DESIGN = 64;              // design-grid canvas size (square)
const CENTER = DESIGN / 2;

const COL = {
  outline: 0x161a20,
  hipDark: 0x2c323d,
  leg: 0x424c5c, legOut: 0x222932,
  torso: 0x515c6d, torsoPlate: 0x6b7688,
  arm: 0x47515f,
  head: 0x768296,
  char: 0x231d1b,
  cockpit: 0xf2c14e,
};

// Per-location anchors + box sizes in mech-local design coords (origin = centre, -y =
// forward). Derived from the chassis' body dimensions so a heavy reads bulkier.
export function mechLayout(mech) {
  const a = mech.chassis.art;
  const L = a.bodyLen, W = a.bodyWid;
  return {
    head:        { x: 0,        y: -L * 0.42, w: W * 0.34, h: L * 0.22 },
    cockpit:     { x: 0,        y: -L * 0.46, w: W * 0.18, h: L * 0.10 },
    centerTorso: { x: 0,        y: -L * 0.05, w: W * 0.50, h: L * 0.44 },
    leftTorso:   { x: -W * 0.42, y: -L * 0.03, w: W * 0.30, h: L * 0.38 },
    rightTorso:  { x:  W * 0.42, y: -L * 0.03, w: W * 0.30, h: L * 0.38 },
    leftArm:     { x: -W * 0.72, y: -L * 0.08, w: W * 0.22, h: L * 0.46 },
    rightArm:    { x:  W * 0.72, y: -L * 0.08, w: W * 0.22, h: L * 0.46 },
    leftLeg:     { x: -W * 0.26, y:  L * 0.34, w: W * 0.28, h: L * 0.52 },
    rightLeg:    { x:  W * 0.26, y:  L * 0.34, w: W * 0.28, h: L * 0.52 },
  };
}

// Draw a centred box (design coords) with a dark outline ring behind it.
function box(sg, cx, cy, w, h, fill, outline = COL.outline) {
  sg.fillStyle(outline, 1);
  sg.fillRect(CENTER + cx - w / 2 - 1, CENTER + cy - h / 2 - 1, w + 2, h + 2);
  sg.fillStyle(fill, 1);
  sg.fillRect(CENTER + cx - w / 2, CENTER + cy - h / 2, w, h);
}

// A destroyed part: a small charred stump where the box used to be.
function stump(sg, cx, cy, w, h) {
  box(sg, cx, cy, w * 0.6, h * 0.55, COL.char);
}

// Legs + hips. `frame` 0..3 is the walk cycle; legs alternate forward/back so the mech
// looks like it's stomping. The body bob is applied in the scene, not here.
function drawHull(sg, mech, frame) {
  const lay = mechLayout(mech);
  const a = mech.chassis.art;
  const shift = a.bodyLen * 0.12;
  // frame: 0 neutral, 1 left-fwd/right-back, 2 neutral, 3 left-back/right-fwd
  const lDir = frame === 1 ? -1 : frame === 3 ? 1 : 0;
  const rDir = frame === 1 ? 1 : frame === 3 ? -1 : 0;

  // Hip block ties the legs together.
  box(sg, 0, a.bodyLen * 0.2, a.bodyWid * 0.5, a.bodyLen * 0.2, COL.hipDark);

  for (const [loc, dir] of [['leftLeg', lDir], ['rightLeg', rDir]]) {
    const p = lay[loc];
    if (mech.isPartDestroyed(loc)) { stump(sg, p.x, p.y, p.w, p.h); continue; }
    box(sg, p.x, p.y + dir * shift, p.w, p.h, COL.leg, COL.legOut);
    // foot pad at the toe (forward end)
    box(sg, p.x, p.y + dir * shift - p.h * 0.42, p.w * 1.1, p.h * 0.16, COL.legOut);
  }
}

// Torsos + head + arms + weapon barrels. Drawn facing up; weapons point forward (-y).
function drawTurret(sg, mech) {
  const lay = mechLayout(mech);
  const accent = mech.chassis.art.accent;

  // Side torsos behind the centre.
  for (const loc of ['leftTorso', 'rightTorso']) {
    const p = lay[loc];
    if (mech.isPartDestroyed(loc)) { stump(sg, p.x, p.y, p.w, p.h); continue; }
    box(sg, p.x, p.y, p.w, p.h, COL.torso);
  }

  // Arms (with weapons).
  for (const loc of ['leftArm', 'rightArm']) {
    const p = lay[loc];
    if (mech.isPartDestroyed(loc)) { stump(sg, p.x, p.y, p.w, p.h); continue; }
    box(sg, p.x, p.y, p.w, p.h, COL.arm);
  }

  // Center torso + an accent stripe.
  const ct = lay.centerTorso;
  if (mech.isPartDestroyed('centerTorso')) {
    stump(sg, ct.x, ct.y, ct.w, ct.h);
  } else {
    box(sg, ct.x, ct.y, ct.w, ct.h, COL.torso);
    box(sg, ct.x, ct.y, ct.w * 0.5, ct.h * 0.7, COL.torsoPlate);
    sg.fillStyle(accent, 1);
    sg.fillRect(CENTER + ct.x - ct.w * 0.06, CENTER + ct.y - ct.h * 0.32, ct.w * 0.12, ct.h * 0.64);
  }

  // Head + cockpit canopy.
  const hd = lay.head;
  if (mech.isPartDestroyed('head')) {
    stump(sg, hd.x, hd.y, hd.w, hd.h);
  } else {
    box(sg, hd.x, hd.y, hd.w, hd.h, COL.head);
    const cp = lay.cockpit;
    box(sg, cp.x, cp.y, cp.w, cp.h, mech.isPartDestroyed('cockpit') ? COL.char : COL.cockpit);
  }

  // Weapon barrels: one stub per mounted weapon, spread across the part, colour-coded
  // by category, pointing forward. Destroyed parts have already been skipped.
  for (const loc of MOUNT_LOCATIONS) {
    if (mech.isPartDestroyed(loc)) continue;
    const p = lay[loc];
    const weaponIds = mech.mounts[loc].filter(isWeapon);
    weaponIds.forEach((id, i) => {
      const wpn = getWeapon(id);
      const color = CATEGORIES[wpn.category]?.color ?? 0xaaaaaa;
      const n = weaponIds.length;
      const bx = p.x + (i - (n - 1) / 2) * (p.w / Math.max(1, n));
      const len = mech.chassis.art.bodyLen * 0.34;
      const front = p.y - p.h / 2;
      sg.fillStyle(COL.outline, 1);
      sg.fillRect(CENTER + bx - 2.2, CENTER + front - len, 4.4, len);
      sg.fillStyle(color, 1);
      sg.fillRect(CENTER + bx - 1.4, CENTER + front - len, 2.8, len);
    });
  }
}

// Build (or re-skin in place) all textures for one mech under `key`.
export function buildMechTextures(scene, key, mech) {
  for (let f = 0; f < 4; f++) {
    gen(scene, `${key}_hull_${f}`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
      (g) => drawHull(scaledGraphics(g), mech, f));
  }
  gen(scene, `${key}_turret`, DESIGN * ART_SCALE, DESIGN * ART_SCALE,
    (g) => drawTurret(scaledGraphics(g), mech));
}

// Re-draw after damage so destroyed parts become stumps / weapons vanish.
export function reskinMech(scene, key, mech) {
  buildMechTextures(scene, key, mech);
}
