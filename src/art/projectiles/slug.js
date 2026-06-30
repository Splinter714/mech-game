// Slug — a heavy autocannon shell with a long tracer: dark shell body, a coloured core, and
// a white-hot tip. The default round when a kind isn't otherwise recognised.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const tx = x - ca * 19 * s, ty = y - sa * 19 * s;
  g.lineStyle(2.9 * s, color, 0.35); g.lineBetween(tx, ty, x, y);
  g.fillStyle(0x2a2d33, 1);                       // dark shell body
  g.fillCircle(x - ca * 2.5 * s, y - sa * 2.5 * s, 3.8 * s); g.fillCircle(x, y, 4 * s);
  g.fillStyle(color, 0.95); g.fillCircle(x, y, 2.5 * s);
  g.fillStyle(0xffffff, 0.95); g.fillCircle(x + ca * 0.8 * s, y + sa * 0.8 * s, 1.3 * s);
}
