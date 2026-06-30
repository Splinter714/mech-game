// Missile — a small warhead with a glowing exhaust trail streaming back along travel.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const bx = x - ca * 7 * s, by = y - sa * 7 * s;
  g.lineStyle(3 * s, 0xffb347, 0.5); g.lineBetween(bx, by, x - ca * 14 * s, y - sa * 14 * s);
  g.fillStyle(color, 1); g.fillCircle(x, y, 2.4 * s);
}
