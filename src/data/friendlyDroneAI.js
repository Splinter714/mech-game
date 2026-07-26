// Pure AI helpers for the Friendly Drone Launcher ability (#497, reworked per fresh playtest
// feedback: "the player drone-summoning ability should work MUCH more like actual enemy drones
// ... they shouldn't just orbit me, they should move similarly to how the enemy versions do, but
// they should hang kinda close to player except they should attack/focus on the player's
// target"). Kept separate from scenes/arena/friendlyDrones.js (the Phaser-facing spawn/view code)
// so the actual decision logic — how many to summon, where they move, what they shoot — is pure
// and unit-tested, matching this codebase's "put pure logic in src/data" convention.
//
// Movement mirrors scenes/arena/enemyBehaviors.js's own `droneBehavior`: a jittered orbit point
// re-picked every 300-700ms, a tangential swirl for a churning read, and boids-style separation
// so a tight squad doesn't stack on one point — same shape, just anchored on the OWNER (so the
// squad hangs close to the player) instead of on whatever the drone is attacking, and hard-leashed
// to the owner (mirrors data/leash.js's own "hard stop, no rubber-band" convention) so separation/
// jitter can never carry one off wandering after a far-off target.
import { nearestInterceptTarget } from './interceptor.js';

// #497 rework (owner: "deploy 3-5 at a time"): a whole squad per summon instead of one pet.
export const DRONE_COUNT_MIN = 3;
export const DRONE_COUNT_MAX = 5;

// A random count in [DRONE_COUNT_MIN, DRONE_COUNT_MAX], inclusive. `rng` is injectable (defaults
// to Math.random) so the spawn count is deterministically testable without stubbing the global.
export function randomDroneCount(rng = Math.random) {
  return DRONE_COUNT_MIN + Math.floor(rng() * (DRONE_COUNT_MAX - DRONE_COUNT_MIN + 1));
}

function approach(cur, target, maxStep) {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}

// Hard-clamp a point to within `radius` of (cx, cy) — no easing/rubber-band, matching the
// player-leash convention (data/leash.js): past the limit, you're simply put back on the circle.
export function clampToRadius(x, y, cx, cy, radius) {
  const dx = x - cx, dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d <= radius || d <= 0.0001) return { x, y };
  const s = radius / d;
  return { x: cx + dx * s, y: cy + dy * s };
}

// One frame of a single friendly drone's orbit-around-owner movement. `state` is the drone's own
// { x, y, vx, vy, orbitAng, orbitR, jitterAt, handed } (handed is its persistent swirl direction,
// same convention as the enemy's own `e.handed`). `tuning` is { maxSpeed, accel, orbitRadius,
// leashRadius, separationRadius, separationWeight, jitterMin, jitterMax }. `siblings` is the
// OTHER friendly drones in this player's own squad (not the whole flyer population — a 3-5 squad
// only needs to avoid stacking on itself). Returns the next state; does not mutate the input.
export function stepFriendlyDroneOrbit(state, ownerX, ownerY, dt, tuning, siblings = []) {
  let { x, y, vx, vy, orbitAng, orbitR, jitterAt, handed } = state;
  handed = handed || 1;

  jitterAt -= dt * 1000;
  if (jitterAt <= 0 || orbitR == null) {
    jitterAt = tuning.jitterMin + Math.random() * (tuning.jitterMax - tuning.jitterMin);
    orbitAng = Math.random() * Math.PI * 2;
    orbitR = tuning.orbitRadius * (0.75 + Math.random() * 0.5);
  }

  // Target point: a ring around the OWNER (not the drone's fire target) at the jittered angle —
  // "hang kinda close to player" rather than escort-orbiting whatever it's shooting at.
  const tx = ownerX + Math.cos(orbitAng) * orbitR;
  const ty = ownerY + Math.sin(orbitAng) * orbitR;
  const dx = tx - x, dy = ty - y;
  const dm = Math.hypot(dx, dy) || 1;

  // Tangential swirl around the owner, same shape as droneBehavior's own bearing-perpendicular
  // term (there: perpendicular to the bearing toward whatever it swarms; here, toward the owner).
  const bx = ownerX - x, by = ownerY - y;
  const bd = Math.hypot(bx, by) || 1;
  const bux = bx / bd, buy = by / bd;

  // Boids-style separation from this drone's own squadmates only (enemyBehaviors.js's
  // flyerSeparation does the same sum over ALL flyers; a 3-5-drone squad only needs to separate
  // from itself).
  let sepX = 0, sepY = 0;
  const r = tuning.separationRadius, r2 = r * r;
  for (const o of siblings) {
    const ddx = x - o.x, ddy = y - o.y;
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 >= r2 || d2 <= 0.0001) continue;
    const d = Math.sqrt(d2);
    const w = (1 - d / r) / d;
    sepX += ddx * w; sepY += ddy * w;
  }

  const desiredX = dx / dm + (-buy) * handed * 0.5 + sepX * tuning.separationWeight;
  const desiredY = dy / dm + (bux) * handed * 0.5 + sepY * tuning.separationWeight;
  const dmag = Math.hypot(desiredX, desiredY) || 1;
  const nvx = approach(vx, (desiredX / dmag) * tuning.maxSpeed, tuning.accel * dt);
  const nvy = approach(vy, (desiredY / dmag) * tuning.maxSpeed, tuning.accel * dt);

  const rawX = x + nvx * dt, rawY = y + nvy * dt;
  const clamped = clampToRadius(rawX, rawY, ownerX, ownerY, tuning.leashRadius);
  const angle = (Math.abs(nvx) > 0.001 || Math.abs(nvy) > 0.001) ? Math.atan2(nvy, nvx) : state.angle ?? 0;

  return { x: clamped.x, y: clamped.y, vx: nvx, vy: nvy, angle, orbitAng, orbitR, jitterAt, handed };
}

// Which enemy a friendly drone shoots at THIS cadence tick: prefer the player's own current
// target/lock-on (#497 owner ask — "they should attack/focus on the player's target") if it's
// still a live enemy within the drone's own range, otherwise fall back to the nearest live enemy
// in range (mirrors the anti-missile point-defense pick, data/interceptor.js
// `nearestInterceptTarget`) rather than doing nothing.
export function pickFriendlyDroneTarget(x, y, range, liveEnemies, lockedTarget) {
  if (lockedTarget && liveEnemies.includes(lockedTarget)) {
    const d = Math.hypot(lockedTarget.x - x, lockedTarget.y - y);
    if (d <= range) return lockedTarget;
  }
  return nearestInterceptTarget(x, y, range, liveEnemies);
}
