// #288: the wall renders as a thickened BOUNDARY LINE, not a hex texture. Exercised against a
// recording Graphics stub (no Phaser), which is enough to pin the properties that matter: a
// standing span draws, a destroyed one draws nothing at all (that hole IS the breach the player
// sees), and the geometry it strokes actually straddles the hex boundary.
import { describe, it, expect } from 'vitest';
import { drawWallEdges } from './wallArt.js';
import { makeWallEdgeSet, WALL_EDGE_HP, WALL_THICKNESS_PX } from '../data/wallEdges.js';
import { edgeMidpoint, pointSegmentDistance } from '../data/hexEdges.js';
import { neighbors, hexToPixel } from '../data/hexgrid.js';

const A = { q: 0, r: 0 };
const NBRS = neighbors(A.q, A.r);

function recorder() {
  const calls = { clear: 0, points: [], circles: [] };
  return {
    calls,
    clear() { calls.clear++; },
    fillStyle() {},
    fillPoints(pts) { calls.points.push(pts); },
    fillCircle(x, y, r) { calls.circles.push({ x, y, r }); },
  };
}

// Every vertex the draw emitted (band corners + circle centres).
const allPoints = (g) => [...g.calls.points.flat(), ...g.calls.circles];

describe('#288 drawWallEdges', () => {
  it('clears and redraws from scratch each time', () => {
    const g = recorder();
    const set = makeWallEdgeSet([{ a: A, b: NBRS[0] }]);
    drawWallEdges(g, [...set.edges.values()]);
    drawWallEdges(g, [...set.edges.values()]);
    expect(g.calls.clear).toBe(2);
  });

  it('draws nothing at all for an empty wall', () => {
    const g = recorder();
    drawWallEdges(g, []);
    expect(g.calls.points).toHaveLength(0);
    expect(g.calls.circles).toHaveLength(0);
  });

  // The geometry check: everything drawn for a span hugs that span's own boundary line — it does
  // not spill into either hex the way a tile texture would.
  it('strokes a band that straddles the hex boundary, not either hex', () => {
    const g = recorder();
    const set = makeWallEdgeSet([{ a: A, b: NBRS[0] }]);
    const e = [...set.edges.values()][0];
    drawWallEdges(g, [e]);
    expect(g.calls.points.length).toBeGreaterThan(0);
    for (const p of allPoints(g)) {
      // Within the wall's own half-thickness of the boundary (plus the 3px shadow offset and the
      // junction pillars' own radius).
      expect(pointSegmentDistance(e.x0, e.y0, e.x1, e.y1, p.x, p.y)).toBeLessThan(WALL_THICKNESS_PX);
    }
    // …and both hex CENTRES stay well outside everything drawn.
    for (const h of [A, NBRS[0]]) {
      const c = hexToPixel(h.q, h.r);
      const nearest = Math.min(...allPoints(g).map((p) => Math.hypot(p.x - c.x, p.y - c.y)));
      expect(nearest).toBeGreaterThan(WALL_THICKNESS_PX);
    }
  });

  // The breach, visually: a destroyed span leaves a literal hole in the line while its neighbours
  // keep drawing — which is exactly what tells the player where they can drive through.
  it('a destroyed span draws nothing, and its neighbours are unaffected', () => {
    const set = makeWallEdgeSet(NBRS.map((n) => ({ a: A, b: n })));
    const spans = [...set.edges.values()];
    const before = recorder();
    drawWallEdges(before, spans);

    spans[2].destroyed = true;
    const after = recorder();
    drawWallEdges(after, spans);

    expect(after.calls.points.length).toBeLessThan(before.calls.points.length);
    const gap = edgeMidpoint(spans[2].a, spans[2].b);
    const nearestToGap = Math.min(...allPoints(after).map((p) => Math.hypot(p.x - gap.x, p.y - gap.y)));
    expect(nearestToGap).toBeGreaterThan(WALL_THICKNESS_PX);
    // The five standing spans still draw around it.
    for (const s of spans.filter((s2) => !s2.destroyed)) {
      const m = edgeMidpoint(s.a, s.b);
      expect(Math.min(...allPoints(after).map((p) => Math.hypot(p.x - m.x, p.y - m.y)))).toBeLessThan(WALL_THICKNESS_PX);
    }
  });

  it('a battered span still draws (it degrades, it does not vanish early)', () => {
    const set = makeWallEdgeSet([{ a: A, b: NBRS[0] }]);
    const e = [...set.edges.values()][0];
    e.hp = 1;
    const g = recorder();
    drawWallEdges(g, [e]);
    expect(g.calls.points.length).toBeGreaterThan(0);
    e.hp = WALL_EDGE_HP;
    const full = recorder();
    drawWallEdges(full, [e]);
    expect(full.calls.points.length).toBe(g.calls.points.length);   // same passes, different sizes
  });
});
