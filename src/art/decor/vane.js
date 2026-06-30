// Vane decor — a swept-back skirmisher fin (light).
import { poly } from '../mechPrims.js';

export function draw(sg, d, lay, T) {
  const st = lay[d.side < 0 ? 'leftTorso' : 'rightTorso'];
  const ox = st.x + d.side * st.w * 0.4, fy = st.y + st.h * 0.08;
  const tipX = ox + d.side * st.w * 1.25, tipY = fy + st.h * 0.55;
  poly(sg, [[ox, fy - st.h * 0.34], [tipX, tipY], [ox, fy + st.h * 0.16]], T.outline);
  poly(sg, [[ox, fy - st.h * 0.3], [tipX - d.side * 0.5, tipY - 0.4], [ox, fy + st.h * 0.12]], T.faceDk);
  poly(sg, [[ox, fy - st.h * 0.3], [ox + d.side * st.w * 0.55, fy - st.h * 0.08], [ox, fy - st.h * 0.02]], T.rim, 0.5);
}
