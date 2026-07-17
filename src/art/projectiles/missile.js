// Missile — a dark gunmetal warhead nosing forward, trailing a pink-hot exhaust flame off
// the tail (the flame reuses the missile category's pink accent, reframed as fire instead of
// a glowing nose). `phase` flickers the flame like the flamethrower stream (see flame.js).
export function draw(g, x, y, ca, sa, color, s, phase) {
  const flicker = 0.7 + 0.3 * Math.sin(phase * 0.6);
  const tailX = x - ca * 5 * s, tailY = y - sa * 5 * s;
  const flameLen = (7 + 4 * flicker) * s;
  const flameWid = 2 * s;
  const flameTipX = tailX - ca * flameLen, flameTipY = tailY - sa * flameLen;

  // Exhaust flame streaming back from the tail — pink accent, flickering.
  g.fillStyle(color, 0.55 * flicker);
  g.beginPath();
  g.moveTo(tailX + sa * flameWid, tailY - ca * flameWid);
  g.lineTo(tailX - sa * flameWid, tailY + ca * flameWid);
  g.lineTo(flameTipX, flameTipY);
  g.closePath();
  g.fillPath();
  // Hot near-white-pink core at the base of the flame.
  g.fillStyle(0xffd0e6, 0.85 * flicker);
  g.fillCircle(tailX - ca * 1.6 * s, tailY - sa * 1.6 * s, 1 * s * flicker);

  // Gunmetal warhead body, nose forward: dark blue-grey body with a darker nose tip.
  g.fillStyle(0x454c56, 1); g.fillCircle(x - ca * 1.4 * s, y - sa * 1.4 * s, 2.6 * s);
  g.fillStyle(0x262a30, 1); g.fillCircle(x, y, 2 * s);
}
