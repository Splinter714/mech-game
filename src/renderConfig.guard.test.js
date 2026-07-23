// #455: the mech's arms/side torsos jostled against the body whenever the turret slewed. Root
// cause was the RENDER CONFIG, not the art or the animation: `pixelArt: true` is a Phaser
// shorthand that also forces `roundPixels: true`, and with rounding on the renderer floors each
// TEXTURED game object's own x/y — for a container child, its LOCAL offset. A mech view is six
// sprites in one container; the four pivoting parts sit at local offsets that sweep continuously
// with the turret angle, so each one crossed its integer boundary at a different angle and popped
// a whole world pixel against a body that had not moved.
//
// main.js builds a live Phaser.Game at import time, so — same technique as the other *.guard
// tests here — this reads the source text rather than instantiating the game.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(DIR, 'main.js'), 'utf8');

describe('#455 render config: no per-object pixel snapping', () => {
  it('never sets `pixelArt` — the shorthand re-enables roundPixels and ignores an explicit false', () => {
    expect(main).not.toMatch(/^\s*pixelArt:\s*true/m);
  });

  it('turns roundPixels OFF explicitly, so stacked mech parts stay sub-pixel aligned', () => {
    expect(main).toMatch(/^\s*roundPixels:\s*false,/m);
  });

  it('keeps nearest-neighbour texture filtering — the half of pixelArt the art actually wanted', () => {
    expect(main).toMatch(/^\s*antialias:\s*false,/m);
    expect(main).toMatch(/^\s*antialiasGL:\s*false,/m);
  });
});
