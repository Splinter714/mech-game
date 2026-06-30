// Napalm canister — a dark steel fuel drum seen from above: near-black steel body, a
// brushed-steel rim, a hazard ring, and a glowing fuel cap at the centre. `phase` flickers
// the heat. Read against dark ground by a subtle rim highlight, not a bright body.
export function draw(g, x, y, ca, sa, color, s, phase) {
  const fl = 0.7 + 0.3 * Math.sin(phase * 0.5);
  const r = 3.8 * s;
  // Dark steel drum, read against dark ground by a subtle rim highlight rather than a
  // bright body.
  g.fillStyle(0x24282e, 1); g.fillCircle(x, y, r);
  g.fillStyle(0x16181c, 1); g.fillCircle(x, y, r * 0.82);
  g.lineStyle(0.8 * s, 0x4c545d, 0.85); g.strokeCircle(x, y, r * 0.9);
  // Small but BRIGHT fuel cap — the only orange, kept punchy.
  g.fillStyle(0xff8a1f, 0.95 * fl); g.fillCircle(x, y, 1.1 * s);
  g.fillStyle(0xffe39a, 1); g.fillCircle(x, y, 0.5 * s);
}
