// Split out of worldgen.js (#574): which spans of a base's wall ring are GATES. Pure logic, no
// Phaser, called from worldgen.js's `placeBaseWalls` (wallPlacement.js after #574) as part of
// building a base's perimeter wall.
import { axialKey, distance, hexToPixel, neighbors } from './hexgrid.js';
import { isPassable as isPassableOf } from './terrain.js';

// ── #309: which spans of a ring are GATES ───────────────────────────────────────────────────
// A gate is not a separate structure — it is one of the ring's own spans, flagged `role: 'gate'`
// (data/wallEdges.js). It keeps the same HP pool and the same geometry as any other span, so
// destroying a closed gate simply breaches it like any other span and leaves a permanent hole; and
// it stays SOLID TO THE PLAYER whether open or shut, which is what preserves #288's seal.
//
// HOW MANY — #354, SCALED TO RING SIZE. #309 fixed this at TWO, sized against the small rings of
// the time, on the reasoning that two is the smallest count that creates a flank (one gate is a
// fixed answer to the fight — the player parks off the single opening and farms whatever walks
// out) while a ring with gates all round reads as a fence rather than a wall. Both halves of that
// still hold; what changed is the ring. #333 grew compounds to ~6x12 hexes, whose rings run 54-68
// spans, and #332 made garrisons actually SORTIE. Two mouths in a 60-span ring is one opening per
// ~30 spans, and a big garrison heading for two doors reads as bunching at them rather than
// pouring out — the #309 agent flagged exactly this as the gate funnel.
//
// So the count is now PROPORTIONAL: one gate per `RING_SPANS_PER_GATE` spans, floored, clamped to
// `[MIN_GATES_PER_RING, MAX_GATES_PER_RING]`. On today's 54-68 span rings that is 3-4 gates.
// Jackson gave no number — 14 spans/gate is a PLAYTEST DIAL, picked so the biggest rings get
// roughly double #309's two without the wall dissolving into fence. The clamps are the real
// guarantees: a small ring never drops below #309's two, and no ring exceeds five however large
// compounds grow later.
//
// WHERE THEY SIT — EVENLY SPREAD, ANCHORED ON THE APPROACH. The open question was "spread around
// the ring" vs "concentrate on the approach side"; this takes SPREAD. Concentrating them all where
// the player arrives just turns two doors into one wide mouth — the same funnel in a wider shape —
// and hands him a single arc to camp, which is the failure #309's second gate existed to prevent.
// Spreading keeps that point and scales it: with four gates a sortie comes at him from four
// bearings and he cannot cover them all.
//
// The FIRST gate still faces the player's APPROACH — the bearing from the base's centre back
// toward the world origin, which is where the run spawns (the corridor spine starts at u=0 at the
// origin, see `placeBases`). That is a cheap proxy for "the side he will arrive on" that needs no
// spine argument and cannot be thrown off by a corridor that doubles back, unlike anything derived
// from progress. The remaining gates sit at even angular steps around from it, so there is always
// one mouth facing him (the read #309 wanted) and the two-gate case degenerates to exactly #309's
// original front/rear pair.
//
// This is deliberately now the SAME shape as `assignWallTurrets` (wallPlacement.js, #310): a
// clamped count derived from the ring, even angular targets starting at the approach, each
// claiming the nearest unclaimed eligible span. The two were already near-identical in spirit and
// #354 finished the convergence — a change to how ring features spread should only have to be
// reasoned about once.
//
// FORGIVING GEOMETRY (#312 is not built — enemy movement is still straight-line steering, so a
// unit that emerges facing its own wall will grind along it rather than path around). Two things
// keep that from happening: a span is only eligible if the hex on its OUTER side is passable
// ground, so nothing ever opens onto a mesa or a lake; and the outward bearing test naturally
// favours a span whose outward normal points away from the compound, so a unit stepping through is
// already heading into open field. If no eligible span exists (a base wedged against impassable
// terrain on every side), that base simply gets no gate rather than one that opens into a cliff —
// it is then a purely passive fortress, exactly as it was before this issue, which is a safe
// degradation rather than a broken one.
export function assignGates(T, base, edges) {
  const c = hexToPixel(base.center.q, base.center.r);
  const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  // #427 (concave + convex MIX, Jackson 2026-07-22 playtest follow-up): a gate is a PAIR of adjacent
  // boundary spans meeting at one ring vertex. Two topologies qualify, and both are now placed so a
  // base shows a mix to compare which reads better in play:
  //
  //   CONCAVE NOTCH — the two spans (a1,b) and (a2,b) share the SAME OUTER (non-base) hex `b`, wedged
  //     between two ADJACENT base hexes. The wall dents INWARD there. Downstream (wallEdges.js
  //     `assignGateLeafDirections`) re-seats this pair onto a STRAIGHT CHORD across the notch mouth,
  //     so the two leaves read as one clean double door bulging a touch into `b`.
  //
  //   CONVEX CORNER — the inverse: the two spans (a,b1) and (a,b2) share the SAME BASE hex `a`, which
  //     juts out between two ADJACENT outer hexes. The wall bows OUTWARD there. This pair is left on
  //     its natural hex edges downstream — the two leaves already bow outward and meet at the real
  //     convex corner, so no chord flattening is wanted.
  //
  // Both cases require passable outer ground under every leaf (a gate must never open onto a cliff)
  // and the same "≥1 hex apart" separation so mouths never fuse. Concave vs convex is fully implied
  // by which hex the paired leaves share (`b` vs `a`), so nothing has to be marked — wallEdges.js and
  // the tests re-derive it geometrically.
  const eligible = edges
    .map((e) => ({ e, outerKey: axialKey(e.b.q, e.b.r) }))
    .filter((w) => isPassableOf(T?.get(w.outerKey)));
  if (!eligible.length) return edges;
  const sites = [];
  // CONCAVE sites: group eligible spans by their shared OUTER hex, then every pair whose two BASE
  // hexes are adjacent (so the two spans meet at one real corner — a genuine notch, not an outer hex
  // merely touched on two unconnected sides). Bearing = outward toward that shared outer hex.
  const byOuter = new Map();
  for (const w of eligible) {
    if (!byOuter.has(w.outerKey)) byOuter.set(w.outerKey, []);
    byOuter.get(w.outerKey).push(w);
  }
  for (const [, ws] of byOuter) {
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        if (distance(ws[i].e.a, ws[j].e.a) !== 1) continue;
        const o = hexToPixel(ws[i].e.b.q, ws[i].e.b.r);
        // The three hexes that define this notch — its two base hexes and its outer hex.
        sites.push({
          kind: 'concave',
          pair: [ws[i].e, ws[j].e], bearing: Math.atan2(o.y - c.y, o.x - c.x),
          hexes: [ws[i].e.a, ws[j].e.a, ws[i].e.b],
        });
      }
    }
  }
  // CONVEX sites: group eligible spans by their shared BASE hex, then every pair whose two OUTER
  // hexes are adjacent (so the two spans meet at one real corner — an outward-jutting base hex, not a
  // base hex merely walled on two unconnected sides). Bearing = outward toward the midpoint of the
  // two outer hexes. The three hexes that define the corner are the base hex and its two outer hexes.
  const byBase = new Map();
  for (const w of eligible) {
    const bk = axialKey(w.e.a.q, w.e.a.r);
    if (!byBase.has(bk)) byBase.set(bk, []);
    byBase.get(bk).push(w);
  }
  for (const [, ws] of byBase) {
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        if (distance(ws[i].e.b, ws[j].e.b) !== 1) continue;
        const o1 = hexToPixel(ws[i].e.b.q, ws[i].e.b.r);
        const o2 = hexToPixel(ws[j].e.b.q, ws[j].e.b.r);
        sites.push({
          kind: 'convex',
          pair: [ws[i].e, ws[j].e],
          bearing: Math.atan2((o1.y + o2.y) / 2 - c.y, (o1.x + o2.x) / 2 - c.x),
          hexes: [ws[i].e.a, ws[i].e.b, ws[j].e.b],
        });
      }
    }
  }
  if (!sites.length) return edges;
  // #354: how many mouths this ring gets, from its own span count (see the header).
  const n = gateCountForRing(edges.length);
  // The approach: back toward the origin, where the run spawns. Even angular steps around from it, so
  // one mouth faces the player and a sortie can come from bearings he cannot all cover.
  const approach = Math.atan2(-c.y, -c.x);
  // Keep chosen mouths SEPARATED — a candidate is rejected if any of its hexes is within one step of
  // a hex already claimed by a chosen mouth. That guarantees no two mouths share a vertex, so each
  // stays a clean two-leaf double door and pairs unambiguously downstream — and it also stops a
  // concave and a convex site that overlap (they always share a hex) from both being taken.
  const usedHexes = new Set();
  const tooClose = (s) => s.hexes.some((h) => {
    if (usedHexes.has(axialKey(h.q, h.r))) return true;
    return neighbors(h.q, h.r).some((nb) => usedHexes.has(axialKey(nb.q, nb.r)));
  });
  const usedSites = new Set();
  // Nearest-by-bearing pick among the still-available sites, optionally restricted to one KIND.
  const pick = (target, kind) => {
    let best = null, bestD = Infinity;
    for (const s of sites) {
      if (usedSites.has(s) || tooClose(s)) continue;
      if (kind && s.kind !== kind) continue;
      const d = angDiff(s.bearing, target);
      if (d < bestD) { best = s; bestD = d; }
    }
    return best;
  };
  for (let i = 0; i < n; i++) {
    const target = approach + (i * 2 * Math.PI) / n;
    // Interleave the two kinds so a base shows a MIX (roughly half-and-half): even mouths prefer a
    // concave notch, odd mouths a convex corner — falling back to the other kind when the preferred
    // one has no well-separated site near this bearing, so terrain never blocks a mouth entirely.
    const preferKind = i % 2 === 0 ? 'concave' : 'convex';
    const best = pick(target, preferKind) || pick(target, null);
    if (!best) break;   // fewer well-separated sites than mouths asked for — take as many as exist
    usedSites.add(best);
    for (const h of best.hexes) usedHexes.add(axialKey(h.q, h.r));
    for (const e of best.pair) e.role = 'gate';
  }
  return edges;
}

// #354: gates scale with the ring's span count — see `assignGates`' header for the reasoning and
// for why these three numbers are playtest dials rather than derived constants.
export const RING_SPANS_PER_GATE = 14;
export const MIN_GATES_PER_RING = 2;
export const MAX_GATES_PER_RING = 5;
export function gateCountForRing(spanCount) {
  const raw = Math.floor((spanCount ?? 0) / RING_SPANS_PER_GATE);
  return Math.max(MIN_GATES_PER_RING, Math.min(MAX_GATES_PER_RING, raw));
}
