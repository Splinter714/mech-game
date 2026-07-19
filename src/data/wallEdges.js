// #288 (rebuilt): base perimeter walls as EDGE-owned obstacles — a thickened line drawn on the
// boundaries BETWEEN hexes, consuming no tile of play space. This replaces the first pass's
// tile-based `wallSegment` terrain entirely (playtest: "I wanted walls to be only on the lines
// between hexes, not new hexes; more like thickened hex boundaries").
//
// Everything here is pure (no Phaser, no scene) and unit-tested in wallEdges.test.js; the arena's
// world mixin (scenes/arena/world.js) owns one of these sets per run and routes movement,
// line-of-sight, and weapon damage through the query functions below. Behaviour is deliberately
// UNCHANGED from the tile version: destructible per span, blocks movement AND line-of-sight, you
// shoot through to breach a gap and can walk around the ends. Only the geometry moved.
import { HEX_SIZE, axialKey, pixelToHex, neighbors, hexesAlongSegment } from './hexgrid.js';
import { edgeKey, edgeEndpoints, segmentCrossT, pointSegmentDistance } from './hexEdges.js';

// HP per SPAN (one hex edge). Lower than the old whole-hex `wallSegment`'s 55: an edge span is a
// narrower thing to shoot and, since the mech collides as a point against terrain, breaching just
// ONE span already opens a drivable gap (a hex edge is HEX_SIZE ≈ 48px long, and the two flanking
// spans only eat WALL_THICKNESS_PX/2 off each end of it). The gate's toughness comes from having to
// stand and grind a span down under fire, not from needing several.
export const WALL_EDGE_HP = 45;

// How thick a wall reads/collides, in px, centred on the hex boundary — ~30% of a hex edge's own
// length, so it looks like a substantial blast wall straddling the line without visibly eating into
// either neighbouring tile. This is what makes every EXISTING point-shaped world query (`_blocked`,
// `_isWall`, the 8px LOS ray march) work against an edge unchanged: a wall is "solid" within half
// this distance of its segment. The exact swept crossing tests below are what stop anything fast
// enough to step over a 14px band from tunnelling.
export const WALL_THICKNESS_PX = 14;

// ── Construction ────────────────────────────────────────────────────────────────────────
// Build the run's live wall state from a plain list of edge definitions (`{ a, b, baseId }`, where
// `a`/`b` are adjacent axial coords — worldgen.js `placeBaseWalls` produces these). Each edge gets
// its own HP pool and its own precomputed pixel endpoints, and is indexed under BOTH of its hexes
// so a query can find candidate walls from a hex lookup instead of scanning every wall on the map.
// Duplicate definitions of the same edge (the same boundary named from either side) collapse into
// one entity via the canonical `edgeKey` — the whole point of canonicalising.
export function makeWallEdgeSet(defs = [], hp = WALL_EDGE_HP) {
  const edges = new Map();      // canonical edgeKey → record
  const byHex = new Map();      // hexKey → record[]  (each edge listed under both its hexes)
  for (const def of defs) {
    const { a, b } = def;
    const pts = edgeEndpoints(a, b);
    if (!pts) continue;         // non-adjacent / malformed — silently skipped, never half-built
    const key = edgeKey(a, b);
    if (edges.has(key)) continue;
    const rec = {
      key, a: { q: a.q, r: a.r }, b: { q: b.q, r: b.r }, baseId: def.baseId ?? null,
      hp, maxHp: hp, destroyed: false, ...pts,
    };
    edges.set(key, rec);
    for (const h of [a, b]) {
      const hk = axialKey(h.q, h.r);
      if (!byHex.has(hk)) byHex.set(hk, []);
      byHex.get(hk).push(rec);
    }
  }
  return { edges, byHex };
}

// Every STANDING edge record, in insertion order.
export function liveWallEdges(set) {
  if (!set) return [];
  return [...set.edges.values()].filter((e) => !e.destroyed);
}

// ── Broad phase ─────────────────────────────────────────────────────────────────────────
// Candidate edges near a world point: the edges of the hex under it plus those of its 6 neighbours.
// A wall within half-thickness of a point is always incident to that point's own hex or an adjacent
// one, so this is complete, not a heuristic.
function candidatesNear(set, x, y, out) {
  const h = pixelToHex(x, y);
  collectHex(set, h.q, h.r, out);
  for (const n of neighbors(h.q, h.r)) collectHex(set, n.q, n.r, out);
}

function collectHex(set, q, r, out) {
  const list = set.byHex.get(axialKey(q, r));
  if (!list) return;
  for (const e of list) if (!e.destroyed) out.add(e);
}

// Candidate edges a straight segment could possibly cross. If a segment crosses the boundary
// between hexes A and B then it passes through BOTH A and B by definition, so indexing off the
// hexes the segment traverses (`hexesAlongSegment` — the same supercover primitive the tile
// collision already uses) finds every crossable edge. Each traversed hex's 6 neighbours are
// included as well, purely as belt-and-braces against `hexesAlongSegment`'s documented dedup quirk
// at grazing angles: if it ever skipped BOTH hexes flanking one edge, that edge would otherwise be
// missed. Cheap — the whole thing is a handful of Map lookups that miss immediately on a map with
// no walls near the ray.
function candidatesAlong(set, x0, y0, x1, y1) {
  const out = new Set();
  for (const h of hexesAlongSegment(x0, y0, x1, y1)) {
    collectHex(set, h.q, h.r, out);
    for (const n of neighbors(h.q, h.r)) collectHex(set, n.q, n.r, out);
  }
  return out;
}

// ── Queries ─────────────────────────────────────────────────────────────────────────────
// The standing wall a world point is INSIDE (within half the wall's thickness of its span), or
// null. This is the point-shaped query: it's what lets the existing `_blocked`/`_isWall`/8px-ray
// machinery treat an edge wall as solid without any of it learning what an edge is.
export function wallEdgeAt(set, x, y, thickness = WALL_THICKNESS_PX) {
  if (!set || set.edges.size === 0) return null;
  const cand = new Set();
  candidatesNear(set, x, y, cand);
  const half = thickness / 2;
  let best = null, bestD = Infinity;
  for (const e of cand) {
    const d = pointSegmentDistance(e.x0, e.y0, e.x1, e.y1, x, y);
    if (d <= half && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

// The FIRST standing wall the straight path (x0,y0)→(x1,y1) crosses, as
// `{ edge, t, x, y, dist }` (t is the fraction along the path, x/y the crossing point, dist the
// pixel distance from the start), or null if the path crosses none.
//
// This is the swept query, and it's the one that actually makes edge walls safe: a mech moving at
// full speed, or a fast projectile, covers far more than the wall's 14px thickness in a single
// step, so a point test alone could step clean over the band. A crossing is a property of the whole
// step, so it can't be out-stepped at any speed or approach angle. (Same class of fix as #159's
// `_blockedAlongSegment` for tiles, and the same swept-test precedent as `segmentPointDistance` in
// delivery.js for fast rounds.)
//
// A path that never crosses a span's centreline but ENDS inside its thickness counts as a contact
// at t = 1, so driving at a wall and stopping short still stops against its face rather than
// parking inside it. Deliberately NOT symmetric: a path that merely STARTS inside the band is not a
// contact, or a unit that ended up parked in the band would be frozen in place with no move (not
// even a retreat) available to it — it just has to not cross the centreline to get out.
export function wallEdgeCrossing(set, x0, y0, x1, y1, thickness = WALL_THICKNESS_PX) {
  if (!set || set.edges.size === 0) return null;
  const cand = candidatesAlong(set, x0, y0, x1, y1);
  if (cand.size === 0) return null;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const half = thickness / 2;
  let best = null, bestT = Infinity;
  for (const e of cand) {
    let t = segmentCrossT(x0, y0, x1, y1, e.x0, e.y0, e.x1, e.y1);
    // A step that never geometrically crosses the span's centreline can still END inside the wall's
    // thickness (e.g. driving straight at it and stopping short, or a round detonating on its face)
    // — treat the endpoint sample as a contact at t = 1 so the wall still stops it.
    if (t == null && pointSegmentDistance(e.x0, e.y0, e.x1, e.y1, x1, y1) <= half) t = 1;
    if (t == null || t >= bestT) continue;
    best = e; bestT = t;
  }
  if (!best) return null;
  return { edge: best, t: bestT, x: x0 + (x1 - x0) * bestT, y: y0 + (y1 - y0) * bestT, dist: len * bestT };
}

// The standing wall nearest a world point within `maxDist` (used to route a weapon hit that landed
// on/next to a wall onto the right span), or null.
export function nearestWallEdge(set, x, y, maxDist = HEX_SIZE) {
  if (!set || set.edges.size === 0) return null;
  const cand = new Set();
  candidatesNear(set, x, y, cand);
  let best = null, bestD = maxDist;
  for (const e of cand) {
    const d = pointSegmentDistance(e.x0, e.y0, e.x1, e.y1, x, y);
    if (d <= bestD) { best = e; bestD = d; }
  }
  return best;
}

// ── Destruction ─────────────────────────────────────────────────────────────────────────
// Chip a span's HP. Each edge has its own independent pool — damaging one never affects its
// neighbours — so the player breaches by grinding down a span until it collapses, opening a gap in
// the line while the rest of the wall stands. Returns `{ hp, destroyed }`; a destroyed span is
// marked (not deleted, so it keeps its identity/geometry for the renderer's collapse) and stops
// blocking movement, sight, and fire immediately. Damaging an already-destroyed span is a no-op.
export function damageWallEdge(set, edge, amount) {
  if (!edge || edge.destroyed) return { hp: 0, destroyed: false };
  edge.hp = Math.max(0, edge.hp - Math.max(0, amount));
  if (edge.hp > 0) return { hp: edge.hp, destroyed: false };
  edge.destroyed = true;
  return { hp: 0, destroyed: true };
}
