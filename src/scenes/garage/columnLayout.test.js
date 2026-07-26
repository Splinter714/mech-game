// #505 THIRD rework: garageColumnLayout is the pure geometry behind GarageScene's per-column
// layout — the mech preview positioned LEFT of, and the SAME HEIGHT as, the loadout tile block,
// with the player label sitting below the preview. See the module's own header comment for why
// the tile block itself is computed by the real shared skillTiles.js `weaponAbilityRows` rather
// than reimplemented here.
import { describe, it, expect } from 'vitest';
import { garageColumnLayout, COLUMN_PAD, HEADER_H, FOOTER_H, GAP } from './columnLayout.js';
import { weaponAbilityRows, TILE_ORDER, HUD_ABILITY_ORDER } from '../../ui/skillTiles.js';

// Representative column widths: solo (full-width), 2-player, 4-player, and a very cramped one.
const WIDTHS = [1260, 630, 300, 220];
const HEIGHTS = [900, 700, 500];

describe('garageColumnLayout (#505)', () => {
  it('reuses the REAL shared weaponAbilityRows layout for the tile block, not a reimplementation', () => {
    const w = 630, h = 700;
    const gl = garageColumnLayout(w, h);
    // Cross-check against calling weaponAbilityRows directly with the same derived tile-area
    // geometry — if this module ever starts computing tile rects itself instead of delegating,
    // this stops matching.
    const innerW = w - COLUMN_PAD * 2;
    const previewW = Math.round(innerW * 0.38);
    const tileAreaX = COLUMN_PAD + previewW + 10;
    const tileAreaW = innerW - previewW - 10;
    const blockBottom = h - COLUMN_PAD - FOOTER_H - GAP;
    const expected = weaponAbilityRows(tileAreaX, tileAreaW, { bottom: blockBottom, maxSize: 60 });
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
      it(`preview matches the tile block's height exactly (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
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

      it(`the player label is centered under the preview and sits below it (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        expect(gl.label.cx).toBe(gl.preview.cx);
        expect(gl.label.y).toBeGreaterThanOrEqual(gl.preview.cy + gl.preview.h / 2);
      });

      it(`the catalog sits above the tile block/preview row with a sane minimum height (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        expect(gl.catalog.h).toBeGreaterThanOrEqual(70);
        expect(gl.catalog.y).toBeGreaterThanOrEqual(HEADER_H);
        expect(gl.catalog.y + gl.catalog.h).toBeLessThanOrEqual(gl.preview.cy - gl.preview.h / 2 + 1);
      });

      it(`every rect stays within the column's own bounds (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        expect(gl.preview.cx - gl.preview.w / 2).toBeGreaterThanOrEqual(0);
        for (const r of [...gl.tiles.weapons, ...gl.tiles.abilities]) {
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(w + 1);
        }
      });
    }
  }
});
