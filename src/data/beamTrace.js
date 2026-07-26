// Pure hitscan/beam targeting geometry — given a firing ray (muzzle + angle) and the set of
// living enemies, find the nearest one actually struck (forward distance along the ray, with
// a perpendicular miss tolerance) and the ray's resting distance if nothing is hit.
//
// Factored out (#86) so the same geometry can run in two places: the damage-tick resolve in
// arena/firing.js `_fireHitscan`, AND a per-render-frame beam visual reposition for held
// continuous beams (sustained/stream hitscan, e.g. the beam laser) — the latter is what makes
// the beam's line track the muzzle smoothly as the turret sweeps, instead of only snapping to
// a new angle each time the weapon's own (much slower) fire cadence ticks.
//
// `enemies` is a plain array of `{ x, y, destroyed }` (no Mech/Phaser coupling) so this stays
// trivially unit-testable; callers map their live enemy list into that shape.
export function traceHitscan(muzzleX, muzzleY, angle, reach, enemies, hitRadius = 44) {
  const dirX = Math.cos(angle), dirY = Math.sin(angle);
  let target = null, t = 0;
  for (const e of enemies) {
    if (e.destroyed) continue;
    const ex = e.x - muzzleX, ey = e.y - muzzleY;
    const tt = ex * dirX + ey * dirY;
    const perp = Math.abs(ex * dirY - ey * dirX);
    if (tt > 0 && tt < reach && perp < hitRadius && (!target || tt < t)) { target = e; t = tt; }
  }
  const endDist = target ? t : Math.min(reach, 600);
  return {
    target,
    t,
    endDist,
    endX: muzzleX + dirX * endDist,
    endY: muzzleY + dirY * endDist,
  };
}

// #537: the piercing counterpart to `traceHitscan` above — instead of stopping at the single
// nearest candidate, returns EVERY living candidate within beam-width tolerance whose forward
// projection falls between the muzzle and `maxDist` (the beam's final, already wall-clamped
// resting distance), sorted nearest-first. Used only by a hitscan weapon whose delivery opts
// into `pierce: true` (currently just Charge Lance) — every other hitscan weapon keeps using
// `traceHitscan` above and is unaffected.
export function traceHitscanPiercing(muzzleX, muzzleY, angle, maxDist, targets, hitRadius = 44) {
  const dirX = Math.cos(angle), dirY = Math.sin(angle);
  const hits = [];
  for (const e of targets) {
    if (e.destroyed) continue;
    const ex = e.x - muzzleX, ey = e.y - muzzleY;
    const tt = ex * dirX + ey * dirY;
    const perp = Math.abs(ex * dirY - ey * dirX);
    if (tt > 0 && tt <= maxDist && perp < hitRadius) hits.push({ target: e, t: tt });
  }
  hits.sort((a, b) => a.t - b.t);
  return hits;
}
