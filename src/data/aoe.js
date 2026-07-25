// Area-of-effect targeting/damage math (#492 introduces this; #490/#498 reuse it for their own
// non-aimed bursts). Pure: given a blast center, radius, and a list of candidate {x,y} points,
// returns which are in range and how much damage each takes after falloff. Never touches
// Mech/HpBody/scene state directly — callers stay responsible for actually applying damage
// through the existing per-owner dispatch (`_damagePlayerAt`/`_damageEnemyAt`), which is where
// co-op's friendly-fire-on rule and kill/death bookkeeping already live. Keeping this pure also
// makes it trivially unit-testable without a scene.
export function damageInRadius(cx, cy, radius, damage, candidates, { falloff = false } = {}) {
  const hits = [];
  for (const c of candidates) {
    const d = Math.hypot(c.x - cx, c.y - cy);
    if (d >= radius) continue;
    // Linear falloff to the blast edge, floored at 1 so a graze is never a true zero — matches
    // the flooring convention `_rangeFactor`-scaled hits already use elsewhere in the arena.
    const amount = falloff ? Math.max(1, Math.round(damage * (1 - d / radius))) : damage;
    hits.push({ target: c, distance: d, amount });
  }
  return hits;
}
