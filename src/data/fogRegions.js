// #337 v2 — COMPOUND-INTERIOR FOG. Pure geometry/set logic, no Phaser; the scene-side wiring is
// scenes/arena/visibility.js.
//
// ── What this replaced, and why ──
// v1 of #337 fogged the ENTIRE world and diced the open ground into coarse 5-hex blocks, revealing a
// 9-ring disc around whichever block you stood in. Jackson played it: "the fog of war thing isn't
// working as intended at all", it "pops badly as I drive". Of course it did — a disc that jumps a
// whole block-width the instant you cross a block boundary is a step function, and there is no
// tuning of the radius that makes a step function stop stepping. His correction, verbatim:
//
//   "lots is wrong; overworld should just always be visible (no fog), and interior of bases should
//    be greyed out until entrance; or partial reveal on breach or gate opening; and it shouldn't be
//    hex by hex, it should be by raycast"
//
// So the block machinery, the reveal disc, the open-cell keys and the run-long "known terrain"
// memory are all GONE — deleted, not disabled. Popping is now structurally impossible because the
// only thing that ever changes state is a compound flipping from fogged to lit, once, forever.
//
// ── The model, in full ──
//   • Open world: no fog. There is no representation of it here at all.
//   • Each base COMPOUND has a fogged INTERIOR (its footprint minus the outline ring the walls and
//     wall turrets sit on — those read from both sides, so the fog draws as a fortified perimeter
//     rather than a shapeless blob).
//   • Entering a compound puts its id in `entered` and it stays lit for the rest of the run. One
//     transition per compound, no live interior shadows, nothing to recompute per frame.
//   • A breach or open gate is a hole you peek through FROM WHERE YOU ARE STANDING. That is a
//     visibility polygon cast from the player (data/shadowPolygon.js), not a set of hexes, and it
//     swings as he moves along the wall. v1 unioned over all exterior angles instead, which reveals
//     nearly the whole yard from one hole — the opposite of the "partial reveal" he asked for.
//
// The only hex-granular thing left is the fogged interior's own footprint and its soft edge ramp,
// which is fine: that boundary IS the wall ring, a hex-aligned structure to begin with.
import { axialKey, neighbors } from './hexgrid.js';
import { targetCoverExempt } from './visibility.js';

// Fog darkness and softness — the one part of v1 Jackson did not object to, kept verbatim.
// "I would like to soften the edges of the shadow itself. So it's not quite so stark."
export const FOG_ALPHA = 0.62;     // ceiling: a fogged interior hex well away from any frontier
export const FOG_SOFT_STEPS = 3;   // rings over which the fog ramps up from the lit boundary

// How far the player can peek through an opening, in world px. Bounds the raycast so the sweep only
// ever considers one compound's worth of geometry — which is exactly why the cost objection that
// retired shadowPolygon.js under #306 (whole-map scope, every frame) does not apply here.
export const PEEK_RADIUS_PX = 900;

// ── World precompute ─────────────────────────────────────────────────────────────────
// Built once per run from the base descriptors. `footprint` (worldgen.js) is the compound's hex set;
// its OUTLINE is the ring of footprint hexes touching the outside, which is exactly where the wall
// spans and their turrets sit. The outline is never fogged — Jackson, "Wall turrets should be
// visible from inside or outside, right?"
export function buildFogWorld(bases = []) {
  const owner = new Map();      // hex key -> baseId, over the whole footprint
  const footprints = new Map(); // baseId -> Set(key)
  const interiors = new Map();  // baseId -> Set(key)  (footprint minus outline)
  const outlines = new Map();   // baseId -> Set(key)
  for (const base of bases) {
    const fp = new Set((base.footprint ?? []).map((h) => axialKey(h.q, h.r)));
    if (!fp.size) continue;
    footprints.set(base.id, fp);
    for (const k of fp) owner.set(k, base.id);
    const outline = new Set();
    for (const h of base.footprint ?? []) {
      if (neighbors(h.q, h.r).some((n) => !fp.has(axialKey(n.q, n.r)))) outline.add(axialKey(h.q, h.r));
    }
    outlines.set(base.id, outline);
    const inner = new Set();
    for (const k of fp) if (!outline.has(k)) inner.add(k);
    interiors.set(base.id, inner);
  }
  return { owner, footprints, interiors, outlines, bases };
}

// Which compound's footprint is this hex in, if any? `null` in the open world — which, per the
// redesign, is simply never fogged.
export function compoundAt(q, r, world) {
  return world?.owner?.get(axialKey(q, r)) ?? null;
}

// ── The fogged set ───────────────────────────────────────────────────────────────────
// Every interior hex of every compound the player has not yet walked into. Recomputed ONLY when
// `entered` grows — i.e. at most once per compound per run.
export function fogHexes(world, entered = new Set()) {
  const out = new Set();
  for (const [baseId, inner] of world?.interiors ?? []) {
    if (entered.has(baseId)) continue;
    for (const k of inner) out.add(k);
  }
  return out;
}

// ── Softened edges ───────────────────────────────────────────────────────────────────
// Depth of each fogged hex measured INWARD from the lit boundary: a BFS seeded on the fogged hexes
// that touch something un-fogged. Alpha then climbs with depth, so the wall-ring edge is a two- or
// three-hex gradient instead of a stencil cut. Fogged hexes deeper than FOG_SOFT_STEPS are simply
// absent from the map and take the full ceiling.
export function fogEdgeDepths(fogged, steps = FOG_SOFT_STEPS) {
  const depth = new Map();
  let frontier = [];
  for (const k of fogged) {
    const [q, r] = k.split(',').map(Number);
    if (neighbors(q, r).some((n) => !fogged.has(axialKey(n.q, n.r)))) {
      depth.set(k, 1);
      frontier.push({ q, r });
    }
  }
  for (let d = 2; d <= steps; d++) {
    const next = [];
    for (const h of frontier) {
      for (const n of neighbors(h.q, h.r)) {
        const nk = axialKey(n.q, n.r);
        if (!fogged.has(nk) || depth.has(nk)) continue;
        depth.set(nk, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return depth;
}

// The alpha for one hex. Un-fogged is 0 (the open world, an entered compound, any wall ring); a
// fogged hex ramps FOG_ALPHA * depth/steps up to the ceiling.
export function fogAlphaFor(key, { fogged, depths, steps = FOG_SOFT_STEPS } = {}) {
  if (!fogged?.has(key)) return 0;
  const d = depths?.get(key);
  return d == null ? FOG_ALPHA : FOG_ALPHA * (d / steps);
}

// ── Entity visibility ────────────────────────────────────────────────────────────────
// An enemy is drawn (and targetable — "nobody targets what they can't see") when ANY of these hold.
// Rules 1, 2 and 4 are carried over from v1 unchanged; only rule 3's geography narrowed, from "the
// whole world outside your reveal disc" to "the interior of a compound you have not entered".
//
//   1. AIRBORNE. "Hides enemies too except for airborn enemies that have launched into the air."
//      This is also why #327's z-order (flyers above the dim layer) is intended, not a wart.
//   2. A WALL TURRET — it sits ON the boundary, visible from either side.
//   3. Its hex is not fogged at all: the open world, or a compound already entered.
//   4. SYMMETRY: it is awake with a clear firing lane to the player. Jackson: "but if they can shoot
//      me, they can see me and I can see them, right?" Since #316 every unit needs LOS before it
//      opens fire, so `losClear && awake` is exactly "could shoot me" — fog conceals BEFORE an
//      engagement, never during one. Still load-bearing for a garrison firing out through a gate.
//
// `peekVisible(x, y)` is the breach peek: the caller's raycast from the player's CURRENT position
// through whatever openings exist. Consulted last because it is the only one that costs anything.
export function enemyVisibleInFog(enemy, {
  fogged, hexKeyOf, losClear = false, awake = false, peekVisible = null,
} = {}) {
  if (!enemy) return false;
  // 1 — #338: via the shared predicate (data/visibility.js), so what may be LOCKED and what a
  // shot may pass through are literally the same decision rather than two rules that agree today.
  if (targetCoverExempt(enemy)) return true;
  if (enemy.spanKey != null) return true;                      // 2
  if (!fogged || !fogged.size) return true;
  if (!fogged.has(hexKeyOf(enemy.x, enemy.y))) return true;    // 3
  if (losClear && awake) return true;                          // 4
  return !!(peekVisible && peekVisible(enemy.x, enemy.y));
}
