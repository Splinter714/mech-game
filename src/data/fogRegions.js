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

// Fog darkness and softness. Jackson, after playtesting the 0.62 + 3-ring version: the interior
// must "be more plainly blacked out, not just light greying still showing base hex details", and
// "by softer edges, I just meant like a 2-3px feathering". A ring is a whole hex (48px), so the
// old ramp was ~144px of grey cloud — the opposite of what he asked for. So: ONE near-black fill
// alpha everywhere inside, and the softness lives entirely in a 2-3px feather stroked at the
// boundary by the renderer (scenes/arena/visibility.js). No depth tiering left.
export const FOG_ALPHA = 0.92;      // the single interior fill alpha — near-black
export const FOG_FEATHER_PX = 3;    // width of the anti-aliased edge, in world px

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

// ── The feathered edge ───────────────────────────────────────────────────────────────
// The fogged hexes that touch something un-fogged — i.e. the outline of the fogged shape, one hex
// thick. These are the only hexes the renderer needs to stroke, and stroking them is the entire
// edge treatment: a few px of half-alpha fog straddling the boundary so the silhouette reads as
// anti-aliased rather than stencil-cut. Their FILL is the same full FOG_ALPHA as everywhere else.
export function fogFrontier(fogged) {
  const out = new Set();
  for (const k of fogged ?? []) {
    const [q, r] = k.split(',').map(Number);
    if (neighbors(q, r).some((n) => !fogged.has(axialKey(n.q, n.r)))) out.add(k);
  }
  return out;
}

// The alpha for one hex: flat. Un-fogged is 0 (the open world, an entered compound, any wall ring);
// anything fogged is the single near-black ceiling.
export function fogAlphaFor(key, { fogged } = {}) {
  return fogged?.has(key) ? FOG_ALPHA : 0;
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
  if (enemy.flying && enemy.airborne !== false) return true;   // 1
  if (enemy.spanKey != null) return true;                      // 2
  if (!fogged || !fogged.size) return true;
  if (!fogged.has(hexKeyOf(enemy.x, enemy.y))) return true;    // 3
  if (losClear && awake) return true;                          // 4
  return !!(peekVisible && peekVisible(enemy.x, enemy.y));
}
