// #369 — a closing gate nudges bodies out of its mouth instead of trapping them.
import { describe, it, expect } from 'vitest';
import { nudgeFromGateMouth, bodyInGateMouth, gateMouthOccupied, GATE_NUDGE_MARGIN_PX } from './gateClearance.js';
import { spanCollideSegment, WALL_THICKNESS_PX } from './wallEdges.js';
import { pointSegmentDistance } from './hexEdges.js';

// A horizontal gate span 48px long (one hex edge) centred on the origin. Its normal is the y axis,
// so "which side is it nearer" reads directly off a body's y.
const GATE = { x0: -24, y0: 0, x1: 24, y1: 0, key: 'g' };
const R = 20;   // a body's wall collide radius
const HALF = WALL_THICKNESS_PX / 2 + R;

const body = (x, y) => ({ x, y });
const opts = (extra = {}) => ({ radiusOf: () => R, ...extra });

// Is this body clear of the plate — i.e. outside the exact collision capsule the movement rule
// (`wallEdgeAt` at this radius) uses? This is the real assertion behind every case below.
function clearOfPlate(b) {
  const s = spanCollideSegment(GATE, R);
  return pointSegmentDistance(s.x0, s.y0, s.x1, s.y1, b.x, b.y) > HALF;
}

describe('bodyInGateMouth / gateMouthOccupied — the occupancy test elevator doors run on', () => {
  it('is true for a body standing in the opening', () => {
    expect(bodyInGateMouth(body(0, 0), GATE, R)).toBe(true);
    expect(bodyInGateMouth(body(-15, 4), GATE, R)).toBe(true);
  });

  it('is false for a body clear across the plate, or standing beside the door', () => {
    expect(bodyInGateMouth(body(0, HALF + 1), GATE, R)).toBe(false);
    expect(bodyInGateMouth(body(90, 0), GATE, R)).toBe(false);
  });

  it('agrees with the movement rule: exactly the bodies that closing would have trapped', () => {
    for (const y of [0, 5, 10, 20, HALF - 0.5, HALF + 0.5, 40, 60]) {
      const b = body(0, y);
      expect(bodyInGateMouth(b, GATE, R)).toBe(!clearOfPlate(b));
    }
  });

  it('scales with the body-s own radius — a tank fits where a mech does not', () => {
    const b = body(0, 20);
    expect(bodyInGateMouth(b, GATE, 8)).toBe(false);    // small unit, clear of the plate
    expect(bodyInGateMouth(b, GATE, 28)).toBe(true);    // mech, still inside it
  });

  it('reports a mouth occupied if ANY body is in it, and empty otherwise', () => {
    const radiusOf = () => R;
    expect(gateMouthOccupied([body(200, 200), body(0, 2)], GATE, radiusOf)).toBe(true);
    expect(gateMouthOccupied([body(200, 200), body(0, 90)], GATE, radiusOf)).toBe(false);
    expect(gateMouthOccupied([], GATE, radiusOf)).toBe(false);
    expect(gateMouthOccupied([body(0, 0)], null, radiusOf)).toBe(false);
  });
});

describe('nudgeFromGateMouth — the fallback displacement rule', () => {
  it('pushes a body standing in the mouth out of the plate entirely', () => {
    const b = body(0, 3);
    expect(clearOfPlate(b)).toBe(false);      // precondition: genuinely trapped
    expect(nudgeFromGateMouth([b], GATE, opts())).toBe(1);
    expect(clearOfPlate(b)).toBe(true);
  });

  it('pushes to whichever side the body is already nearer', () => {
    const above = body(0, -4), below = body(0, 5);
    nudgeFromGateMouth([above, below], GATE, opts());
    expect(above.y).toBeLessThan(0);          // stayed on its own side
    expect(below.y).toBeGreaterThan(0);
    expect(clearOfPlate(above)).toBe(true);
    expect(clearOfPlate(below)).toBe(true);
  });

  it('never overshoots — the nudge is the minimum clearance plus the margin', () => {
    const b = body(0, 5);
    nudgeFromGateMouth([b], GATE, opts());
    expect(b.y).toBeCloseTo(HALF + GATE_NUDGE_MARGIN_PX, 6);
  });

  it('does not slide the body along the span — only across it', () => {
    const b = body(7, 2);
    nudgeFromGateMouth([b], GATE, opts());
    expect(b.x).toBe(7);
  });

  it('resolves a body dead centre in the mouth deterministically', () => {
    const a = body(0, 0), c = body(0, 0);
    nudgeFromGateMouth([a], GATE, opts());
    nudgeFromGateMouth([c], GATE, opts());
    expect(a.y).toBe(c.y);
    expect(clearOfPlate(a)).toBe(true);
  });

  it('leaves alone a body that is merely near the gate, not in it', () => {
    const beside = body(0, HALF + 5);         // clear across the plate
    const past = body(80, 0);                 // past the end of the span, beside the door
    expect(nudgeFromGateMouth([beside, past], GATE, opts())).toBe(0);
    expect(beside).toEqual({ x: 0, y: HALF + 5 });
    expect(past).toEqual({ x: 80, y: 0 });
  });

  it('nudges players and enemies alike, each at its own radius', () => {
    const tank = { x: 0, y: 2, r: 8 }, mech = { x: 10, y: 2, r: 28 };
    expect(nudgeFromGateMouth([tank, mech], GATE, { radiusOf: (b) => b.r })).toBe(2);
    expect(tank.y).toBeCloseTo(WALL_THICKNESS_PX / 2 + 8 + GATE_NUDGE_MARGIN_PX, 6);
    expect(mech.y).toBeCloseTo(WALL_THICKNESS_PX / 2 + 28 + GATE_NUDGE_MARGIN_PX, 6);
  });

  it('handles every body in the mouth at once, and reports how many moved', () => {
    const bodies = [body(-10, 1), body(0, -1), body(12, 4), body(200, 200)];
    expect(nudgeFromGateMouth(bodies, GATE, opts())).toBe(3);
    for (const b of bodies.slice(0, 3)) expect(clearOfPlate(b)).toBe(true);
  });

  it('is a no-op on an empty list, a missing gate, or a degenerate zero-length span', () => {
    expect(nudgeFromGateMouth([], GATE, opts())).toBe(0);
    expect(nudgeFromGateMouth([body(0, 0)], null, opts())).toBe(0);
    expect(nudgeFromGateMouth([body(0, 0)], { x0: 5, y0: 5, x1: 5, y1: 5 }, opts())).toBe(0);
  });
});

describe('nudgeFromGateMouth — the push is clipped through the caller‑s collision test', () => {
  it('never commits a push the world rejects', () => {
    const b = body(0, 3);
    expect(nudgeFromGateMouth([b], GATE, opts({ canMove: () => false }))).toBe(0);
    expect(b).toEqual({ x: 0, y: 3 });        // stuck beats teleported into a wall
  });

  it('goes out the FAR side when the nearer side is walled off', () => {
    const b = body(0, 4);                     // nearer side is +y
    // Everything on the +y side is solid (a unit backed against a building inside the compound).
    const canMove = (_b, x, y) => y < 0;
    expect(nudgeFromGateMouth([b], GATE, opts({ canMove }))).toBe(1);
    expect(b.y).toBeLessThan(0);
    expect(clearOfPlate(b)).toBe(true);
  });

  it('does not leave a body half-pushed when the far-side fallback also fails', () => {
    const b = body(0, 4);
    // Near side blocked, far side blocked too: the body must be untouched, not shifted partway.
    const canMove = (_b, _x, y) => Math.abs(y) > 500;
    expect(nudgeFromGateMouth([b], GATE, opts({ canMove }))).toBe(0);
    expect(b).toEqual({ x: 0, y: 4 });
  });

  it('asks the collision test at the destination, with the body itself', () => {
    const seen = [];
    const b = body(0, 2);
    nudgeFromGateMouth([b], GATE, opts({ canMove: (who, x, y) => { seen.push([who, x, y]); return true; } }));
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(b);
    expect(seen[0][2]).toBeCloseTo(HALF + GATE_NUDGE_MARGIN_PX, 6);
  });
});

describe('nudgeFromGateMouth — a diagonal span, so the rule is not axis-special', () => {
  const DIAG = { x0: -20, y0: -20, x1: 20, y1: 20 };
  const clearOfDiag = (b) => {
    const s = spanCollideSegment(DIAG, R);
    return pointSegmentDistance(s.x0, s.y0, s.x1, s.y1, b.x, b.y) > WALL_THICKNESS_PX / 2 + R;
  };

  it('pushes perpendicular to the span, to the nearer side, and clears the plate', () => {
    const left = { x: -5, y: 0 }, right = { x: 5, y: 0 };
    expect(nudgeFromGateMouth([left, right], DIAG, opts())).toBe(2);
    expect(clearOfDiag(left)).toBe(true);
    expect(clearOfDiag(right)).toBe(true);
    expect(left.x).toBeLessThan(-5);           // each stayed on its own side of the door line
    expect(right.x).toBeGreaterThan(5);
    // Perpendicular means the displacement is along (1,-1)/√2: equal and opposite in x and y.
    expect(left.x + 5).toBeCloseTo(-(left.y - 0), 6);
  });
});
