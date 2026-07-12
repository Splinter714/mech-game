// #151: pure idle-wander goal-picking helper, extracted out of scenes/arena/enemies.js so it's
// unit-testable without pulling in Phaser/the live scene (mirrors the #114/#115 spawnPlacement.js
// split — keep the geometry pure, let the caller supply the world-aware bits as a predicate).
//
// Picks a random point within `radius` of (spawnX, spawnY), then — if `isBlocked` rejects it —
// nudges it back toward the spawn point (same shrink-toward-origin pattern used everywhere else
// in this file for cluster/goal placement) until it clears or the retry budget runs out. The
// spawn point itself is always assumed valid (spawn-time placement already validates it — see
// #114/#115 — so it's a safe last-resort fallback), which guarantees convergence: each nudge
// halves the distance to a known-good point.
//
// `isBlocked(x, y)` is the caller's world-knowledge — typically "impassable terrain" OR, for a
// unit that should avoid it, "a water hex" (see terrain.js `isWaterTerrain` + enemyKinds.js
// `avoidWater`). Keeping that logic out of this file is what makes it pure.
export function pickWanderGoal(spawnX, spawnY, radius, isBlocked, rng = Math.random) {
  const a = rng() * Math.PI * 2;
  const r = rng() * radius;
  let gx = spawnX + Math.cos(a) * r, gy = spawnY + Math.sin(a) * r;
  for (let t = 0; t < 5 && isBlocked(gx, gy); t++) {
    gx = (gx + spawnX) / 2; gy = (gy + spawnY) / 2;
  }
  return { x: gx, y: gy };
}
