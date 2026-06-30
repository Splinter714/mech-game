// Slug — a heavy autocannon shell with a long tracer: dark shell body, a coloured core, and
// a white-hot tip. The default round when a kind isn't otherwise recognised.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const tx = x - ca * 16 * s, ty = y - sa * 16 * s;
  g.lineStyle(2.4 * s, color, 0.35); g.lineBetween(tx, ty, x, y);
  g.fillStyle(0x2a2d33, 1);                       // dark shell body
  g.fillCircle(x - ca * 2 * s, y - sa * 2 * s, 3 * s); g.fillCircle(x, y, 3.2 * s);
  g.fillStyle(color, 0.95); g.fillCircle(x, y, 2 * s);
  g.fillStyle(0xffffff, 0.95); g.fillCircle(x + ca * 0.6 * s, y + sa * 0.6 * s, 1 * s);
}
