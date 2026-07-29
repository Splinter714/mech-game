// Pure target-selection for anti-missile point defense (#494) — no engine concept of "shoot
// down an incoming projectile" existed before this. #494/#546: Anti-Missile Defense moved from a
// passive core-slot pick (whose cooldown gate used to live on Mech) to an active mountable
// ability — the cooldown/duration/active-window state now lives in the normal ability-state
// system (data/abilityState.js), ticked by scenes/arena/abilities.js's `antiMissile` effect. This
// stays here because it needs no Mech at all, just points — still the reusable target-selection
// primitive underneath the ability's per-frame scan.

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
