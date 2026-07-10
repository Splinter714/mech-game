import { describe, it, expect } from 'vitest';
import {
  hexToPixel, pixelToHex, neighbors, distance, range, ring, axialKey, nearestHex, HEX_SIZE,
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

describe('hexgrid nearestHex (reachable-drop search, #73)', () => {
  // Model a small world: passable iff inside radius R AND not in a blocked set. This is the
  // exact shape the arena uses (in-disc + passable-terrain predicate), kept pure here.
  const R = 5;
  const makeOk = (blocked = new Set()) => (q, r) =>
    distance({ q: 0, r: 0 }, { q, r }) <= R && !blocked.has(axialKey(q, r));

  it('returns an already-valid spot unchanged (distance 0)', () => {
    const ok = makeOk();
    expect(nearestHex({ q: 2, r: -1 }, ok)).toEqual({ q: 2, r: -1 });
  });

  it('resolves an off-map death spot to an in-world passable hex', () => {
    const ok = makeOk();
    const found = nearestHex({ q: 40, r: -40 }, ok);
    expect(found).not.toBeNull();
    expect(distance({ q: 0, r: 0 }, found)).toBeLessThanOrEqual(R);
    expect(ok(found.q, found.r)).toBe(true);
  });

  it('resolves a spot inside a wall/water blob to the nearest passable hex outside it', () => {
    // Block the 7-hex disc around the origin; the nearest passable ring is distance 2.
    const blocked = new Set(range({ q: 0, r: 0 }, 1).map((h) => axialKey(h.q, h.r)));
    const ok = makeOk(blocked);
    const found = nearestHex({ q: 0, r: 0 }, ok);
    expect(found).not.toBeNull();
    expect(ok(found.q, found.r)).toBe(true);
    expect(distance({ q: 0, r: 0 }, found)).toBe(2);
  });

  it('returns null when nothing within range passes (caller supplies a fallback)', () => {
    expect(nearestHex({ q: 0, r: 0 }, () => false, 3)).toBeNull();
  });
});
