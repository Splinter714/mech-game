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
  // A small dish for support.
  support: (sg, c) => { sg.fillStyle(c, 1); sg.fillCircle(8, 8, 5); sg.fillStyle(0x0d1014, 1); sg.fillCircle(8, 8, 2.5); },
  // #618: a loose cluster of blobs — the plasma family (Caustic Lobber, Plasma Coater/Cannon/
  // Lance) reads as globs/bolts rather than a clean beam, so the glyph is irregular circles
  // instead of a straight shape.
  plasma: (sg, c) => {
    sg.fillStyle(c, 1);
    sg.fillCircle(8, 7, 4.2); sg.fillCircle(4.5, 10.5, 2.4); sg.fillCircle(11.5, 10, 2.6);
  },
  // #618: a simple flame silhouette — Napalm Lobber/Flamethrower.
  fire: (sg, c) => {
    sg.fillStyle(c, 1);
    sg.fillTriangle(8, 1, 3.5, 13, 12.5, 13);
    sg.fillStyle(0x0d1014, 1);
    sg.fillTriangle(8, 6, 5.5, 13, 10.5, 13);
  },
  // #622: a jagged bolt — Chain Bolt/Tesla Pylons. CRITICAL (per #618's postmortem): every
  // category MUST have a glyph here — GLYPHS is iterated unconditionally at boot with no
  // fallback, so a missing entry crashes the game instantly.
  lightning: (sg, c) => {
    sg.fillStyle(c, 1);
    sg.fillTriangle(9, 1, 4, 9, 8, 9);
    sg.fillTriangle(8, 9, 12, 9, 7, 15);
  },
};

export function buildIconTextures(scene) {
  for (const id of Object.keys(CATEGORIES)) {
    const color = CATEGORIES[id].color;
    const glyph = GLYPHS[id];
    gen(scene, `icon_${id}`, SIZE * ART_SCALE, SIZE * ART_SCALE, (g) => glyph(scaledGraphics(g), color));
  }
}
