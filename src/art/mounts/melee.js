// Melee mount — a tapered blade with a glowing tip.
import { poly, glowDot, emissive } from '../mechPrims.js';
import { barrelLen } from './barrelSpec.js';

export function draw(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('melee', s, cap), w = 3 * s;
  poly(sg, [[bx - w / 2, frontY], [bx + w / 2, frontY], [bx, frontY - L]], T.faceMid);
  emissive(sg, () => poly(sg, [[bx - w * 0.18, frontY], [bx + w * 0.18, frontY], [bx, frontY - L]], n.core, 0.9)); // glowing edge
  glowDot(sg, bx, frontY - L, 1.4 * s, n);
}
