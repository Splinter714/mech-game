// Energy mount (also the default for any unrecognised category) — a slim barrel with an
// edge light and a big glowing emitter lens.
import { barrel, rectC, glowDot, emissive } from '../mechPrims.js';
import { barrelLen } from './barrelSpec.js';

// #585 tags: no separate housing to call `collar` and no end piece to call `muzzle` — the bare
// tube IS the whole mount.
export function draw(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const L = barrelLen('energy', s, cap), w = 2.2 * s;
  tag('barrel');
  barrel(sg, T, bx, frontY - L / 2, w, L);
  tag('color');
  emissive(sg, () => rectC(sg, bx - w * 0.42, frontY - L / 2, w * 0.22, L, n.edge, 0.7)); // edge light
  glowDot(sg, bx, frontY - L, 2.6 * s, n);
}
