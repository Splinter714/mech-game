// Pure push/pull impulse math (#491 gravity, #499 push/pull) — no knockback/tractor concept
// existed anywhere in the engine before this. One shared primitive for both: a signed pull
// (attract, `sign < 0`) or push (repel, `sign > 0`) toward/away from a center point, with linear
// falloff to the edge of its radius. Returns the raw {dx, dy} displacement for ONE tick (`dt`
// seconds already baked in) — the caller applies it to whatever position field the target uses
// (enemies.js `e.x`/`e.y` today), same "pure math, scene applies it" split as data/aoe.js.
export function computeImpulse(cx, cy, radius, strength, sign, tx, ty, dt, { falloff = true } = {}) {
  const dx = tx - cx, dy = ty - cy;
  const d = Math.hypot(dx, dy);
  if (d >= radius || d < 1) return { dx: 0, dy: 0 };   // at/beyond the edge, or already at the center
  const f = falloff ? (1 - d / radius) : 1;
  const mag = strength * f * dt * sign;
  // (dx/d, dy/d) points FROM the center TO the target (i.e. away from it) — a positive sign
  // (repel) rides that direction outward; a negative sign (attract) flips it inward.
  return { dx: (dx / d) * mag, dy: (dy / d) * mag };
}
