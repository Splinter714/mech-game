// Slug — a heavy autocannon shell with a long tracer: dark shell body, a coloured core, and
// a white-hot tip. The default round when a kind isn't otherwise recognised.
// #421: the SHELL already carries a dark body (0x2a2d33) and reads on any biome. Its long
// TRACER did not — a 0.35-alpha bright line over snow/sand was nearly invisible, so the round
// lost the streak that tells you where it came from. A dark under-stroke fixes that without
// touching the bright pass on dark ground.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const tx = x - ca * 19 * s, ty = y - sa * 19 * s;
  g.lineStyle(3.8 * s, 0x14161a, 0.3); g.lineBetween(tx, ty, x, y);   // dark under-tracer
  g.lineStyle(2.9 * s, color, 0.35); g.lineBetween(tx, ty, x, y);
  g.fillStyle(0x2a2d33, 1);                       // dark shell body
  g.fillCircle(x - ca * 2.5 * s, y - sa * 2.5 * s, 3.8 * s); g.fillCircle(x, y, 4 * s);
  g.fillStyle(color, 0.95); g.fillCircle(x, y, 2.5 * s);
  g.fillStyle(0xffffff, 0.95); g.fillCircle(x + ca * 0.8 * s, y + sa * 0.8 * s, 1.3 * s);
}
