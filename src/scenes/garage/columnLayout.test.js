// #505 FOURTH rework: garageColumnLayout is the pure geometry behind GarageScene's per-column
// layout. Per Jackson's fresh correction — "the mech preview and ability layout... next to each
// other and then that whole bunch center aligned," the preview "square and taller, matching the
// height of the ability layout, which should be the same size as it is in arena" — the tile block
// is pinned to the arena's own CONSOLE_TILES size (not fit to the column), the preview is square
// and derives its size from that block's height, and the pair is centered as ONE unit.
import { describe, it, expect } from 'vitest';
import {
  garageColumnLayout, COLUMN_PAD, HEADER_H, TILE_SIZE, TILE_GAP, TILE_N,
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
    const blockBottom = h - COLUMN_PAD;
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

      // #505 fifth rework: the preview shrank to match just the WEAPON row's own height — the
      // ability row's counterpart on the preview's side is now the passive tile (below), not
      // extra preview height.
      it(`preview is SQUARE and matches the WEAPON ROW's height exactly, not the combined block (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        expect(gl.preview.w).toBe(gl.preview.h);
        expect(gl.preview.h).toBe(gl.tiles.weapons[0].h);
        const rows = [...gl.tiles.weapons, ...gl.tiles.abilities];
        const blockTop = Math.min(...rows.map((r) => r.y));
        const blockBottom = Math.max(...rows.map((r) => r.y + r.h));
        // Regression guard: the preview must be SHORTER than the full combined block now.
        expect(gl.preview.h).toBeLessThan(blockBottom - blockTop);
      });

      // #505 fifth rework: the new passive/core tile, stacked above the preview.
      it(`passive tile sits directly above the preview, matching its width and the ability row's height (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        expect(gl.passive.loc).toBe('core');
        expect(gl.passive.w).toBe(gl.preview.w);
        expect(gl.passive.h).toBe(gl.tiles.abilities[0].h);
        expect(gl.passive.x).toBe(gl.preview.cx - gl.preview.w / 2);
        expect(gl.passive.y).toBe(gl.tiles.abilities[0].y);
      });

      // The two side-by-side columns (passive+preview / ability+weapon) must stay in lockstep:
      // the passive tile's bottom sits exactly where the preview's top is anchored, mirroring the
      // ability row's own gap above the weapon row on the other side.
      it(`the passive/preview pair mirrors the ability/weapon row gap exactly (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        const abilityBottom = gl.tiles.abilities[0].y + gl.tiles.abilities[0].h;
        const weaponTop = gl.tiles.weapons[0].y;
        const passiveBottom = gl.passive.y + gl.passive.h;
        const previewTop = gl.preview.cy - gl.preview.h / 2;
        expect(passiveBottom).toBe(abilityBottom);
        expect(previewTop).toBe(weaponTop);
        expect(previewTop - passiveBottom).toBe(weaponTop - abilityBottom);
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

      it(`the catalog sits above the tile block/passive-tile row with a sane minimum height (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        expect(gl.catalog.h).toBeGreaterThanOrEqual(70);
        expect(gl.catalog.y).toBeGreaterThanOrEqual(HEADER_H);
        // The passive tile (not the now-lower preview) is the true topmost element on the
        // preview's side of the pair — it shares its y with the ability row, the topmost element
        // overall — so the catalog must clear IT, not the preview.
        expect(gl.catalog.y + gl.catalog.h).toBeLessThanOrEqual(gl.passive.y + 1);
      });

      // #505 sixth rework (playtest): the old footer reserve left dead space below the panel that
      // a scrolled-out (masked but still input-live) catalog card could still catch a click in —
      // `panel` is the bounding box GarageScene's click-blocker/top-border are sized to, and it
      // must be flush with the column's own bottom padding, no leftover gap beneath it.
      it(`panel spans the full inner width (same x/w as the catalog) and sits flush with the column's bottom padding (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        expect(gl.panel.x).toBe(gl.catalog.x);
        expect(gl.panel.w).toBe(gl.catalog.w);
        expect(gl.panel.y).toBe(gl.passive.y);
        expect(gl.panel.y + gl.panel.h).toBe(h - COLUMN_PAD);
        // The weapon row (and so the preview, which matches its height) sits flush with the
        // panel's own bottom edge — nothing is reserved below either of them.
        expect(gl.tiles.weapons[0].y + gl.tiles.weapons[0].h).toBe(gl.panel.y + gl.panel.h);
      });

      // #528: GarageScene paints an invisible interactive rect over gl.panel to stop clicks on
      // the loadout row (preview + tiles, including the gaps between them) from falling through
      // to a WeaponCardList catalog card positioned underneath. That rect is only a real fix if
      // this box actually spans the FULL band the preview/tiles occupy — no gaps at the edges.
      it(`panel spans the full width and exactly the tile block/passive+preview's own y-range, no gaps (w=${w}, h=${h})`, () => {
        const gl = garageColumnLayout(w, h);
        const previewBottom = gl.preview.cy + gl.preview.h / 2;
        const rows = [...gl.tiles.weapons, ...gl.tiles.abilities];
        const blockTop = Math.min(...rows.map((r) => r.y));
        const blockBottom = Math.max(...rows.map((r) => r.y + r.h));
        // The passive tile (above the preview) shares the topmost row's own y — NOT the preview's
        // own top, since the preview only matches the weapon row's height/position (#505 fifth
        // rework). Panel top is that shared topmost edge; panel bottom matches both the tile
        // block's own bottom and the (equal-height) preview's own bottom.
        expect(gl.panel.y).toBeCloseTo(blockTop, 0);
        expect(gl.panel.y).toBeCloseTo(gl.passive.y, 0);
        expect(gl.panel.y + gl.panel.h).toBeCloseTo(blockBottom, 0);
        expect(gl.panel.y + gl.panel.h).toBeCloseTo(previewBottom, 0);
        // Full inner width, at the column's own pad — matching (a superset of) the catalog's own
        // x/w, so nothing a catalog card could occupy sits outside this blocker.
        expect(gl.panel.x).toBe(COLUMN_PAD);
        expect(gl.panel.w).toBe(gl.innerW);
        expect(gl.catalog.x).toBeGreaterThanOrEqual(gl.panel.x);
        expect(gl.catalog.x + gl.catalog.w).toBeLessThanOrEqual(gl.panel.x + gl.panel.w);
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
