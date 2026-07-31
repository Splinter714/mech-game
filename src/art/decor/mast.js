// Mast decor — a tall sensor antenna with a glowing tip (light scout).
import { rectC, glowDot, NEON } from '../mechPrims.js';

export function draw(sg, d, lay, T, tag) {
  const hd = lay.head;
  const mx = hd.x + (d.side ?? -1) * hd.w * 0.18;
  tag('body');
  // Live-chat ask (2026-07-31): "remove all colour accents from the three chassis except for the
  // part on the head." The earlier head-only pass converted every plate() caller to `rim:
  // T.baseRim`, but decor pieces hand-roll their own shapes and so kept reading the now-accented
  // `T.rim` — this mast stem was painting itself in the player's colour. `?? T.rim` because
  // themeFor returns the base theme UNCLONED when no accent is set (enemies, garage preview), so
  // baseRim is undefined there and T.rim is already the unaccented tone.
  rectC(sg, mx, hd.y - hd.h * 1.3, Math.max(0.8, hd.w * 0.07), hd.h * 1.8, T.baseRim ?? T.rim);
  tag('tip');
  glowDot(sg, mx, hd.y - hd.h * 2.1, 1.1, NEON.energy);
}
