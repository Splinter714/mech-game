// Plasma round — a lobbed glob of molten energy: a soft pulsing corona, a teardrop body
// trailing back along travel, a white-hot core, and a couple of shed sparks. `phase` (the
// round's distance) drives the flicker and the wobble of the cast-off droplets.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const f = 0.75 + 0.25 * Math.sin(phase * 0.5);
  // Hot wake streaming back from the glob.
  g.fillStyle(color, 0.18 * f); g.fillCircle(x - ca * 3.5 * s, y - sa * 3.5 * s, 3.8 * s);
  g.fillStyle(color, 0.30 * f); g.fillCircle(x, y, 5 * s);
  // Teardrop: round front, tapered tail (drawn as two overlapping circles).
  g.fillStyle(color, 0.92); g.fillCircle(x, y, 2.4 * s);
  g.fillStyle(color, 0.7); g.fillCircle(x - ca * 2 * s, y - sa * 2 * s, 1.5 * s);
  g.fillStyle(0xffffff, 0.95); g.fillCircle(x + ca * 0.4 * s, y + sa * 0.4 * s, 1 * s);
  // Shed droplets wobbling off to the sides.
  const wob = Math.sin(phase * 0.7) * 1.6 * s;
  g.fillStyle(color, 0.55 * f);
  g.fillCircle(x - ca * 4 * s - sa * wob, y - sa * 4 * s + ca * wob, 0.8 * s);
}
