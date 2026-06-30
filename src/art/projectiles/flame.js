// Flame — a tapered, flickering tongue of fire (flamethrower stream particle). Elongated
// along the direction of travel, flickers in size/opacity with phase, and cools from a
// white-hot core through orange to a fading red edge as phase advances.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const flicker = 0.65 + 0.35 * Math.sin(phase * 0.6);
  const cool = 0.5 + 0.5 * Math.sin(phase * 0.4 + 1.7);   // 0 (hot) .. 1 (cool), drifts independently
  const len = (7 + 5 * flicker) * s;
  const wid = (2.6 + 1.4 * flicker) * s;
  const tx = x - ca * len, ty = y - sa * len;

  // Outer tongue: cools from orange toward red/transparent at the tail.
  const outer = cool > 0.5 ? 0xb33a12 : 0xff7a18;
  g.fillStyle(outer, 0.45 * flicker * (1 - 0.3 * cool));
  g.beginPath();
  g.moveTo(x + sa * wid, y - ca * wid);
  g.lineTo(x - sa * wid, y + ca * wid);
  g.lineTo(tx, ty);
  g.closePath();
  g.fillPath();

  // Mid body: orange-gold, denser near the nozzle.
  const midLen = len * 0.6, midWid = wid * 0.6;
  g.fillStyle(0xffae3d, 0.75 * flicker);
  g.beginPath();
  g.moveTo(x + sa * midWid, y - ca * midWid);
  g.lineTo(x - sa * midWid, y + ca * midWid);
  g.lineTo(x - ca * midLen, y - sa * midLen);
  g.closePath();
  g.fillPath();

  // Hot core: whiter at the hottest phase, shrinking and fading as it cools.
  const coreColor = cool < 0.35 ? 0xfff6e0 : 0xffd56b;
  g.fillStyle(coreColor, 0.95 * (1 - 0.4 * cool));
  g.fillCircle(x, y, (1.6 + 0.8 * flicker) * s * (1 - 0.25 * cool));
}
