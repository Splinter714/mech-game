// Split out of worldgen.js (#574): a base's perimeter wall ring, and which of its spans mount a
// wall turret. Pure logic, no Phaser. `placeBaseWalls` is called from worldgen.js's
// `generateTerrain`; it delegates gate-span selection to gateAssignment.js's `assignGates`.
import { axialKey, hexToPixel, neighbors } from './hexgrid.js';
import { isPassable as isPassableOf } from './terrain.js';
import { assignGates } from './gateAssignment.js';

// #288 (placement re-specced 2026-07-19 — "instead of a line across the corridor, let's do a full
// RING around the base"): one base's perimeter wall, as a set of hex EDGES. Returns
// `[{ baseId, edges: [{ a, b }] }]`, one entry per base that got a ring (`a`/`b` are the two
// adjacent axial coords the edge separates; `a` is always the BASE-side hex). Consumes nothing from
// `T` and writes nothing to it: an edge wall occupies no tile, so world-gen's terrain map is
// untouched by this pass — the caller hands the returned edges to `makeWallEdgeSet`
// (data/wallEdges.js) as their own parallel layer.
//
// THE CONSTRUCTION: the ring is the TOPOLOGICAL BOUNDARY OF THE BASE'S OWN FOOTPRINT — walk every
// hex of `base.footprint` and wall every edge whose far side is NOT in the footprint. Three
// properties fall straight out of that, none of which needs a patching pass:
//
//   1. SEALED, unconditionally. Any walk from outside the footprint to inside it must, at some
//      step, cross from a non-footprint hex to a footprint hex — and by definition every such
//      edge is walled. There is no seam, no corner gap, and no "between two spans" to slip
//      through: the boundary is a complete cut in the adjacency graph. The owner confirmed the
//      seal is deliberate (with #309's gates being enemies-only, BREACHING IS THE ONLY WAY IN).
//   2. NOTHING NATURAL BEHIND A SPAN. `a` is always a footprint hex, and `placeBases` paves the
//      entire footprint as base infrastructure — so every span backs onto the compound, which is
//      the "the bases should flow with no natural hexes directly behind each wall segment"
//      requirement, satisfied by construction rather than by a proximity heuristic.
//   3. It HUGS the base. There is no setback parameter anymore because there is no longer anything
//      for a setback to mean: the wall is the compound's own perimeter fence. `WALL_LINE_SETBACK_PX`
//      (250px, ~3 hex steps up-corridor) is deleted along with the BFS level-set construction it
//      fed — that whole approach put the wall out in alert-tower territory, which is what failed
//      the 2026-07-19 playtest.
//
// Deliberately walls boundary edges REGARDLESS of what's on the far side — including edges facing
// impassable terrain or the world boundary ring. Those spans are redundant for sealing (nothing
// walks through a mesa either), but the ring is a visible fortification and a fortification with
// its far wall missing because a lake happened to be there reads as broken. Keeping it
// unconditional also means the seal can never be quietly weakened by a later change to what counts
// as passable.
//
// Takes no `spine` and no `T`-derived reachability: unlike the deleted level-set version, a ring
// is a purely local property of the base, so it can't be thrown off by a corridor that doubles
// back (which broke two earlier constructions of the wall LINE on real curved seeds).
export function placeBaseWalls(T, bases) {
  const walls = [];
  if (!bases?.length) return walls;
  for (const base of bases) {
    const footprint = new Set((base.footprint ?? []).map((h) => axialKey(h.q, h.r)));
    if (!footprint.size) continue;
    const edges = [];
    for (const k of footprint) {
      const [q, r] = k.split(',').map(Number);
      for (const n of neighbors(q, r)) {
        if (footprint.has(axialKey(n.q, n.r))) continue;
        edges.push({ a: { q, r }, b: { q: n.q, r: n.r } });   // `a` = the base side
      }
    }
    // #310: turrets are assigned AFTER gates, and read the gate flags in order to avoid them —
    // see `assignWallTurrets`. Order matters here and nowhere else.
    if (edges.length) walls.push({ baseId: base.id, edges: assignWallTurrets(T, base, assignGates(T, base, edges)) });
  }
  return walls;
}

// ── #310: which spans of a ring mount a RAIL-LANCE TURRET ───────────────────────────────────
// Same shape as gateAssignment.js's `assignGates` and deliberately so: a turret span is one of the
// ring's own spans flagged `role: 'turret'` (data/wallEdges.js), keeping its HP pool, its geometry
// and its contribution to the seal. The gun itself is a separate dormant enemy unit garrisoning the
// span (scenes/arena/bases.js `_spawnWallTurrets`), not a property of the wall — so destroying the
// span destroys the gun (the #287 precedent), while the wall stays a wall.
//
// HOW MANY: PROPORTIONAL to the ring, clamped — `round(eligible * TURRET_SPAN_FRACTION)` into
// [MIN, MAX]. Not a fixed count, because base footprints differ in size and #308 now runs five of
// them: a flat 3 would make a big compound feel under-defended and a small one feel like a
// porcupine. Proportional keeps turret DENSITY along the wall roughly constant, so the wall reads
// the same however big the base is. The clamp is what stops the proportion from doing anything
// silly at the extremes — every ring gets at least two (one gun is a single blind spot away from
// being no guns), and never more than five however large the compound, because past that the
// approach stops having any survivable heading at all.
//
// WHERE THEY SIT: EVENLY SPREAD by bearing, with the first anchored on the player's APPROACH (the
// same origin-facing bearing #309's front gate uses, and for the same reason — it needs no spine
// argument and no progress derivation). The alternative, concentrating them on the approach face,
// was considered and rejected: it makes flanking to the far side a completely safe answer, which
// turns a fortification into a puzzle with one solution. Spread evenly, there is no free heading —
// but a gun is still blocked by every span of the ring OTHER than the one it is bolted to (#310's
// centring exempts only its own span, see TURRET_MOUNT_OFFSET_PX), so only the two or three facing
// the player's arc can engage him at once. The ring is threatening from every side without ever
// bringing its whole armament to bear — and since the centring, that holds INSIDE the compound too
// rather than the guns all falling silent the moment the player is through the wall.
//
// ELIGIBILITY, two rules:
//   - NEVER a gate span. A gate that is also a gun emplacement muddles both reads: the gate's
//     whole visual job (#309) is "this is the moving part, this is where they come out", and
//     bolting a gun on top makes the one span on the ring the player most needs to read at a
//     glance into the busiest. They are also mechanically at odds — a gate wants to be approached
//     (it is the sally port) and a turret wants to deny approach. Keeping them disjoint means
//     every span on the ring says exactly one thing.
//   - The OUTER hex must be passable ground, matching gate eligibility. A gun whose entire field
//     of fire is the inside of a mesa is wasted, and worse, it is wasted INVISIBLY — the player
//     never learns why that stretch of wall was harmless.
// If nothing is eligible the ring simply gets no turrets, the same safe degradation as gates.
const TURRET_SPAN_FRACTION = 0.22;
const TURRET_SPANS_MIN = 2;
const TURRET_SPANS_MAX = 5;

export function assignWallTurrets(T, base, edges) {
  const c = hexToPixel(base.center.q, base.center.r);
  const eligible = edges
    .filter((e) => e.role !== 'gate' && isPassableOf(T?.get(axialKey(e.b.q, e.b.r))))
    .map((e) => {
      const o = hexToPixel(e.b.q, e.b.r);
      return { e, bearing: Math.atan2(o.y - c.y, o.x - c.x) };
    });
  if (!eligible.length) return edges;
  const count = Math.max(TURRET_SPANS_MIN, Math.min(TURRET_SPANS_MAX,
    Math.round(eligible.length * TURRET_SPAN_FRACTION)));
  const approach = Math.atan2(-c.y, -c.x);
  const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const taken = new Set();
  // One evenly spaced target bearing per turret, starting at the approach; each claims the nearest
  // still-unclaimed eligible span. A ring can have fewer eligible spans than the count asks for
  // (a base hemmed in by terrain), in which case some targets find nothing left and the ring just
  // gets fewer guns — never a duplicate, never a crash.
  for (let i = 0; i < count; i++) {
    const target = approach + (i * 2 * Math.PI) / count;
    let best = null, bestD = Infinity;
    for (const w of eligible) {
      if (taken.has(w.e)) continue;
      const d = angDiff(w.bearing, target);
      if (d < bestD) { best = w; bestD = d; }
    }
    if (!best) break;
    taken.add(best.e);
    best.e.role = 'turret';
  }
  return edges;
}
