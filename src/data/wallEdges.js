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
// scale (tank 80, carrier 150, light mech 200, player 600) a 55hp span fell to a four-weapon
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

// ── #320: collision inflation by BODY RADIUS ────────────────────────────────────────────
// Playtest: "sometimes tanks can visibly poke through a bit" — and its twin symptom, "I'm able to
// shoot OVER walls if I stand real close." Both had ONE cause: every query below treated a unit as
// a POINT, so a unit stopped when its CENTRE reached ±7px of the span's centreline while its body
// (28px for a mech, up to 24px for a vehicle) carried on through the plate. The muzzle, offset
// forward of that centre, then ended up on the far side of the wall, so the shot's ray started
// past the barrier and never crossed it.
//
// The fix is Minkowski inflation: a unit of radius R stops when its BODY meets the plate, i.e. its
// centre halts at `R + WALL_THICKNESS_PX / 2` from the span. Callers pass their own radius
// (scenes/arena/shared.js `wallCollideRadius`); everything genuinely point-shaped — rounds, sight
// rays, placement scans, #310's turret exemption — keeps passing 0 and is bit-for-bit unchanged.
//
// THE CATCH, and why `spanCollideSegment` exists. A hex edge is HEX_SIZE = 48px long, and a
// breached span's two ring VERTICES are only 24px from its midpoint. Inflate naively by a mech's
// body radius and the centre must stay clear of both vertices — so a one-span breach becomes
// physically unenterable, which would break the drive-through #288 verified and the whole premise
// of #313's per-span HP ("breaching just ONE span already opens a drivable gap"). Measured: naive
// inflation seals a breach for any R > 17.
//
// So a span's COLLISION segment is its centreline SHORTENED by R at each end (clamped to its
// midpoint), then inflated by R. Two consequences, both load-bearing and both verified in
// wallEdges.test.js:
//
//   • THE SEAL ONLY EVER GETS STRONGER — the inflated shortened capsule is a strict SUPERSET of
//     today's 14px band. Proof: take any point p within 7px of the full centreline, and let c be
//     its closest point on that centreline. Either c survives the shortening (so p is within 7 of
//     the collision segment), or c lies within R of an end, in which case the shortened endpoint e
//     satisfies dist(p, e) <= dist(p, c) + R <= 7 + R. Either way p is inside. This is why #288's
//     720-bearing pixel probes and the ring-VERTEX cases cannot regress: a vertex stays covered by
//     BOTH of its spans' capsules with 7px of margin, exactly the margin it has today.
//   • A BREACH AND AN OPEN GATE MOUTH STAY DRIVABLE — pulling the flanking spans back off the
//     shared vertex reopens the pinch. Measured live on real maps: every breachable span leaves a
//     34px hole against the 27px a full-radius body needs.
//
// Physically this says the plate resists you across its FACE at full body width, while the last R
// of it near a corner is treated as a chamfer you can round rather than a post you snag on. That
// is both the forgiving choice for driving and the honest one for a barrier whose whole point is
// that a hole in it is a way through.
export function spanCollideSegment(edge, radius = 0) {
  if (!(radius > 0)) return edge;
  const dx = edge.x1 - edge.x0, dy = edge.y1 - edge.y0;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return edge;
  const cut = Math.min(radius, len / 2);
  const ux = dx / len, uy = dy / len;
  return {
    x0: edge.x0 + ux * cut, y0: edge.y0 + uy * cut,
    x1: edge.x1 - ux * cut, y1: edge.y1 - uy * cut,
  };
}

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

// #427: the SHOT-solidity predicate, the counterpart to `blocksSpan`'s MOVEMENT solidity. A gate is
// now TWO door leaves that part toward their posts when it opens but only retract ~70%, leaving a
// solid stub on each side and — as the confirmed simplification — kept as ONE logical edge that is
// always hittable rather than two literal 70%/30% hitboxes. So an OPEN gate blocks and receives fire
// even though a unit may drive through the central passage: shots no longer sail through the mouth,
// they detonate on the gate and route to its single HP pool (superseding #412's aim-pip workaround).
// Every OTHER standing span is solid to shots exactly as it is to movement, so this differs from
// `blocksSpan` for gates alone. Destroyed spans stop nothing either way — that is the breach.
export function blocksShot(edge) {
  return !!edge && !edge.destroyed;
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

// #310 (owner, playtest 2026-07-19: "wall turrets should be centered on the wall so they can shoot
// inside OR outside of the wall"): a wall turret sits ON its span's centreline, not outboard of it.
//
// This used to be 13px — clear of the wall's 7px half-thickness — so the gun overhung the OUTER
// face and its own wall band blocked it from firing back into the compound. That was deliberate at
// the time ("a perimeter gun covers the ground outside the wall and nothing else"), and the owner
// has now overruled it: the gun straddles the line and engages targets on EITHER side, so a player
// who breaches gets no free reprieve from the ring's guns simply by being through it.
//
// The offset existed for a real reason, not just for looks: every unit must pass `aimAndFire`'s
// line-of-sight gate before it opens fire, and LOS is traced with `wallEdgeCrossing` FROM the
// unit's own position — a gun seated exactly on the centreline crosses that centreline at t ≈ 0 on
// every single ray it traces, in every direction, so a naively-centred turret is permanently blind.
// The fix is explicit rather than geometric: the LOS/fire path now IGNORES the shooter's own span
// (`ignoreKey` below, threaded from the unit's `spanKey`), so the gun sees past the wall it is
// bolted to and nothing else. Every OTHER span, including the rest of its own ring, still blocks it
// exactly as before — which is what keeps only two or three guns able to bear at once.
export const TURRET_MOUNT_OFFSET_PX = 0;

// The world-space point a span's turret is seated at: its midpoint, optionally pushed OUTWARD
// (away from the base-side hex `a`, toward the outer hex `b`) by `offset`. At the current offset
// of 0 this is simply the midpoint; the outward derivation is kept because it costs nothing, it
// is what `offset` means, and callers (art) still ask which way is out.
export function spanTurretMount(edge, offset = TURRET_MOUNT_OFFSET_PX) {
  if (!edge?.a || !edge?.b) return null;
  const mx = (edge.x0 + edge.x1) / 2, my = (edge.y0 + edge.y1) / 2;
  if (!offset) return { x: mx, y: my };
  const inner = hexToPixel(edge.a.q, edge.a.r);
  const outer = hexToPixel(edge.b.q, edge.b.r);
  const dx = outer.x - inner.x, dy = outer.y - inner.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: mx + (dx / len) * offset, y: my + (dy / len) * offset };
}

// #426 (owner decision): a wall turret is hittable from its EXPOSED side, but its own wall may
// still block a shot fired from BEHIND it (inside the compound). "Exposed" is OUTWARD — away from
// `edge.a` (the base-interior hex) toward `edge.b` (the outer hex) — the exact same direction
// `spanTurretMount`'s `offset` already pushes along, so "outward" means one consistent thing
// everywhere a span is reasoned about.
//
// Returns a SIGNED distance of `(x, y)` from the span's centreline along that outward normal:
// positive is outward/exposed, negative is inward/behind. Callers that just need a boolean use
// `isOutwardOfSpan` below; the signed form exists so a caller can also ask "how far", though
// nothing needs that yet.
export function wallSpanOutwardSign(edge, x, y) {
  if (!edge?.a || !edge?.b) return 0;
  const inner = hexToPixel(edge.a.q, edge.a.r);
  const outer = hexToPixel(edge.b.q, edge.b.r);
  const nx = outer.x - inner.x, ny = outer.y - inner.y;
  const len = Math.hypot(nx, ny) || 1;
  const mx = (edge.x0 + edge.x1) / 2, my = (edge.y0 + edge.y1) / 2;
  return (x - mx) * (nx / len) + (y - my) * (ny / len);
}

// #426: is `(x, y)` on the EXPOSED (outward) side of `edge`? A missing/malformed edge fails
// CLOSED (false — not exposed), so a bad lookup can never accidentally open a shot through a wall.
export function isOutwardOfSpan(edge, x, y) {
  return wallSpanOutwardSign(edge, x, y) > 0;
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
// #320: a RADIUS-inflated query reaches further than a point one, so the broad phase has to reach
// further too or a span could be solid and never even be considered — the failure mode that turns
// a collision fix into a tunnelling bug. The fan of axial offsets within `rings` steps is built
// once per ring count and cached, because this runs per movement substep per unit and must not
// allocate: the point case (rings = 1) is the original "own hex + 6 neighbours" as a 7-entry flat
// array walk, with no Set and no per-call arrays.
const OFFSET_FANS = new Map();
function offsetFan(rings) {
  let fan = OFFSET_FANS.get(rings);
  if (fan) return fan;
  fan = [];
  for (let dq = -rings; dq <= rings; dq++) {
    for (let dr = Math.max(-rings, -dq - rings); dr <= Math.min(rings, -dq + rings); dr++) {
      fan.push(dq, dr);                       // flat pairs — no per-entry object
    }
  }
  OFFSET_FANS.set(rings, fan);
  return fan;
}

function collectAround(set, q, r, out, radius, solid) {
  // Hex inradius (centre to edge midpoint) for pointy-top hexes of side HEX_SIZE — one extra ring
  // per inradius of reach. R = 0 gives 1 ring, i.e. exactly the original fan.
  const rings = 1 + Math.ceil(Math.max(0, radius) / (HEX_SIZE * Math.sqrt(3) / 2));
  const fan = offsetFan(rings);
  for (let i = 0; i < fan.length; i += 2) collectHex(set, q + fan[i], r + fan[i + 1], out, solid);
}

function candidatesNear(set, x, y, out, radius = 0, solid = blocksSpan) {
  const h = pixelToHex(x, y);
  collectAround(set, h.q, h.r, out, radius, solid);
}

// #309: the single choke point where "is this span solid to THIS caller" is decided — every query
// below funnels through here, so an open gate can never leak into one query's notion of solidity
// while staying solid in another's.
// #427: `solid` is that notion, made explicit. It defaults to `blocksSpan` (MOVEMENT solidity — an
// open gate is a doorway), so every existing movement/sight caller is bit-for-bit unchanged; the
// shot-collision queries (world.js `_wallEdgeHit`/`_isWall`/`_isWallForRound`, and hit routing)
// pass `blocksShot`, under which an open gate is a solid, hittable target.
function collectHex(set, q, r, out, solid = blocksSpan) {
  const list = set.byHex.get(axialKey(q, r));
  if (!list) return;
  for (const e of list) if (solid(e)) out.add(e);
}

// Candidate edges a straight segment could possibly cross. If a segment crosses the boundary
// between hexes A and B then it passes through BOTH A and B by definition, so indexing off the
// hexes the segment traverses (`hexesAlongSegment` — the same supercover primitive the tile
// collision already uses) finds every crossable edge. Each traversed hex's 6 neighbours are
// included as well, purely as belt-and-braces against `hexesAlongSegment`'s documented dedup quirk
// at grazing angles: if it ever skipped BOTH hexes flanking one edge, that edge would otherwise be
// missed. Cheap — the whole thing is a handful of Map lookups that miss immediately on a map with
// no walls near the ray.
function candidatesAlong(set, x0, y0, x1, y1, radius = 0, solid = blocksSpan) {
  const out = new Set();
  for (const h of hexesAlongSegment(x0, y0, x1, y1)) collectAround(set, h.q, h.r, out, radius, solid);
  return out;
}

// ── Queries ─────────────────────────────────────────────────────────────────────────────
// The standing wall a world point is INSIDE (within half the wall's thickness of its span), or
// null. This is the point-shaped query: it's what lets the existing `_blocked`/`_isWall`/8px-ray
// machinery treat an edge wall as solid without any of it learning what an edge is.
// `ignoreKey` (#310): one span this query pretends is not there — see `wallEdgeCrossing`'s own
// note. Needed on the POINT form too, not just the swept one: the sampled ray marchers
// (`_wallDistance` -> `_isWall`, and the projectiles' `_isWallForRound`) test the band by point,
// and a wall turret sits inside its own band, so without this a beam aimed at the gun stops on the
// sample 4px short of it even though the swept crossing test correctly let it through. Measured in
// the real game, not reasoned about — the swept exemption alone was not enough.
// #320: `radius` is the querying BODY's radius — 0 (the default) is the original point query, and
// every point-shaped caller (rounds, sight rays, placement scans, #310's turret exemption) keeps
// that. A positive radius tests the unit's whole circle against the span's collision segment; see
// `spanCollideSegment`. The broad phase widens with it, since an inflated span reaches further
// than its own hex pair.
export function wallEdgeAt(set, x, y, thickness = WALL_THICKNESS_PX, ignoreKey = null, radius = 0, solid = blocksSpan) {
  if (!set || set.edges.size === 0) return null;
  const cand = new Set();
  candidatesNear(set, x, y, cand, radius, solid);
  const half = thickness / 2 + Math.max(0, radius);
  let best = null, bestD = Infinity;
  for (const e of cand) {
    if (ignoreKey && e.key === ignoreKey) continue;
    const s = spanCollideSegment(e, radius);
    const d = pointSegmentDistance(s.x0, s.y0, s.x1, s.y1, x, y);
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
// `ignoreKey` (#310): one span, by canonical key, that this query pretends is not there. Exists
// for two callers, both about a WALL TURRET seated on that span's centreline (#310's centred
// mounts): the gun's own line of sight and outgoing fire, and fire aimed AT the gun. Without it a
// centred gun crosses its own span on every ray it traces — blind in every direction — and is
// itself unhittable, since the wall and the gun occupy the same point. Scoped to a single named
// span, so the gun is still blinded by every OTHER wall (the far side of its own ring included)
// and no shot gains a lane through any wall it was not already aimed through.
// #320: `radius` inflates the moving body exactly as in `wallEdgeAt` — 0 keeps the original
// point-swept behaviour for rounds and rays. The caller (locomotion.js) rejects the whole step on
// a contact, so a `t` that names the centreline rather than the exact moment of first touch never
// has to be resolved.
export function wallEdgeCrossing(set, x0, y0, x1, y1, thickness = WALL_THICKNESS_PX, ignoreKey = null, radius = 0, solid = blocksSpan) {
  if (!set || set.edges.size === 0) return null;
  const cand = candidatesAlong(set, x0, y0, x1, y1, radius, solid);
  if (cand.size === 0) return null;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const half = thickness / 2 + Math.max(0, radius);
  let best = null, bestT = Infinity;
  for (const e of cand) {
    if (ignoreKey && e.key === ignoreKey) continue;
    // The two clauses use DIFFERENT geometry, and that asymmetry is load-bearing (#320).
    //
    // ANTI-TUNNELLING uses the span's FULL centreline, never the shortened one. Physically
    // crossing the wall's own line is a contact at any radius — and a span shorter than 2R
    // degenerates to a POINT under `spanCollideSegment`, which a zero-length crossing test can
    // never detect, so testing the shortened segment here would hand a big mech a tunnel straight
    // through every 48px span at speed. (Caught by the "no speed out-steps an inflated span" test,
    // which failed exactly this way before the split.) Using the full line is also strictly the
    // stronger seal: it is the unchanged point-form clause.
    let t = segmentCrossT(x0, y0, x1, y1, e.x0, e.y0, e.x1, e.y1);
    // PROXIMITY uses the shortened segment inflated by the body radius. A step that never crosses
    // the centreline can still END with the body overlapping the plate (driving at a wall and
    // stopping short, or a round detonating on its face) — a contact at t = 1. This is the clause
    // the corner chamfer belongs to, and the only one a breach's drivability depends on.
    if (t == null) {
      const s = spanCollideSegment(e, radius);
      if (pointSegmentDistance(s.x0, s.y0, s.x1, s.y1, x1, y1) <= half) t = 1;
    }
    if (t == null || t >= bestT) continue;
    best = e; bestT = t;
  }
  if (!best) return null;
  return { edge: best, t: bestT, x: x0 + (x1 - x0) * bestT, y: y0 + (y1 - y0) * bestT, dist: len * bestT };
}

// #320: the first standing span that genuinely SEPARATES two points — i.e. whose centreline the
// segment actually crosses, leaving the two ends on opposite sides — or null.
//
// Deliberately NOT `wallEdgeCrossing`, and the difference is the whole point. That function also
// reports a contact when a segment merely ENDS inside the wall's thickness, which is right for
// movement and for a round detonating on a plate, but wrong here: this backs the shot-origin guard
// (world.js `_muzzleWallBlocked`), and a muzzle that is inside the plate but still on the shooter's
// own side is a barrel pressed AGAINST the wall, not through it. Suppressing that shot would stop
// the player breaching a wall he is leaning on — the core loop of #288/#313 — so it must still fire
// and let the round resolve its hit on the span normally. Measured in the real game: at the closest
// stance the fix permits, a long arm weapon's tip sits ~5px from the centreline, well inside the
// 7px band, so this distinction is load-bearing and not a hypothetical.
export function wallEdgeSeparating(set, x0, y0, x1, y1) {
  if (!set || set.edges.size === 0) return null;
  const cand = candidatesAlong(set, x0, y0, x1, y1);
  let best = null, bestT = Infinity;
  for (const e of cand) {
    const t = segmentCrossT(x0, y0, x1, y1, e.x0, e.y0, e.x1, e.y1);
    if (t == null || t >= bestT) continue;
    best = e; bestT = t;
  }
  return best;
}

// The standing wall nearest a world point within `maxDist` (used to route a weapon hit that landed
// on/next to a wall onto the right span), or null.
export function nearestWallEdge(set, x, y, maxDist = HEX_SIZE, solid = blocksSpan) {
  if (!set || set.edges.size === 0) return null;
  const cand = new Set();
  candidatesNear(set, x, y, cand, 0, solid);
  let best = null, bestD = maxDist;
  for (const e of cand) {
    const d = pointSegmentDistance(e.x0, e.y0, e.x1, e.y1, x, y);
    if (d <= bestD) { best = e; bestD = d; }
  }
  return best;
}

// ── Destruction ─────────────────────────────────────────────────────────────────────────
// #392 (owner retune 2026-07-20, SUPERSEDES the first landing's "open the whole wall hex" rule;
// tightened 2026-07-21 to be STRICT): destroying a span opens a breach of the hit span plus the ONE
// span immediately adjacent on EACH side along the SAME wall run (its collinear left/right
// neighbour). A breach reads the same width everywhere instead of swallowing an entire hex ring
// (which felt wrong on concave stretches). The whole-hex cascade (`wallHexSiblings`, keyed on the
// base-side coord `a`) is gone; contiguity is GEOMETRIC.
//
// STRICT (owner 2026-07-21): NO BACKFILL. If a side has no collinear neighbour (the hit span is at
// the end of a run, a lone span, or the only spans at that corner turn away) that side contributes
// nothing and the other side does NOT reach further to compensate. So a mid-run hit fells 3, an
// end-of-run hit fells 2, and a lone span fells 1 — never a backfilled 3.

// The MOST spans a single breach takes down: the hit span + up to one collinear neighbour on each
// side of it along the run. Fewer at ends/corners. Owner: tunable.
export const BREACH_SPAN_COUNT = 3;

// Two spans meet along the wall run iff they share a VERTEX — a hex corner. Each span carries its
// two pixel corners as (x0,y0)/(x1,y1); a rounded key collapses the float noise between the SAME
// corner computed from either span's own hex (corners sit ~24–48px apart, so rounding to 0.01px can
// never conflate two distinct ones). Sharing a vertex makes two spans CANDIDATE neighbours; which
// one actually continues the run is then a collinearity test (`collinearNeighbor`), so a breach
// follows the wall line around convex or concave corners without grabbing a perpendicular spur that
// merely touches the same corner.
function vertexKey(x, y) {
  return `${Math.round(x * 100)},${Math.round(y * 100)}`;
}

// Every STANDING span (other than `edge` and anything already felled this breach) that touches the
// vertex (vx,vy). A pre-existing breach (`destroyed`) is skipped so a run walk stops at an existing
// gap instead of hopping across it. Scans the set's edges directly — destruction is rare and a wall
// set is small, so the O(n) walk costs nothing and needs no corner index.
function spansAtVertex(set, edge, vx, vy, visited) {
  const vk = vertexKey(vx, vy);
  const out = [];
  for (const e of set.edges.values()) {
    if (e === edge || e.destroyed || visited.has(e)) continue;
    if (vertexKey(e.x0, e.y0) === vk || vertexKey(e.x1, e.y1) === vk) out.push(e);
  }
  return out;
}

// The ONE span that COLLINEARLY continues the hit span past the shared vertex (vx,vy), or null.
// `(farX,farY)` is the hit span's OTHER corner, so `d_in` is the run's travel direction ARRIVING at
// the vertex; a candidate's `d_out` is its own direction LEAVING the vertex toward its far corner.
//
// Adjacent hex spans are NEVER parallel — two edges of the same orientation don't share a corner —
// so a genuine run continuation always makes a 60° turn (dot(d_in, d_out) = +0.5), while a fold-back
// or a perpendicular spur meeting the vertex at a T-junction turns 120°/180° (dot <= -0.5). Every
// possible turn is a multiple of 60°, so requiring `dot > 0` cleanly admits ONLY the collinear
// continuation and rejects any cross-junction branch — no "nearest by distance" pick. When two
// candidates tie on straightness (a symmetric junction), the canonical edge key breaks it so the
// choice never depends on Map iteration order.
function collinearNeighbor(set, hit, vx, vy, farX, farY) {
  const inx = vx - farX, iny = vy - farY;
  const inLen = Math.hypot(inx, iny) || 1;
  const dix = inx / inLen, diy = iny / inLen;
  const vk = vertexKey(vx, vy);
  let best = null, bestDot = 0;
  for (const e of spansAtVertex(set, hit, vx, vy, EMPTY_VISITED)) {
    // The neighbour's far endpoint — whichever of its two corners is NOT the shared vertex.
    const atX0 = vertexKey(e.x0, e.y0) === vk;
    const nfx = atX0 ? e.x1 : e.x0, nfy = atX0 ? e.y1 : e.y0;
    const ox = nfx - vx, oy = nfy - vy, oLen = Math.hypot(ox, oy) || 1;
    const dot = dix * (ox / oLen) + diy * (oy / oLen);
    if (dot <= 1e-6) continue;                 // fold-back / perpendicular spur — not a continuation
    if (!best || dot > bestDot + 1e-6 ||
        (Math.abs(dot - bestDot) <= 1e-6 && e.key < best.key)) {
      best = e; bestDot = dot;
    }
  }
  return best;
}
const EMPTY_VISITED = new Set();

// The run breached when `hit` falls (#392, owner retune 2026-07-21 — STRICT: hit + immediate
// neighbour each side, NO backfill): `hit` first, then the ONE span that collinearly continues the
// run past each of `hit`'s two corners. No backfill — if a side has no collinear continuation (the
// hit span is at the end of a run, a lone span, or the only candidates turn away at a corner) that
// side contributes nothing; the other side does NOT reach further to compensate. So a mid-run hit
// fells 3, an end-of-run hit fells 2, and a lone span fells 1. `count` caps the total (3). Marks
// nothing itself; the caller collapses the returned spans.
function breachRun(set, hit, count) {
  const felled = [hit];
  if (!set || count <= 1) return felled;
  // One immediate neighbour per direction, seeded at each of the hit span's two corners.
  const sides = [
    { vx: hit.x0, vy: hit.y0, fx: hit.x1, fy: hit.y1 },
    { vx: hit.x1, vy: hit.y1, fx: hit.x0, fy: hit.y0 },
  ];
  for (const s of sides) {
    if (felled.length >= count) break;
    const n = collinearNeighbor(set, hit, s.vx, s.vy, s.fx, s.fy);
    if (n && !felled.includes(n)) felled.push(n);
  }
  return felled;
}

// Chip a span's HP. Each span keeps its OWN HP pool and takes its own hits — damaging one never
// chips its neighbours (no shared pool, no damage bleed). What happens on DEATH (#392): the span's
// collapse opens a breach of the hit span plus the ONE collinear neighbour on each side along the
// wall run — so the player grinds a single span down and the instant it falls a consistent-width gap
// opens, one span either side of the hole where the run has them. STRICT (owner 2026-07-21): no
// backfill — an end-of-run hit fells 2, a lone span 1, only a mid-run hit 3; a corner/junction never
// grabs a perpendicular span, only the collinear continuation of the same wall line.
//
// Returns `{ hp, destroyed, felled }`: `hp`/`destroyed` describe the span actually hit; `felled` is
// every span this call brought down (the hit span first, then its cascaded neighbours), so the scene
// can play collapse FX / drop wall turrets / invalidate sight+routes once per fallen span. `felled`
// is empty when the hit only chipped HP (or was a no-op). A destroyed span is marked (not deleted,
// so it keeps its identity/geometry for the renderer's collapse) and stops blocking movement,
// sight, and fire immediately. Damaging an already-destroyed span is a no-op.
export function damageWallEdge(set, edge, amount) {
  if (!edge || edge.destroyed) return { hp: 0, destroyed: false, felled: [] };
  edge.hp = Math.max(0, edge.hp - Math.max(0, amount));
  if (edge.hp > 0) return { hp: edge.hp, destroyed: false, felled: [] };
  edge.destroyed = true;
  const felled = breachRun(set, edge, BREACH_SPAN_COUNT);
  for (const span of felled) {
    if (span === edge) continue;
    span.hp = 0;
    span.destroyed = true;
  }
  return { hp: 0, destroyed: true, felled };
}
