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
//
// `foreshorten` (#377) compresses the sprite ALONG its travel axis only (perpendicular width
// unchanged) to fake pitch on an arcing round — 1 = full side-on length, <1 = seen more end-on
// as it climbs/dives. It's applied via a canvas transform (translate→rotate→scaleX) so no
// per-kind art has to know about it: the kind draws itself at the origin heading +x as usual,
// and the scaleX squashes only the length. The fast common path (foreshorten === 1) keeps the
// original direct-coordinate draw untouched.
export function drawProjectileBody(g, x, y, angle, kind, color, s = 1, phase = 0, foreshorten = 1) {
  const drawKind = PROJECTILE_ART[kind] ?? PROJECTILE_ART.slug;
  if (foreshorten !== 1) {
    g.save();
    g.translateCanvas(x, y);
    g.rotateCanvas(angle);
    g.scaleCanvas(foreshorten, 1);     // squash length along the travel axis, keep width
    drawKind(g, 0, 0, 1, 0, color, s, phase);
    g.restore();
    return;
  }
  const ca = Math.cos(angle), sa = Math.sin(angle);
  drawKind(g, x, y, ca, sa, color, s, phase);
}
