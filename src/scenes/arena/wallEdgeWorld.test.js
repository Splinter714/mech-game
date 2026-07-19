// #288 (rebuilt as edge geometry): the arena world mixin's side of edge walls. The pure geometry is
// covered in data/wallEdges.test.js; what's pinned HERE is that the scene's existing, entirely
// tile-shaped world queries — passability, swept movement collision, line-of-sight, weapon damage
// routing — all honour a wall that owns no tile.
//
// WorldMixin's query methods have no Phaser dependency (they read `this.terrain`/`this.wallEdges`
// and pure helpers), so they're exercised against a minimal fake ArenaScene `this`, the same way
// world.test.js does.
import { describe, it, expect } from 'vitest';
import { WorldMixin } from './world.js';
import { makeWallEdgeSet, WALL_EDGE_HP, WALL_THICKNESS_PX } from '../../data/wallEdges.js';
import { edgeMidpoint } from '../../data/hexEdges.js';
import { hexToPixel, axialKey, neighbors, HEX_SIZE } from '../../data/hexgrid.js';

const A = { q: 0, r: 0 };
const B = neighbors(A.q, A.r)[0];

// Open grass everywhere, with one wall span on the A|B boundary — so anything that blocks in these
// tests is unambiguously the WALL and not the terrain.
function makeScene(defs = [{ a: A, b: B }]) {
  const terrain = new Map();
  for (let q = -6; q <= 6; q++) for (let r = -6; r <= 6; r++) terrain.set(axialKey(q, r), 'grass');
  const scene = Object.assign({}, WorldMixin, {
    terrain,
    wallEdges: makeWallEdgeSet(defs),
    time: { now: 0 },
    buildingHp: new Map(),
    coverHp: new Map(),
    _redrawWallEdges() {},
    _outpostCollapseFx() { scene.fxCount = (scene.fxCount ?? 0) + 1; },
  });
  return scene;
}

const centre = (h) => hexToPixel(h.q, h.r);

describe('#288 movement collision against a wall span', () => {
  it('the hexes either side of a wall are still fully passable — the wall consumes no tile', () => {
    const s = makeScene();
    for (const h of [A, B]) {
      const c = centre(h);
      expect(s._blocked(c.x, c.y)).toBe(false);
      expect(s.terrain.get(axialKey(h.q, h.r))).toBe('grass');
    }
  });

  it('the wall band itself is impassable', () => {
    const s = makeScene();
    const m = edgeMidpoint(A, B);
    expect(s._blocked(m.x, m.y)).toBe(true);
  });

  // The headline: you cannot walk from one side to the other, at any speed. A frame's movement at
  // full chassis speed is many times the wall's 14px painted thickness, so this has to be a swept
  // segment test rather than a sampled one.
  it('you cannot cross the wall in one step, however fast the step is', () => {
    const s = makeScene();
    const ca = centre(A), cb = centre(B);
    const ux = (cb.x - ca.x) / HEX_SIZE, uy = (cb.y - ca.y) / HEX_SIZE;
    for (const speed of [20, 100, 1000, 20000]) {
      const m = edgeMidpoint(A, B);
      expect(s._blockedAlongSegment(m.x - ux * speed, m.y - uy * speed, m.x + ux * speed, m.y + uy * speed)).toBe(true);
    }
  });

  it('movement that never touches the wall is unaffected', () => {
    const s = makeScene();
    const ca = centre(A);
    const far = centre({ q: 0, r: 3 });
    expect(s._blockedAlongSegment(ca.x, ca.y, far.x, far.y)).toBe(false);
    expect(s._blocked(far.x, far.y)).toBe(false);
  });

  // Breach and drive through: the whole point of the feature.
  it('once the span is shot down, the same crossing goes straight through', () => {
    const s = makeScene();
    const ca = centre(A), cb = centre(B);
    expect(s._blockedAlongSegment(ca.x, ca.y, cb.x, cb.y)).toBe(true);
    const span = [...s.wallEdges.edges.values()][0];
    s._damageWallEdge(span, WALL_EDGE_HP);
    expect(s._blockedAlongSegment(ca.x, ca.y, cb.x, cb.y)).toBe(false);
    const m = edgeMidpoint(A, B);
    expect(s._blocked(m.x, m.y)).toBe(false);
  });

  it('a scene with no walls at all behaves exactly as before', () => {
    const s = makeScene([]);
    const ca = centre(A), cb = centre(B);
    expect(s._blocked(ca.x, ca.y)).toBe(false);
    expect(s._blockedAlongSegment(ca.x, ca.y, cb.x, cb.y)).toBe(false);
    expect(s._isWall(ca.x, ca.y)).toBe(false);
  });
});

describe('#288 line-of-sight against a wall span', () => {
  const rayArgs = (from, to) => {
    const p0 = centre(from), p1 = centre(to);
    return [p0.x, p0.y, Math.atan2(p1.y - p0.y, p1.x - p0.x), Math.hypot(p1.x - p0.x, p1.y - p0.y), p1.x, p1.y];
  };

  it('a wall breaks line of sight between the hexes it separates', () => {
    const s = makeScene();
    const [x0, y0, ang, maxT, x1, y1] = rayArgs(A, B);
    expect(s._wallDistanceLos(x0, y0, ang, maxT, x1, y1)).not.toBe(Infinity);
    expect(s._wallDistance(x0, y0, ang, maxT)).not.toBe(Infinity);
    const m = edgeMidpoint(A, B);
    expect(s._isWall(m.x, m.y)).toBe(true);
    expect(s._isWallForRound(m.x, m.y, null, null)).toBe(true);
  });

  // `_wallDistanceLos` deliberately skips samples that land in the same hex as the previous one —
  // a point-sampled wall check could not survive that, so the wall half is an exact crossing test.
  it('blocks LOS even on a long ray whose sampling would skip past the span', () => {
    const s = makeScene();
    const far = { q: -4, r: 0 };
    const beyond = { q: 4, r: 0 };
    const p0 = centre(far), p1 = centre(beyond);
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x), maxT = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d = s._wallDistanceLos(p0.x, p0.y, ang, maxT, p1.x, p1.y);
    expect(d).not.toBe(Infinity);
    // …and it's blocked AT the wall, not at some arbitrary point along the lane.
    const m = edgeMidpoint(A, B);
    expect(d).toBeCloseTo(Math.hypot(m.x - p0.x, m.y - p0.y), 0);
  });

  it('sight is clear again once the span falls', () => {
    const s = makeScene();
    const [x0, y0, ang, maxT, x1, y1] = rayArgs(A, B);
    s._damageWallEdge([...s.wallEdges.edges.values()][0], WALL_EDGE_HP);
    expect(s._wallDistanceLos(x0, y0, ang, maxT, x1, y1)).toBe(Infinity);
    expect(s._wallDistance(x0, y0, ang, maxT)).toBe(Infinity);
  });

  it('sight past open ground is unaffected by a wall elsewhere', () => {
    const s = makeScene();
    const [x0, y0, ang, maxT, x1, y1] = rayArgs({ q: 0, r: -3 }, { q: 0, r: 3 });
    expect(s._wallDistanceLos(x0, y0, ang, maxT, x1, y1)).toBe(Infinity);
  });
});

describe('#288 weapon damage routing', () => {
  it('a hit landing on the wall damages the SPAN, not the terrain hex under it', () => {
    const s = makeScene();
    const m = edgeMidpoint(A, B);
    const span = [...s.wallEdges.edges.values()][0];
    expect(s._damageBuildingAt(m.x, m.y, 10)).toBe(false);
    expect(span.hp).toBe(WALL_EDGE_HP - 10);
    expect(s.terrain.get(axialKey(A.q, A.r))).toBe('grass');   // the ground is untouched
    expect(s.terrain.get(axialKey(B.q, B.r))).toBe('grass');
  });

  it('the killing blow destroys the span and plays the collapse', () => {
    const s = makeScene();
    const m = edgeMidpoint(A, B);
    const span = [...s.wallEdges.edges.values()][0];
    expect(s._damageBuildingAt(m.x, m.y, WALL_EDGE_HP)).toBe(true);
    expect(span.destroyed).toBe(true);
    expect(s.fxCount).toBe(1);
    expect(s._liveWallEdges()).toHaveLength(0);
  });

  it('a hit well clear of the wall never touches it', () => {
    const s = makeScene();
    const far = centre({ q: 0, r: 3 });
    s._damageBuildingAt(far.x, far.y, 999);
    expect([...s.wallEdges.edges.values()][0].hp).toBe(WALL_EDGE_HP);
  });

  // A round's step is a swept segment, so a fast round detonates ON the wall's face rather than
  // sailing through it (scenes/arena/projectiles.js reads this).
  it('_wallEdgeHit reports where a fast round meets the wall', () => {
    const s = makeScene();
    const ca = centre(A), cb = centre(B);
    const ux = (cb.x - ca.x) / HEX_SIZE, uy = (cb.y - ca.y) / HEX_SIZE;
    const m = edgeMidpoint(A, B);
    const hit = s._wallEdgeHit(m.x - ux * 900, m.y - uy * 900, m.x + ux * 900, m.y + uy * 900);
    expect(hit).toBeTruthy();
    expect(Math.hypot(hit.x - m.x, hit.y - m.y)).toBeLessThan(WALL_THICKNESS_PX);
  });
});
