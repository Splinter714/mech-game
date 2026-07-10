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
import { projectileKind } from '../data/delivery.js';
import { drawProjectileBody } from './projectiles/index.js';

// `projectileKind` lives in the pure delivery sim (data/delivery.js); re-exported here so
// existing art importers keep resolving it from the art layer. `drawProjectileBody` now
// lives in the per-kind registry under ./projectiles/ — re-exported so call sites (and
// art/index.js) keep importing it from here. Add a round kind = a new file there.
export { projectileKind };
export { drawProjectileBody };

// The splatter/inner spark flecks below (shared by every hitscan beam — pulse/beam/rail
// laser all draw through this one drawBeam) — the glow/core/warble above are unaffected
// either way. Flip to false to disable if they ever read as too noisy again.
const SPARKS_ENABLED = true;

// A hitscan beam: tapered glow, chunky warbling core, and splatter sparks off the sides.
// `phase` is a ms timestamp driving the warble (callers pass time or beam age).
// `heavy` thickens everything for the rail lance.
export function drawBeam(g, x0, y0, x1, y1, color, s = 1, heavy = false, phase = 0, sparkAlpha = 1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  const nx = dx / len, ny = dy / len;   // beam direction
  const px = -ny, py = nx;              // perpendicular

  const glowW = (heavy ? 17 : 11) * s;
  const coreW = (heavy ? 4 : 2.6) * s;
  const SEGS = heavy ? 48 : 64;

  if (sparkAlpha >= 1) {
  // Outer glow: tapered warbling segments matching the core wobble.
  for (let i = 0; i < SEGS; i++) {
    const t0 = i / SEGS, t1 = (i + 1) / SEGS;
    const tc = (t0 + t1) / 2;
    const taperStart = 0.85;
    const taper = tc < taperStart ? 1.0 : Math.cos(((tc - taperStart) / (1 - taperStart)) * Math.PI / 2);
    const warpRaw = Math.sin(phase * 0.04 + tc * Math.PI * 3) * 1.3 * s;
    const warp0 = t0 === 0 ? 0 : warpRaw;
    const warp1 = t1 === 1 ? 0 : warpRaw;
    g.lineStyle(glowW * taper, color, 0.18);
    g.lineBetween(x0 + nx * len * t0 + px * warp0, y0 + ny * len * t0 + py * warp0,
                  x0 + nx * len * t1 + px * warp1, y0 + ny * len * t1 + py * warp1);
  }

  // Core: warbling segments — each slightly offset perpendicular so the beam "wobbles".
  // Taper alpha near the ends so it doesn't cut off abruptly.
  for (let i = 0; i < SEGS; i++) {
    const t0 = i / SEGS, t1 = (i + 1) / SEGS;
    const tc = (t0 + t1) / 2;
    // Taper: full at muzzle, tapers only toward the far end.
    const taperStart = 0.85;
    const taper = tc < taperStart ? 1.0 : Math.cos(((tc - taperStart) / (1 - taperStart)) * Math.PI / 2);
    // Warp also multiplied by taper so the beam connects cleanly to muzzle and endpoint.
    const warpRaw = Math.sin(phase * 0.04 + tc * Math.PI * 3) * 1.3 * s;
    const warp0 = t0 === 0 ? 0 : warpRaw;
    const warp1 = t1 === 1 ? 0 : warpRaw;
    const ax = x0 + nx * len * t0 + px * warp0, ay = y0 + ny * len * t0 + py * warp0;
    const bx = x0 + nx * len * t1 + px * warp1, by = y0 + ny * len * t1 + py * warp1;
    g.lineStyle(coreW * taper, color, 0.85); g.lineBetween(ax, ay, bx, by);
  }
  } // end sparkAlpha >= 1 block

  if (!SPARKS_ENABLED) return;

  // Splatter sparks: chunky dots near the beam, each on its own slow oscillation.
  const sparkCount = heavy ? 10 : 12;
  const maxDrift = (heavy ? 18 : 13) * s;
  for (let i = 0; i < sparkCount; i++) {
    const speed = 0.05 + i * 0.02;
    const sign = (i % 2 === 0) ? 1 : -1;
    // Random beam position that re-randomises each cycle.
    const cycle = Math.floor(phase * speed + i * 37);
    const th = Math.sin(cycle * 127.3 + i * 31.7) * 43758.5453;
    const t = th - Math.floor(th);  // uniform [0,1], no arcsine clustering
    const tipTaper = 0.25 + 0.75 * Math.cos(t * Math.PI / 2);  // 1 at muzzle, 0.25 at tip
    const drift = (phase * speed + i * 37) % (maxDrift * tipTaper);
    const life = 1 - drift / (maxDrift * tipTaper + 0.001);
    const rMax = (heavy ? 4.0 : 2.8) * s;
    const r = rMax * life;              // shrinks to nothing as it flies off
    if (r < 0.5) continue;
    const sx = x0 + nx * len * t + px * sign * drift;
    const sy = y0 + ny * len * t + py * sign * drift;
    // Fleck: a short streak perpendicular to the beam, with a bright hot center dot.
    const fx = px * r * 1.6, fy = py * r * 1.6;
    g.lineStyle(r * 0.9, color, sparkAlpha); g.lineBetween(sx - fx, sy - fy, sx + fx, sy + fy);
    g.fillStyle(0xffffff, sparkAlpha); g.fillCircle(sx, sy, r * 0.4);
  }

  // Inner sparks: same flecks but confined within the core width, like energy crackling along the beam.
  const innerCount = heavy ? 8 : 10;
  for (let i = 0; i < innerCount; i++) {
    const speed = 0.04 + i * 0.015;
    const sign = (i % 2 === 0) ? 1 : -1;
    const cycle = Math.floor(phase * speed + i * 53);
    const th2 = Math.sin(cycle * 83.1 + i * 47.3) * 43758.5453;
    const t = th2 - Math.floor(th2);
    const drift = (phase * speed + i * 53) % (coreW / 2);
    const life = 1 - drift / (coreW / 2);
    const r = (heavy ? 1.4 : 1.0) * s * life;
    if (r < 0.3) continue;
    const sx = x0 + nx * len * t + px * sign * drift;
    const sy = y0 + ny * len * t + py * sign * drift;
    const fx = px * r * 1.4, fy = py * r * 1.4;
    g.lineStyle(r * 0.8, color, 1.0); g.lineBetween(sx - fx, sy - fy, sx + fx, sy + fy);
    g.fillStyle(0xffffff, 1.0); g.fillCircle(sx, sy, r * 0.5);
  }
}

// A melee swing: a bright crescent that sweeps through `facing` as `t` goes 0→1, fading
// as it completes. Shared so the garage icon and the arena swing read identically.
export function drawSlash(g, x, y, facing, t, color, s = 1, reach = 30) {
  const span = Math.PI * 0.95;
  const a0 = facing - span / 2;
  const lead = a0 + span * Math.min(1, t);
  const R = reach * s;
  g.lineStyle(3.5 * s, color, 0.75 * (1 - t));
  g.beginPath(); g.arc(x, y, R, a0, lead, false); g.strokePath();
  g.lineStyle(2 * s, 0xffffff, 0.9 * (1 - t));     // bright leading edge
  g.lineBetween(x, y, x + Math.cos(lead) * R, y + Math.sin(lead) * R);
}

// A burning ground patch (napalm): a spreading pool of sticky liquid fire that coats the
// ground (low, roiling, smooth-edged — not tall spikes) with hot pockets and lazy smoke
// rising off it. `phase` is a millisecond clock driving the flicker. Extracted from the
// arena so the lab's preview patch matches the real one exactly.
function _catmull(t, p0, p1, p2, p3) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
export function drawGroundFire(g, x, y, r, phase, s = 1) {
  const seed = (x * 13.1 + y * 7.7);
  const rnd = (i) => { const v = Math.sin(seed + i * 53.17) * 43758.5; return v - Math.floor(v); };
  const pulse = 0.5 + 0.5 * Math.sin(phase * 0.005);

  // An irregular, slowly-roiling blob outline that is wavy but SMOOTH: a few jittered lobe
  // radii define the silhouette, then a closed Catmull-Rom spline is sampled through them so
  // the edges flow instead of faceting. Squashed for the top-down view.
  const blob = (cx, cy, rx, key, lobes = 7, squash = 0.7, wob = 0.18) => {
    const ctrl = [];
    for (let k = 0; k < lobes; k++) {
      const a = (k / lobes) * Math.PI * 2;
      const n = rnd(key + k * 2.13);
      const rad = rx * (0.8 + n * 0.3 + wob * Math.sin(phase * 0.006 + n * 9 + key));
      ctrl.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad * squash });
    }
    const pts = [];
    const steps = 6;
    for (let k = 0; k < lobes; k++) {
      const p0 = ctrl[(k - 1 + lobes) % lobes], p1 = ctrl[k];
      const p2 = ctrl[(k + 1) % lobes], p3 = ctrl[(k + 2) % lobes];
      for (let sp = 0; sp < steps; sp++) {
        const t = sp / steps;
        pts.push({ x: _catmull(t, p0.x, p1.x, p2.x, p3.x), y: _catmull(t, p0.y, p1.y, p2.y, p3.y) });
      }
    }
    return pts;
  };

  // Charred scorch the napalm soaked into, and the layered liquid-fire pool.
  g.fillStyle(0x140a06, 0.4).fillPoints(blob(x, y, r * 1.05 * s, 1, 11, 0.72, 0.1), true);
  g.fillStyle(0x5e1d04, 0.55).fillPoints(blob(x, y, r * 0.95 * s, 2, 10, 0.7), true);
  g.fillStyle(0xb23206, 0.45 + 0.2 * pulse).fillPoints(blob(x, y, r * 0.74 * s, 3, 10, 0.68, 0.22), true);
  g.fillStyle(0xe85610, 0.35 + 0.2 * pulse).fillPoints(blob(x, y, r * 0.5 * s, 4, 9, 0.66, 0.26), true);

  // Roiling flame globs: small ragged blobs that breathe in place, clinging to the pool.
  const globs = 9;
  for (let i = 0; i < globs; i++) {
    const ang = rnd(i) * 6.28;
    const rad = (0.2 + rnd(i + 31) * 0.7) * r * s;
    const gx = x + Math.cos(ang) * rad;
    const gy = y + Math.sin(ang) * rad * 0.66;
    const phaseI = rnd(i + 7) * 6.28;
    const breathe = 0.6 + 0.4 * Math.sin(phase * 0.009 + phaseI);
    const rr = r * s * (0.24 + rnd(i + 5) * 0.2) * breathe;
    g.fillStyle(0xff6a18, 0.45).fillPoints(blob(gx, gy, rr, i * 4 + 200, 7, 0.8, 0.3), true);
    g.fillStyle(0xffb43c, 0.6).fillPoints(blob(gx, gy - rr * 0.2, rr * 0.6, i * 4 + 201, 7, 0.8, 0.34), true);
    if (rnd(i + 11) > 0.55) g.fillStyle(0xfff0c0, 0.55).fillCircle(gx, gy - rr * 0.25, rr * 0.26);
  }

  // Lazy smoke: a few translucent grey puffs rising and drifting, fading as they climb.
  const puffs = 4;
  for (let i = 0; i < puffs; i++) {
    const phaseI = rnd(i + 50) * 6.28;
    const rise = ((phase * 0.00018 + rnd(i + 60)) % 1);
    const sx = x + (rnd(i + 70) * 2 - 1) * r * 0.6 * s + Math.sin(phase * 0.001 + phaseI) * r * 0.3 * s;
    const sy = y - rise * r * 2.4 * s;
    const sr = r * s * (0.3 + rise * 0.6);
    g.fillStyle(0x2a2622, (1 - rise) * 0.22).fillCircle(sx, sy, sr);
  }
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
  if (d.hit === 'contact') {                        // melee → a slash crescent
    drawSlash(g, c - 8 * S, c + 8 * S, ang, 0.35, color, S, 16);
    return;
  }
  if (d.hit === 'hitscan') {
    const r = 9 * S;
    drawBeam(g, c - r, c + r, c + r, c - r, color, S, d.kind === 'rail');
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
