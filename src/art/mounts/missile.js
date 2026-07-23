// Missile mount — a launch box with a 2×2 grid of glowing cells.
import { poly, plateOutline, rectC, emissive } from '../mechPrims.js';
import { barrelLen } from './barrelSpec.js';

export function draw(sg, T, bx, frontY, s, n, cap) {
  const w = 5.4 * s, h = barrelLen('missile', s, cap), cy = frontY - h / 2;
  // #446: the enemy's bubbly ellipse box is gone, and pass 2 dropped its hard-cornered rounded
  // rect too — a launcher is a CUT box on both themes now, faceted or chamfered per faction.
  poly(sg, plateOutline(T, bx, cy, w + 1, h + 1, 1), T.outline);
  poly(sg, plateOutline(T, bx, cy, w, h, 1), T.faceDk);
  for (const dx of [-1, 1]) for (const dy of [0, 1]) {           // 2×2 launch cells
    const cxx = bx + dx * w * 0.22, cyy = frontY - h * (0.28 + dy * 0.32);
    emissive(sg, () => {
      rectC(sg, cxx, cyy, w * 0.26, h * 0.18, n.halo, 0.5);
      rectC(sg, cxx, cyy, w * 0.18, h * 0.12, n.core, 1);
    });
  }
}
