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
import { HEX_SIZE, axialKey, pixelToHex, hexToPixel, neighbors, hexesAlongSegment } from './hexgrid.js';
import { edgeKey, edgeEndpoints, segmentCrossT, pointSegmentDistance } from './hexEdges.js';

// HP per SPAN (one hex edge). #313 (owner-confirmed retune): raised 55 → 200. Every destructible
// structure used to be more fragile than the cheapest combat unit — against #299's unit toughness
// scale (tank 80, quadruped 150, light mech 200, player 600) a 55hp span fell to a four-weapon
// mech in about half a second, which made the gate a speed bump. 200 puts a single span on par
// with a light mech, so punching a hole is a deliberate several-second commitment under fire.
// Since the mech collides as a POINT against terrain and walls alike, breaching just ONE span
// already opens a drivable gap (a hex edge is HEX_SIZE ≈ 48px long and its two flanking spans only
// eat WALL_THICKNESS_PX/2 off each end), so the toughness lives in the per-span pool rather than in
// needing several — that's exactly why it can afford to be this high. Owner: tunable.
export const WALL_EDGE_HP = 200;

// #288: how much of the normal building-STOMP rate a wall takes when the mech simply leans on it
// (scenes/arena/world.js `_stompBuildingAt`). A wall is stompable like any other structure — that
// affordance is unchanged — but a hardened blast wall shouldn't be a shack: at the full stomp rate
// (STOMP_DPS 45) a span would fall after barely a second of pressing against it, which makes the
// gate something you drive through rather than something you shoot through. At a quarter rate it's
// a genuine several-second grind under fire, so shooting stays the sensible route while ramming is
// still a desperate last resort. #313 re-checked this after WALL_EDGE_HP went 55 → 200, by
// MEASURING it in the real game (scripts/audit-destructible-313.mjs) rather than modelling it —
// which matters, because the naive arithmetic (STOMP_DPS 45 × 0.25 ≈ 11 HP/s ⇒ ~18s) is wrong:
// `_stompBuildingAt` scales its bite by `speedFrac`, and a mech pressed against a wall has
// STALLED, so the real rate is far below the nominal one. Measured: 51s of flat-out leaning to
// break a span, vs 1.8s of shooting it with a four-weapon loadout. Ramming is therefore no longer
// a meaningful last resort at this HP — it reads as "the wall is not stompable." Left at 0.25
// because #313's brief was HP only, but this is the knob to revisit (or drop the speedFrac scaling
// for walls) if the owner ever wants ramming to be a real option again. Owner: tunable.
export const WALL_STOMP_FACTOR = 0.25;

// How thick a wall reads/collides, in px, centred on the hex boundary — ~30% of a hex edge's own
// length, so it looks like a substantial blast wall straddling the line without visibly eating into
// either neighbouring tile. This is what makes every EXISTING point-shaped world query (`_blocked`,
// `_isWall`, the 8px LOS ray march) work against an edge unchanged: a wall is "solid" within half
// this distance of its segment. The exact swept crossing tests below are what stop anything fast
// enough to step over a 14px band from tunnelling.
export const WALL_THICKNESS_PX = 14;

// ── Span ROLE (#309) ────────────────────────────────────────────────────────────────────
// A span is otherwise identical whatever it does — same HP pool, same geometry, same index — so
// what a particular span IS gets expressed as a plain string `role` rather than as a subclass or a
// parallel structure. `wall` is the default (a plain blank span); `gate` is #309's sally port. This
// is deliberately open-ended: #310 mounts rail-lance turrets on spans, which is the same shape
// again (`role: 'turret'`), and any future span variant slots in without touching construction,
// indexing, damage, or the seal.
//
// The ONE behavioural hook a role gets is `open`: a span whose role opens can, while open, be
// stepped through — by ANYONE, player included (#309 playtest). The seal is therefore a statement
// about a CLOSED gate, not about gates in general: a shut gate, a solid span, a ring vertex, and
// every seam between them are impassable to the player, and an open gate is a genuine doorway that
// he may drive through if he times it. What no player action can do is make one open.
export const SPAN_ROLE_WALL = 'wall';
export const SPAN_ROLE_GATE = 'gate';
// #310: a span that carries a rail-lance gun on its parapet. Taking the role seam #309 left
// open, exactly as invited above — a turret span is a NORMAL span in every mechanical respect
// (same 200hp pool, same geometry, same index, same `blocksSpan` answer), and the gun is a
// separate enemy unit garrisoning it, not a property of the wall. That separation is what keeps
// the seal proof untouched: `blocksMovement`/`blocksSpan` never branch on this role, so a turret
// span is passability-identical to a blank one, and #288's hex-graph and pixel-space seal tests
// bind unchanged. It is decoration plus a garrison, never a change to the barrier itself.
export const SPAN_ROLE_TURRET = 'turret';

// Does this span block an actor RIGHT NOW? Destroyed spans block nothing (that's a breach), and an
// OPEN GATE blocks nothing either — it is a real doorway, standing open, and anyone may walk
// through it.
//
// #309 playtest ("player should be able to pass through the gate when it's open, it just shouldn't
// open FOR the player") RETIRED the `passOpenGates` opt-in this function used to carry. That flag
// existed to make an open gate passable to enemies and to sight/fire while keeping the player out,
// which needed every caller to declare which side it was on. Now that an open gate is open to
// EVERYONE, every caller wanted the same answer, and a parameter whose callers all pass the same
// value is a place for them to disagree by accident rather than a real degree of freedom. So it is
// gone: open-gate passability is unconditional and there is exactly one answer to "is this span
// solid". What stays enemies-only is the TRIGGER, not the passability — a gate opens because a
// garrison unit needs out (see gateDemand.js), never because the player is near or wants in.
//
// FOR OTHER SYSTEMS CONSUMING SPANS (#306's raycast shadows, #310's wall-mounted turrets): this is
// the canonical "is this span solid" predicate — prefer it over reading `destroyed`/`open` by hand
// so a new role can never be solid to one system and not another. The span's own state is plain
// readable data either way — `role`, `open` (fully open, passable), and `openFrac` (0..1, the
// leaves' animated travel, for anything that wants to fade a shadow as the doors move).
export function blocksSpan(edge) {
  if (!edge || edge.destroyed) return false;
  if (edge.role === SPAN_ROLE_GATE && edge.open) return false;
  return true;
}

// Set a gate span's open/closed state. A no-op on a non-gate or a destroyed span — a blown gate is
// just a breach and can never re-close, which is the answer to "what if the player destroys a
// closed gate": the span dies like any other and the hole it leaves is permanent.
export function setGateOpen(set, edge, open) {
  if (!edge || edge.role !== SPAN_ROLE_GATE || edge.destroyed) return false;
  edge.open = !!open;
  return edge.open;
}

// Every gate span in the set (standing or not), optionally filtered to one base.
export function gateEdges(set, baseId = null) {
  if (!set) return [];
  return [...set.edges.values()].filter(
    (e) => e.role === SPAN_ROLE_GATE && (baseId == null || e.baseId === baseId),
  );
}

// #310: every turret-carrying span in the set (standing or not), optionally filtered to one base.
// Mirrors `gateEdges` exactly — the scene uses it once at spawn time to seat a gun per span.
export function turretEdges(set, baseId = null) {
  if (!set) return [];
  return [...set.edges.values()].filter(
    (e) => e.role === SPAN_ROLE_TURRET && (baseId == null || e.baseId === baseId),
  );
}

// #310: how far OUTBOARD of its span's centreline a wall turret's gun is seated, in px. This is
// not a cosmetic nicety — it is what makes the gun able to shoot at all.
//
// Every unit in the game, flyers included since #316, must pass `aimAndFire`'s line-of-sight gate
// before it opens fire (scenes/arena/enemyBehaviors.js). LOS is traced from the unit's own
// position, and a gun seated exactly ON the span's centreline traces its outward ray from inside
// (or precisely along) its own 14px-thick wall band — a degenerate case that at best relies on
// `wallEdgeCrossing`'s "a path that merely STARTS inside the band is not a contact" clause, and at
// worst has the turret permanently blinded by the very wall it is mounted on. Seating it clear of
// the outer face removes the question entirely rather than depending on a boundary case.
//
// > half of WALL_THICKNESS_PX (7), so the mount sits fully outboard of the plate with a little
// margin, and it reads correctly too: the gun overhangs the parapet's OUTER face, looking out over
// the approach. The deliberate corollary is that its own wall blocks it from firing INTO the
// compound — a perimeter gun that covers the ground outside the wall and nothing else, which is
// what a wall gun should do. Once the player breaches and is inside, the ring's turrets on the far
// side genuinely cannot shoot him through their own wall, and that is a real, earned reprieve.
export const TURRET_MOUNT_OFFSET_PX = 13;

// The world-space point a span's turret is seated at: the span's midpoint pushed OUTWARD (away
// from the base-side hex `a`, toward the outer hex `b`) by TURRET_MOUNT_OFFSET_PX. Pure geometry,
// derived from the record's own stored hexes, so nothing downstream has to know which side of a
// span the compound is on. Returns null for a malformed record.
export function spanTurretMount(edge, offset = TURRET_MOUNT_OFFSET_PX) {
  if (!edge?.a || !edge?.b) return null;
  const mx = (edge.x0 + edge.x1) / 2, my = (edge.y0 + edge.y1) / 2;
  const inner = hexToPixel(edge.a.q, edge.a.r);
  const outer = hexToPixel(edge.b.q, edge.b.r);
  const dx = outer.x - inner.x, dy = outer.y - inner.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: mx + (dx / len) * offset, y: my + (dy / len) * offset };
}

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
      // #309: role travels on the DEF (worldgen decides which spans are gates), so nothing
      // downstream has to re-derive it geometrically. A gate starts CLOSED — a base the player
      // hasn't woken is a shut fortress.
      role: def.role ?? SPAN_ROLE_WALL, open: false,
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

// #309: the single choke point where "is this span solid to THIS caller" is decided — every query
// below funnels through here, so an open gate can never leak into one query's notion of solidity
// while staying solid in another's.
function collectHex(set, q, r, out) {
  const list = set.byHex.get(axialKey(q, r));
  if (!list) return;
  for (const e of list) if (blocksSpan(e)) out.add(e);
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
