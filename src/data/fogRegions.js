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
import { axialKey, neighbors, hexToPixel, pixelToHex } from './hexgrid.js';
import { targetCoverExempt } from './visibility.js';

// Fog darkness and softness. Jackson, after playtesting the 0.62 + 3-ring version: the interior
// must "be more plainly blacked out, not just light greying still showing base hex details", and
// "by softer edges, I just meant like a 2-3px feathering". A ring is a whole hex (48px), so the
// old ramp was ~144px of grey cloud — the opposite of what he asked for. So: ONE near-black fill
// alpha everywhere inside, and the softness lives entirely in a 2-3px feather stroked at the
// boundary by the renderer (scenes/arena/visibility.js). No depth tiering left.
//
// v3 (2026-07-19 playtest): 0.92 still wasn't stark enough — "the blackout should be even MORE
// stark", the second such ask. So this is now FULLY OPAQUE. Deliberately not 0.98: he has asked
// twice and splitting the difference a third time is how you get asked a fourth. Nothing inside an
// unentered compound reads through at all; the only softness left is the pixel feather.
export const FOG_ALPHA = 1;         // the single interior fill alpha — fully opaque
export const FOG_FEATHER_PX = 3;    // width of the anti-aliased edge, in world px

// ── v3: how big the breach/gate peek is ──────────────────────────────────────────────
// How close the player must be to an opening, in world px, to see the one hex behind it. Measured
// from the OUTER hex of the open span, so it is "walk up to the hole", not "stand in the yard next
// door". ~2.5 hex steps.
//
// This replaces PEEK_RADIUS_PX (900) and the whole player-position visibility polygon with it.
// Jackson: "the auto-reveal on breach/gate is a bit too generous; maybe we just reveal the one hex
// inside the breach or opening or something small like that". A 900px raycast sweep whose intended
// output is a single hex is doing pointless work, so the geometry is gone rather than shrunk — see
// `peekHexes`. It reads as a peek through a hole because it is a shallow flood fill THROUGH the
// hole, not a radius (#352 deepened it from a flat one hex to 1-3 by proximity; see PEEK_MAX_DEPTH).
// Since the 2026-07-20 follow-up this is no longer a CUTOFF — beyond it the peek floors at one hex
// rather than closing — so read it as the ramp's SCALE, not its range.
export const PEEK_RANGE_PX = 220;

// ── #352: the peek DEEPENS as you close on the opening ───────────────────────────────
// Jackson, having played the flat one-hex version: "when the player gets close, I want to expose
// slightly more base interior hexes through a breach or open gate - e.g. 3 hex ring around the
// player instead of just the base 1".
//
// So depth is a step function of how close he is to the opening's outer hex: the far third of
// PEEK_RANGE_PX still gives the v3 single hex, the middle third two, and pressed right up against
// the hole three. Nothing about the shape changes — see `peekHexes`, it is still a cone drilled
// straight through the opening, never a disc around the player and never a view of the yard.
// #352 follow-up (2026-07-20 playtest): the ramp NO LONGER FALLS TO ZERO. Jackson: "make 1 hex
// always visible regardless of how far back the player is". So PEEK_RANGE_PX stopped being a
// cutoff and became purely the ramp's scale: 3 in the near third, 2 in the middle, 1 from the far
// third out to any distance at all. A hole in a wall is a hole from across the map; how MUCH it
// gives up is what closing on it buys.
export const PEEK_MAX_DEPTH = 3;
export function peekDepthFor(distPx) {
  const t = Math.max(0, distPx || 0) / PEEK_RANGE_PX;  // 0 at the opening, 1 at the ramp's edge
  return Math.max(1, PEEK_MAX_DEPTH - Math.floor(t * PEEK_MAX_DEPTH));
}

// ── World precompute ─────────────────────────────────────────────────────────────────
// Built once per run from the base descriptors. `footprint` (worldgen.js) is the compound's hex set.
//
// ── v3 BUG FIX: the fogged set is the WHOLE footprint ──
// Jackson, playtesting v2: "the first ring of hexes inside the wall isn't blacked out at all." Two
// candidate causes looked identical on screen; it was this one, not the feather.
//
// v2 fogged `footprint minus outline`, where the outline is the ring of footprint hexes touching
// the outside. The reasoning was that the outline is "where the wall spans and their turrets sit",
// so fogging it would hide the fortification. But walls are EDGE-owned (#288, data/wallEdges.js) —
// `placeBaseWalls` emits a span for every footprint-hex/outside-hex boundary, with `a` = the base
// side. So a wall span sits on the OUTER EDGE of an outline hex, and the outline hex itself is
// ground fully INSIDE the wall. Excluding it wasn't lightening the first ring, it was leaving the
// first ring genuinely un-fogged — exactly the reported symptom, and structurally, not by degree.
//
// The perimeter still reads, but that is now handled by DEPTH rather than by punching a hole in the
// fog: the wall Graphics and the wall-turret views draw at DEPTH.WALLS, just above DEPTH.LOS_DIM
// (scenes/arena/shared.js), so they sit ON TOP of the fill instead of needing a gap in it. That
// preserves "Wall turrets should be visible from inside or outside, right?" without the gap — and
// it has to, now that the fill is fully opaque.
//
// `outlines` is still computed and returned: it is the ring of hexes the walls line, and cheap.
export function buildFogWorld(bases = []) {
  const owner = new Map();      // hex key -> baseId, over the whole footprint
  const footprints = new Map(); // baseId -> Set(key)
  const interiors = new Map();  // baseId -> Set(key)  (v3: the whole footprint, walls included)
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
    interiors.set(base.id, new Set(fp));
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

// ── The breach/gate peek (v3) ────────────────────────────────────────────────────────
// The hexes an opening lets the player see into, given where he is standing: for each OPEN span
// (breached or open gate) on a fogged compound, the single fogged hex immediately behind it, and
// only while he is within PEEK_RANGE_PX of that span's outer hex.
//
// #352: "the single fogged hex" became "up to `peekDepthFor(dist)` hexes", as a WEDGE drilled
// through the hole (each revealed hex strictly farther from the opening than the last).
//
// #352 follow-up (2026-07-20 playtest): Jackson saw that wedge and wants a DISC — "make it a 1-2-3
// hex ring around the player, not just a cone through the opening". That is a real hazard, and the
// only interesting thing in this function: a ring centred on the player, taken naively, lights
// interior hexes THROUGH INTACT WALL the moment he stands near a hole with the ring overhanging
// solid plate. The wedge constraint was blocking that implicitly; deleting it means blocking has to
// be done on purpose.
//
// ── How intact wall still blocks ──
// The reveal is a FLOOD FILL, not a radius test. Light spreads outward hex-to-hex from the player,
// and the ONLY edge it may use to get from un-fogged ground into a fogged compound is one of the
// `openEdges` the caller hands us. Every other fog/not-fog boundary crossing — i.e. every intact
// wall span, since #337 v3 fogs the whole footprint and walls sit on its outer edges — is
// impassable to the fill. Inside the fog and outside it, movement is free. So:
//   • the opening is still the TRIGGER (nothing enters a compound except through a hole);
//   • the ring is only the SHAPE (once inside, it spreads in every direction, a disc not a wedge);
//   • an interior hex behind unbroken wall is never reached, no matter how close he stands.
// No raycasts, no polygon, no wall geometry — the fog set and the open-span list already carry
// everything the fill needs.
//
// ── The two sources ──
// The fill is seeded at the PLAYER'S hex (cost 0) and at the hole's throat, the fogged hex just
// inside the opening (cost 1), and reveals every fogged hex reached at cost <= depth. The throat
// seed is what makes the always-one-hex floor work at any distance: at depth 1 the player's own
// spread reaches nothing, and the throat alone lights up. Up close, at depth 3, his own spread is
// what dominates and the shape is the ring around him he asked for.
//
// Monotone in depth by construction (a bigger budget only ever admits more hexes), so closing on a
// hole never flickers anything off. `openEdges` is the caller's already-filtered list of
// non-blocking spans (`blocksSpan`, data/wallEdges.js), so a blown span and an open gate take the
// same path.
//
// Pure and set-valued, so the drawn fill and the targeting gate read the SAME answer — what he can
// see and what he can shoot cannot disagree, same guarantee the shared segment list used to give.
function crossingKey(ak, bk) { return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`; }

export function peekHexes(fogged, openEdges = [], origin = null) {
  const out = new Set();
  if (!fogged?.size || !origin) return out;

  // Collect the holes: spans that actually separate fog from not-fog. Tried from both sides so the
  // caller never has to know which of `a`/`b` is the base side.
  const passable = new Set();   // fog/not-fog crossings the fill is allowed to use
  const throats = [];
  for (const e of openEdges ?? []) {
    if (!e?.a || !e?.b) continue;
    for (const [inner, outer] of [[e.a, e.b], [e.b, e.a]]) {
      const ik = axialKey(inner.q, inner.r);
      const ok = axialKey(outer.q, outer.r);
      if (!fogged.has(ik) || fogged.has(ok)) continue;
      passable.add(crossingKey(ik, ok));
      throats.push({ inner, outer, ik });
    }
  }
  if (!throats.length) return out;

  const ph = pixelToHex(origin.x, origin.y);
  const pk = axialKey(ph.q, ph.r);
  // If he is somehow standing ON a fogged hex, don't seed the fill there: that would let it spread
  // through the interior without ever passing an opening, which is exactly the invariant this
  // function exists to hold. (In play the compound he is standing in is `entered`, so un-fogged.)
  const seedPlayer = !fogged.has(pk);
  for (const t of throats) {
    const p = hexToPixel(t.outer.q, t.outer.r);
    const depth = peekDepthFor(Math.hypot(origin.x - p.x, origin.y - p.y));
    if (!depth) continue;
    // Uniform-cost BFS. Seeds are pushed in nondecreasing cost order (0 then 1), so a plain queue
    // is already a correct shortest-path expansion.
    const cost = new Map();
    const queue = [];
    if (seedPlayer) { cost.set(pk, 0); queue.push({ q: ph.q, r: ph.r, d: 0 }); }
    cost.set(t.ik, 1);
    queue.push({ q: t.inner.q, r: t.inner.r, d: 1 });
    out.add(t.ik);
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      if (cur.d >= depth) continue;
      const curKey = axialKey(cur.q, cur.r);
      const curFogged = fogged.has(curKey);
      for (const n of neighbors(cur.q, cur.r)) {
        const nk = axialKey(n.q, n.r);
        if (cost.has(nk)) continue;
        const nFogged = fogged.has(nk);
        // THE BLOCKING RULE: you may only change sides through a listed opening.
        if (curFogged !== nFogged && !passable.has(crossingKey(curKey, nk))) continue;
        cost.set(nk, cur.d + 1);
        queue.push({ q: n.q, r: n.r, d: cur.d + 1 });
        if (nFogged) out.add(nk);
      }
    }
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

// The alpha for one hex: flat. Un-fogged is 0 (the open world, or an entered compound); anything
// fogged is opaque. v3: a hex currently peeked through an opening (`peekHexes`) reads 0 as well —
// that is how the one-hex reveal is cut, replacing v2's inverted GeometryMask. No per-hex
// arbitration is being reintroduced by that: the peek was always a set, it is just no longer
// laundered through a polygon first.
export function fogAlphaFor(key, { fogged, peeked } = {}) {
  if (!fogged?.has(key)) return 0;
  return peeked?.has(key) ? 0 : FOG_ALPHA;
}

// ── Entity visibility ────────────────────────────────────────────────────────────────
// An enemy is drawn (and targetable — "nobody targets what they can't see") when ANY of these hold.
// Rules 1, 2 and 4 are carried over from v1 unchanged; only rule 3's geography narrowed, from "the
// whole world outside your reveal disc" to "the interior of a compound you have not entered".
//
//   1. AIRBORNE. "Hides enemies too except for airborn enemies that have launched into the air."
//      This is also why #327's z-order (flyers above the dim layer) is intended, not a wart.
//   2. A WALL TURRET — it sits ON the boundary, visible from either side.
//   3. Its hex is not fogged at all (the open world, or a compound already entered) AND the player
//      has a clear HARD-COVER line to it — see #460 below.
//   4. SYMMETRY: it is awake with a clear firing lane to the player. Jackson: "but if they can shoot
//      me, they can see me and I can see them, right?" Since #316 every unit needs LOS before it
//      opens fire, so `losClear && awake` is exactly "could shoot me" — fog conceals BEFORE an
//      engagement, never during one. Still load-bearing for a garrison firing out through a gate.
//
// ── #460: rule 3 grew its missing geometry half ──
// Since v2 there is NO open-world fog, so "its hex is not fogged" was true for every ground enemy
// standing anywhere outside an unentered compound — a bare `return true` with no geometric check
// behind it. That made the red lock reticle appear on a tank sitting behind a boulder or a base
// wall, while the SHOT stayed correctly blocked (`_shotIgnoresCover`, firing.js, is airborne-only):
// muzzles converged, homing rounds tracked, and every round splashed on stone. The indicator lied.
// `hardCoverLos(enemy)` closes that: the caller's player→enemy hard-cover raycast, wired to the
// SAME `_wallDistanceLos`/`coverBlocksForRay` machinery the shot uses, so lock and shot now share
// one geometric answer. Omitting it (a scene double, or any caller with no world to cast through)
// keeps the old unconditional `true`, so nothing that never had geometry starts refusing locks.
//
// This does NOT collapse the three lock/shot disagreements catalogued in data/visibility.js — they
// are all *downstream* of this question and survive untouched: the target can still duck after you
// fire, the muzzle is still offset from the eye this ray is cast from, and partial cover still
// leaves a head visible to a ray that a flatter shot loses on the parapet.
//
// Rule 4 is evaluated BEFORE rule 3's raycast, purely as an optimisation — an enemy already
// engaging the player is visible either way, and a CLEAR ray is the expensive case (it runs the
// full march; a blocked one returns early). The answer is identical in both orders.
//
// `peekVisible(x, y)` is the breach peek: the caller's raycast from the player's CURRENT position
// through whatever openings exist. Consulted last because it is the only one that costs anything.
// It can only ever be reached for a FOGGED hex (the peek set is a subset of the fogged set), which
// is why rule 3 may answer `false` outright rather than falling through to it.
export function enemyVisibleInFog(enemy, {
  fogged, hexKeyOf, losClear = false, awake = false, peekVisible = null, hardCoverLos = null,
} = {}) {
  if (!enemy) return false;
  // 1 — #338: via the shared predicate (data/visibility.js), so what may be LOCKED and what a
  // shot may pass through are literally the same decision rather than two rules that agree today.
  if (targetCoverExempt(enemy)) return true;
  if (enemy.spanKey != null) return true;                      // 2 — #426: wall turrets, either side
  if (losClear && awake) return true;                          // 4 (hoisted — see note above)
  const inFog = !!(fogged && fogged.size && fogged.has(hexKeyOf(enemy.x, enemy.y)));
  if (!inFog) return !hardCoverLos || !!hardCoverLos(enemy);   // 3
  return !!(peekVisible && peekVisible(enemy.x, enemy.y));
}
