// Constants + tiny helpers shared across more than one arena mixin. Each mixin keeps its
// OWN single-use constants local to its file; only the genuinely cross-cutting ones live
// here so they can't drift between concerns.
import { LOCATIONS } from '../../data/anatomy.js';

// On-screen scale of an arena mech (hull/turret sprites). Used by locomotion (view + muzzle)
// and combat (mapping a hit point back to the nearest body part).
export const ARENA_MECH_SCALE = 0.34;

// The starting enemy's hex (world build clears it; create() spawns the first enemy there).
export const DUMMY_HEX = { q: 3, r: -1 };

// Move `cur` toward `target` by at most `maxStep`. Used by player + enemy locomotion.
export function approach(cur, target, maxStep) {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}

// Re-exported for the combat mixin (damage maps to a body location; cockpit is hit via head).
export const DAMAGEABLE = LOCATIONS.filter((l) => l !== 'cockpit');

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
