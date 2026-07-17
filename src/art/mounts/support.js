// Support mount — a stubby barrel with a big glowing emitter.
import { barrel, glowDot } from '../mechPrims.js';
import { barrelLen } from './barrelSpec.js';

export function draw(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('support', s, cap);
  barrel(sg, T, bx, frontY - L * 0.4, 2 * s, L * 0.8);
  glowDot(sg, bx, frontY - L, 2.6 * s, n);
}
