// Vane decor — a swept-back skirmisher fin (light).
//
// THE HEAD-ONLY ACCENT RULE, for every decor piece. Live-chat ask (2026-07-31): "remove all colour
// accents from the three chassis except for the part on the head." The earlier head-only pass
// converted every `plate()` caller to `rim: T.baseRim`, but decor pieces hand-roll their own shapes
// and so kept reading the now-accented `T.rim` — which is what painted the player's colour across
// vanes and pauldrons in the art preview. So a decor highlight uses `T.baseRim ?? T.rim`. The `??`
// matters: `themeFor` returns the base theme UNCLONED when no accent is set (enemies, the garage
// preview), so `baseRim` is undefined there and `T.rim` is already the unaccented tone.
// (This note used to live in decor/mast.js, which #600 deleted along with decor/stack.js — both
// kinds were left listed by no chassis after the 2026-07-31 decor pass.)
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
  // Head-only accent (see this file's header for the full rule). This highlight wedge was the
  // vane's blue in the art preview; it now takes the theme's unaccented rim tone.
  poly(sg, [[ox, fy - st.h * 0.3], [ox + d.side * st.w * 0.55, fy - st.h * 0.08], [ox, fy - st.h * 0.02]], T.baseRim ?? T.rim, 0.5);
}
