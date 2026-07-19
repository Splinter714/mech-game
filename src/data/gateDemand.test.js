// #309 playtest — the pure demand layer (data/gateDemand.js). The scene-level behaviour it feeds
// is covered in scenes/arena/gates.test.js; what's pinned here is the two primitives underneath:
// reading a gate request off a route, and the grace window that makes a sampled signal safe to read
// every frame.
import { describe, it, expect } from 'vitest';
import { firstGateOnRoute, makeGateDemand, GATE_DEMAND_GRACE_MS } from './gateDemand.js';
import { makeWallEdgeSet, gateEdges, damageWallEdge, WALL_EDGE_HP } from './wallEdges.js';
import { neighbors } from './hexgrid.js';

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
