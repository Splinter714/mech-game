// Pauldron decor — a big angular shoulder block (heavy bruiser).
import { plate, rectC } from '../mechPrims.js';

// `tag` is only ever absent if a future call site forgets it; the fallback keeps the piece drawing.
export function draw(sg, d, lay, T, tag = () => {}) {
  const st = lay[d.side < 0 ? 'leftTorso' : 'rightTorso'];
  const w = st.w * 1.15, h = st.h * 0.52;
  const cx = st.x + d.side * st.w * 0.28, cy = st.y - st.h * 0.36;
  // The prefix is threaded in, so `plate()`'s own opt-in furniture tags (body/rim/ao) nest under
  // whichever call site is drawing this — 'pauldron.plate.*' on the side torso texture.
  plate(sg, T, cx, cy, w, h, { fill: T.faceDk, chamfer: Math.min(w, h) * 0.34, seam: false, tag: tag('plate') });
  tag('vent');   // same word the side torso's own recessed slot uses
  rectC(sg, cx, cy, w * 0.5, h * 0.18, T.recess);
}
