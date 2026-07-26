// Caustic Lobber canister — reskinned (#492 playtest) into a dark, swirling shadow-magic
// orb: a hazy violet-black core wrapped in curling wisps of purple mist that corkscrew
// slowly around it as it drifts. Always dark purple regardless of the passed-in category
// color — like `fire.js` before it, this kind ignores `color` on purpose so the orb reads
// as shadow-magic rather than the ballistic-row orange. `phase` (the round's travelled
// distance) drives the wisp rotation and a slow pulsing glow.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const pulse = 0.7 + 0.3 * Math.sin(phase * 0.4);
  const r = 4.2 * s;

  // Soft outer haze — a faint bloom the wisps swirl through.
  g.fillStyle(0x2a0a3d, 0.32 * pulse); g.fillCircle(x, y, r * 1.7);

  // Three curling wisps, corkscrewing around the core as phase advances — reads as swirling
  // smoke rather than a trail streaming straight back.
  const swirl = phase * 0.22;
  for (let i = 0; i < 3; i++) {
    const a = swirl + (i * Math.PI * 2) / 3;
    const wr = r * (1.15 + 0.15 * Math.sin(phase * 0.3 + i));
    const wx = x + Math.cos(a) * wr, wy = y + Math.sin(a) * wr;
    g.fillStyle(0x8b3fc9, 0.5 * pulse);
    g.fillCircle(wx, wy, 1.4 * s);
    g.fillStyle(0x5c1f8a, 0.35 * pulse);
    g.fillCircle(wx - Math.cos(a) * 1.5 * s, wy - Math.sin(a) * 1.5 * s, 1 * s);
  }

  // Dark violet core, near-black at the centre.
  g.fillStyle(0x1a0626, 1); g.fillCircle(x, y, r);
  g.fillStyle(0x3d1259, 0.9); g.fillCircle(x, y, r * 0.7);

  // Bright violet eye — the one hot spot the orb reads by.
  g.fillStyle(0xb060e0, 0.95 * pulse); g.fillCircle(x, y, 1.1 * s);
}
