// #288: the destructible edge-wall layer — the pure half of "walls block movement and sight, you
// shoot a span down, then you drive through the gap." The scene wiring is thin on top of this; the
// behaviour lives here.
import { describe, it, expect } from 'vitest';
import {
  makeWallEdgeSet, wallEdgeAt, wallEdgeCrossing, nearestWallEdge, damageWallEdge, liveWallEdges,
  WALL_EDGE_HP, WALL_THICKNESS_PX, WALL_STOMP_FACTOR,
} from './wallEdges.js';
import { edgeKey, edgeEndpoints, edgeMidpoint } from './hexEdges.js';
import { HEX_SIZE, hexToPixel, neighbors } from './hexgrid.js';

const A = { q: 0, r: 0 };
const B = neighbors(A.q, A.r)[0];          // A's east neighbour — one shared edge
const oneWall = () => makeWallEdgeSet([{ a: A, b: B, baseId: 'base-1' }]);

// A short row of spans around one hex, so "one span falls, the rest stand" is testable.
const rowWall = () => makeWallEdgeSet(neighbors(A.q, A.r).map((n) => ({ a: A, b: n, baseId: 'b' })));

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
    expect(damageWallEdge(set, e, 10)).toEqual({ hp: WALL_EDGE_HP - 10, destroyed: false });
    expect(damageWallEdge(set, e, WALL_EDGE_HP)).toEqual({ hp: 0, destroyed: true });
    expect(e.destroyed).toBe(true);
    // Already down: further hits are inert, and it never "re-destroys".
    expect(damageWallEdge(set, e, 50)).toEqual({ hp: 0, destroyed: false });
    expect(damageWallEdge(set, null, 50)).toEqual({ hp: 0, destroyed: false });
  });

  // The breach mechanic: grinding one span down opens a gap in the line while every other span is
  // completely untouched — independent pools, no shared HP, no "weak point" that drops the row.
  it('breaching ONE span leaves every other span at full HP and still standing', () => {
    const set = rowWall();
    const all = [...set.edges.values()];
    expect(all).toHaveLength(6);
    damageWallEdge(set, all[2], WALL_EDGE_HP);
    expect(liveWallEdges(set)).toHaveLength(5);
    for (const other of all.filter((e) => e !== all[2])) {
      expect(other.hp).toBe(WALL_EDGE_HP);
      expect(other.destroyed).toBe(false);
      const m = edgeMidpoint(other.a, other.b);
      expect(wallEdgeAt(set, m.x, m.y)).toBeTruthy();
    }
    // And the gap is a real hole you can pass through — the span's own midpoint is now open ground.
    const gap = edgeMidpoint(all[2].a, all[2].b);
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
    const set = rowWall();
    expect(liveWallEdges(set)).toHaveLength(6);
    for (const e of [...set.edges.values()].slice(0, 4)) damageWallEdge(set, e, 999);
    expect(liveWallEdges(set)).toHaveLength(2);
    expect(liveWallEdges(null)).toEqual([]);
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
    // #299 toughness scale: tank 80, quadruped 150, light mech 200. A gate span you can pop faster
    // than the cheapest vehicle in the game was the exact complaint #313 was filed about.
    expect(WALL_EDGE_HP).toBeGreaterThan(80);
    expect(WALL_EDGE_HP).toBeGreaterThanOrEqual(200);
  });

  it('still falls to a full pool of damage in one bite, and survives one short of it', () => {
    // Guards the raise against an off-by-one in any damage path that assumed the old 55.
    const set = oneWall();
    const e = [...set.edges.values()][0];
    expect(damageWallEdge(set, e, WALL_EDGE_HP - 1)).toEqual({ hp: 1, destroyed: false });
    expect(damageWallEdge(set, e, 1)).toEqual({ hp: 0, destroyed: true });
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
