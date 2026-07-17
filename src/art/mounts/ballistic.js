// Ballistic mount — a twin-barrel autocannon over a muzzle housing.
import { rectC, barrel, glowDot } from '../mechPrims.js';
import { barrelLen } from './barrelSpec.js';

export function draw(sg, T, bx, frontY, s, n, cap) {
  const L = barrelLen('ballistic', s, cap), w = 1.9 * s, off = 1.5 * s;
  rectC(sg, bx, frontY - L * 0.5 + 1, (w + off) * 2.1, 2.4 * s, T.deep);     // muzzle housing
  for (const dx of [-1, 1]) {
    barrel(sg, T, bx + dx * off, frontY - L / 2, w, L);
    glowDot(sg, bx + dx * off, frontY - L + 0.5, 1.5 * s, n);
  }
}
