import { describe, it, expect } from 'vitest';
import { hexesForLabelsInRange } from './hexLabels.js';
import { hexToPixel, pixelToHex, axialKey, range } from './hexgrid.js';

// Build a small terrain disc so tests are self-contained and fast.
function discTerrain(radius = 6, pick = () => 'grass') {
  const t = new Map();
  for (const h of range({ q: 0, r: 0 }, radius)) {
    t.set(axialKey(h.q, h.r), pick(h.q, h.r));
  }
  return t;
}

describe('hexesForLabelsInRange', () => {
  it('returns only hexes within the pixel radius of the centre', () => {
    const terrain = discTerrain(6);
    const { x, y } = hexToPixel(0, 0);
    const small = hexesForLabelsInRange(terrain, x, y, 60);
    const large = hexesForLabelsInRange(terrain, x, y, 600);
    expect(small.length).toBeGreaterThan(0);
    expect(large.length).toBeGreaterThan(small.length);
    // Every returned hex must actually be within the requested radius of (x,y).
    for (const { q, r } of small) {
      const p = hexToPixel(q, r);
      expect(Math.hypot(p.x - x, p.y - y)).toBeLessThanOrEqual(60 + 1e-6);
    }
  });

  it('carries the correct terrain id for each returned hex', () => {
    const terrain = discTerrain(6, (q, r) => (q === 0 && r === 0 ? 'building' : 'grass'));
    const { x, y } = hexToPixel(0, 0);
    const found = hexesForLabelsInRange(terrain, x, y, 200);
    const centre = found.find((h) => h.q === 0 && h.r === 0);
    expect(centre.id).toBe('building');
    expect(found.some((h) => h.id === 'grass')).toBe(true);
  });

  it('skips hex keys in excludeKeys (the special dock/alertTower/turret labels)', () => {
    const terrain = discTerrain(6);
    const { x, y } = hexToPixel(0, 0);
    const centreKey = axialKey(0, 0);
    const withExclude = hexesForLabelsInRange(terrain, x, y, 200, new Set([centreKey]));
    expect(withExclude.some((h) => h.key === centreKey)).toBe(false);
    const without = hexesForLabelsInRange(terrain, x, y, 200);
    expect(without.some((h) => h.key === centreKey)).toBe(true);
  });

  it('skips hexes with no terrain entry (nothing generated there)', () => {
    const terrain = discTerrain(2); // small map — plenty of nearby hexes are ungenerated
    const { x, y } = hexToPixel(0, 0);
    const found = hexesForLabelsInRange(terrain, x, y, 600);
    for (const { key } of found) {
      expect(terrain.has(key)).toBe(true);
    }
    // Sanity: a large-enough radius over a tiny map would have included ungenerated hexes if
    // the filter weren't applied — assert we didn't just get an empty/trivial result.
    expect(found.length).toBeGreaterThan(0);
  });

  it('a moving centre roughly tracks the expected in-range set (smoke-level, no throw)', () => {
    const terrain = discTerrain(8);
    let prevCount = null;
    for (let i = 0; i < 20; i++) {
      const cx = i * 20, cy = 0;
      const found = hexesForLabelsInRange(terrain, cx, cy, 150);
      expect(() => found.map((h) => h.key)).not.toThrow();
      expect(Array.isArray(found)).toBe(true);
      prevCount = found.length;
    }
    expect(prevCount).toBeGreaterThan(0);
  });
});
