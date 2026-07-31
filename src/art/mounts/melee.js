// Melee mount — a tapered blade with a glowing tip.
import { poly, glowDot, emissive } from '../mechPrims.js';
import { barrelLen } from './barrelSpec.js';

// #585 tags: a blade has no tube, but it IS the emitting body projecting off the mech — so the
// blade takes `barrel` rather than earning a term of its own.
export function draw(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('melee', s, cap), w = 3 * s;
  tag('barrel');
  poly(sg, [[bx - w / 2, frontY], [bx + w / 2, frontY], [bx, frontY - L]], T.faceMid);
  tag('color');
  emissive(sg, () => poly(sg, [[bx - w * 0.18, frontY], [bx + w * 0.18, frontY], [bx, frontY - L]], n.core, 0.9)); // glowing edge
  glowDot(sg, bx, frontY - L, 1.4 * s, n);
}
