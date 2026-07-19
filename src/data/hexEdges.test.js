// #288: hex EDGE identity + geometry. The whole feature rests on "the same boundary, approached
// from either side, is ONE entity" and on the exact swept crossing test — both pinned here.
import { describe, it, expect } from 'vitest';
import {
  edgeKey, parseEdgeKey, areAdjacent, edgeEndpoints, edgeMidpoint, segmentCrossT,
  pointSegmentDistance,
} from './hexEdges.js';
import { HEX_SIZE, neighbors, hexToPixel, distance } from './hexgrid.js';

const H = { q: 3, r: -2 };

describe('#288 edge identity', () => {
  it('is canonical: the same edge from either side is one key', () => {
    for (const n of neighbors(H.q, H.r)) {
      expect(edgeKey(H, n)).toBe(edgeKey(n, H));
    }
  });

  it('distinguishes all 6 of a hex\'s own edges from each other', () => {
    const keys = new Set(neighbors(H.q, H.r).map((n) => edgeKey(H, n)));
    expect(keys.size).toBe(6);
  });

  it('round-trips through parseEdgeKey (as the same unordered pair)', () => {
    for (const n of neighbors(H.q, H.r)) {
      const { a, b } = parseEdgeKey(edgeKey(H, n));
      expect(edgeKey(a, b)).toBe(edgeKey(H, n));
      expect([a, b].some((h) => h.q === H.q && h.r === H.r)).toBe(true);
      expect([a, b].some((h) => h.q === n.q && h.r === n.r)).toBe(true);
    }
  });

  it('two hexes share an edge exactly when they are one step apart', () => {
    expect(areAdjacent(H, neighbors(H.q, H.r)[0])).toBe(true);
    expect(areAdjacent(H, H)).toBe(false);
    expect(areAdjacent(H, { q: H.q + 2, r: H.r })).toBe(false);
  });
});

describe('#288 edge geometry', () => {
  it('an edge\'s endpoints are the two corners the hexes actually share', () => {
    for (const n of neighbors(H.q, H.r)) {
      const e = edgeEndpoints(H, n);
      expect(e).not.toBeNull();
      // Both endpoints are exactly one hex RADIUS from each centre — i.e. genuine shared corners.
      const ca = hexToPixel(H.q, H.r), cb = hexToPixel(n.q, n.r);
      for (const [x, y] of [[e.x0, e.y0], [e.x1, e.y1]]) {
        expect(Math.hypot(x - ca.x, y - ca.y)).toBeCloseTo(HEX_SIZE, 6);
        expect(Math.hypot(x - cb.x, y - cb.y)).toBeCloseTo(HEX_SIZE, 6);
      }
      // A regular hexagon's edge is exactly its circumradius long.
      expect(Math.hypot(e.x1 - e.x0, e.y1 - e.y0)).toBeCloseTo(HEX_SIZE, 6);
    }
  });

  // The cheapest possible check that the corner MATCHING picked the right pair: an edge's midpoint
  // must independently equal the midpoint of the two hex centres.
  it('an edge\'s midpoint is the midpoint of the two hex centres', () => {
    for (const n of neighbors(H.q, H.r)) {
      const m = edgeMidpoint(H, n);
      const ca = hexToPixel(H.q, H.r), cb = hexToPixel(n.q, n.r);
      expect(m.x).toBeCloseTo((ca.x + cb.x) / 2, 6);
      expect(m.y).toBeCloseTo((ca.y + cb.y) / 2, 6);
    }
  });

  it('is orientation-free: naming the edge from either side gives the same segment', () => {
    for (const n of neighbors(H.q, H.r)) {
      const f = edgeEndpoints(H, n), r = edgeEndpoints(n, H);
      const pts = (e) => [[e.x0, e.y0], [e.x1, e.y1]].map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).sort();
      expect(pts(f)).toEqual(pts(r));
    }
  });

  it('returns null for non-adjacent hexes', () => {
    expect(edgeEndpoints(H, { q: H.q + 3, r: H.r })).toBeNull();
    expect(edgeMidpoint(H, H)).toBeNull();
  });

  // Every edge of the grid belongs to exactly two hexes, and both name the same segment — the
  // property that makes "one edge, one HP pool" true rather than aspirational.
  it('neighbouring hexes agree on their shared edge across a whole patch of grid', () => {
    const seen = new Map();
    for (let q = -3; q <= 3; q++) {
      for (let r = -3; r <= 3; r++) {
        for (const n of neighbors(q, r)) {
          const k = edgeKey({ q, r }, n);
          const e = edgeEndpoints({ q, r }, n);
          const sig = [[e.x0, e.y0], [e.x1, e.y1]].map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).sort().join('|');
          if (seen.has(k)) expect(seen.get(k)).toBe(sig);
          else seen.set(k, sig);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(50);
  });
});

describe('#288 segmentCrossT (the swept collision primitive)', () => {
  it('reports the fraction along the first segment where they cross', () => {
    expect(segmentCrossT(0, 0, 10, 0, 5, -5, 5, 5)).toBeCloseTo(0.5, 9);
    expect(segmentCrossT(0, 0, 100, 0, 25, -5, 25, 5)).toBeCloseTo(0.25, 9);
  });

  it('is null when the segments miss, stop short, or never reach', () => {
    expect(segmentCrossT(0, 0, 4, 0, 5, -5, 5, 5)).toBeNull();     // stops short
    expect(segmentCrossT(0, 0, 10, 0, 5, 2, 5, 8)).toBeNull();     // wall is off to one side
    expect(segmentCrossT(0, 0, 10, 0, 20, -5, 20, 5)).toBeNull();  // wall is past the end
  });

  it('is null for a parallel or collinear pair — sliding ALONG a wall is not crossing it', () => {
    expect(segmentCrossT(0, 0, 10, 0, 0, 3, 10, 3)).toBeNull();
    expect(segmentCrossT(0, 0, 10, 0, 2, 0, 8, 0)).toBeNull();
  });

  // The property that matters at speed: a single huge step across a wall is still a crossing. A
  // point-sampled check on that same step's endpoints would see open ground at both ends.
  it('catches an arbitrarily fast step that leaps clean over the wall', () => {
    for (const speed of [40, 400, 4000, 40000]) {
      const t = segmentCrossT(-speed, 0, speed, 0, 0, -HEX_SIZE / 2, 0, HEX_SIZE / 2);
      expect(t).not.toBeNull();
      expect(t).toBeCloseTo(0.5, 6);
    }
  });

  // …and against a real hex edge at every approach angle, not just axis-aligned toy segments.
  it('catches a fast crossing of a REAL hex edge from every direction', () => {
    for (const n of neighbors(H.q, H.r)) {
      const e = edgeEndpoints(H, n);
      const ca = hexToPixel(H.q, H.r), cb = hexToPixel(n.q, n.r);
      // Centre-to-centre passes through the shared edge by definition; overshoot both ends 20x so
      // the step is far longer than any wall thickness.
      const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
      const dx = (cb.x - ca.x) * 20, dy = (cb.y - ca.y) * 20;
      const t = segmentCrossT(mx - dx, my - dy, mx + dx, my + dy, e.x0, e.y0, e.x1, e.y1);
      expect(t).not.toBeNull();
    }
  });
});

describe('#288 pointSegmentDistance', () => {
  it('measures perpendicular distance inside the span and endpoint distance outside it', () => {
    expect(pointSegmentDistance(0, 0, 10, 0, 5, 3)).toBeCloseTo(3, 9);
    expect(pointSegmentDistance(0, 0, 10, 0, 14, 0)).toBeCloseTo(4, 9);
    expect(pointSegmentDistance(0, 0, 10, 0, -3, 4)).toBeCloseTo(5, 9);
    expect(pointSegmentDistance(2, 2, 2, 2, 2, 7)).toBeCloseTo(5, 9);   // degenerate span
  });

  it('says a hex CENTRE is half the centre-to-centre spacing from its own edges', () => {
    const ca = hexToPixel(H.q, H.r);
    for (const n of neighbors(H.q, H.r)) {
      const e = edgeEndpoints(H, n);
      const cb = hexToPixel(n.q, n.r);
      const half = Math.hypot(cb.x - ca.x, cb.y - ca.y) / 2;
      expect(pointSegmentDistance(e.x0, e.y0, e.x1, e.y1, ca.x, ca.y)).toBeCloseTo(half, 6);
      expect(distance(H, n)).toBe(1);
    }
  });
});
