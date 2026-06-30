// Slug — a heavy autocannon shell with a long tracer: dark shell body, a coloured core, and
// a white-hot tip. The default round when a kind isn't otherwise recognised.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const tx = x - ca * 22 * s, ty = y - sa * 22 * s;
  g.lineStyle(3.4 * s, color, 0.35); g.lineBetween(tx, ty, x, y);
  g.fillStyle(0x2a2d33, 1);                       // dark shell body
  g.fillCircle(x - ca * 3 * s, y - sa * 3 * s, 4.6 * s); g.fillCircle(x, y, 5 * s);
  g.fillStyle(color, 0.95); g.fillCircle(x, y, 3.1 * s);
  g.fillStyle(0xffffff, 0.95); g.fillCircle(x + ca * 1 * s, y + sa * 1 * s, 1.6 * s);
}
