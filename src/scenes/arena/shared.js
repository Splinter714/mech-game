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
