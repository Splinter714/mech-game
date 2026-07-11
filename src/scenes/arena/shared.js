// Constants + tiny helpers shared across more than one arena mixin. Each mixin keeps its
// OWN single-use constants local to its file; only the genuinely cross-cutting ones live
// here so they can't drift between concerns.
import { LOCATIONS } from '../../data/anatomy.js';

// On-screen scale of an arena mech (hull/turret sprites). Used by locomotion (view + muzzle)
// and combat (mapping a hit point back to the nearest body part).
export const ARENA_MECH_SCALE = 0.34;

// The starting enemy's hex (world build clears it; create() spawns the first enemy there).
export const DUMMY_HEX = { q: 3, r: -1 };

// #87 (corrected): a dying enemy's death explosion should read as size-appropriate — a drone
// popping should look small, a tank/heavy mech's should go up in a noticeably bigger blast.
// Both enemy shapes already carry a size signal: a mech's `weightClass` (light/medium/heavy
// off its chassis) or a non-mech kind's data-driven `scale` (enemyKinds.js — already used to
// size its on-screen sprite; a drone is 0.72, a tank 0.82, etc.). Map either to one multiplier
// so the death FX (combat.js `_damageEnemyAt`) can scale a single burst recipe instead of two.
const MECH_WEIGHT_DEATH_SCALE = { light: 0.8, medium: 1.0, heavy: 1.35 };
export function deathScaleFor(e) {
  if (e.kind === 'mech' || e.kind === undefined) {
    return MECH_WEIGHT_DEATH_SCALE[e.mech.weightClass] ?? 1.0;
  }
  return e.kindDef?.scale ?? 1.0;
}

// Move `cur` toward `target` by at most `maxStep`. Used by player + enemy locomotion.
export function approach(cur, target, maxStep) {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}

// #86 — one shared turret/heading rotation step, used by the player's turret slew, every
// enemy mech's turret + facing, and the vehicle-behavior turret tracking (locomotion.js,
// enemies.js, enemyBehaviors.js all had their own copy of this exact expression, each calling
// Phaser.Math.Angle.RotateTo directly). PURE reimplementation of that same algorithm (no
// Phaser import — importing the `phaser` package itself crashes under vitest's node test
// environment: it touches `navigator` at import time for device detection) so this is
// directly unit-testable: rotate `cur` toward `target` at `radPerSec`, scaled by `dt` —
// properly dt-scaled so it behaves the same at 30fps (dt≈0.033) as 60fps (dt≈0.017), taking
// the short way around the ±π seam, and snapping to the target instead of overshooting past
// it once the step would cover the remaining distance (a big dt, or being already close).
const PI2 = Math.PI * 2;
export function rotateToward(cur, target, radPerSec, dt) {
  const lerp = radPerSec * dt;
  if (cur === target) return cur;
  let t = target;
  const diff = Math.abs(t - cur);
  if (diff <= lerp || diff >= PI2 - lerp) return t;
  if (diff > Math.PI) t += t < cur ? PI2 : -PI2;
  if (t > cur) return cur + lerp;
  if (t < cur) return cur - lerp;
  return cur;
}

// Re-exported for the combat mixin (damage maps to a body location; cockpit is hit via head).
export const DAMAGEABLE = LOCATIONS.filter((l) => l !== 'cockpit');

// ── Direct-fire convergence (#40, #31, #74) ──────────────────────────────────────────
// Direct-fire weapons (lasers, autocannons) toe their off-centre muzzles inward to a point
// on the turret line at the live most-aimed enemy's range, so shots land where the turret
// points. Two named distances, both playtest-tunable:
export const CONVERGE_DIST = 450;     // px: convergence range when nothing is being aimed at.
// #74: floor on the convergence distance so a point-blank enemy (dist → ~0) can't drag the
// point onto the mech and rotate the arm/torso muzzles until they nearly cross — an absurd,
// silly toe-in the playtester flagged. Below this floor the muzzles stay only gently toed.
// Sanity-checked against the actual world-space muzzle geometry (part.x × ARENA_MECH_SCALE ×
// ART_SCALE — see locomotion `_muzzle`): the widest muzzles are the arms, whose LATERAL
// offset r ≈ 17px (light) … 33px (heavy) sit forward f ≈ 12–19px of the mech centre, so the
// worst-case toe-in is atan(r / (dist − f)). At this 200px floor that peaks at ~10° (heavy/
// medium arms) down to ~5° (light) — a modest inward cant, versus ~2–4° at the natural 450
// range and the ~45–90° near-crossing it replaces at true point-blank. Raising it toes in
// less (more parallel), lowering it toes in more; 200 keeps convergence active through the
// common mid-range engagement while killing the point-blank cross-eye.
export const MIN_CONVERGE_DIST = 200;

// Fire angle for one direct-fire muzzle at world (mx, my): aim it at a convergence point on
// the turret line `dist` ahead of the mech at (px, py), with `dist` clamped to `minDist` so
// the toe-in can't blow up at point-blank. PURE (no Phaser / no scene) so it's unit-testable;
// both the firing path (targeting `_fireAngle`) and the visual part-tilt (locomotion
// `_partTilt`, which calls `_fireAngle`) go through this, so the clamp applies to both.
export function convergedFireAngle(px, py, turretAngle, dist, mx, my, minDist = MIN_CONVERGE_DIST) {
  const d = Math.max(dist, minDist);
  const cx = px + Math.cos(turretAngle) * d;
  const cy = py + Math.sin(turretAngle) * d;
  return Math.atan2(cy - my, cx - mx);
}

// #92: the tank's HULL turns to face its direction of TRAVEL (like a real tank driving),
// completely independent of its turret (which separately tracks the player — see aimAndFire
// in enemyBehaviors.js, which drives e.turret). PURE + testable: only turns while actually
// moving faster than `moveThreshold` (a stopped tank keeps facing wherever it last drove,
// rather than snapping to some arbitrary heading), reusing the same dt-scaled `rotateToward`
// step every other facing/aim rotation in the arena uses.
export function hullTravelAngle(curAngle, vx, vy, turnRate, dt, moveThreshold = 5) {
  if (Math.hypot(vx, vy) <= moveThreshold) return curAngle;
  return rotateToward(curAngle, Math.atan2(vy, vx), turnRate, dt);
}

// #92: is point (px, py) inside a circle of `radius` centred at (ex, ey)? PURE — the shared
// primitive behind the player-vs-ground-enemy collision check (world.js `_blockedByGroundEnemy`),
// factored out so the geometry itself is unit-testable without a scene.
export function circleContains(px, py, ex, ey, radius) {
  return Math.hypot(px - ex, py - ey) < radius;
}

// #92: the on-screen collision footprint (px) of a GROUND enemy unit, used both to block the
// player's movement (world.js `_blockedByGroundEnemy`) and to decide how close counts as
// "pressed into it" for the tank-crush check. A mech enemy uses one flat radius (they're all
// drawn at the same ARENA_MECH_SCALE); a non-mech vehicle kind scales a base radius by its
// own data-driven `scale` (enemyKinds.js) so a small turret and a bulkier tank each collide at
// roughly their drawn size. Both radii are owner-tunable — picked to roughly match the sprite
// footprints, not derived from exact art bounds.
export const ENEMY_COLLIDE_RADIUS_MECH = 28;      // px — enemy mech chassis footprint
export const ENEMY_COLLIDE_RADIUS_VEHICLE = 24;   // px — base non-mech ground-unit footprint
export function groundEnemyRadius(e) {
  if (e.kind === 'mech' || e.kind === undefined) return ENEMY_COLLIDE_RADIUS_MECH;
  return ENEMY_COLLIDE_RADIUS_VEHICLE * (e.kindDef?.scale ?? 1);
}

// #92: crush/stomp damage for ONE frame of the player leaning into a destructible thing (an
// outpost, or now a tank) — DPS scaled by how hard the player is driving in (speedFrac, clamped
// 0..1), with a floor (0.35) so even a gentle press still chips away instead of doing nothing.
// PURE — shared by world.js `_stompBuildingAt` (outposts, #41) and `_crushTankAt` (tanks, #92)
// so the two crush mechanics can't drift apart.
export function crushDamage(dps, dt, speedFrac) {
  const frac = speedFrac < 0 ? 0 : speedFrac > 1 ? 1 : speedFrac;
  return dps * dt * (0.35 + 0.65 * frac);
}

// #45: mechs don't run backwards at full tilt. Scale a max-speed figure down when the
// movement-intent vector (mx, my; needn't be normalized) has a net negative component
// along the turret facing — i.e. the mech is backing away from where it's aimed. Pure
// sideways/forward movement is untouched; only the backward component is penalized, via
// a continuous lerp so strafing diagonally-back doesn't hard-clip to one multiplier.
export const BACKWARD_SPEED_MULT = 0.55; // owner: tune — 50-60% of maxSpeed while backing up
export function backwardSpeedScale(mx, my, turretAngle) {
  const mag = Math.hypot(mx, my);
  if (mag < 1e-4) return 1;
  const facing = Math.cos(turretAngle) * (mx / mag) + Math.sin(turretAngle) * (my / mag);
  if (facing >= 0) return 1;
  // facing in [-1, 0]; lerp from 1 (purely sideways) to BACKWARD_SPEED_MULT (straight back).
  return 1 + facing * (1 - BACKWARD_SPEED_MULT);
}
