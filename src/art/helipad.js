// Helipad ground marking (#251) — cosmetic set-dressing that reads as "a helicopter launches
// from here": a round tarmac pad, a painted border ring, perimeter threshold lights, and a big
// "H" landing mark. Purely a ground decal — no terrain/gameplay properties (it doesn't gate or
// alter spawning), drawn as an ordinary Phaser sprite dropped at a helicopter's actual spawn
// point (scenes/arena/enemies.js `_spawnKind`) rather than a new hex-grid terrain type, since it
// needs to sit at an arbitrary pixel point (dynamic off-screen spawn placement), not a fixed hex.
// Built once at boot (art/index.js `buildBaseTextures`), same as the hex tile textures.
import { gen, scaledGraphics, ART_SCALE } from './_frames.js';

export const HELIPAD_KEY = 'helipad_pad';

const R = 46;                       // design-unit pad radius
const SIZE = Math.ceil(R * 2 + 10); // texture footprint with a little breathing room

function drawHelipad(sg) {
  const cx = SIZE / 2, cy = SIZE / 2;
  // Soft ground shadow so the pad reads as sitting ON the terrain, not floating over it.
  sg.fillStyle(0x000000, 0.32);
  sg.fillEllipse(cx + 2, cy + 4, R * 2.05, R * 1.55);

  // Base tarmac disc + a darker outline ring (same "outer fill, inner fill" ring trick hexArt.js
  // uses for hex borders — scaledGraphics has no stroked-circle primitive).
  sg.fillStyle(0x14171c, 1);
  sg.fillCircle(cx, cy, R);
  sg.fillStyle(0x272b32, 1);
  sg.fillCircle(cx, cy, R * 0.93);

  // Painted ring marking (a thinner circle near the pad's edge — reads as the classic
  // heliport painted-circle boundary).
  sg.fillStyle(0xd8b23a, 0.9);
  sg.fillCircle(cx, cy, R * 0.86);
  sg.fillStyle(0x272b32, 1);
  sg.fillCircle(cx, cy, R * 0.8);

  // Perimeter threshold lights — small bright studs evenly spaced around the ring.
  const lightCount = 10;
  for (let i = 0; i < lightCount; i++) {
    const a = (i / lightCount) * Math.PI * 2;
    const lx = cx + Math.cos(a) * R * 0.9, ly = cy + Math.sin(a) * R * 0.9;
    sg.fillStyle(0xffe08a, 0.95);
    sg.fillCircle(lx, ly, 1.6);
  }

  // Big "H" landing mark, centred — two vertical bars + a crossbar.
  const hw = R * 0.32, hh = R * 0.56, barW = R * 0.14;
  sg.fillStyle(0xe8d9a0, 0.95);
  sg.fillRect(cx - hw, cy - hh, barW, hh * 2);
  sg.fillRect(cx + hw - barW, cy - hh, barW, hh * 2);
  sg.fillRect(cx - hw, cy - barW / 2, hw * 2, barW);
}

export function buildHelipadTexture(scene) {
  gen(scene, HELIPAD_KEY, SIZE * ART_SCALE, SIZE * ART_SCALE, (g) => drawHelipad(scaledGraphics(g)));
}
