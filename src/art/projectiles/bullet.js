// Bullet — a machine-gun round / shotgun pellet: a short tracer streak into a hot tip.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const tx = x - ca * 6 * s, ty = y - sa * 6 * s;
  g.lineStyle(1.5 * s, color, 0.45); g.lineBetween(tx, ty, x, y);
  g.fillStyle(0xfff0c4, 1); g.fillCircle(x, y, 1.6 * s);
}
