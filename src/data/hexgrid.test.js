import { describe, it, expect } from 'vitest';
import {
  hexToPixel, pixelToHex, neighbors, distance, range, ring, axialKey, HEX_SIZE,
  hexesWithinPixelRadius,
} from './hexgrid.js';

describe('hexgrid neighbors', () => {
  it('returns exactly 6 distinct adjacent hexes', () => {
    const ns = neighbors(0, 0);
    expect(ns).toHaveLength(6);
    const keys = new Set(ns.map((h) => axialKey(h.q, h.r)));
    expect(keys.size).toBe(6);
  });

  it('every neighbor is distance 1 away', () => {
    for (const n of neighbors(3, -2)) {
      expect(distance({ q: 3, r: -2 }, n)).toBe(1);
    }
  });
});

describe('hexgrid distance', () => {
  it('is zero to itself and symmetric', () => {
    const a = { q: 2, r: -1 }, b = { q: -3, r: 4 };
    expect(distance(a, a)).toBe(0);
    expect(distance(a, b)).toBe(distance(b, a));
  });

  it('matches a known straight-line distance', () => {
    expect(distance({ q: 0, r: 0 }, { q: 3, r: 0 })).toBe(3);
    expect(distance({ q: 0, r: 0 }, { q: 0, r: -4 })).toBe(4);
  });
});

describe('hexgrid pixel round-trip', () => {
  it('pixelToHex(hexToPixel(h)) recovers h for a spread of coords', () => {
    for (let q = -5; q <= 5; q++) {
      for (let r = -5; r <= 5; r++) {
        const p = hexToPixel(q, r);
        const back = pixelToHex(p.x, p.y);
        expect(back).toEqual({ q, r });
      }
    }
  });

  it('honours a custom size', () => {
    const p = hexToPixel(2, -1, 20);
    expect(pixelToHex(p.x, p.y, 20)).toEqual({ q: 2, r: -1 });
    expect(HEX_SIZE).toBeGreaterThan(0);
  });
});

describe('hexgrid range + ring', () => {
  it('range(c, n) has the centered-hexagonal-number count 3n(n+1)+1', () => {
    const center = { q: 0, r: 0 };
    expect(range(center, 0)).toHaveLength(1);
    expect(range(center, 1)).toHaveLength(7);
    expect(range(center, 2)).toHaveLength(19);
    expect(range(center, 3)).toHaveLength(37);
  });

  it('ring(c, n) has 6n hexes, all exactly n away', () => {
    const center = { q: 1, r: 1 };
    const r2 = ring(center, 2);
    expect(r2).toHaveLength(12);
    for (const h of r2) expect(distance(center, h)).toBe(2);
    expect(ring(center, 0)).toEqual([center]);
  });
});

describe('hexesWithinPixelRadius (#72 burning ground → terrain)', () => {
  it('a small circle returns just its containing hex', () => {
    const c = hexToPixel(3, -1);
    const hexes = hexesWithinPixelRadius(c.x, c.y, 10);
    expect(hexes).toEqual([{ q: 3, r: -1 }]);
  });

  it('a napalm-patch-sized circle centred on a hex burns that hex (not its neighbours)', () => {
    // Napalm's ground fire is radius 46 — neighbouring hex centres are ~83px away, so the
    // patch cooks the hex it lands on without bleeding a whole ring outward.
    const c = hexToPixel(0, 2);
    const hexes = hexesWithinPixelRadius(c.x, c.y, 46);
    expect(hexes).toEqual([{ q: 0, r: 2 }]);
  });

  it('a big circle sweeps in every hex whose centre it covers', () => {
    const c = hexToPixel(0, 0);
    const hexes = hexesWithinPixelRadius(c.x, c.y, HEX_SIZE * Math.sqrt(3) + 1);
    expect(hexes).toHaveLength(7);   // centre + all 6 neighbours
    for (const h of hexes) {
      const p = hexToPixel(h.q, h.r);
      expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(HEX_SIZE * Math.sqrt(3) + 1);
    }
  });

  it('an off-centre circle still includes the hex containing its centre point', () => {
    // Near a hex corner, the containing hex's CENTRE can be farther than r — it must still burn.
    const c = hexToPixel(2, 2);
    const hexes = hexesWithinPixelRadius(c.x + HEX_SIZE * 0.8, c.y, 5);
    expect(hexes.length).toBeGreaterThanOrEqual(1);
    const centre = pixelToHex(c.x + HEX_SIZE * 0.8, c.y);
    expect(hexes).toContainEqual(centre);
  });
});
