// Bullet — a machine-gun round / shotgun pellet: a short tracer streak into a hot tip.
// #421 legibility: the hot tip (0xfff0c4) all but vanished on light ground (snow 0xd9e6ef,
// sand 0xbf9c5e). A dark contrast disc drawn UNDER the tip, plus a dark under-stroke beneath
// the tracer, carries the round on light terrain without changing its bright read on dark.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const tx = x - ca * 6 * s, ty = y - sa * 6 * s;
  g.lineStyle(2.4 * s, 0x14161a, 0.5); g.lineBetween(tx, ty, x, y);   // dark under-tracer
  g.lineStyle(1.5 * s, color, 0.45); g.lineBetween(tx, ty, x, y);
  g.fillStyle(0x14161a, 0.9); g.fillCircle(x, y, 2.7 * s);            // dark contrast disc
  g.fillStyle(0xfff0c4, 1); g.fillCircle(x, y, 1.6 * s);
}
