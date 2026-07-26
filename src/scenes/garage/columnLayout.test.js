// #505 FOURTH rework: garageColumnLayout is the pure geometry behind GarageScene's per-column
// layout. Per Jackson's fresh correction — "the mech preview and ability layout... next to each
// other and then that whole bunch center aligned," the preview "square and taller, matching the
// height of the ability layout, which should be the same size as it is in arena" — the tile block
// is pinned to the arena's own CONSOLE_TILES size (not fit to the column), the preview is square
// and derives its size from that block's height, and the pair is centered as ONE unit.
import { describe, it, expect } from 'vitest';
import {
  garageColumnLayout, COLUMN_PAD, HEADER_H, FOOTER_H, GAP, TILE_SIZE, TILE_GAP, TILE_N,
  LABEL_BOTTOM_INSET,
} from './columnLayout.js';
import { weaponAbilityRows, TILE_ORDER, HUD_ABILITY_ORDER } from '../../ui/skillTiles.js';
import { CONSOLE_TILES, tileRowWidth } from '../../data/hudLayout.js';

// Representative column widths: solo (full-width), 2-player, 4-player, and a very cramped one.
const WIDTHS = [1260, 630, 300, 220];
const HEIGHTS = [900, 700, 500];

describe('garageColumnLayout (#505)', () => {
  it('pins the tile size/gap/count to the arena\'s own CONSOLE_TILES dial', () => {
    expect(TILE_SIZE).toBe(CONSOLE_TILES.max);
    expect(TILE_GAP).toBe(CONSOLE_TILES.gap);
    expect(TILE_N).toBe(CONSOLE_TILES.n);
  });

  it('reuses the REAL shared weaponAbilityRows layout for the tile block, not a reimplementation', () => {
    const w = 630, h = 700;
    const gl = garageColumnLayout(w, h);
    const tileBlockW = tileRowWidth(TILE_SIZE, TILE_N, TILE_GAP);
    const blockBottom = h - COLUMN_PAD - FOOTER_H - GAP;
    // Same block width/bottom/maxSize regardless of x — cross-check the actual rects at the
    // layout's own tileAreaX by re-deriving it the same way the module does.
    const previewSize = gl.preview.h;
    const pairW = previewSize + 10 + tileBlockW;
    const pairX = COLUMN_PAD + (gl.innerW - pairW) / 2;
    const tileAreaX = pairX + previewSize + 10;
    const expected = weaponAbilityRows(tileAreaX, tileBlockW, { bottom: blockBottom, maxSize: TILE_SIZE });
    expect(gl.tiles.weapons).toEqual(expected.weapons);
    expect(gl.tiles.abilities).toEqual(expected.abilities);
  });

  it('returns the 4 weapon slots (TILE_ORDER) and 2 ability slots (HUD_ABILITY_ORDER) every time', () => {
    for (const w of WIDTHS) {
      const gl = garageColumnLayout(w, 700);
      expect(gl.tiles.weapons.map((t) => t.loc)).toEqual(TILE_ORDER);
      expect(gl.tiles.abilities.map((t) => t.loc)).toEqual(HUD_ABILITY_ORDER);
    }
  });

  for (const w of WIDTHS) {
    for (const h of HEIGHTS) {
      it(`tile block always renders at the arena's full tile size, never scaled to the column (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        for (const t of gl.tiles.weapons) expect(t.w).toBe(TILE_SIZE);
        expect(gl.tiles.abilities[0].h).toBe(Math.round(TILE_SIZE / 2));
      });

      it(`preview is SQUARE and matches the tile block's height exactly (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        expect(gl.preview.w).toBe(gl.preview.h);
        const rows = [...gl.tiles.weapons, ...gl.tiles.abilities];
        const blockTop = Math.min(...rows.map((r) => r.y));
        const blockBottom = Math.max(...rows.map((r) => r.y + r.h));
        expect(gl.preview.h).toBeCloseTo(blockBottom - blockTop, 0);
      });

      it(`preview sits fully to the LEFT of the tile block, no overlap (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        const leftmostTileX = Math.min(...[...gl.tiles.weapons, ...gl.tiles.abilities].map((r) => r.x));
        expect(gl.preview.cx + gl.preview.w / 2).toBeLessThanOrEqual(leftmostTileX);
      });

      it(`the preview+tiles pair is centered as one unit within the column's inner width (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        const rightmostTileX = Math.max(...[...gl.tiles.weapons, ...gl.tiles.abilities].map((r) => r.x + r.w));
        const leftEdge = gl.preview.cx - gl.preview.w / 2;
        const pairLeftGap = leftEdge - COLUMN_PAD;
        const pairRightGap = (COLUMN_PAD + gl.innerW) - rightmostTileX;
        // Centered means equal breathing room on both sides of the pair — allow for rounding.
        expect(Math.abs(pairLeftGap - pairRightGap)).toBeLessThanOrEqual(2);
      });

      // #505 playtest follow-up: the player-number label moved from just below the preview box to
      // INSIDE it, anchored near its bottom edge.
      it(`the player label is centered horizontally on the preview and anchored INSIDE it, near the bottom (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        const previewTop = gl.preview.cy - gl.preview.h / 2;
        const previewBottom = gl.preview.cy + gl.preview.h / 2;
        expect(gl.label.cx).toBe(gl.preview.cx);
        // Inside the box vertically...
        expect(gl.label.y).toBeGreaterThan(previewTop);
        expect(gl.label.y).toBeLessThan(previewBottom);
        // ...and specifically in the bottom portion of it, not centered or near the top.
        expect(gl.label.y).toBeGreaterThan(gl.preview.cy);
        // Exactly the configured inset up from the box's own bottom edge.
        expect(gl.label.y).toBe(previewBottom - LABEL_BOTTOM_INSET);
      });

      it(`the catalog sits above the tile block/preview row with a sane minimum height (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        expect(gl.catalog.h).toBeGreaterThanOrEqual(70);
        expect(gl.catalog.y).toBeGreaterThanOrEqual(HEADER_H);
        expect(gl.catalog.y + gl.catalog.h).toBeLessThanOrEqual(gl.preview.cy - gl.preview.h / 2 + 1);
      });
    }
  }

  it('at a wide/solo column, the pair fits fully within bounds with room to spare', () => {
    const gl = garageColumnLayout(1260, 900);
    expect(gl.preview.cx - gl.preview.w / 2).toBeGreaterThanOrEqual(0);
    for (const r of [...gl.tiles.weapons, ...gl.tiles.abilities]) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1260);
    }
  });

  it('at a narrow (4-player-scale) column, the fixed-size pair can overflow the column bounds — this is EXPECTED, not a bug: tiles stay full arena size rather than shrinking to fit', () => {
    const gl = garageColumnLayout(300, 700);
    const previewLeft = gl.preview.cx - gl.preview.w / 2;
    const rightmostTileX = Math.max(...[...gl.tiles.weapons, ...gl.tiles.abilities].map((r) => r.x + r.w));
    const pairW = (rightmostTileX - previewLeft);
    // The pair's fixed width exceeds a narrow column's inner width — documenting the overflow
    // this rework accepts rather than silently clipping/shrinking it.
    expect(pairW).toBeGreaterThan(gl.innerW);
    expect(previewLeft).toBeLessThan(0);
  });
});
