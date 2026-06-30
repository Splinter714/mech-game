// Pauldron decor — a big angular shoulder block (heavy bruiser).
import { plate, rectC } from '../mechPrims.js';

export function draw(sg, d, lay, T) {
  const st = lay[d.side < 0 ? 'leftTorso' : 'rightTorso'];
  const w = st.w * 1.15, h = st.h * 0.52;
  const cx = st.x + d.side * st.w * 0.28, cy = st.y - st.h * 0.36;
  plate(sg, T, cx, cy, w, h, { fill: T.faceDk, chamfer: Math.min(w, h) * 0.34, seam: false });
  rectC(sg, cx, cy, w * 0.5, h * 0.18, T.recess);
}
