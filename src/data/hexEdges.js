// #288: hex EDGE identity + geometry — the boundary BETWEEN two adjacent hexes, as a first-class
// thing you can name, key, and intersect against. Everything tile-shaped in the game (terrain.js)
// belongs to a coord; an edge wall belongs to the *line between* two coords and occupies no tile of
// its own, so it needs its own primitive.
//
// This sits beside hexgrid.js (and imports all its hex knowledge from it) rather than inside it,
// per the repo's "hexgrid.js is the only file that knows hexes exist" rule — no new hex math is
// invented here: corners come from `hexCorners`, centres from `hexToPixel`, adjacency from
// `distance`. Pure and unit-tested (hexEdges.test.js); no Phaser, no game state.
import { HEX_SIZE, axialKey, distance, hexToPixel, hexCorners } from './hexgrid.js';

// ── Identity ────────────────────────────────────────────────────────────────────────────
// An edge is an UNORDERED pair of adjacent hexes. Approaching the same wall from either side must
// name the SAME entity (one edge with one HP pool, not two half-walls), so the key is canonical:
// the two coords sorted by (q, then r) and joined. `edgeKey(a, b) === edgeKey(b, a)` always.
export function edgeKey(a, b) {
  const ka = axialKey(a.q, a.r), kb = axialKey(b.q, b.r);
  const aFirst = a.q !== b.q ? a.q < b.q : a.r < b.r;
  return aFirst ? `${ka}|${kb}` : `${kb}|${ka}`;
}

// Split a canonical edge key back into its two hexes, in canonical (sorted) order.
export function parseEdgeKey(key) {
  const [ka, kb] = key.split('|');
  const [aq, ar] = ka.split(',').map(Number);
  const [bq, br] = kb.split(',').map(Number);
  return { a: { q: aq, r: ar }, b: { q: bq, r: br } };
}

// Two hexes share an edge iff they're exactly one grid step apart.
export function areAdjacent(a, b) {
  return distance(a, b) === 1;
}

// ── Geometry ────────────────────────────────────────────────────────────────────────────
// The pixel-space segment two adjacent hexes share: their two COMMON corners.
//
// Derived by matching corner positions rather than by a hardcoded direction→edge-index table.
// hexgrid.js deliberately exposes only `hexCorners()` (a rendering concern) and `neighbors()`
// (an adjacency concern) with no documented mapping between their two independent index orders —
// so rather than re-deriving that mapping (world.js's NEIGHBOR_EDGE table did, analytically, for
// its outline stroke), this just computes both hexes' 6 world-space corners and keeps the two that
// coincide. Regular hexes share exactly 2 corners with each neighbour, so the match is exact up to
// float noise; EPS is generous relative to the ~48px corner spacing and tight relative to any real
// distinct pair of corners. Returns null for non-adjacent hexes (nothing shared).
const CORNER_EPS = 1e-6;
export function edgeEndpoints(a, b, size = HEX_SIZE) {
  if (!areAdjacent(a, b)) return null;
  const ca = hexToPixel(a.q, a.r, size), cb = hexToPixel(b.q, b.r, size);
  const corners = hexCorners(size);
  const eps = CORNER_EPS * Math.max(1, size);
  const shared = [];
  for (const pa of corners) {
    const ax = ca.x + pa.x, ay = ca.y + pa.y;
    for (const pb of corners) {
      const bx = cb.x + pb.x, by = cb.y + pb.y;
      if (Math.abs(ax - bx) < eps && Math.abs(ay - by) < eps) shared.push({ x: ax, y: ay });
    }
  }
  if (shared.length !== 2) return null;
  return { x0: shared[0].x, y0: shared[0].y, x1: shared[1].x, y1: shared[1].y };
}

// The midpoint of the shared edge — which is also, for a regular grid, the midpoint of the two hex
// CENTRES. (Both are computed independently here and asserted equal in the tests, which is the
// cheapest possible check that `edgeEndpoints`' corner matching picked the right pair.)
export function edgeMidpoint(a, b, size = HEX_SIZE) {
  const e = edgeEndpoints(a, b, size);
  if (!e) return null;
  return { x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2 };
}

// Where segment P(t) = (ax,ay)→(bx,by) crosses segment (cx,cy)→(dx,dy), as the parameter `t` in
// [0,1] along the FIRST segment, or null if they don't cross. Standard 2D segment-segment
// intersection; parallel/degenerate cases return null (a movement step running exactly ALONG a
// wall never "crosses" it, which is the behaviour we want — you slide, you don't pass through).
//
// This is the exact swept test that makes edge collision tunnel-proof: a wall is a LINE with no
// thickness of its own to sample, so a point-sampled check (even a fine one) can always be
// out-stepped by a fast enough mech or round. Crossing is a boolean about the whole step.
export function segmentCrossT(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay;
  const sx = dx - cx, sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null;           // parallel or collinear
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

// Shortest distance from point (px,py) to segment (ax,ay)→(bx,by). Local copy of the same clamped
// projection `segmentPointDistance` (data/delivery.js) uses for swept projectile hits — duplicated
// (7 lines) rather than imported so this geometry module stays free of any weapon-model dependency.
export function pointSegmentDistance(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
