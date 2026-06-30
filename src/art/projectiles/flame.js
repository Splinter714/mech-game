// Flame — a soft, flickering ember bloom (flamethrower stream particle).
export function draw(g, x, y, ca, sa, color, s, phase) {
  const f = 0.7 + 0.3 * Math.sin(phase * 0.4);
  g.fillStyle(0xff7a18, 0.4 * f); g.fillCircle(x, y, 6 * s);
  g.fillStyle(0xffd56b, 0.9 * f); g.fillCircle(x, y, 2.6 * s);
}
