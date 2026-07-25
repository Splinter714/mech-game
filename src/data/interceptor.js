// Pure target-selection for anti-missile point defense (#494) — no engine concept of "shoot
// down an incoming projectile" existed before this. The cooldown GATE itself lives on Mech
// (data/Mech.js `canIntercept`/`triggerIntercept`/`tickInterceptorCooldown`, mirroring shield's
// own runtime-state precedent); this stays here because it needs no Mech at all, just points.

// Nearest candidate (an `{x,y}`-shaped point — an enemy-fired round in practice) within `range`
// of (x, y), or null if none qualify.
export function nearestInterceptTarget(x, y, range, candidates) {
  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < range && d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}
