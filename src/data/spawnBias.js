// #102 — bias off-screen enemy spawn points toward the OBJECTIVE's direction instead of a
// uniform-random bearing around the player, so enemies read as defenders converging from what
// you're attacking, not a random ambush from every side. Pure angle math, Phaser-free
// (spawnBias.test.js) — the arena (scenes/arena/enemies.js `_offscreenSpawnPoint`) supplies the
// live objective bearing and calls `biasedSpawnAngle` in place of a plain `Math.random() * 2π`.

// How far (radians) a spawn bearing may stray from the straight line to the objective. Keeps a
// generous ARC facing the objective — not a single pinpoint bearing — so successive spawns still
// land at varied points instead of stacking on one line, while all reading as "from over there".
// Owner: tunable.
export const SPAWN_BIAS_SPREAD = Math.PI / 2.4;   // ~75°, so the full arc is ~150° wide

// Pick a spawn bearing biased toward `objectiveAngle` (radians, player → objective) within
// ±spread. `rand` is an injectable 0..1 generator (deterministic tests); defaults to Math.random
// for real gameplay. Falls back to a uniform bearing when there's no live objective this stage
// (e.g. objectiveAngle is null) so spawning never breaks in that edge case.
export function biasedSpawnAngle(objectiveAngle, spread = SPAWN_BIAS_SPREAD, rand = Math.random) {
  if (objectiveAngle == null || !Number.isFinite(objectiveAngle)) return rand() * Math.PI * 2;
  return objectiveAngle + (rand() * 2 - 1) * spread;
}

// Is a candidate bearing within the acceptable bias arc around the objective direction? Handles
// angle wraparound (e.g. objective at 179° and a candidate at -179° are 2° apart, not 358°).
// Used by tests (and available to callers) to verify a spawn actually landed "from the objective".
export function isWithinSpawnBias(angle, objectiveAngle, spread = SPAWN_BIAS_SPREAD) {
  let diff = Math.abs(angle - objectiveAngle) % (Math.PI * 2);
  if (diff > Math.PI) diff = Math.PI * 2 - diff;
  return diff <= spread + 1e-9;
}
