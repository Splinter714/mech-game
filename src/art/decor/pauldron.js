// Pauldron decor — a big angular shoulder block (heavy bruiser).
import { plate, rectC } from '../mechPrims.js';

// `tag` is only ever absent if a future call site forgets it; the fallback keeps the piece drawing.
export function draw(sg, d, lay, T, tag = () => {}) {
  const st = lay[d.side < 0 ? 'leftShoulder' : 'rightShoulder'];
  const w = st.w * 1.15, h = st.h * 0.52;
  const cx = st.x + d.side * st.w * 0.28, cy = st.y - st.h * 0.36;
  // The prefix is threaded in, so `plate()`'s own opt-in furniture tags (body/rim/ao) nest under
  // whichever call site is drawing this — 'pauldron.plate.*' on the shoulder texture.
  // Head-only accent — see vane.js's header for the full rule (#600 moved it there). This plate()
  // call took the accented `T.rim` by default, which is what painted the blue bars across the
  // Colossus' shoulders in the art preview; `rim: T.baseRim` opts it out the same way every
  // non-head plate() caller in mechArt.js already does.
  plate(sg, T, cx, cy, w, h,
        { fill: T.faceDk, chamfer: Math.min(w, h) * 0.34, seam: false, rim: T.baseRim, tag: tag('plate') });
  tag('vent');   // same word the shoulder's own recessed slot uses
  rectC(sg, cx, cy, w * 0.5, h * 0.18, T.recess);
}
