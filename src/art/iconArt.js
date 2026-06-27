// Small procedural icons for weapon categories, used in the garage catalog. Each is a
// 16-design-px glyph tinted with its category colour so the player can read the
// catalog at a glance. Keys are `icon_<categoryId>`.

import { gen, scaledGraphics, ART_SCALE } from './_frames.js';
import { CATEGORIES } from '../data/categories.js';

const SIZE = 16;

const GLYPHS = {
  // A short slug for ballistic.
  ballistic: (sg, c) => { sg.fillStyle(c, 1); sg.fillRect(6, 3, 4, 10); sg.fillRect(5, 12, 6, 2); },
  // A missile with fins.
  missile: (sg, c) => {
    sg.fillStyle(c, 1); sg.fillRect(6, 3, 4, 8);
    sg.fillTriangle(8, 0, 6, 3, 10, 3);
    sg.fillRect(4, 9, 2, 4); sg.fillRect(10, 9, 2, 4);
  },
  // A beam.
  energy: (sg, c) => { sg.fillStyle(c, 1); sg.fillRect(7, 1, 2, 14); sg.fillRect(4, 6, 8, 2); },
  // A blade.
  melee: (sg, c) => { sg.fillStyle(c, 1); sg.fillTriangle(8, 1, 5, 11, 11, 11); sg.fillRect(6, 11, 4, 3); },
  // A small dish for support.
  support: (sg, c) => { sg.fillStyle(c, 1); sg.fillCircle(8, 8, 5); sg.fillStyle(0x0d1014, 1); sg.fillCircle(8, 8, 2.5); },
};

export function buildIconTextures(scene) {
  for (const id of Object.keys(CATEGORIES)) {
    const color = CATEGORIES[id].color;
    const glyph = GLYPHS[id];
    gen(scene, `icon_${id}`, SIZE * ART_SCALE, SIZE * ART_SCALE, (g) => glyph(scaledGraphics(g), color));
  }
}
