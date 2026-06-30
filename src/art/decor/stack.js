// Stack decor — a rear exhaust pair with glowing embers.
import { rectC, glowBar } from '../mechPrims.js';

export function draw(sg, d, lay, T) {
  const st = lay[d.side < 0 ? 'leftTorso' : 'rightTorso'];
  const cx = st.x, cy = st.y + st.h * 0.5;
  rectC(sg, cx, cy, st.w * 0.4, st.h * 0.22, T.deep);
  glowBar(sg, cx, cy + st.h * 0.06, st.w * 0.22, st.h * 0.06, { halo: 0xc8801a, core: 0xff7a18, hot: 0xffd56b });
}
