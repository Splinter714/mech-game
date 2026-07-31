// Vane decor — a swept-back skirmisher fin (light).
import { poly } from '../mechPrims.js';

// Tags mirror `plate()`'s own furniture split (mechPrims.js) even though this is a hand-rolled
// shape: the outline+face is the `body`, the lit highlight wedge is the `rim`.
export function draw(sg, d, lay, T, tag) {
  const st = lay[d.side < 0 ? 'leftShoulder' : 'rightShoulder'];
  const ox = st.x + d.side * st.w * 0.4, fy = st.y + st.h * 0.08;
  const tipX = ox + d.side * st.w * 1.25, tipY = fy + st.h * 0.55;
  tag('body');
  poly(sg, [[ox, fy - st.h * 0.34], [tipX, tipY], [ox, fy + st.h * 0.16]], T.outline);
  poly(sg, [[ox, fy - st.h * 0.3], [tipX - d.side * 0.5, tipY - 0.4], [ox, fy + st.h * 0.12]], T.faceDk);
  tag('rim');
  // Live-chat ask (2026-07-31): head-only accent — see mast.js for the full note. This highlight
  // wedge was the vane's blue in the art preview; it now takes the theme's unaccented rim tone.
  poly(sg, [[ox, fy - st.h * 0.3], [ox + d.side * st.w * 0.55, fy - st.h * 0.08], [ox, fy - st.h * 0.02]], T.baseRim ?? T.rim, 0.5);
}
