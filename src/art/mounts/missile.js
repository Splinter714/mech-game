// Missile mount — a launch box with a 2×2 grid of glowing cells, on the flush mounting collar
// (`weaponCollar`, mechPrims.js) shared with Plasma Coater and the bespoke missile weapons
// (live-chat ask): sits ON the plate rather than projecting past its own edge.
import { weaponCollar, rectC, emissive } from '../mechPrims.js';
import { barrelLen } from './barrelSpec.js';

// #585 tags: the launch cells here are drawn ENTIRELY as `emissive()` colour (no dark tube ring
// under them, unlike streakPod/clusterRocket), so this mount has no `barrel` piece at all — the
// cells are lit, therefore `color`, and they're exactly what the glow-only overlay keeps.
export function draw(sg, T, bx, frontY, s, n, cap, partW, partH, tag) {
  const w = partW ?? 5.4 * s, collarH = barrelLen('missile', s, cap) * 0.8;
  tag('collar');
  const collarY = weaponCollar(sg, T, bx, frontY, w, collarH, partW, partH);
  const y0 = collarY - collarH / 2;
  tag('color');
  for (const dx of [-1, 1]) for (const dy of [0, 1]) {           // 2×2 launch cells
    const cxx = bx + dx * w * 0.22, cyy = y0 + collarH * (0.28 + dy * 0.32);
    emissive(sg, () => {
      rectC(sg, cxx, cyy, w * 0.26, collarH * 0.18, n.halo, 0.5);
      rectC(sg, cxx, cyy, w * 0.18, collarH * 0.12, n.core, 1);
    });
  }
}
