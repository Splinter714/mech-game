import { describe, it, expect } from 'vitest';
import { luminanceGrey, silhouetteBoundary, dilateMask, cloakEdgeMask } from './desaturate.js';

describe('luminanceGrey (#500 follow-up: genuine per-pixel desaturation for Cloak)', () => {
  it('is a no-op on already-neutral pixels (black/white/mid-grey)', () => {
    expect(luminanceGrey(0, 0, 0)).toBe(0);
    expect(luminanceGrey(255, 255, 255)).toBe(255);
    expect(luminanceGrey(128, 128, 128)).toBe(128);
  });

  it('uses Rec. 601 luma weights (green weighted heaviest, blue lightest)', () => {
    expect(luminanceGrey(255, 0, 0)).toBe(76);   // 0.299 * 255
    expect(luminanceGrey(0, 255, 0)).toBe(150);  // 0.587 * 255
    expect(luminanceGrey(0, 0, 255)).toBe(29);   // 0.114 * 255
  });

  it('a saturated colour and a flat grey of the SAME luminance collapse to the identical output', () => {
    // This is the actual bug a Phaser sprite tint cannot fix: a multiply-tint preserves the
    // difference between a saturated colour and a grey of equal brightness (both just get
    // scaled by the same factor); this per-pixel formula erases it, because collapsing R/G/B to
    // one shared value is what "removing colour" actually means.
    const saturatedRedGrey = luminanceGrey(255, 0, 0);
    expect(luminanceGrey(saturatedRedGrey, saturatedRedGrey, saturatedRedGrey)).toBe(saturatedRedGrey);
  });

  it('rounds to the nearest integer and never leaves the 0-255 byte range', () => {
    expect(luminanceGrey(10, 20, 30)).toBe(Math.round(0.299 * 10 + 0.587 * 20 + 0.114 * 30));
    expect(Number.isInteger(luminanceGrey(123, 45, 67))).toBe(true);
    expect(luminanceGrey(0, 0, 0)).toBeGreaterThanOrEqual(0);
    expect(luminanceGrey(255, 255, 255)).toBeLessThanOrEqual(255);
  });

  it('desaturates a saturated player-accent-style hue toward a mid grey, not toward black or white', () => {
    // Mirrors the actual complaint: a player's saturated rim-accent colour (e.g. the AZURE
    // PLAYER_COLORS swatch 0x427ffa = (66,127,250)) must land on a genuine mid-range grey, not
    // collapse to a near-black or near-white extreme that would misread as "gone dark" instead
    // of "greyed out".
    const azureGrey = luminanceGrey(0x42, 0x7f, 0xfa);
    expect(azureGrey).toBeGreaterThan(40);
    expect(azureGrey).toBeLessThan(215);
  });
});

// #500 (third playtest pass — "can we make it a bit more wire-frame-y? like more outline-y"): the
// pure alpha-channel edge math behind the Cloak rim-outline bake (mechArt.js `desaturateTexture`
// calls these). Grids are written as row-strings ('#' opaque, '.' transparent) for readability.
function gridToAlpha(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const alphas = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) alphas[y * width + x] = row[x] === '#' ? 255 : 0;
  });
  return { alphas, width, height };
}

function maskToGrid(mask, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) row += mask[y * width + x] ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

describe('silhouetteBoundary (#500 third pass: the 1px edge line under the Cloak outline)', () => {
  it('marks only the perimeter of a solid shape, not its interior', () => {
    const { alphas, width, height } = gridToAlpha([
      '.......',
      '.#####.',
      '.#####.',
      '.#####.',
      '.#####.',
      '.#####.',
      '.......',
    ]);
    const boundary = silhouetteBoundary(alphas, width, height);
    expect(maskToGrid(boundary, width, height)).toEqual([
      '.......',
      '.#####.',
      '.#...#.',
      '.#...#.',
      '.#...#.',
      '.#####.',
      '.......',
    ]);
  });

  it('is empty for a fully transparent image', () => {
    const { alphas, width, height } = gridToAlpha(['...', '...', '...']);
    const boundary = silhouetteBoundary(alphas, width, height);
    expect([...boundary].every((v) => v === 0)).toBe(true);
  });

  it('treats the canvas edge as transparent, so a shape touching it is boundary right up to the edge', () => {
    const { alphas, width, height } = gridToAlpha(['###', '###', '###']);
    const boundary = silhouetteBoundary(alphas, width, height);
    // every pixel around the perimeter of a shape that fills the whole canvas has at least one
    // neighbour off-canvas (treated as transparent); only the dead-center pixel is fully interior.
    expect(maskToGrid(boundary, width, height)).toEqual(['###', '#.#', '###']);
  });
});

describe('dilateMask (#500 third pass: thickening the 1px edge into a visible rim band)', () => {
  it('radius 0 is a no-op', () => {
    const mask = new Uint8Array([0, 1, 0, 0]);
    expect(dilateMask(mask, 2, 2, 0)).toBe(mask);
  });

  it('grows a single marked pixel into a square block of side (2*radius + 1)', () => {
    const width = 7, height = 7;
    const mask = new Uint8Array(width * height);
    mask[3 * width + 3] = 1; // center pixel
    const grown = dilateMask(mask, width, height, 1);
    expect(maskToGrid(grown, width, height)).toEqual([
      '.......',
      '.......',
      '..###..',
      '..###..',
      '..###..',
      '.......',
      '.......',
    ]);
  });
});

describe('cloakEdgeMask (#500 third pass: boundary detection + thickening in one call)', () => {
  it('with thickness 0, is identical to the raw 1px boundary', () => {
    const { alphas, width, height } = gridToAlpha([
      '.....',
      '.###.',
      '.###.',
      '.###.',
      '.....',
    ]);
    expect(cloakEdgeMask(alphas, width, height, 0)).toEqual(silhouetteBoundary(alphas, width, height));
  });

  it('thickens the boundary outward, still never marking a fully-transparent pixel run beyond the shape entirely untouched at distance', () => {
    const { alphas, width, height } = gridToAlpha([
      '.........',
      '.........',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '.........',
      '.........',
    ]);
    const edge = cloakEdgeMask(alphas, width, height, 1);
    const grid = maskToGrid(edge, width, height);
    // the shape's own center pixel (row4, col4) is 2 cells from every side of the 5x5 square, so
    // it's outside a thickness-1 rim and should read as interior fill, not outline.
    expect(grid[4][4]).toBe('.');
    // the top-left corner of the square (row2, col2) IS within the boundary/rim band.
    expect(grid[2][2]).toBe('#');
  });
});
