// #312: the ARENA-side half of enemy pathfinding. The graph search and the caching/invalidation
// policy are covered exhaustively in data/hexRoute.test.js; what's pinned HERE is the wiring —
// that the scene's traversability predicates agree with the movement integrator's own notion of
// what blocks an enemy, and that a unit facing an obstacle actually gets steered around it.
//
// EnemiesMixin's routing methods read only `this.terrain` / `this.wallEdges` / `this.time` and
// pure helpers, so they run against a minimal fake ArenaScene `this`, the same pattern
// world.test.js and wallEdgeWorld.test.js use.
import { describe, it, expect, vi } from 'vitest';
// enemies.js transitively imports Phaser (for its display objects), which needs a DOM. The routing
// methods under test touch none of it — same stub enemyStandDown.test.js uses.
vi.mock('phaser', () => ({ default: {} }));
import { EnemiesMixin } from './enemies.js';
import { WorldMixin } from './world.js';
import { makeWallEdgeSet, setGateOpen, damageWallEdge, SPAN_ROLE_GATE } from '../../data/wallEdges.js';
import { edgeKey, edgeMidpoint } from '../../data/hexEdges.js';
import { hexToPixel, axialKey, neighbors, distance } from '../../data/hexgrid.js';

const CENTRE = { q: 0, r: 0 };
const centre = (h) => hexToPixel(h.q, h.r);

// A wide field of open grass, so anything that blocks is unambiguously a wall or an explicitly
// placed impassable hex — never the map edge.
function makeScene({ wallDefs = [], impassable = [] } = {}) {
  const terrain = new Map();
  for (let q = -12; q <= 12; q++) for (let r = -12; r <= 12; r++) terrain.set(axialKey(q, r), 'grass');
  for (const h of impassable) terrain.set(axialKey(h.q, h.r), 'deepWater');
  const scene = Object.assign({}, WorldMixin, EnemiesMixin, {
    terrain,
    wallEdges: makeWallEdgeSet(wallDefs),
    time: { now: 0 },
    buildingHp: new Map(),
    coverHp: new Map(),
    px: 0, py: 0,
    _redrawWallEdges() {},
    _outpostCollapseFx() {},
  });
  return scene;
}

// The six spans fully enclosing the origin — #288's sealed ring, in miniature.
const ringDefs = (c = CENTRE) => neighbors(c.q, c.r).map((n) => ({ a: c, b: n, baseId: 'b1' }));

describe('#312 _canEnemyStep — traversability is per EDGE', () => {
  it('agrees with the movement integrator: both flanking hexes are passable, the edge is not', () => {
    const a = CENTRE, b = neighbors(0, 0)[0];
    const s = makeScene({ wallDefs: [{ a, b }] });
    // The integrator's own view: neither tile blocks, but the band between them does.
    expect(s._blocked(centre(a).x, centre(a).y)).toBe(false);
    expect(s._blocked(centre(b).x, centre(b).y)).toBe(false);
    const m = edgeMidpoint(a, b);
    expect(s._blocked(m.x, m.y)).toBe(true);
    // Routing must reach the same conclusion, which a tile-only predicate could not.
    expect(s._canEnemyStep(a, b)).toBe(false);
    expect(s._canEnemyStep(b, a)).toBe(false);
    expect(s._canEnemyStep(a, neighbors(0, 0)[1])).toBe(true);
  });

  it('blocks a step onto impassable terrain', () => {
    const water = neighbors(0, 0)[2];
    const s = makeScene({ impassable: [water] });
    expect(s._canEnemyStep(CENTRE, water)).toBe(false);
  });

  it('an OPEN gate is steppable — and matches the movement query _blocked exactly', () => {
    const defs = ringDefs();
    defs[0].role = SPAN_ROLE_GATE;
    const s = makeScene({ wallDefs: defs });
    const gate = s.wallEdges.edges.get(edgeKey(defs[0].a, defs[0].b));

    expect(s._canEnemyStep(defs[0].a, defs[0].b)).toBe(false);       // shut
    setGateOpen(s.wallEdges, gate, true);
    expect(s._canEnemyStep(defs[0].a, defs[0].b)).toBe(true);        // open: everyone through

    // Routing and movement must agree about the same span — a disagreement here is how a unit
    // ends up planning through a door it then cannot walk through, or vice versa. Since the #309
    // playtest there is one answer for everyone, so this is a straight equality rather than the
    // enemy/player split it used to assert.
    const m = edgeMidpoint(defs[0].a, defs[0].b);
    expect(s._blocked(m.x, m.y)).toBe(false);
    setGateOpen(s.wallEdges, gate, false);
    expect(s._canEnemyStep(defs[0].a, defs[0].b)).toBe(false);
    expect(s._blocked(m.x, m.y)).toBe(true);
  });
});

describe('#312 _enemyLineClear', () => {
  it('is false through a wall span and true across open ground', () => {
    const a = CENTRE, b = neighbors(0, 0)[0];
    const s = makeScene({ wallDefs: [{ a, b }] });
    const ca = centre(a), cb = centre(b);
    expect(s._enemyLineClear(ca.x, ca.y, cb.x, cb.y)).toBe(false);
    const far = centre({ q: 0, r: 4 });
    expect(s._enemyLineClear(ca.x, ca.y, far.x, far.y)).toBe(true);
  });

  it('is true through an OPEN gate — the enemy needs no route for a doorway that is standing open', () => {
    const defs = ringDefs();
    defs[0].role = SPAN_ROLE_GATE;
    const s = makeScene({ wallDefs: defs });
    const ca = centre(defs[0].a), cb = centre(defs[0].b);
    expect(s._enemyLineClear(ca.x, ca.y, cb.x, cb.y)).toBe(false);
    setGateOpen(s.wallEdges, s.wallEdges.edges.get(edgeKey(defs[0].a, defs[0].b)), true);
    expect(s._enemyLineClear(ca.x, ca.y, cb.x, cb.y)).toBe(true);
  });
});

describe('#312 _routedIntent — the steering the movement code consumes', () => {
  const unitAt = (h) => { const c = centre(h); return { x: c.x, y: c.y }; };

  it('steers dead straight when nothing is in the way (unchanged from before #312)', () => {
    const s = makeScene();
    const e = unitAt(CENTRE);
    const target = centre({ q: 5, r: 0 });
    const got = s._routedIntent(e, target.x, target.y);
    const dx = target.x - e.x, dy = target.y - e.y, m = Math.hypot(dx, dy);
    expect(got.mx).toBeCloseTo(dx / m, 6);
    expect(got.my).toBeCloseTo(dy / m, 6);
  });

  it('steers AROUND a wall rather than into it', () => {
    const a = CENTRE, b = neighbors(0, 0)[0];
    const s = makeScene({ wallDefs: [{ a, b }] });
    const e = unitAt(a);
    const target = centre(b);
    const direct = { x: target.x - e.x, y: target.y - e.y };
    const dm = Math.hypot(direct.x, direct.y);
    s._enemyRouter?.beginTick();
    const got = s._routedIntent(e, target.x, target.y);
    // The routed heading is materially different from driving straight at the wall.
    const dot = got.mx * (direct.x / dm) + got.my * (direct.y / dm);
    expect(dot).toBeLessThan(0.95);
    // And following it does not put the unit inside the wall band.
    expect(s._blocked(e.x + got.mx * 20, e.y + got.my * 20)).toBe(false);
  });

  it('a unit sealed inside an intact ring falls back to the old straight-line steer, not a freeze', () => {
    const s = makeScene({ wallDefs: ringDefs() });
    const e = unitAt(CENTRE);
    const target = centre({ q: 5, r: 0 });
    const got = s._routedIntent(e, target.x, target.y);
    // Non-zero, and pointing at the target exactly as it did before this feature existed.
    expect(Math.hypot(got.mx, got.my)).toBeCloseTo(1, 6);
    const dx = target.x - e.x, dy = target.y - e.y, m = Math.hypot(dx, dy);
    expect(got.mx).toBeCloseTo(dx / m, 6);
    expect(s._enemyRouter.routeFor(e).complete).toBe(false);
  });

  // Both tests below deliberately open the ring on the side AWAY from the target (index 3 is
  // (-1,0); the target is out past (1,0)). That forces a genuine route — out the back and around
  // — rather than the degenerate case where the opening happens to lie on the straight line, in
  // which case the correct behaviour is to stop routing entirely and just drive at it.
  const BACK = 3;

  it('routes OUT through a gate the moment it opens, once routes are invalidated', () => {
    const defs = ringDefs();
    defs[BACK].role = SPAN_ROLE_GATE;
    const s = makeScene({ wallDefs: defs });
    const e = unitAt(CENTRE);
    const target = centre({ q: 5, r: 0 });

    s._enemyRouter?.beginTick();
    s._routedIntent(e, target.x, target.y);
    expect(s._enemyRouter.routeFor(e).complete).toBe(false);      // sealed

    setGateOpen(s.wallEdges, s.wallEdges.edges.get(edgeKey(defs[BACK].a, defs[BACK].b)), true);
    s._invalidateRoutes();
    s.time.now = 50;
    s._enemyRouter.beginTick();
    s._routedIntent(e, target.x, target.y);
    const route = s._enemyRouter.routeFor(e);
    expect(route.complete).toBe(true);
    expect(route.path[0]).toEqual({ q: defs[BACK].b.q, r: defs[BACK].b.r });   // out the gate
  });

  it('a breached span invalidates cached routes through _damageWallEdge', () => {
    const defs = ringDefs();
    const s = makeScene({ wallDefs: defs });
    const e = unitAt(CENTRE);
    const target = centre({ q: 5, r: 0 });

    s._enemyRouter?.beginTick();
    s._routedIntent(e, target.x, target.y);
    expect(s._enemyRouter.routeFor(e).complete).toBe(false);
    const epochBefore = s._enemyRouter.epoch;

    // The player shoots a span down — the scene's own damage path must bump the epoch. #392: this
    // ring is a SINGLE wall hex (every span shares base-side CENTRE), so breaching the BACK span
    // opens the WHOLE hex at once, not just that one face.
    const span = s.wallEdges.edges.get(edgeKey(defs[BACK].a, defs[BACK].b));
    s._damageWallEdge(span, 99999);
    expect(span.destroyed).toBe(true);
    expect(s._liveWallEdges()).toHaveLength(0);   // #392: the off-line breach opened the whole ring
    expect(s._enemyRouter.epoch).toBeGreaterThan(epochBefore);

    // The route cache is now stale (epoch bumped) AND the way out is wide open. On recompute the
    // unit has a clear line to the target and heads straight for it rather than routing around a
    // remnant — there is no remnant left to route around.
    s.time.now = 10;   // deep inside the failure backoff — the epoch bump is what overrides it
    s._enemyRouter.beginTick();
    const got = s._routedIntent(e, target.x, target.y);
    const dx = target.x - e.x, dy = target.y - e.y, m = Math.hypot(dx, dy);
    expect(got.mx).toBeCloseTo(dx / m, 6);
    expect(got.my).toBeCloseTo(dy / m, 6);
  });

  it('breaching the span directly on the line stops routing entirely — the unit just drives at it', () => {
    // The complementary case, pinned so the behaviour above is understood as deliberate: when the
    // hole IS the way you were already facing, the right answer is no route at all.
    const defs = ringDefs();
    const s = makeScene({ wallDefs: defs });
    const e = unitAt(CENTRE);
    const target = centre({ q: 5, r: 0 });
    expect(s._enemyLineClear(e.x, e.y, target.x, target.y)).toBe(false);

    s._damageWallEdge(s.wallEdges.edges.get(edgeKey(defs[0].a, defs[0].b)), 99999);
    expect(s._enemyLineClear(e.x, e.y, target.x, target.y)).toBe(true);

    s.time.now = 10;
    s._enemyRouter?.beginTick();
    const got = s._routedIntent(e, target.x, target.y);
    const dx = target.x - e.x, dy = target.y - e.y, m = Math.hypot(dx, dy);
    expect(got.mx).toBeCloseTo(dx / m, 6);
  });

  it('walking the routed heading actually escapes a ring with one gap (no stalling)', () => {
    // The end-to-end claim, simulated: step the unit along whatever heading routing hands it and
    // check it genuinely gets out, using the integrator's OWN block test to reject illegal steps.
    const defs = ringDefs();
    const gap = defs.pop();                       // one span missing — the way out
    const s = makeScene({ wallDefs: defs });
    const e = unitAt(CENTRE);
    const target = centre({ q: 6, r: 0 });

    let escaped = false;
    for (let step = 0; step < 400 && !escaped; step++) {
      s.time.now = step * 16;
      s._enemyRouter?.beginTick();
      const { mx, my } = s._routedIntent(e, target.x, target.y);
      const nx = e.x + mx * 6, ny = e.y + my * 6;
      if (!s._blocked(nx, ny)) { e.x = nx; e.y = ny; }
      if (distance({ q: 0, r: 0 }, { q: 0, r: 0 }) === 0 && Math.hypot(e.x, e.y) > 120) escaped = true;
    }
    expect(escaped).toBe(true);
    expect(Math.hypot(e.x - target.x, e.y - target.y)).toBeLessThan(Math.hypot(target.x, target.y));
    void gap;
  });
});
