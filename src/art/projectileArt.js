// Projectile / beam visuals — the SINGLE source of the "what a fired round looks like"
// art. The arena draws live travelling rounds and hitscan beams with these primitives,
// and the garage renders still tile icons from the very same functions, so the icons can
// never drift from the in-game look: update a primitive here and both update together.
//
// Primitives take a raw Phaser Graphics and target-pixel coordinates; `s` scales the
// drawing (the arena passes s=1 to draw at world px; the icon builder passes s=ART_SCALE
// to super-sample into a texture). Positions are always in the target's pixel space.

import { gen, ART_SCALE } from './_frames.js';
import { CATEGORIES } from '../data/categories.js';
import { WEAPONS, WEAPON_IDS } from '../data/weapons.js';
import { EQUIPMENT, EQUIPMENT_IDS } from '../data/equipment.js';

// The visual KIND of a fired round (shared by the arena and the icons). Mirrors what the
// arena used to compute inline, now centralised so there's one rule.
export function projectileKind(weapon) {
  const d = weapon.delivery || {};
  if (d.kind) return d.kind;                       // explicit override (flame, fire)
  if (weapon.category === 'energy') return 'plasma';
  if (weapon.category === 'missile') return 'missile';
  return 'slug';
}

// A travelling round's body, drawn at (x, y) heading along `angle`. `phase` drives the
// flame flicker (the arena passes the round's distance; icons pass 0).
export function drawProjectileBody(g, x, y, angle, kind, color, s = 1, phase = 0) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  if (kind === 'plasma') {
    // A lobbed glob of molten energy: a soft pulsing corona, a teardrop body trailing
    // back along travel, a white-hot core, and a couple of shed sparks. `phase` (the
    // round's distance) drives the flicker and the wobble of the cast-off droplets.
    const f = 0.75 + 0.25 * Math.sin(phase * 0.5);
    // Hot wake streaming back from the glob.
    g.fillStyle(color, 0.18 * f); g.fillCircle(x - ca * 3.5 * s, y - sa * 3.5 * s, 3.8 * s);
    g.fillStyle(color, 0.30 * f); g.fillCircle(x, y, 5 * s);
    // Teardrop: round front, tapered tail (drawn as two overlapping circles).
    g.fillStyle(color, 0.92); g.fillCircle(x, y, 2.4 * s);
    g.fillStyle(color, 0.7); g.fillCircle(x - ca * 2 * s, y - sa * 2 * s, 1.5 * s);
    g.fillStyle(0xffffff, 0.95); g.fillCircle(x + ca * 0.4 * s, y + sa * 0.4 * s, 1 * s);
    // Shed droplets wobbling off to the sides.
    const wob = Math.sin(phase * 0.7) * 1.6 * s;
    g.fillStyle(color, 0.55 * f);
    g.fillCircle(x - ca * 4 * s - sa * wob, y - sa * 4 * s + ca * wob, 0.8 * s);
  } else if (kind === 'missile') {
    const bx = x - ca * 7 * s, by = y - sa * 7 * s;
    g.lineStyle(3 * s, 0xffb347, 0.5); g.lineBetween(bx, by, x - ca * 14 * s, y - sa * 14 * s);
    g.fillStyle(color, 1); g.fillCircle(x, y, 2.4 * s);
  } else if (kind === 'flame') {
    const f = 0.7 + 0.3 * Math.sin(phase * 0.4);
    g.fillStyle(0xff7a18, 0.4 * f); g.fillCircle(x, y, 6 * s);
    g.fillStyle(0xffd56b, 0.9 * f); g.fillCircle(x, y, 2.6 * s);
  } else if (kind === 'fire') {                    // napalm canister
    g.fillStyle(0x3a2a1c, 1); g.fillCircle(x, y, 3.2 * s);
    g.fillStyle(0xff7a18, 0.9); g.fillCircle(x, y, 1.6 * s);
  } else {                                          // slug: a short bright tracer
    const tx = x - ca * 9 * s, ty = y - sa * 9 * s;
    g.lineStyle(2 * s, color, 0.9); g.lineBetween(tx, ty, x, y);
  }
}

// A hitscan beam: a soft coloured glow under a bright white core (also what melee/contact
// hits draw in-arena).
export function drawBeam(g, x0, y0, x1, y1, color, s = 1) {
  g.lineStyle(5 * s, color, 0.25); g.lineBetween(x0, y0, x1, y1);
  g.lineStyle(1.6 * s, 0xffffff, 0.9); g.lineBetween(x0, y0, x1, y1);
}

// An activated ability's signature flash (mirrors the arena's _activateAbility visuals).
export function drawAbilityFx(g, ability, x, y, s = 1) {
  if (ability === 'dash') {                         // jump-jet thruster puff
    g.fillStyle(0xffd56b, 0.85); g.fillCircle(x, y, 6 * s);
    g.fillStyle(0xffffff, 0.9); g.fillCircle(x, y, 2.4 * s);
  } else {                                           // bubble shield
    g.lineStyle(2 * s, 0x5ec8e0, 0.9); g.strokeCircle(x, y, 8 * s);
    g.fillStyle(0x5ec8e0, 0.14); g.fillCircle(x, y, 8 * s);
  }
}

// ── Garage tile icons ── a still composed from the same primitives, one per item. ──
const ICON = 30;   // design px (square)

export function itemFxKey(id) { return `wfx_${id}`; }

// Compose one weapon's icon: hitscan/melee → a beam streak; projectile → its round body
// (a small fan for spread weapons), all heading up-and-right.
function drawWeaponIcon(g, weapon, S, c) {
  const color = CATEGORIES[weapon.category]?.color ?? 0xffffff;
  const d = weapon.delivery || {};
  const ang = -Math.PI / 4;
  if (d.hit === 'hitscan' || d.hit === 'contact') {
    const r = 9 * S;
    drawBeam(g, c - r, c + r, c + r, c - r, color, S);
    return;
  }
  const kind = projectileKind(weapon);
  if (d.pattern === 'spread') {
    const n = Math.min(3, Math.max(2, d.spreadCount || 3));
    const perp = ang + Math.PI / 2;
    for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * 6 * S;
      drawProjectileBody(g, c + Math.cos(perp) * o, c + Math.sin(perp) * o, ang, kind, color, S * 0.8);
    }
  } else {
    drawProjectileBody(g, c, c, ang, kind, color, S);
  }
}

// Build a `wfx_<id>` texture for every weapon AND ability, from the shared art above.
export function buildItemFxTextures(scene) {
  const S = ART_SCALE;
  const c = (ICON / 2) * S;
  for (const id of WEAPON_IDS) {
    gen(scene, itemFxKey(id), ICON * S, ICON * S, (g) => drawWeaponIcon(g, WEAPONS[id], S, c));
  }
  for (const id of EQUIPMENT_IDS) {
    gen(scene, itemFxKey(id), ICON * S, ICON * S, (g) => drawAbilityFx(g, EQUIPMENT[id].ability, c, c, S * 1.5));
  }
}
