// #288: the destructible edge-wall layer — the pure half of "walls block movement and sight, you
// shoot a span down, then you drive through the gap." The scene wiring is thin on top of this; the
// behaviour lives here.
import { describe, it, expect } from 'vitest';
import {
  makeWallEdgeSet, wallEdgeAt, wallEdgeCrossing, nearestWallEdge, damageWallEdge, liveWallEdges,
  WALL_EDGE_HP, WALL_THICKNESS_PX, WALL_STOMP_FACTOR, isOutwardOfSpan, wallSpanOutwardSign,
  blocksSpan, blocksShot, setGateOpen, gateEdges, SPAN_ROLE_GATE,
} from './wallEdges.js';
import { edgeKey, edgeEndpoints, edgeMidpoint, pointSegmentDistance } from './hexEdges.js';
import { HEX_SIZE, hexToPixel, neighbors } from './hexgrid.js';

const A = { q: 0, r: 0 };
const B = neighbors(A.q, A.r)[0];          // A's east neighbour — one shared edge
const oneWall = () => makeWallEdgeSet([{ a: A, b: B, baseId: 'base-1' }]);

// A full ring of spans around hex A — a closed 6-span RUN (consecutive outward faces share a
// corner). Since #392's retune a breach fells the hit span + its two nearest contiguous neighbours
// along that run, so breaching one drops exactly THREE of the six, not the whole ring.
const rowWall = () => makeWallEdgeSet(neighbors(A.q, A.r).map((n) => ({ a: A, b: n, baseId: 'b' })));

// Two ISOLATED spans that share no vertex (far-apart hexes) — the fixture for "a lone span has no
// contiguous neighbour, so its breach fells only itself and leaves the other untouched."
const C = { q: 3, r: 0 };
const twoHexes = () => makeWallEdgeSet([
  { a: A, b: neighbors(A.q, A.r)[0], baseId: 'b' },
  { a: C, b: neighbors(C.q, C.r)[0], baseId: 'b' },
]);

describe('#288 makeWallEdgeSet', () => {
  it('builds one record per edge, with HP and precomputed pixel endpoints', () => {
    const set = oneWall();
    expect(set.edges.size).toBe(1);
    const rec = [...set.edges.values()][0];
    expect(rec.hp).toBe(WALL_EDGE_HP);
    expect(rec.maxHp).toBe(WALL_EDGE_HP);
    expect(rec.destroyed).toBe(false);
    expect(rec.baseId).toBe('base-1');
    const geom = edgeEndpoints(A, B);
    expect(rec.x0).toBeCloseTo(geom.x0, 9);
    expect(rec.y1).toBeCloseTo(geom.y1, 9);
  });

  // The point of canonical edge identity: naming the same boundary from both sides must not create
  // two half-walls with two HP pools that have to be shot down separately.
  it('collapses the same edge named from either side into ONE span', () => {
    const set = makeWallEdgeSet([{ a: A, b: B }, { a: B, b: A }]);
    expect(set.edges.size).toBe(1);
  });

  it('indexes each span under BOTH of its hexes, and skips malformed pairs', () => {
    const set = oneWall();
    expect(set.byHex.get('0,0')).toHaveLength(1);
    expect(set.byHex.get(`${B.q},${B.r}`)).toHaveLength(1);
    expect(makeWallEdgeSet([{ a: A, b: { q: 5, r: 5 } }]).edges.size).toBe(0);   // not adjacent
    expect(makeWallEdgeSet([]).edges.size).toBe(0);
  });
});

describe('#288 point queries (what the existing tile-shaped world queries see)', () => {
  it('a point ON the span is inside the wall; a point well clear of it is not', () => {
    const set = oneWall();
    const m = edgeMidpoint(A, B);
    expect(wallEdgeAt(set, m.x, m.y)).toBeTruthy();
    // Both hex CENTRES are half a hex-step away — comfortably outside the wall's thickness, i.e.
    // the wall eats no play space out of either tile it sits between.
    for (const h of [A, B]) {
      const c = hexToPixel(h.q, h.r);
      expect(wallEdgeAt(set, c.x, c.y)).toBeNull();
    }
  });

  it('the solid band is exactly WALL_THICKNESS_PX wide, centred on the boundary', () => {
    const set = oneWall();
    const m = edgeMidpoint(A, B);
    const ca = hexToPixel(A.q, A.r), cb = hexToPixel(B.q, B.r);
    const len = Math.hypot(cb.x - ca.x, cb.y - ca.y);
    const ux = (cb.x - ca.x) / len, uy = (cb.y - ca.y) / len;   // unit normal to the span
    const inside = WALL_THICKNESS_PX / 2 - 0.5, outside = WALL_THICKNESS_PX / 2 + 0.5;
    for (const s of [1, -1]) {
      expect(wallEdgeAt(set, m.x + ux * inside * s, m.y + uy * inside * s)).toBeTruthy();
      expect(wallEdgeAt(set, m.x + ux * outside * s, m.y + uy * outside * s)).toBeNull();
    }
  });

  it('a destroyed span stops being solid immediately', () => {
    const set = oneWall();
    const m = edgeMidpoint(A, B);
    damageWallEdge(set, [...set.edges.values()][0], WALL_EDGE_HP);
    expect(wallEdgeAt(set, m.x, m.y)).toBeNull();
    expect(nearestWallEdge(set, m.x, m.y)).toBeNull();
  });

  it('an empty set answers every query cheaply and safely', () => {
    const empty = makeWallEdgeSet([]);
    expect(wallEdgeAt(empty, 10, 10)).toBeNull();
    expect(wallEdgeCrossing(empty, 0, 0, 500, 500)).toBeNull();
    expect(nearestWallEdge(empty, 0, 0)).toBeNull();
    expect(wallEdgeAt(null, 0, 0)).toBeNull();
    expect(wallEdgeCrossing(undefined, 0, 0, 1, 1)).toBeNull();
  });
});

describe('#288 swept crossing (movement + fast rounds)', () => {
  // The headline anti-tunnelling property. A wall is a LINE with 14px of painted thickness; a mech
  // at full speed and a plasma bolt both cover far more than that per step, so the only safe test
  // is "did this whole step cross the span."
  it('blocks a step at ANY speed — including one that leaps clean over the band', () => {
    const set = oneWall();
    const ca = hexToPixel(A.q, A.r), cb = hexToPixel(B.q, B.r);
    const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
    const ux = (cb.x - ca.x) / Math.hypot(cb.x - ca.x, cb.y - ca.y);
    const uy = (cb.y - ca.y) / Math.hypot(cb.x - ca.x, cb.y - ca.y);
    for (const step of [10, 60, 500, 5000, 50000]) {
      const hit = wallEdgeCrossing(set, mx - ux * step, my - uy * step, mx + ux * step, my + uy * step);
      expect(hit).toBeTruthy();
      expect(hit.edge.key).toBe(edgeKey(A, B));
      // …and it reports WHERE, so a round can detonate on the wall's face rather than past it.
      expect(Math.hypot(hit.x - mx, hit.y - my)).toBeLessThan(1);
      expect(hit.dist).toBeCloseTo(step, 3);
    }
  });

  it('crossing the same span from the far side is the same one span, not a second wall', () => {
    const set = oneWall();
    const ca = hexToPixel(A.q, A.r), cb = hexToPixel(B.q, B.r);
    const fwd = wallEdgeCrossing(set, ca.x, ca.y, cb.x, cb.y);
    const back = wallEdgeCrossing(set, cb.x, cb.y, ca.x, ca.y);
    expect(fwd.edge).toBe(back.edge);
  });

  it('a step that stops SHORT of the wall still stops against its face, not inside it', () => {
    const set = oneWall();
    const m = edgeMidpoint(A, B);
    const ca = hexToPixel(A.q, A.r);
    const len = Math.hypot(m.x - ca.x, m.y - ca.y);
    const ux = (m.x - ca.x) / len, uy = (m.y - ca.y) / len;
    // Ends 2px short of the centreline — inside the painted band, so it's a contact.
    expect(wallEdgeCrossing(set, ca.x, ca.y, m.x - ux * 2, m.y - uy * 2)).toBeTruthy();
    // Ends a comfortable margin clear of the band — free movement.
    expect(wallEdgeCrossing(set, ca.x, ca.y, m.x - ux * 20, m.y - uy * 20)).toBeNull();
  });

  // A unit that has come to rest against the wall must still be able to back away — it would be
  // frozen if merely STARTING inside the painted band counted as a contact.
  it('a unit resting against the wall can still move away from it', () => {
    const set = oneWall();
    const m = edgeMidpoint(A, B);
    const ca = hexToPixel(A.q, A.r);
    const len = Math.hypot(m.x - ca.x, m.y - ca.y);
    const ux = (m.x - ca.x) / len, uy = (m.y - ca.y) / len;
    const restX = m.x - ux * 2, restY = m.y - uy * 2;         // parked in the band
    expect(wallEdgeCrossing(set, restX, restY, restX - ux * 40, restY - uy * 40)).toBeNull();
  });

  it('running ALONG a span does not count as crossing it', () => {
    const set = oneWall();
    const e = [...set.edges.values()][0];
    const dx = e.x1 - e.x0, dy = e.y1 - e.y0;
    expect(wallEdgeCrossing(set, e.x0 - dx, e.y0 - dy, e.x1 + dx, e.y1 + dy)).toBeNull();
  });

  it('reports the NEAREST span when a step would cross more than one', () => {
    const set = rowWall();
    const ca = hexToPixel(A.q, A.r);
    const far = neighbors(A.q, A.r)[0], near = neighbors(A.q, A.r)[3];
    const pFar = hexToPixel(far.q, far.r), pNear = hexToPixel(near.q, near.r);
    // A line straight through hex A crosses the spans on both sides of it.
    const hit = wallEdgeCrossing(set, pNear.x, pNear.y, pFar.x, pFar.y);
    expect(hit.edge.key).toBe(edgeKey(A, near));
    expect(hit.dist).toBeLessThan(Math.hypot(pFar.x - ca.x, pFar.y - ca.y));
  });

  it('a destroyed span no longer blocks the step that used to be stopped by it', () => {
    const set = oneWall();
    const ca = hexToPixel(A.q, A.r), cb = hexToPixel(B.q, B.r);
    expect(wallEdgeCrossing(set, ca.x, ca.y, cb.x, cb.y)).toBeTruthy();
    damageWallEdge(set, [...set.edges.values()][0], WALL_EDGE_HP);
    expect(wallEdgeCrossing(set, ca.x, ca.y, cb.x, cb.y)).toBeNull();
  });
});

describe('#288 per-span destruction', () => {
  it('chips HP, then destroys once the pool is spent — never below zero', () => {
    const set = oneWall();
    const e = [...set.edges.values()][0];
    expect(damageWallEdge(set, e, 10)).toEqual({ hp: WALL_EDGE_HP - 10, destroyed: false, felled: [] });
    expect(damageWallEdge(set, e, WALL_EDGE_HP)).toEqual({ hp: 0, destroyed: true, felled: [e] });
    expect(e.destroyed).toBe(true);
    // Already down: further hits are inert, and it never "re-destroys".
    expect(damageWallEdge(set, e, 50)).toEqual({ hp: 0, destroyed: false, felled: [] });
    expect(damageWallEdge(set, null, 50)).toEqual({ hp: 0, destroyed: false, felled: [] });
  });

  // #392: the breach mechanic — grinding ONE span down opens a fixed three-span gap, but a span
  // with NO contiguous neighbour (an isolated wall) fells only itself and leaves every other span
  // untouched (independent pools, no shared HP, no bleed).
  it('breaching an isolated span fells only itself and leaves others at full HP and standing', () => {
    const set = twoHexes();
    const [hitSpan, otherSpan] = [...set.edges.values()];
    damageWallEdge(set, hitSpan, WALL_EDGE_HP);
    expect(hitSpan.destroyed).toBe(true);
    // The other span shares no vertex with the hit one — untouched, full HP, still solid.
    expect(otherSpan.destroyed).toBe(false);
    expect(otherSpan.hp).toBe(WALL_EDGE_HP);
    const om = edgeMidpoint(otherSpan.a, otherSpan.b);
    expect(wallEdgeAt(set, om.x, om.y)).toBeTruthy();
    // And the breached span's own midpoint is now open ground.
    const gap = edgeMidpoint(hitSpan.a, hitSpan.b);
    expect(wallEdgeAt(set, gap.x, gap.y)).toBeNull();
  });

  it('routes a hit landing on a span\'s face to THAT span (weapon damage targeting)', () => {
    const set = rowWall();
    for (const e of set.edges.values()) {
      const m = edgeMidpoint(e.a, e.b);
      expect(nearestWallEdge(set, m.x, m.y, WALL_THICKNESS_PX).key).toBe(e.key);
    }
    // A hit landing well away from the line hits nothing at all.
    expect(nearestWallEdge(set, 10000, 10000, HEX_SIZE)).toBeNull();
  });

  it('liveWallEdges is exactly the standing spans', () => {
    // #392 retune: rowWall is a 6-span RUN, so breaching one span fells 3 (the hit span + a
    // neighbour on each side) — from 6 down to 3, not to 0.
    const set = rowWall();
    expect(liveWallEdges(set)).toHaveLength(6);
    damageWallEdge(set, [...set.edges.values()][0], 999);
    expect(liveWallEdges(set)).toHaveLength(3);
    expect(liveWallEdges(null)).toEqual([]);
  });
});

// The ring is a 6-cycle by insertion order: span i shares a corner with spans (i+5)%6 and (i+1)%6.
// So a breach at i fells exactly {(i+5)%6, i, (i+1)%6}.
const ringNeighbours = (i) => [(i + 5) % 6, (i + 1) % 6];

describe('#392 a breach fells the hit span + its two contiguous neighbours (fixed 3-span width)', () => {
  it('fells exactly the hit span and one neighbour on each side of the run', () => {
    const set = rowWall();               // 6-span closed run around hex A
    const all = [...set.edges.values()];
    expect(all).toHaveLength(6);
    const hitIdx = 2;
    const { destroyed, felled } = damageWallEdge(set, all[hitIdx], WALL_EDGE_HP);
    expect(destroyed).toBe(true);
    // Exactly three spans down: the hit one + its two run-neighbours; the far three still stand.
    expect(felled).toHaveLength(3);
    expect(liveWallEdges(set)).toHaveLength(3);
    const expected = new Set([hitIdx, ...ringNeighbours(hitIdx)].map((i) => all[i]));
    expect(new Set(felled)).toEqual(expected);
    for (let i = 0; i < 6; i++) expect(all[i].destroyed).toBe(expected.has(all[i]));
    // `felled` leads with the hit span, then its neighbours — one entry per fallen span, no dupes.
    expect(felled[0]).toBe(all[hitIdx]);
    expect(new Set(felled).size).toBe(3);
    // The three fallen faces are now passable / shoot-through; the three standing ones are not.
    for (let i = 0; i < 6; i++) {
      const m = edgeMidpoint(all[i].a, all[i].b);
      if (expected.has(all[i])) expect(wallEdgeAt(set, m.x, m.y)).toBeNull();
      else expect(wallEdgeAt(set, m.x, m.y)).toBeTruthy();
    }
  });

  it('a lone span with no contiguous neighbour fells only itself', () => {
    const set = twoHexes();
    const [hitSpan, otherSpan] = [...set.edges.values()];
    const { felled } = damageWallEdge(set, hitSpan, WALL_EDGE_HP);
    expect(felled).toEqual([hitSpan]);          // nothing shares a vertex with it
    expect(otherSpan.destroyed).toBe(false);
    expect(otherSpan.hp).toBe(WALL_EDGE_HP);
  });

  it('a stub run shorter than three fells only what it has, and only its own run', () => {
    // Two contiguous faces of hex A (a corner: consecutive ring faces share a vertex) sitting apart
    // from a third lone span. Breaching one of the pair fells BOTH of the pair (the whole 2-span
    // run) and nothing of the lone span — a short run gives a shorter breach; it does not reach
    // across a gap.
    const ns = neighbors(A.q, A.r);
    const lone = { q: 6, r: -3 };
    const set = makeWallEdgeSet([
      { a: A, b: ns[0], baseId: 'b' },   // run span 1 — shares a corner with the next
      { a: A, b: ns[1], baseId: 'b' },   // run span 2
      { a: lone, b: neighbors(lone.q, lone.r)[0], baseId: 'b' },   // isolated span, far away
    ]);
    const [run1, run2, loneSpan] = [...set.edges.values()];
    const { felled } = damageWallEdge(set, run1, WALL_EDGE_HP);
    expect(new Set(felled)).toEqual(new Set([run1, run2]));   // the whole 2-span run, no more
    expect(run2.destroyed).toBe(true);
    expect(loneSpan.destroyed).toBe(false);
    expect(loneSpan.hp).toBe(WALL_EDGE_HP);
  });

  it('takes down a PARTIALLY-damaged neighbour too — the breach cascade ignores its remaining HP', () => {
    const set = rowWall();
    const all = [...set.edges.values()];
    const hitIdx = 3;
    const [nA, nB] = ringNeighbours(hitIdx);
    // Wound one neighbour (its own pool only), then breach the span between it and its partner.
    damageWallEdge(set, all[nA], 30);
    expect(all[nA].hp).toBe(WALL_EDGE_HP - 30);   // the chip stayed on that span alone — no bleed
    expect(all[nA].destroyed).toBe(false);
    const { felled } = damageWallEdge(set, all[hitIdx], WALL_EDGE_HP);
    // The wounded neighbour falls with the breach — its remaining HP does not spare it.
    expect(all[nA].destroyed).toBe(true);
    expect(all[nA].hp).toBe(0);
    expect(felled).toContain(all[nA]);
    expect(new Set(felled)).toEqual(new Set([all[hitIdx], all[nA], all[nB]]));
    expect(liveWallEdges(set)).toHaveLength(3);
  });

  it('an END-of-run hit fells only itself + its single neighbour — NO backfill from the live side', () => {
    // #392 STRICT retune (owner 2026-07-21): a breach fells the hit span plus its ONE immediate
    // collinear neighbour on EACH side — never more. An OPEN 4-span run (faces 0,1,2,3 of hex A, a
    // partial arc). Breaching an END span (face 0) has a dead end on one side, so it fells exactly
    // TWO (face 0 + face 1) and does NOT reach a second span down the live side to backfill to three.
    const ns = neighbors(A.q, A.r);
    const set = makeWallEdgeSet([0, 1, 2, 3].map((i) => ({ a: A, b: ns[i], baseId: 'b' })));
    const spans = [...set.edges.values()];
    expect(spans).toHaveLength(4);
    const { felled } = damageWallEdge(set, spans[0], WALL_EDGE_HP);   // end span: one side dead
    expect(felled).toHaveLength(2);
    expect(new Set(felled)).toEqual(new Set([spans[0], spans[1]]));   // hit + its lone neighbour
    expect(spans[2].destroyed).toBe(false);   // NOT backfilled — face 2 still stands
    expect(spans[3].destroyed).toBe(false);
  });

  it('a corner/junction hit takes the collinear continuation, never a perpendicular spur', () => {
    // A closed ring around A, plus a SPUR: the edge between two adjacent ring neighbours (ns[0] and
    // ns[1]), which meets the ring at their shared corner — a T-junction. Breaching ring face 0
    // (A–ns[0]) must fell its two collinear ring neighbours and leave the spur standing, even though
    // the spur shares the exact same vertex: a breach follows the SAME wall line, not "nearest span".
    const ns = neighbors(A.q, A.r);
    const set = makeWallEdgeSet([
      ...ns.map((n) => ({ a: A, b: n, baseId: 'b' })),
      { a: ns[0], b: ns[1], baseId: 'b' },   // spur off the ring at the ns[0]/ns[1] corner
    ]);
    const all = [...set.edges.values()];
    const spur = all[6];
    const { felled } = damageWallEdge(set, all[0], WALL_EDGE_HP);
    expect(felled).toHaveLength(3);
    // The two ring neighbours of face 0 (faces 5 and 1), never the spur.
    expect(new Set(felled)).toEqual(new Set([all[0], all[5], all[1]]));
    expect(felled).not.toContain(spur);
    expect(spur.destroyed).toBe(false);
    expect(spur.hp).toBe(WALL_EDGE_HP);
  });
});

describe('#427 the DOUBLE-DOOR gate — TWO adjacent leaves, each an independent span, parting apart', () => {
  // A gate is now TWO ADJACENT gate leaves flanked on the SAME wall run by a plain span on each
  // side. ns[0..3] are four consecutive outward faces of hex A (a 4-span run, consecutive faces
  // share a corner); the middle two (ns[1], ns[2]) are the gate's two leaves.
  const ns = neighbors(A.q, A.r);
  const gatedRun = () => makeWallEdgeSet([
    { a: A, b: ns[0], baseId: 'b' },
    { a: A, b: ns[1], baseId: 'b', role: SPAN_ROLE_GATE },
    { a: A, b: ns[2], baseId: 'b', role: SPAN_ROLE_GATE },
    { a: A, b: ns[3], baseId: 'b' },
  ]);
  const leavesOf = (set) => gateEdges(set);

  it('a gate is TWO adjacent gate edges, paired to each other, opening OPPOSITE ways', () => {
    const set = gatedRun();
    const leaves = leavesOf(set);
    expect(leaves).toHaveLength(2);
    const [l0, l1] = leaves;
    // Each names the other as its partner.
    expect(l0.gatePartnerKey).toBe(l1.key);
    expect(l1.gatePartnerKey).toBe(l0.key);
    // They share exactly one vertex (the passage centre they part away from).
    const vk = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
    const l0v = [vk(l0.x0, l0.y0), vk(l0.x1, l0.y1)];
    const l1v = [vk(l1.x0, l1.y0), vk(l1.x1, l1.y1)];
    const shared = l0v.filter((v) => l1v.includes(v));
    expect(shared).toHaveLength(1);
    // Each leaf's HINGE end (the post it retracts TOWARD) is the endpoint that is NOT the shared
    // vertex — so the two leaves retract in opposite directions, parting at the shared vertex.
    const hingeVk = (l) => (l.gateHingeEnd === 1 ? vk(l.x1, l.y1) : vk(l.x0, l.y0));
    expect(hingeVk(l0)).not.toBe(shared[0]);
    expect(hingeVk(l1)).not.toBe(shared[0]);
    expect(hingeVk(l0)).not.toBe(hingeVk(l1));
  });

  // #427 (Jackson 2026-07-21): the two leaves are re-seated onto a STRAIGHT CHORD — each hinges at
  // its outer post and the pair MEET at the MIDPOINT of the two posts, so a shut gate is one clean
  // straight span (bulging a touch into the non-base hex) rather than a kinked concave corner.
  it('re-seats the leaves as a straight chord meeting at the midpoint of the two posts', () => {
    const set = gatedRun();
    const [l0, l1] = leavesOf(set);
    const post = (l) => (l.gateHingeEnd === 1 ? { x: l.x1, y: l.y1 } : { x: l.x0, y: l.y0 });
    const meet = (l) => (l.gateHingeEnd === 1 ? { x: l.x0, y: l.y0 } : { x: l.x1, y: l.y1 });
    const p0 = post(l0), p1 = post(l1);
    // Both leaves' meeting ends land on the SAME point — the midpoint of the two outer posts.
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    for (const m of [meet(l0), meet(l1)]) {
      expect(m.x).toBeCloseTo(mid.x, 6);
      expect(m.y).toBeCloseTo(mid.y, 6);
    }
    // …and the whole gate is STRAIGHT: post0 → meet and post1 → meet run in exactly opposite
    // directions (the chord post0—post1 is one line, with the meeting point between them).
    const d0 = { x: mid.x - p0.x, y: mid.y - p0.y }, d1 = { x: mid.x - p1.x, y: mid.y - p1.y };
    const dot = (d0.x * d1.x + d0.y * d1.y) / (Math.hypot(d0.x, d0.y) * Math.hypot(d1.x, d1.y));
    expect(dot).toBeCloseTo(-1, 6);
  });

  it('each leaf is INDEPENDENTLY solid to fire (open or shut) and a doorway to movement when open', () => {
    const set = gatedRun();
    for (const leaf of leavesOf(set)) {
      setGateOpen(set, leaf, true);
      expect(blocksShot(leaf)).toBe(true);    // open leaf still stops shots
      expect(blocksSpan(leaf)).toBe(false);   // ...but units drive past it
      setGateOpen(set, leaf, false);
      expect(blocksShot(leaf)).toBe(true);
      expect(blocksSpan(leaf)).toBe(true);
      leaf.destroyed = true;
      expect(blocksShot(leaf)).toBe(false);   // a breach stops neither
      expect(blocksSpan(leaf)).toBe(false);
    }
  });

  it('a plain wall span is identical under both predicates — the split touches gate leaves alone', () => {
    const set = gatedRun();
    const wall = liveWallEdges(set).find((e) => e.role !== SPAN_ROLE_GATE);
    expect(blocksShot(wall)).toBe(true);
    expect(blocksSpan(wall)).toBe(true);
  });

  it('a shot crossing an OPEN leaf hits THAT leaf (blocksShot), while movement crosses freely', () => {
    const set = gatedRun();
    const leaf = leavesOf(set)[0];
    setGateOpen(set, leaf, true);
    const m = { x: (leaf.x0 + leaf.x1) / 2, y: (leaf.y0 + leaf.y1) / 2 };
    const nx = -(leaf.y1 - leaf.y0), ny = (leaf.x1 - leaf.x0);
    const len = Math.hypot(nx, ny) || 1;
    const ax = m.x - nx / len * 40, ay = m.y - ny / len * 40;
    const bx = m.x + nx / len * 40, by = m.y + ny / len * 40;
    expect(wallEdgeCrossing(set, ax, ay, bx, by, WALL_THICKNESS_PX, null, 0, blocksShot)?.edge).toBe(leaf);
    expect(wallEdgeCrossing(set, ax, ay, bx, by)).toBe(null);   // movement: the open leaf is a doorway
  });

  it('a point on an OPEN leaf is solid to a shot query and clear to a movement query', () => {
    const set = gatedRun();
    const leaf = leavesOf(set)[0];
    setGateOpen(set, leaf, true);
    const m = { x: (leaf.x0 + leaf.x1) / 2, y: (leaf.y0 + leaf.y1) / 2 };
    expect(wallEdgeAt(set, m.x, m.y, WALL_THICKNESS_PX, null, 0, blocksShot)).toBe(leaf);
    expect(wallEdgeAt(set, m.x, m.y)).toBe(null);
  });

  it('a leaf is damageable whether OPEN or SHUT — its own HP pool, chipped independently', () => {
    for (const open of [true, false]) {
      const set = gatedRun();
      const [l0, l1] = leavesOf(set);
      setGateOpen(set, l0, open);
      const before0 = l0.hp, before1 = l1.hp;
      damageWallEdge(set, l0, 30);
      expect(l0.hp).toBe(before0 - 30);
      expect(l0.destroyed).toBe(false);
      expect(l1.hp).toBe(before1);   // chipping one leaf never touches its partner's pool
    }
  });
});

describe('#441 gates die ONLY from gate hits', () => {
  // Jackson 2026-07-21: destroying a gate leaf takes BOTH leaves but never the adjacent plain wall;
  // destroying a plain wall next to a gate leaves the gate intact. So a gate only ever falls when a
  // gate leaf is hit directly. gatedRun below is a 4-span run of hex A: plain, gate, gate, plain.
  const ns = neighbors(A.q, A.r);
  const gatedRun = () => makeWallEdgeSet([
    { a: A, b: ns[0], baseId: 'b' },
    { a: A, b: ns[1], baseId: 'b', role: SPAN_ROLE_GATE },
    { a: A, b: ns[2], baseId: 'b', role: SPAN_ROLE_GATE },
    { a: A, b: ns[3], baseId: 'b' },
  ]);

  it('a gate-leaf hit fells EXACTLY the two leaves and spares the flanking plain wall', () => {
    const set = gatedRun();
    const [w0, g1, g2, w3] = [...set.edges.values()];
    const { destroyed, felled } = damageWallEdge(set, g1, WALL_EDGE_HP);
    expect(destroyed).toBe(true);
    // Exactly the two gate leaves — the hit leaf plus its partner — and nothing else. The collinear
    // plain neighbour w0 that shares g1's post vertex is NOT dragged in (the old rule would have).
    expect(new Set(felled)).toEqual(new Set([g1, g2]));
    expect(g2.destroyed).toBe(true);
    expect(w0.destroyed).toBe(false);
    expect(w0.hp).toBe(WALL_EDGE_HP);
    expect(w3.destroyed).toBe(false);
    expect(w3.hp).toBe(WALL_EDGE_HP);
  });

  it('hitting EITHER leaf takes both — the partner falls whichever leaf is struck', () => {
    const set = gatedRun();
    const [, g1, g2] = [...set.edges.values()];
    const { felled } = damageWallEdge(set, g2, WALL_EDGE_HP);   // hit the OTHER leaf
    expect(new Set(felled)).toEqual(new Set([g1, g2]));
  });

  it('a plain-wall hit next to a gate leaves the GATE INTACT — its run stops at the leaf', () => {
    // A 5-span run of hex A: plain(0), plain(1), gate(2), gate(3), plain(4). Breaching the inner
    // plain wall (1) fells it + its plain neighbour (0); the collinear continuation on the other
    // side is a gate leaf, so that side stops and the gate stays whole.
    const set = makeWallEdgeSet([
      { a: A, b: ns[0], baseId: 'b' },
      { a: A, b: ns[1], baseId: 'b' },
      { a: A, b: ns[2], baseId: 'b', role: SPAN_ROLE_GATE },
      { a: A, b: ns[3], baseId: 'b', role: SPAN_ROLE_GATE },
      { a: A, b: ns[4], baseId: 'b' },
    ]);
    const [w0, w1, g2, g3, w4] = [...set.edges.values()];
    const { felled } = damageWallEdge(set, w1, WALL_EDGE_HP);
    expect(new Set(felled)).toEqual(new Set([w1, w0]));   // no gate leaf among the felled
    expect(g2.destroyed).toBe(false);
    expect(g2.hp).toBe(WALL_EDGE_HP);
    expect(g3.destroyed).toBe(false);
    expect(g3.hp).toBe(WALL_EDGE_HP);
    expect(w4.destroyed).toBe(false);
  });

  it('a lone gate leaf (partner already gone) fells only itself', () => {
    const set = gatedRun();
    const [, g1, g2] = [...set.edges.values()];
    damageWallEdge(set, g2, WALL_EDGE_HP);   // takes g1 + g2
    expect(g1.destroyed).toBe(true);
    // g1 is already down; re-hitting it is a no-op, and it never had a live partner to drag.
    const { felled } = damageWallEdge(set, g1, WALL_EDGE_HP);
    expect(felled).toEqual([]);
  });
});

describe('#313 wall-span HP retune — the gate is a commitment, not a speed bump', () => {
  // Raised 55 -> 200 with the rest of the destructible structures. Because the mech collides as a
  // POINT, breaching ONE span already opens a drivable gap, so all of a gate's toughness has to
  // live in the per-span pool — which is why this is the joint-highest destructible value in the
  // game rather than a middling one.
  it('pins the per-span HP at the owner-confirmed 200', () => {
    expect(WALL_EDGE_HP).toBe(200);
  });

  it('makes a span as tough as a light mech, not as a tank', () => {
    // #299 toughness scale: tank 80, carrier 150, light mech 200. A gate span you can pop faster
    // than the cheapest vehicle in the game was the exact complaint #313 was filed about.
    expect(WALL_EDGE_HP).toBeGreaterThan(80);
    expect(WALL_EDGE_HP).toBeGreaterThanOrEqual(200);
  });

  it('still falls to a full pool of damage in one bite, and survives one short of it', () => {
    // Guards the raise against an off-by-one in any damage path that assumed the old 55.
    const set = oneWall();
    const e = [...set.edges.values()][0];
    expect(damageWallEdge(set, e, WALL_EDGE_HP - 1)).toEqual({ hp: 1, destroyed: false, felled: [] });
    expect(damageWallEdge(set, e, 1)).toEqual({ hp: 0, destroyed: true, felled: [e] });
  });

  it('keeps shooting decisively cheaper than ramming (WALL_STOMP_FACTOR unchanged at 0.25)', () => {
    // #313 check 2. NOTE the number below is the BEST CASE only: `_stompBuildingAt` scales its
    // bite by `speedFrac`, and a mech pressed against a wall has stalled, so measured reality is
    // much worse than this bound (scripts/audit-destructible-313.mjs clocked 51s of leaning vs
    // 1.8s of shooting a span down). All this pins is the design invariant that survived the
    // retune: ramming must never be the quick way through a gate.
    const STOMP_DPS = 45;   // scenes/arena/world.js (module-private; mirrored here deliberately)
    const bestCaseRammingSeconds = WALL_EDGE_HP / (STOMP_DPS * WALL_STOMP_FACTOR);
    expect(WALL_STOMP_FACTOR).toBe(0.25);
    expect(bestCaseRammingSeconds).toBeGreaterThan(10);
  });
});

// ── #320: collision inflation by body radius ────────────────────────────────────────────
// Playtest: tanks visibly poked through walls, and you could shoot over one by standing close.
// Both because every query treated a unit as a POINT. These pin the three things that have to be
// true at once: bodies stop at their own width, the seal cannot weaken, and a breach stays drivable.
describe('#320 wall collision inflated by body radius', () => {
  const half = WALL_THICKNESS_PX / 2;

  // A whole RING around A, so ring vertices (where two spans meet at 120°) are real, and a breach
  // is a genuine one-hex-edge hole with standing spans either side of it.
  const ring = () => makeWallEdgeSet(neighbors(A.q, A.r).map((n) => ({ a: A, b: n, baseId: 'b' })));

  // Distance from a point to a span's centreline, via the same primitive the queries use.
  const distTo = (e, x, y) => pointSegmentDistance(e.x0, e.y0, e.x1, e.y1, x, y);

  it('a unit of radius R is stopped exactly when its BODY meets the plate — centre at R + 7', () => {
    const set = oneWall();
    const e = [...set.edges.values()][0];
    const m = edgeMidpoint(A, B);
    // Unit normal of the span, so we can step straight off its face.
    const dx = e.x1 - e.x0, dy = e.y1 - e.y0, len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len;
    for (const R of [0, 8, 14, 24, 28]) {
      const stop = R + half;
      // Just INSIDE the body's reach → blocked.
      const inX = m.x + nx * (stop - 0.5), inY = m.y + ny * (stop - 0.5);
      expect(wallEdgeAt(set, inX, inY, WALL_THICKNESS_PX, null, R)).toBeTruthy();
      expect(distTo(e, inX, inY)).toBeCloseTo(stop - 0.5, 6);
      // Just OUTSIDE it → clear. This is the half that proves inflation isn't unbounded.
      const outX = m.x + nx * (stop + 0.5), outY = m.y + ny * (stop + 0.5);
      expect(wallEdgeAt(set, outX, outY, WALL_THICKNESS_PX, null, R)).toBeNull();
    }
  });

  it('radius 0 is bit-for-bit the original point query — rounds and sight rays are untouched', () => {
    const set = ring();
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2;
      for (const d of [10, 30, 47, 60, 90]) {
        const x = Math.cos(a) * d, y = Math.sin(a) * d;
        expect(!!wallEdgeAt(set, x, y, WALL_THICKNESS_PX, null, 0))
          .toBe(!!wallEdgeAt(set, x, y, WALL_THICKNESS_PX));
      }
    }
  });

  // The seal proof. Inflation must be a strict SUPERSET of the point-form band — anything solid to
  // a point is solid to a body — or #288's 720-bearing probes would have a hole punched in them by
  // the very shortening that keeps breaches drivable.
  it('is a strict superset of the point-form seal at every radius, including ring VERTICES', () => {
    const set = ring();
    const live = [...set.edges.values()];
    const solidAt = (x, y, R) => !!wallEdgeAt(set, x, y, WALL_THICKNESS_PX, null, R);
    let probed = 0;
    for (let i = 0; i < 720; i++) {
      const a = (i / 720) * Math.PI * 2;
      for (let d = 0; d < 120; d += 1) {
        const x = Math.cos(a) * d, y = Math.sin(a) * d;
        if (!solidAt(x, y, 0)) continue;
        probed++;
        for (const R of [8, 14, 24, 28, 40]) expect(solidAt(x, y, R)).toBe(true);
      }
    }
    expect(probed).toBeGreaterThan(500);
    // Vertices explicitly: the corner case where shortening pulls BOTH spans back off the same
    // point. Each span's capsule still covers it, with `half` to spare.
    for (const e of live) {
      for (const [vx, vy] of [[e.x0, e.y0], [e.x1, e.y1]]) {
        for (const R of [8, 14, 24, 28, 40]) {
          expect(wallEdgeAt(set, vx, vy, WALL_THICKNESS_PX, null, R)).toBeTruthy();
        }
      }
    }
  });

  // The regression #288/#313 care about most: breaching ONE span must still open a drivable gap,
  // for the LARGEST ground unit. Naive inflation (no shortening) seals it for any R > 17.
  it('a breached span stays traversable by the largest ground unit (R = 20)', () => {
    const set = ring();
    const spans = [...set.edges.values()];
    const breach = spans[0];
    damageWallEdge(set, breach, WALL_EDGE_HP);
    expect(breach.destroyed).toBe(true);

    const R = 20;                                    // PLAYER_WALL_COLLIDE_RADIUS — the biggest wall body
    const inside = hexToPixel(breach.a.q, breach.a.r);
    const outside = hexToPixel(breach.b.q, breach.b.r);
    const free = (x, y) => !wallEdgeAt(set, x, y, WALL_THICKNESS_PX, null, R);
    expect(free(outside.x, outside.y)).toBe(true);

    // Flood fill on a 1px lattice from outside to inside, through free space only. If inflation had
    // sealed the hole this finds no route.
    const key = (i, j) => `${i},${j}`;
    const gi = Math.round(inside.x), gj = Math.round(inside.y);
    const seen = new Set([key(Math.round(outside.x), Math.round(outside.y))]);
    let frontier = [[Math.round(outside.x), Math.round(outside.y)]];
    let reached = false;
    while (frontier.length && !reached) {
      const next = [];
      for (const [i, j] of frontier) {
        if (i === gi && j === gj) { reached = true; break; }
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di, nj = j + dj, k = key(ni, nj);
          if (seen.has(k) || Math.abs(ni) > 220 || Math.abs(nj) > 220) continue;
          seen.add(k);
          if (free(ni, nj)) next.push([ni, nj]);
        }
      }
      frontier = next;
    }
    expect(reached).toBe(true);
  });

  it('an INTACT ring admits nobody, at any radius — the breach above is the hole, not the model', () => {
    const set = ring();
    const spans = [...set.edges.values()];
    for (const R of [0, 14, 28]) {
      const free = (x, y) => !wallEdgeAt(set, x, y, WALL_THICKNESS_PX, null, R);
      // Walk straight in across each span's midpoint; every bearing must meet solid geometry.
      for (const e of spans) {
        const mx = (e.x0 + e.x1) / 2, my = (e.y0 + e.y1) / 2;
        const d = Math.hypot(mx, my) || 1;
        let hit = false;
        for (let t = 1.6; t >= 0; t -= 0.02) if (!free((mx / d) * d * t, (my / d) * d * t)) { hit = true; break; }
        expect(hit).toBe(true);
      }
    }
  });

  it('the swept crossing test inflates too — a step that ENDS with the body on the plate is a contact', () => {
    const set = oneWall();
    const e = [...set.edges.values()][0];
    const m = edgeMidpoint(A, B);
    const dx = e.x1 - e.x0, dy = e.y1 - e.y0, len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len;
    const R = 28;
    const from = { x: m.x + nx * 140, y: m.y + ny * 140 };
    // Ends with the body's edge on the plate → blocked, even though the CENTRE is 34px clear.
    const near = { x: m.x + nx * (R + half - 1), y: m.y + ny * (R + half - 1) };
    expect(wallEdgeCrossing(set, from.x, from.y, near.x, near.y, WALL_THICKNESS_PX, null, R)).toBeTruthy();
    // Point-form (radius 0) at the same spot is NOT a contact — that gap is exactly the bug.
    expect(wallEdgeCrossing(set, from.x, from.y, near.x, near.y, WALL_THICKNESS_PX, null, 0)).toBeNull();
    // And stopping fully clear of the body's reach is still free movement.
    const clear = { x: m.x + nx * (R + half + 2), y: m.y + ny * (R + half + 2) };
    expect(wallEdgeCrossing(set, from.x, from.y, clear.x, clear.y, WALL_THICKNESS_PX, null, R)).toBeNull();
  });

  it('no speed out-steps an inflated span — the anti-tunnelling clause survives inflation', () => {
    const set = oneWall();
    const ca = hexToPixel(A.q, A.r), cb = hexToPixel(B.q, B.r);
    const ux = (cb.x - ca.x) / HEX_SIZE, uy = (cb.y - ca.y) / HEX_SIZE;
    const m = edgeMidpoint(A, B);
    for (const speed of [20, 100, 1000, 20000]) {
      for (const R of [0, 14, 28]) {
        const hit = wallEdgeCrossing(
          set, m.x - ux * speed, m.y - uy * speed, m.x + ux * speed, m.y + uy * speed,
          WALL_THICKNESS_PX, false, R,
        );
        expect(hit).toBeTruthy();
      }
    }
  });
});

// #426: wall turrets are hittable from their EXPOSED side; their own wall may still block a shot
// from behind. This is the pure geometry the scene-side exemption (firing.js/projectiles.js) is
// gated on — see wallTurrets.test.js / projectiles.test.js for the behaviour built on top of it.
describe('#426 isOutwardOfSpan / wallSpanOutwardSign', () => {
  it('a point on the OUTER hex side of the span is outward (positive sign, isOutwardOfSpan true)', () => {
    const set = oneWall();
    const edge = [...set.edges.values()][0];
    const outer = hexToPixel(B.q, B.r);
    expect(wallSpanOutwardSign(edge, outer.x, outer.y)).toBeGreaterThan(0);
    expect(isOutwardOfSpan(edge, outer.x, outer.y)).toBe(true);
  });

  it('a point on the INNER (base-interior) hex side of the span is inward (negative sign, false)', () => {
    const set = oneWall();
    const edge = [...set.edges.values()][0];
    const inner = hexToPixel(A.q, A.r);
    expect(wallSpanOutwardSign(edge, inner.x, inner.y)).toBeLessThan(0);
    expect(isOutwardOfSpan(edge, inner.x, inner.y)).toBe(false);
  });

  it('a missing/malformed edge fails CLOSED — not exposed', () => {
    expect(isOutwardOfSpan(null, 0, 0)).toBe(false);
    expect(isOutwardOfSpan({}, 0, 0)).toBe(false);
    expect(wallSpanOutwardSign(undefined, 0, 0)).toBe(0);
  });
});
