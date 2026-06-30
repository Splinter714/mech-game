// Mast decor — a tall sensor antenna with a glowing tip (light scout).
import { rectC, glowDot, NEON } from '../mechPrims.js';

export function draw(sg, d, lay, T) {
  const hd = lay.head;
  const mx = hd.x + (d.side ?? -1) * hd.w * 0.18;
  rectC(sg, mx, hd.y - hd.h * 1.3, Math.max(0.8, hd.w * 0.07), hd.h * 1.8, T.rim);
  glowDot(sg, mx, hd.y - hd.h * 2.1, 1.1, NEON.energy);
}
