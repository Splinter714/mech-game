// #306 (rework): the player's field of view as a TRUE VISIBILITY POLYGON — continuous plane
// geometry, not hex tiles.
//
// ── Why this replaced the hex-granular pass ──
// The first #306 shipped `computeVisibleHexes` (data/visibility.js): walk a hex line to every tile
// in the disc, mark it seen/unseen, fill the unseen HEXES. It worked, but every shadow boundary
// snapped to a hex edge, and that blockiness is the first thing the owner noticed in play — "didn't
// realize you were building a hex-darkening version instead of like a raycast". The game is
// continuous physics on top of hexes anyway, so grid-quantised shadows were the odd thing out.
//
// This module treats blockers as LINE SEGMENTS and sweeps rays around the viewer, producing one
// continuous star-shaped lit region whose edges radiate from obstacle corners at any angle. It is
// PURE (no Phaser, no scene state) and unit-tested in shadowPolygon.test.js.
//
// ── RENDERING ONLY — deliberately ──
// This does NOT replace data/visibility.js. That module still owns the GAMEPLAY gate
// (`enemyTargetable`: what convergence/lock may acquire), because it is pure, unit-tested, and its
// own-hex / soft-cover rules were confirmed good in play (and #316 has just re-cut them). Swapping
// the targeting gate to new geometry would put a cosmetic change on the critical path of a tested
// combat rule for no gain. So: hexes decide what you may SHOOT, polygons decide what you SEE
// dimmed. The two are built from the same blocker set (`coverBlocksForRay` + standing wall spans),
// so they agree to within a hex; where they can differ is a sub-hex sliver at a shadow boundary —
// a unit's hex centre lit while its sprite edge is in shadow, or the reverse. That is a knowingly
// accepted cosmetic seam, not a bug to silently reconcile.
//
// ── Why the SWEEP polygon, and not per-obstacle shadow volumes ──
// The obvious alternative is to draw, per blocker, a quad extending away from the viewer, and let
// them overlap. That is simpler to write but WRONG for a translucent overlay: two overlapping
// shadow quads at alpha 0.8 composite to 0.96, so a wall ring — where shadows overlap constantly —
// would render as a patchwork of visibly different darknesses. Fixing that needs a stencil/geometry
// mask (draw the volumes opaque into a mask, then pull one flat dim rect through it), which is more
// machinery and more platform risk than the geometry it avoids.
//
// The sweep polygon dodges the problem entirely. Its vertices are ANGULARLY SORTED around the
// viewer, so the shadow wedge between each consecutive pair occupies its own disjoint angular
// slice: the wedges cannot overlap by construction. A plain translucent fill is therefore exactly
// uniform with zero extra machinery, and the total darkness is one alpha value the owner can retune
// by editing one number.
import { HEX_SIZE, hexToPixel, neighbors, pixelToHex, range } from './hexgrid.js';
import { edgeEndpoints, pointSegmentDistance } from './hexEdges.js';
import { coverBlocksForRay } from './terrain.js';
import { SPAN_ROLE_GATE } from './wallEdges.js';

// Angular nudge either side of each blocker corner. Two rays per endpoint (θ-ε and θ+ε) rather than
// the textbook three (θ-ε, θ, θ+ε): the exact-θ ray only ever reproduces the corner the ±ε pair
// already brackets, and at ε = 1e-5 rad the bracketing rays miss the true corner by ε × range —
// under a fiftieth of a pixel at any range this game draws. A third of the rays saved for an error
// far below one screen pixel.
const ANGLE_EPS = 1e-5;

// A blocker this close to the viewer is DISCARDED: you are standing on it (inside a wall's 14px
// band, or clipped into a structure's outline). Sweeping from a point that lies on a segment is
// degenerate — the segment subtends ~180° and the whole world goes black behind you, which looks
// like a bug even when it is arguably "correct". Dropping it fails open, which is the right failure
// direction for a cosmetic overlay.
const ON_TOP_PX = 1.5;

// Shadow wedges wider than this get subdivided. A wedge's far boundary is a straight chord, but the
// region it must cover is bounded by an ARC at the cull radius; for a wide wedge the chord cuts
// well inside the arc and would leave a bright crescent at the screen edge. Splitting the wedge's
// (exactly straight) near edge into equal pieces and extending each radially keeps the near
// boundary mathematically unchanged while making the far boundary track the arc.
const MAX_WEDGE_RAD = Math.PI / 9;   // 20°

// How far past the cull radius a shadow wedge is extended. Generous, because the wedge only has to
// end up off-screen, and overdraw beyond the camera costs nothing (Phaser scissors it).
const WEDGE_OVERSHOOT = 1.6;

// ── Blocker collection ──────────────────────────────────────────────────────────────────
// Every sight-blocking line segment within `radiusPx` of (x, y), as `{x0, y0, x1, y1}`.
//
// Two sources, matching exactly what the hex pass consults so the two can't disagree about WHAT
// blocks (only about sub-hex precision):
//
//   1. Terrain hexes whose cover blocks a ray (`coverBlocksForRay(id, false)` — the same shared
//      decision `shotBlockedAt` / `_wallDistanceLos` use). SOFT cover contributes NOTHING —
//      `coverBlocksForRay` is false for it (#374 made that true for every unit, not just a
//      mech-sized viewer). That is deliberate and unchanged from the hex version — dimming
//      concentrates around structures and walls, not woodland. #374's foliage shot-block is a
//      per-shot roll at the target and has no sight/shadow component at all.
//   2. Standing base-wall spans (#288), which are edge geometry with real pixel endpoints and are
//      not terrain hexes at all. A terrain-only pass would see straight through a base wall.
//
// A blocking hex reduces to its SILHOUETTE, not all six of its edges: an edge shared with another
// blocking hex is interior to a solid region and can never bound a shadow, so it's skipped. On a
// dense outpost cluster that is the difference between 6 segments per hex and roughly 1-2, and it
// is what keeps the sweep affordable per frame. The shared edge is derived via #288's
// `edgeEndpoints` (corner matching) rather than a hand-rolled direction→corner-index table, so
// there is exactly one place in the codebase that knows which corners a hex pair has in common.
export function collectShadowSegments(x, y, radiusPx, terrainAt, opts = {}) {
  const { wallEdges = null, hexRadius = null } = opts;
  const segs = [];
  // Hex-space search radius: enough rings to cover the pixel radius. A hex advances 1.5 * HEX_SIZE
  // per row (the tighter of the two axes), so this over- rather than under-estimates.
  const rings = hexRadius ?? Math.ceil(radiusPx / (HEX_SIZE * 1.5)) + 1;
  const home = pixelToHex(x, y);

  const blocks = (q, r) => coverBlocksForRay(terrainAt(q, r), false);
  for (const h of range(home, rings)) {
    if (!blocks(h.q, h.r)) continue;
    // The viewer's OWN hex never casts a shadow — the #72 own-hex exemption, mirrored. Standing
    // inside a structure must not black out the entire screen.
    if (h.q === home.q && h.r === home.r) continue;
    const c = hexToPixel(h.q, h.r);
    // Cheap circle reject before generating any geometry: a hex whose centre is more than its own
    // circumradius past the cull distance cannot contribute a visible segment.
    if (Math.hypot(c.x - x, c.y - y) > radiusPx + HEX_SIZE) continue;
    for (const nb of neighbors(h.q, h.r)) {
      if (blocks(nb.q, nb.r)) continue;          // interior edge — never bounds a shadow
      const e = edgeEndpoints(h, nb);
      if (e) segs.push(e);
    }
  }

  if (wallEdges) {
    for (const e of wallEdges) {
      // #309: an OPEN gate is a hole you can see and shoot through, so it casts no shadow. This is
      // the same condition `wallEdgeCrossing(..., passOpenGates: true)` applies for the hex pass —
      // a span is see-through only when it is a GATE *and* currently open, never just because it
      // carries an `open` field.
      if (e.destroyed || (e.role === SPAN_ROLE_GATE && e.open)) continue;
      if (pointSegmentDistance(e.x0, e.y0, e.x1, e.y1, x, y) > radiusPx) continue;
      segs.push({ x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 });
    }
  }

  // Drop anything the viewer is standing on (see ON_TOP_PX) and anything degenerate.
  return segs.filter((s) => {
    const d = pointSegmentDistance(s.x0, s.y0, s.x1, s.y1, x, y);
    return d > ON_TOP_PX && (s.x0 !== s.x1 || s.y0 !== s.y1);
  });
}

// ── The sweep ───────────────────────────────────────────────────────────────────────────
// Precompute, per segment, the angular interval it subtends from the viewer. Because the viewer is
// never ON a segment (ON_TOP_PX guarantees it), that interval is always shorter than π, so it can
// be stored as a start angle plus a positive width and tested with two comparisons.
//
// This is the whole performance story. A naive sweep tests every ray against every segment, which
// is O(n²) — with ~90 wall spans around a base plus structure silhouettes that is tens of thousands
// of intersections per frame. The interval test rejects a segment in two compares, and a ray only
// ever has a handful of segments genuinely spanning its direction, so the real cost collapses to
// roughly O(n · k) with k small and constant.
function prepare(x, y, segments) {
  const out = [];
  for (const s of segments) {
    const a0 = Math.atan2(s.y0 - y, s.x0 - x);
    const a1 = Math.atan2(s.y1 - y, s.x1 - x);
    let d = a1 - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out.push({ ...s, lo: d >= 0 ? a0 : a1, width: Math.abs(d) });
  }
  return out;
}

// Signed difference a - b wrapped into (-π, π].
function angDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

// Distance from (x,y) along unit direction (dx,dy) to the nearest prepared segment, capped at
// `far`. Returns `far` when the ray escapes cleanly.
function castRay(x, y, dx, dy, prepared, far, ang) {
  let best = far;
  for (let i = 0; i < prepared.length; i++) {
    const s = prepared[i];
    // Angular reject: does this segment even span the ray's direction?
    const rel = angDelta(ang, s.lo);
    if (rel < -1e-9 || rel > s.width + 1e-9) continue;
    const sx = s.x1 - s.x0, sy = s.y1 - s.y0;
    const denom = dx * sy - dy * sx;
    if (denom === 0) continue;                       // parallel
    const t = ((s.x0 - x) * sy - (s.y0 - y) * sx) / denom;
    if (t <= 0 || t >= best) continue;               // behind us, or farther than a known hit
    const u = ((s.x0 - x) * dy - (s.y0 - y) * dx) / denom;
    if (u < 0 || u > 1) continue;                    // misses the span itself
    best = t;
  }
  return best;
}

// The visibility polygon: the star-shaped lit region around (x, y), as vertices sorted by angle.
// Each entry is `{ ang, dist, x, y }`. `far` caps every ray, so with no blockers in range the
// polygon is empty (nothing to dim) rather than a pointless 360-gon.
//
// Rays are cast at θ±ε for each blocker ENDPOINT — those are the only directions where the
// nearest-blocker distance can jump, so they are the only directions that can produce a polygon
// corner. Everything between two adjacent rays is a straight edge, which is precisely why the
// output has sharp straight shadow boundaries at arbitrary angles instead of hex-stepped ones.
export function computeVisibilityPolygon(x, y, segments, far) {
  if (!segments.length) return [];
  const prepared = prepare(x, y, segments);
  const angles = [];
  for (const s of prepared) {
    for (const [ex, ey] of [[s.x0, s.y0], [s.x1, s.y1]]) {
      const a = Math.atan2(ey - y, ex - x);
      angles.push(a - ANGLE_EPS, a + ANGLE_EPS);
    }
  }
  angles.sort((a, b) => a - b);
  const poly = [];
  for (const ang of angles) {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const dist = castRay(x, y, dx, dy, prepared, far, ang);
    poly.push({ ang, dist, x: x + dx * dist, y: y + dy * dist });
  }
  return poly;
}

// ── Shadow geometry ─────────────────────────────────────────────────────────────────────
// The polygon's COMPLEMENT, as a list of convex quads (each a flat array of 8 numbers,
// x0,y0,x1,y1,...) ready to fill.
//
// For the angular slice between consecutive polygon vertices, the lit part is the triangle
// (viewer, pi, pj) and the dark part is everything beyond the straight edge pi→pj. So each slice
// contributes one quad: pi, pj, and those two points pushed radially out past the cull radius.
// Because the slices are angularly disjoint, so are the quads — which is what lets the caller fill
// them all at one alpha and get a perfectly uniform darkness with no seams and no double-darkening.
//
// Slices where BOTH ends already reached `far` are skipped: that is open sky, and its quad would be
// an off-screen sliver between the cull radius and the overshoot radius.
export function shadowWedges(poly, x, y, far) {
  const out = [];
  if (poly.length < 2) return out;
  const outer = far * WEDGE_OVERSHOOT;
  const lit = far * 0.999;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (a.dist >= lit && b.dist >= lit) continue;
    let span = angDelta(b.ang, a.ang);
    if (span <= 0) span += 2 * Math.PI;
    if (span >= Math.PI) continue;         // the wrap-around slice of a degenerate fan; skip
    const steps = Math.max(1, Math.ceil(span / MAX_WEDGE_RAD));
    for (let k = 0; k < steps; k++) {
      // Subdivide along the STRAIGHT near edge, so the lit/dark boundary is bit-for-bit the true
      // polygon edge; only the far boundary gains resolution.
      const t0 = k / steps, t1 = (k + 1) / steps;
      const p0x = a.x + (b.x - a.x) * t0, p0y = a.y + (b.y - a.y) * t0;
      const p1x = a.x + (b.x - a.x) * t1, p1y = a.y + (b.y - a.y) * t1;
      out.push([p0x, p0y, p1x, p1y, ...push(x, y, p1x, p1y, outer), ...push(x, y, p0x, p0y, outer)]);
    }
  }
  return out;
}

// Push a point radially away from the viewer to exactly `dist` from it.
function push(x, y, px, py, dist) {
  const dx = px - x, dy = py - y;
  const len = Math.hypot(dx, dy) || 1;
  return [x + (dx / len) * dist, y + (dy / len) * dist];
}

// Convenience: blockers → fillable shadow quads, in one call. The arena scene uses this; the pieces
// are exported separately so the geometry can be unit-tested a stage at a time.
export function computeShadowWedges(x, y, radiusPx, terrainAt, opts = {}) {
  const segs = collectShadowSegments(x, y, radiusPx, terrainAt, opts);
  if (!segs.length) return [];
  const poly = computeVisibilityPolygon(x, y, segs, radiusPx);
  return shadowWedges(poly, x, y, radiusPx);
}

// ── Point queries against the same blocker set ──────────────────────────────────────────
// #337 v2 needs a per-ENTITY answer ("can the player see this enemy through the breach?"), not just
// the drawable polygon. Doing that by point-in-polygon on the sweep output is fiddly (the polygon is
// star-shaped and its vertices are ±ε pairs); a single segment-vs-segment test against the same
// blockers is exact, cheaper for a handful of entities, and — crucially — uses the SAME segment set
// the drawn polygon came from, so what you can see and what you can shoot cannot disagree.
export function pointVisibleFrom(x, y, tx, ty, segments) {
  const dx = tx - x, dy = ty - y;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const sx = s.x1 - s.x0, sy = s.y1 - s.y0;
    const denom = dx * sy - dy * sx;
    if (denom === 0) continue;                          // parallel
    const t = ((s.x0 - x) * sy - (s.y0 - y) * sx) / denom;
    if (t <= 0 || t >= 1) continue;                     // crossing is off the viewer→target span
    const u = ((s.x0 - x) * dy - (s.y0 - y) * dx) / denom;
    if (u < 0 || u > 1) continue;                       // misses the blocker itself
    return false;
  }
  return true;
}

// Exported for the scene's own bookkeeping/tests.
export const _internals = { ANGLE_EPS, ON_TOP_PX, MAX_WEDGE_RAD, WEDGE_OVERSHOOT, castRay, prepare, angDelta };
