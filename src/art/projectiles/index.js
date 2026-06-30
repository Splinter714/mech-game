// Projectile-kind art registry — the generic "what a travelling round looks like"
// dispatcher. Each kind lives in its own file exporting `draw(g, x, y, ca, sa, color, s,
// phase)`; this module owns nothing kind-specific beyond the lookup table. **Add a kind =
// a new file + one appended line in PROJECTILE_ART** (which git merges cleanly across
// concurrent branches). The classifier `projectileKind` (data/delivery.js) maps a weapon to
// one of these keys; an unknown key falls back to `slug`.
import { draw as plasma } from './plasma.js';
import { draw as missile } from './missile.js';
import { draw as flame } from './flame.js';
import { draw as fire } from './fire.js';
import { draw as bullet } from './bullet.js';
import { draw as slug } from './slug.js';

export const PROJECTILE_ART = { plasma, missile, flame, fire, bullet, slug };

// A travelling round's body, drawn at (x, y) heading along `angle`. `phase` drives the
// flame flicker (the arena passes the round's distance; icons pass 0). Computes the heading
// vector once and dispatches to the registered kind (default `slug`).
export function drawProjectileBody(g, x, y, angle, kind, color, s = 1, phase = 0) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  (PROJECTILE_ART[kind] ?? PROJECTILE_ART.slug)(g, x, y, ca, sa, color, s, phase);
}
