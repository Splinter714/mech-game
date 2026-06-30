// Delivery simulation — the SINGLE source of "how a weapon fires", shared by the live
// arena and the Weapon Lab preview so the two can never drift. Pure + headless (no
// Phaser): it owns only the parts that are identical between the two —
//
//   1. planEmissions(weapon)  — how one trigger pull turns into shots: a single shot, a
//      fanned spread cone, a tight parallel cluster, or a rapid multi-pulse burst. Each
//      emission is a descriptor (delay + angle offset + lateral offset); the scene
//      applies it to its own muzzle/aim at fire time.
//   2. makeProjectile(...)    — the kinematic round object (velocity, kind, colour…).
//   3. stepProjectile(...)    — advancing a round one frame, incl. homing steering.
//
// Everything that genuinely differs stays in the scenes: the arena resolves live
// targets, walls, collision and damage; the Lab just flies rounds to the stage edge.
// Both, however, get spread/cluster/burst/homing behaviour from exactly one place.

import { CATEGORIES } from './categories.js';

const TURN_RATE = 4.0;            // guided-missile steering rate (rad/s)
const CLUSTER_SPACING = 6;        // lateral px between rounds in a dumbfire cluster
const DEFAULT_SPREAD_DEG = 16;    // fan width for a spread weapon that omits spreadAngle

// The visual KIND of a fired round (shared by the arena, the Lab, and the garage icons).
export function projectileKind(weapon) {
  const d = weapon.delivery || {};
  if (d.kind) return d.kind;                       // explicit override (flame, fire, bullet, rail…)
  if (weapon.category === 'energy') return 'plasma';
  if (weapon.category === 'missile') return 'missile';
  // Ballistic: rapid streams/pellets are little tracer bullets; a single shot is a heavy
  // autocannon shell.
  if (d.pattern === 'stream' || d.pattern === 'spread') return 'bullet';
  return 'slug';
}

// What one trigger pull emits. Returns { mode, shots } where mode is 'hitscan' |
// 'contact' | 'projectile' and each shot is { delay, angleOffset, lateral }:
//   delay        ms to wait before this sub-shot (multi-pulse burst); 0 = immediate
//   angleOffset  radians off the aim line (spread fan, or a cluster's tiny jitter)
//   lateral      px perpendicular to the shot (a cluster's parallel offset)
// The caller turns each into a real shot from its current muzzle/aim.
export function planEmissions(weapon) {
  const d = weapon.delivery || {};
  if (d.hit === 'contact') return { mode: 'contact', shots: [shot()] };
  if (d.hit === 'hitscan') {
    if (d.burst) {
      const shots = [];
      for (let i = 0; i < d.burst.count; i++) shots.push(shot({ delay: i * d.burst.interval }));
      return { mode: 'hitscan', shots };
    }
    return { mode: 'hitscan', shots: [shot()] };
  }
  // Projectile: a single round, a fanned cone of `spreadCount`, or — for `cluster`
  // weapons — a tight parallel clump (lateral offsets, ~parallel headings, no fan).
  const n = d.pattern === 'spread' ? Math.max(1, d.spreadCount) : 1;
  const shots = [];
  const cone = ((d.spreadAngle || DEFAULT_SPREAD_DEG) * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const c = n > 1 ? (i - (n - 1) / 2) : 0;       // centred index: −…0…+
    if (d.cluster) shots.push(shot({ angleOffset: (Math.random() - 0.5) * 0.04, lateral: c * CLUSTER_SPACING }));
    else if (n > 1) shots.push(shot({ angleOffset: (c / (n - 1)) * cone }));
    else shots.push(shot());
  }
  return { mode: 'projectile', shots };
}

function shot({ delay = 0, angleOffset = 0, lateral = 0 } = {}) {
  return { delay, angleOffset, lateral };
}

// Build a round's kinematic state. The caller supplies `maxDist` (its own travel budget:
// the arena's target/lob distance, the Lab's stage width) and may tack on scene-specific
// fields (owner, trail) afterward.
export function makeProjectile(weapon, x, y, angle, { maxDist }) {
  const d = weapon.delivery || {};
  const speed = d.velocity || 480;
  return {
    x, y, angle, speed,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    kind: projectileKind(weapon), color: CATEGORIES[weapon.category]?.color ?? 0xffffff,
    damage: weapon.damage, splash: d.splash || 0, range: weapon.range, scale: d.scale || 1,
    dist: 0, maxDist, arc: d.path === 'arcing', ground: d.groundFire || null,
    homing: d.guidance === 'homing', turn: TURN_RATE,
  };
}

// Advance a round one frame. `desiredAngle` (radians) is where a guided round should steer
// — the arena passes the bearing to its live target, the Lab passes straight-ahead;
// `null` (or a non-homing round) flies ballistically.
export function stepProjectile(p, dt, desiredAngle = null) {
  if (p.homing && desiredAngle != null) {
    p.angle = rotateToward(p.angle, desiredAngle, p.turn * dt);
    p.vx = Math.cos(p.angle) * p.speed;
    p.vy = Math.sin(p.angle) * p.speed;
  }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.dist += p.speed * dt;
}

// Rotate angle `a` toward `target` by at most `maxStep`, taking the shortest way around.
export function rotateToward(a, target, maxStep) {
  const diff = wrapAngle(target - a);
  if (Math.abs(diff) <= maxStep) return wrapAngle(target);
  return wrapAngle(a + Math.sign(diff) * maxStep);
}

function wrapAngle(x) { return Math.atan2(Math.sin(x), Math.cos(x)); }
