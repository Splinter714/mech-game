import { describe, it, expect } from 'vitest';
import { luminanceGrey } from './desaturate.js';

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
