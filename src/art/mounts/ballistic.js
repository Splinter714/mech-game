// Ballistic mount — a twin-barrel autocannon over a muzzle housing.
import { rectC, barrel, glowDot } from '../mechPrims.js';
import { barrelLen } from './barrelSpec.js';

// #585 tags: the per-barrel `barrel`/`color` pair is re-tagged INSIDE the loop rather than split
// into two passes — the halo of one barrel's glowDot overlaps its neighbour's tube, so reordering
// the draws to group them by tag would change the bake.
export function draw(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('ballistic', s, cap), w = 1.9 * s, off = 1.5 * s;
  tag('collar');
  rectC(sg, bx, frontY - L * 0.5 + 1, (w + off) * 2.1, 2.4 * s, T.deep);     // muzzle housing
  for (const dx of [-1, 1]) {
    tag('barrel');
    barrel(sg, T, bx + dx * off, frontY - L / 2, w, L);
    tag('color');
    glowDot(sg, bx + dx * off, frontY - L + 0.5, 1.5 * s, n);
  }
}
