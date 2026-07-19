// #309 playtest — the pure demand layer (data/gateDemand.js). The scene-level behaviour it feeds
// is covered in scenes/arena/gates.test.js; what's pinned here is the two primitives underneath:
// reading a gate request off a route, and the grace window that makes a sampled signal safe to read
// every frame.
import { describe, it, expect } from 'vitest';
import {
  firstGateOnRoute, gateRequestOnRoute, remainingToGate, requestsGate, trackApproach,
  makeGateDemand, GATE_DEMAND_GRACE_MS, GATE_OPEN_LEAD_MS, GATE_AT_DOOR_PX,
  GATE_MIN_CLOSING_PX_PER_SEC, APPROACH_SAMPLE_MS,
} from './gateDemand.js';
import { makeWallEdgeSet, gateEdges, damageWallEdge, WALL_EDGE_HP } from './wallEdges.js';
import { neighbors, HEX_SIZE } from './hexgrid.js';

const A = { q: 0, r: 0 };
const NB = neighbors(A.q, A.r);

// A ring of six spans around the origin, with `NB[3]`'s span the gate — the same miniature
// enclosure the scene tests use.
function ring({ gateIndex = 3 } = {}) {
  return makeWallEdgeSet(NB.map((n, i) => ({
    a: A, b: n, baseId: 'base0', ...(i === gateIndex ? { role: 'gate' } : {}),
  })));
}

describe('firstGateOnRoute', () => {
  it('names the gate span a route crosses on its way out', () => {
    const set = ring();
    const gate = gateEdges(set)[0];
    // Origin -> the gate's own neighbour -> onward. The first step crosses the gate.
    const path = [NB[3], { q: NB[3].q * 2, r: NB[3].r * 2 }];
    expect(firstGateOnRoute(A, path, set.byHex)).toBe(gate.key);
  });

  it('returns null for a route that crosses no gate at all', () => {
    const set = ring();
    // A route that never leaves the outside of the ring crosses nothing.
    const path = [{ q: 3, r: 0 }, { q: 4, r: 0 }];
    expect(firstGateOnRoute({ q: 2, r: 0 }, path, set.byHex)).toBe(null);
  });

  it('returns the FIRST gate crossed, not a later one', () => {
    // Two gates on the ring. A route leaving through NB[0]'s span must name THAT one, even though
    // the other is also a gate — a unit asks for the door it is about to use, not every door.
    const set = makeWallEdgeSet(NB.map((n, i) => ({
      a: A, b: n, baseId: 'base0', ...(i === 0 || i === 3 ? { role: 'gate' } : {}),
    })));
    const first = set.byHex.get('0,0').find(
      (e) => e.role === 'gate' && (e.a.q === NB[0].q || e.b.q === NB[0].q)
        && (e.a.r === NB[0].r || e.b.r === NB[0].r),
    );
    expect(firstGateOnRoute(A, [NB[0]], set.byHex)).toBe(first.key);
  });

  // A blown gate is a permanent hole, so a route through it needs nothing opened — it must not be
  // reported as demand, or a destroyed door would keep asking to be cranked forever.
  it('ignores a DESTROYED gate — a breach needs nothing opened', () => {
    const set = ring();
    damageWallEdge(set, gateEdges(set)[0], WALL_EDGE_HP);
    expect(firstGateOnRoute(A, [NB[3]], set.byHex)).toBe(null);
  });

  it('is safe on an empty route and a missing index', () => {
    const set = ring();
    expect(firstGateOnRoute(A, [], set.byHex)).toBe(null);
    expect(firstGateOnRoute(A, [NB[3]], null)).toBe(null);
  });
});

describe('makeGateDemand — the grace window', () => {
  it('a gate that was just asked for is wanted', () => {
    const d = makeGateDemand();
    d.note('g', 1000);
    expect(d.wanted('g', 1000)).toBe(true);
    expect(d.wanted('g', 1000 + GATE_DEMAND_GRACE_MS - 1)).toBe(true);
  });

  // The whole point of the window: the scan is throttled and round-robins, so a gate that is
  // genuinely wanted goes un-re-asked for a few hundred ms at a time. It must stay wanted across
  // those gaps, or the door would hunt.
  it('stays wanted across the gaps between scans, then lapses', () => {
    const d = makeGateDemand();
    d.note('g', 0);
    expect(d.wanted('g', 750)).toBe(true);                        // a couple of scans later
    expect(d.wanted('g', GATE_DEMAND_GRACE_MS + 1)).toBe(false);  // genuinely gone
  });

  it('a gate nobody ever asked for is never wanted', () => {
    const d = makeGateDemand();
    d.note('g', 0);
    expect(d.wanted('other', 0)).toBe(false);
    expect(d.wanted(undefined, 0)).toBe(false);
  });

  it('noting a null key records nothing — a route that wants no gate asks for none', () => {
    const d = makeGateDemand();
    d.note(null, 0);
    expect(d.size).toBe(0);
  });

  it('forget drops a gate outright, so a destroyed door cannot stay wanted', () => {
    const d = makeGateDemand();
    d.note('g', 0);
    d.forget('g');
    expect(d.wanted('g', 0)).toBe(false);
  });

  it('ageMs reports how stale a request is', () => {
    const d = makeGateDemand();
    expect(d.ageMs('g', 0)).toBe(Infinity);
    d.note('g', 100);
    expect(d.ageMs('g', 400)).toBe(300);
  });
});

// ── PLAYTEST 3: the "just in time" arithmetic ──────────────────────────────────────────
describe('gateRequestOnRoute — how far to the door', () => {
  it('reports the distance to the gate, not just its identity', () => {
    const set = ring();
    const gate = gateEdges(set)[0];
    const req = gateRequestOnRoute(A, [NB[3]], set.byHex);
    expect(req.key).toBe(gate.key);
    // The doorway is on the boundary between the two hexes, so it is half a step away.
    expect(req.pathPx).toBeGreaterThan(0);
    expect(req.pathPx).toBeLessThan(HEX_SIZE * 2);
  });

  // The whole point of the change: a unit further along the same route reports a LONGER distance,
  // which is what lets the door hold shut until it is genuinely close.
  it('a longer approach to the same gate reports a longer distance', () => {
    const set = ring();
    const near = gateRequestOnRoute(A, [NB[3]], set.byHex);
    // Start several hexes away and walk in through the same span.
    const farStart = { q: NB[3].q * 4, r: NB[3].r * 4 };
    const path = [
      { q: NB[3].q * 3, r: NB[3].r * 3 },
      { q: NB[3].q * 2, r: NB[3].r * 2 },
      NB[3], A,
    ];
    const far = gateRequestOnRoute(farStart, path, set.byHex);
    expect(far.key).toBe(near.key);
    expect(far.pathPx).toBeGreaterThan(near.pathPx * 3);
  });
});

describe('remainingToGate', () => {
  const intent = { key: 'g', pathPx: 500, x: 0, y: 0 };

  it('counts down as the unit makes progress', () => {
    // Moved 200px toward a mouth that is still 300px further on.
    expect(remainingToGate(200, 0, intent, 500, 0)).toBeCloseTo(300, 0);
  });

  // The stale-intent guard: a unit that has already gone through and walked away must stop asking,
  // even though its cached path distance has long since run out.
  it('grows again once the unit has passed the gate and left', () => {
    const wayPast = remainingToGate(900, 0, intent, 500, 0);
    expect(wayPast).toBeGreaterThan(300);   // the straight-line floor takes over
  });

  it('is Infinity with no intent — nothing to ask for', () => {
    expect(remainingToGate(0, 0, null, 0, 0)).toBe(Infinity);
  });
});

describe('requestsGate — motion, not position', () => {
  const far = GATE_AT_DOOR_PX * 6;

  // THE PLAYTEST 3 BUG, in one assertion. A garrison unit holding its standoff position near its
  // own wall is not about to use the door, however close it happens to be standing. Measured in the
  // live game at 110-180px from the doorway, indefinitely — under a distance-based rule that held
  // the gate open 95% of the time.
  it('a unit loitering near its gate does NOT ask for it', () => {
    expect(requestsGate(far, 0)).toBe(false);
    expect(requestsGate(far, GATE_MIN_CLOSING_PX_PER_SEC - 1)).toBe(false);
  });

  it('a unit moving AWAY never asks', () => {
    expect(requestsGate(far, -60)).toBe(false);
  });

  // …and the same unit, at the same place, asks the moment it actually commits and starts closing.
  it('a unit closing on its gate asks once it is within the lead', () => {
    const closing = 60;                              // px/sec
    const justInside = (GATE_OPEN_LEAD_MS / 1000) * closing - 1;
    const justOutside = (GATE_OPEN_LEAD_MS / 1000) * closing + 1;
    expect(requestsGate(justInside, closing)).toBe(true);
    expect(requestsGate(justOutside, closing)).toBe(false);
  });

  // Speed still matters, which is why this is a time budget rather than a radius: at the same
  // distance a fast unit is about to arrive and a slow one is not.
  it('the same distance is inside the lead for a fast closer and outside for a slow one', () => {
    const px = 400;
    expect(requestsGate(px, 400)).toBe(true);
    expect(requestsGate(px, 30)).toBe(false);
  });

  // The hole the rate rule would otherwise have: a unit that reaches a SHUT gate is stopped dead by
  // it, so its closing rate collapses to zero — and without this it would stand there forever in
  // front of a door it is actively asking to use.
  it('a unit stopped AT the door asks even with no closing rate at all', () => {
    expect(requestsGate(GATE_AT_DOOR_PX - 1, 0)).toBe(true);
    expect(requestsGate(GATE_AT_DOOR_PX - 1, -50)).toBe(true);
  });

  // The budget the lead has to cover: the doors need GATE_REACTION_MS + GATE_OPENING_MS
  // (600 + 800 = 1400ms) between the first request and a walkable doorway, so a shorter lead would
  // make the gate structurally incapable of being open on arrival.
  it('leaves room for the doors to actually open', () => {
    expect(GATE_OPEN_LEAD_MS).toBeGreaterThan(600 + 800);
  });
});

describe('trackApproach — the smoothed closing rate', () => {
  it('starts at rest', () => {
    expect(trackApproach(null, 300, 0).rate).toBe(0);
  });

  it('ignores samples closer together than the sample interval', () => {
    const a = trackApproach(null, 300, 0);
    const b = trackApproach(a, 100, APPROACH_SAMPLE_MS - 1);
    expect(b).toBe(a);            // same object: nothing was folded in
  });

  it('converges on a steady closing rate', () => {
    // 50px/sec, sampled every APPROACH_SAMPLE_MS.
    let st = trackApproach(null, 1000, 0);
    for (let i = 1; i <= 12; i++) {
      const t = i * APPROACH_SAMPLE_MS;
      st = trackApproach(st, 1000 - 50 * (t / 1000), t);
    }
    expect(st.rate).toBeGreaterThan(45);
    expect(st.rate).toBeLessThan(55);
  });

  it('reports a negative rate for a unit moving away', () => {
    let st = trackApproach(null, 100, 0);
    for (let i = 1; i <= 8; i++) {
      const t = i * APPROACH_SAMPLE_MS;
      st = trackApproach(st, 100 + 40 * (t / 1000), t);
    }
    expect(st.rate).toBeLessThan(0);
  });

  // A single frame of noise (a collision shove) must not read as an approach.
  it('a one-off jump does not swing the rate to a full approach', () => {
    let st = trackApproach(null, 500, 0);
    st = trackApproach(st, 480, APPROACH_SAMPLE_MS);         // one 20px hop
    st = trackApproach(st, 480, APPROACH_SAMPLE_MS * 2);     // then still
    st = trackApproach(st, 480, APPROACH_SAMPLE_MS * 3);
    expect(requestsGate(480, st.rate)).toBe(false);
  });
});
