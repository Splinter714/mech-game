// Missile — a dark gunmetal warhead nosing forward, trailing a pink-hot exhaust flame off
// the tail (the flame reuses the missile category's pink accent, reframed as fire instead of
// a glowing nose). `phase` flickers the flame like the flamethrower stream (see flame.js).
export function draw(g, x, y, ca, sa, color, s, phase) {
  const flicker = 0.7 + 0.3 * Math.sin(phase * 0.6);
  const tailX = x - ca * 6.4 * s, tailY = y - sa * 6.4 * s;
  const flameLen = (7 + 4 * flicker) * s;
  const flameWid = 2 * s;
  const flameTipX = tailX - ca * flameLen, flameTipY = tailY - sa * flameLen;

  // Exhaust flame streaming back from the tail — pink accent, flickering, pushed bright.
  g.fillStyle(color, 0.9 * flicker);
  g.beginPath();
  g.moveTo(tailX + sa * flameWid, tailY - ca * flameWid);
  g.lineTo(tailX - sa * flameWid, tailY + ca * flameWid);
  g.lineTo(flameTipX, flameTipY);
  g.closePath();
  g.fillPath();
  // Inner tongue: brighter hot-pink, denser near the tail, before the white-hot core.
  const midLen = flameLen * 0.55, midWid = flameWid * 0.55;
  g.fillStyle(0xff8ac2, 0.9 * flicker);
  g.beginPath();
  g.moveTo(tailX + sa * midWid, tailY - ca * midWid);
  g.lineTo(tailX - sa * midWid, tailY + ca * midWid);
  g.lineTo(tailX - ca * midLen, tailY - sa * midLen);
  g.closePath();
  g.fillPath();
  // Hot near-white-pink core at the base of the flame.
  g.fillStyle(0xffd0e6, 1);
  g.fillCircle(tailX - ca * 1.6 * s, tailY - sa * 1.6 * s, 1.3 * s * flicker);

  // Gunmetal warhead body, nose forward: a long, thin shaft ending in a pointed cone
  // (not stacked circles — that read as too thick/round). Dark blue-grey shaft with a
  // darker pointed nose tip.
  const noseTipX = x + ca * 2 * s, noseTipY = y + sa * 2 * s;
  const noseBaseX = x - ca * 1 * s, noseBaseY = y - sa * 1 * s;
  const shaftBackX = x - ca * 6 * s, shaftBackY = y - sa * 6 * s;
  const halfW = 1 * s;
  // Thin rectangular shaft body, from the base of the nose cone back near the fins/flame.
  g.fillStyle(0x454c56, 1);
  g.beginPath();
  g.moveTo(noseBaseX + sa * halfW, noseBaseY - ca * halfW);
  g.lineTo(shaftBackX + sa * halfW, shaftBackY - ca * halfW);
  g.lineTo(shaftBackX - sa * halfW, shaftBackY + ca * halfW);
  g.lineTo(noseBaseX - sa * halfW, noseBaseY + ca * halfW);
  g.closePath();
  g.fillPath();
  // Pointed nose cone, darker, tapering to an actual tip rather than a rounded blob.
  g.fillStyle(0x262a30, 1);
  g.beginPath();
  g.moveTo(noseTipX, noseTipY);
  g.lineTo(noseBaseX + sa * halfW, noseBaseY - ca * halfW);
  g.lineTo(noseBaseX - sa * halfW, noseBaseY + ca * halfW);
  g.closePath();
  g.fillPath();

  // Small tail fins, one each side, where the body meets the exhaust.
  const finX = x - ca * 5 * s, finY = y - sa * 5 * s;
  const finSpan = 1.8 * s, finBack = 2.2 * s;
  g.fillStyle(0x454c56, 1);
  g.beginPath();
  g.moveTo(finX + sa * 0.4 * s, finY - ca * 0.4 * s);
  g.lineTo(finX + sa * finSpan, finY - ca * finSpan);
  g.lineTo(finX - ca * finBack + sa * 0.6 * s, finY - sa * finBack - ca * 0.6 * s);
  g.closePath();
  g.fillPath();
  g.beginPath();
  g.moveTo(finX - sa * 0.4 * s, finY + ca * 0.4 * s);
  g.lineTo(finX - sa * finSpan, finY + ca * finSpan);
  g.lineTo(finX - ca * finBack - sa * 0.6 * s, finY - sa * finBack + ca * 0.6 * s);
  g.closePath();
  g.fillPath();
}
