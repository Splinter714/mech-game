import { describe, it, expect } from 'vitest';
import {
  findHexPath, makeRouter, ROUTE_FAIL_BACKOFF_MS, ROUTE_REPLAN_MS, LINE_CHECK_MS,
} from './hexRoute.js';
import { axialKey, hexToPixel, pixelToHex, distance, neighbors } from './hexgrid.js';
import { makeWallEdgeSet, blocksSpan, setGateOpen, damageWallEdge, SPAN_ROLE_GATE } from './wallEdges.js';
import { edgeKey } from './hexEdges.js';

// ── Helpers ─────────────────────────────────────────────────────────────────────────────
// The traversability predicate the game itself builds: tile passability of the destination hex
// AND no blocking span on the edge between. Since the #309 playtest `blocksSpan` takes no
// per-caller opt-in — an open gate is passable to everyone — so there is one stepper, not two.
const stepper = (blockedHexes = new Set(), wallSet = null) => (from, to) => {
  if (blockedHexes.has(axialKey(to.q, to.r))) return false;
  if (wallSet) {
    const e = wallSet.edges.get(edgeKey(from, to));
    if (e && blocksSpan(e)) return false;
  }
  return true;
};

// A ring of 6 wall spans fully enclosing the origin hex: every edge between the origin and each
// of its 6 neighbours. This is the shape #288 builds around a base, in miniature.
const sealDefs = (centre = { q: 0, r: 0 }, role = undefined) =>
  neighbors(centre.q, centre.r).map((n) => ({ a: centre, b: n, baseId: 'b1', ...(role ? { role } : {}) }));

const pathKeys = (p) => p.map((h) => axialKey(h.q, h.r));

describe('findHexPath — basic A*', () => {
  it('returns an empty complete path when already at the goal', () => {
    const r = findHexPath({ q: 2, r: -1 }, { q: 2, r: -1 }, () => true);
    expect(r.complete).toBe(true);
    expect(r.path).toEqual([]);
  });

  it('finds a shortest route across open ground', () => {
    const goal = { q: 5, r: -2 };
    const r = findHexPath({ q: 0, r: 0 }, goal, () => true);
    expect(r.complete).toBe(true);
    // Shortest possible: one step per unit of hex distance, and it ends ON the goal.
    expect(r.path.length).toBe(distance({ q: 0, r: 0 }, goal));
    expect(r.path[r.path.length - 1]).toEqual(goal);
  });

  it('never includes the start hex as a waypoint (the unit is already there)', () => {
    const r = findHexPath({ q: 0, r: 0 }, { q: 3, r: 0 }, () => true);
    expect(pathKeys(r.path)).not.toContain(axialKey(0, 0));
  });

  it('produces a path whose every step is a legal single-hex move', () => {
    const blocked = new Set([axialKey(1, 0), axialKey(1, 1), axialKey(2, 0)]);
    const r = findHexPath({ q: 0, r: 0 }, { q: 4, r: 0 }, stepper(blocked));
    expect(r.complete).toBe(true);
    let prev = { q: 0, r: 0 };
    for (const h of r.path) {
      expect(distance(prev, h)).toBe(1);
      expect(blocked.has(axialKey(h.q, h.r))).toBe(false);
      prev = h;
    }
  });
});

describe('findHexPath — blocking TERRAIN', () => {
  it('routes around a wall of impassable hexes rather than through it', () => {
    // A vertical-ish barrier of impassable hexes at q=2, with a hole nowhere near the straight line.
    const blocked = new Set([-3, -2, -1, 0, 1, 2, 3].map((r) => axialKey(2, r)));
    const r = findHexPath({ q: 0, r: 0 }, { q: 5, r: 0 }, stepper(blocked));
    expect(r.complete).toBe(true);
    for (const h of r.path) expect(blocked.has(axialKey(h.q, h.r))).toBe(false);
    // It had to detour, so it is longer than the free-space distance.
    expect(r.path.length).toBeGreaterThan(distance({ q: 0, r: 0 }, { q: 5, r: 0 }));
  });

  it('reports incomplete with a best-effort partial route when the goal is walled off', () => {
    // Seal the goal hex behind impassable terrain on all six sides.
    const goal = { q: 5, r: 0 };
    const blocked = new Set(neighbors(goal.q, goal.r).map((n) => axialKey(n.q, n.r)));
    const r = findHexPath({ q: 0, r: 0 }, goal, stepper(blocked));
    expect(r.complete).toBe(false);
    // Degrades gracefully: it still walks as close as it can get rather than returning nothing.
    expect(r.path.length).toBeGreaterThan(0);
    expect(distance(r.path[r.path.length - 1], goal)).toBe(2);
  });

  it('returns no path at all when the unit itself is completely enclosed', () => {
    const blocked = new Set(neighbors(0, 0).map((n) => axialKey(n.q, n.r)));
    const r = findHexPath({ q: 0, r: 0 }, { q: 6, r: 0 }, stepper(blocked));
    expect(r.complete).toBe(false);
    expect(r.path).toEqual([]);
  });

  it('still plans a way OUT of a hex the unit should not be standing on', () => {
    // The start hex is itself in the blocked set (shoved into a wall, or terrain collapsed under
    // it). Start passability is deliberately never tested, or the unit would be frozen forever.
    const blocked = new Set([axialKey(0, 0)]);
    const r = findHexPath({ q: 0, r: 0 }, { q: 3, r: 0 }, stepper(blocked));
    expect(r.complete).toBe(true);
    expect(r.path.length).toBeGreaterThan(0);
  });

  it('respects the node cap and still returns a partial route', () => {
    const r = findHexPath({ q: 0, r: 0 }, { q: 400, r: 0 }, () => true, 40);
    expect(r.expanded).toBeLessThanOrEqual(40);
    expect(r.complete).toBe(false);
    expect(r.path.length).toBeGreaterThan(0);
  });
});

describe('findHexPath — blocking EDGES (#288 walls: the case a tile-only A* fails)', () => {
  // This is the crux of #312. Both hexes flanking a wall span are ORDINARY GROUND, so a tile-only
  // search plans straight through the wall. These tests pin the per-edge behaviour.

  it('a tile-only predicate would walk straight through a wall — the edge predicate does not', () => {
    const centre = { q: 0, r: 0 };
    const set = makeWallEdgeSet(sealDefs(centre));
    const goal = { q: 0, r: 0 };
    const start = { q: 3, r: 0 };

    // Tile-only: every hex is passable ground, so it happily plans right through the ring.
    const tileOnly = findHexPath(start, goal, () => true);
    expect(tileOnly.complete).toBe(true);

    // Edge-aware: the ring is sealed, so there is genuinely no route in.
    const edgeAware = findHexPath(start, goal, stepper(new Set(), set));
    expect(edgeAware.complete).toBe(false);
  });

  it('routes AROUND a single wall span instead of crossing it', () => {
    const a = { q: 0, r: 0 }, b = { q: 1, r: 0 };
    const set = makeWallEdgeSet([{ a, b, baseId: 'b1' }]);
    const r = findHexPath(a, b, stepper(new Set(), set));
    expect(r.complete).toBe(true);
    // The direct step is one hex; going around costs more, and never uses the blocked edge.
    expect(r.path.length).toBeGreaterThan(1);
    let prev = a;
    for (const h of r.path) {
      expect(set.edges.get(edgeKey(prev, h))).toBeUndefined();
      prev = h;
    }
  });

  it('both hexes flanking the wall are themselves perfectly enterable', () => {
    // Guards the premise: the span blocks the EDGE, not either tile — so any fix that worked by
    // marking tiles impassable would be wrong, and this test would catch it.
    const a = { q: 0, r: 0 }, b = { q: 1, r: 0 };
    const set = makeWallEdgeSet([{ a, b, baseId: 'b1' }]);
    const canStep = stepper(new Set(), set);
    // Reachable from elsewhere...
    expect(findHexPath({ q: 3, r: 0 }, b, canStep).complete).toBe(true);
    expect(findHexPath({ q: -3, r: 0 }, a, canStep).complete).toBe(true);
    // ...just not across the shared edge.
    expect(canStep(a, b)).toBe(false);
    expect(canStep(b, a)).toBe(false);   // canonical: blocked from either side
  });

  it('finds the gap when a ring has one span missing', () => {
    const centre = { q: 0, r: 0 };
    const defs = sealDefs(centre);
    const gapNeighbour = defs[2].b;
    const set = makeWallEdgeSet(defs.filter((_, i) => i !== 2));
    const r = findHexPath({ q: 4, r: 0 }, centre, stepper(new Set(), set));
    expect(r.complete).toBe(true);
    // The last step in must come through the one unwalled neighbour.
    expect(r.path[r.path.length - 2]).toEqual({ q: gapNeighbour.q, r: gapNeighbour.r });
  });
});

describe('findHexPath — #309 gates', () => {
  const centre = { q: 0, r: 0 };
  const build = () => {
    const defs = sealDefs(centre);
    defs[0].role = SPAN_ROLE_GATE;
    return { set: makeWallEdgeSet(defs), gateNeighbour: defs[0].b };
  };

  it('a CLOSED gate is as solid as a wall — no route in, for anybody', () => {
    const { set } = build();
    expect(findHexPath({ q: 4, r: 0 }, centre, stepper(new Set(), set, true)).complete).toBe(false);
    expect(findHexPath({ q: 4, r: 0 }, centre, stepper(new Set(), set, false)).complete).toBe(false);
  });

  // #309 playtest: an OPEN gate is a real route in BOTH directions, for everyone. The garrison
  // routes out through it, and the player routes in through the very same span — there is no
  // longer a player form of the predicate that sees it as solid.
  it('an OPEN gate is a real route out for the garrison AND in for the player', () => {
    const { set, gateNeighbour } = build();
    const gate = set.edges.get(edgeKey(centre, gateNeighbour));
    setGateOpen(set, gate, true);

    // Outbound: the garrison unit's way out is through the gate's own neighbour hex.
    const out = findHexPath(centre, { q: 4, r: 0 }, stepper(new Set(), set));
    expect(out.complete).toBe(true);
    expect(out.path[0]).toEqual({ q: gateNeighbour.q, r: gateNeighbour.r });

    // Inbound: the same span, the other way. This is the entry the playtest opened up.
    const inbound = findHexPath({ q: 4, r: 0 }, centre, stepper(new Set(), set));
    expect(inbound.complete).toBe(true);
  });

  // …and the counterpart that proves the door is what did it: SHUT it, and the ring is sealed
  // again in both directions.
  it('a SHUT gate seals the ring against the garrison and the player alike', () => {
    const { set, gateNeighbour } = build();
    setGateOpen(set, set.edges.get(edgeKey(centre, gateNeighbour)), false);
    expect(findHexPath(centre, { q: 4, r: 0 }, stepper(new Set(), set)).complete).toBe(false);
    expect(findHexPath({ q: 4, r: 0 }, centre, stepper(new Set(), set)).complete).toBe(false);
  });

  it('does not mistake an open gate for a wall when routing around', () => {
    // Regression guard for the specific bug the issue warns about: routing that used the PLAYER's
    // blocking form for enemies would send a garrison unit hunting for a gap that already exists.
    const { set, gateNeighbour } = build();
    setGateOpen(set, set.edges.get(edgeKey(centre, gateNeighbour)), true);
    const r = findHexPath(centre, { q: 4, r: 0 }, stepper(new Set(), set, true));
    expect(r.complete).toBe(true);
    expect(r.path.length).toBeLessThanOrEqual(5);   // straight out the gate, not a scenic detour
  });

  it('a gate destroyed while shut becomes a permanent breach for everyone', () => {
    const { set, gateNeighbour } = build();
    const gate = set.edges.get(edgeKey(centre, gateNeighbour));
    damageWallEdge(set, gate, 99999);
    // Even the player form now gets through: a blown span blocks nobody.
    expect(findHexPath({ q: 4, r: 0 }, centre, stepper(new Set(), set, false)).complete).toBe(true);
  });
});

// ── Router: caching, invalidation, budget ───────────────────────────────────────────────
describe('makeRouter', () => {
  const centre = { q: 0, r: 0 };
  const px = (q, r) => hexToPixel(q, r);
  const ctxFor = (canStep, clearLine = () => false) => ({
    canStep, clearLine, hexOf: (x, y) => pixelToHex(x, y),
  });

  it('steers straight (returns null) when the line to the goal is clear', () => {
    const router = makeRouter();
    const unit = {};
    router.beginTick();
    const wp = router.follow(unit, 0, 0, { x: 300, y: 0 }, 0, ctxFor(() => true, () => true));
    expect(wp).toBeNull();
    expect(router.budgetLeft).toBe(4);      // and it did not spend a search doing so
  });

  it('returns a routed waypoint when the direct line is obstructed', () => {
    const set = makeWallEdgeSet([{ a: centre, b: { q: 1, r: 0 }, baseId: 'b1' }]);
    const router = makeRouter();
    const unit = {};
    router.beginTick();
    const goalPx = px(1, 0);
    const wp = router.follow(unit, 0, 0, goalPx, 0, ctxFor(stepper(new Set(), set, true)));
    expect(wp).not.toBeNull();
    // The waypoint is a real neighbouring hex centre, and NOT straight at the walled-off goal.
    const wpHex = pixelToHex(wp.x, wp.y);
    expect(distance(centre, wpHex)).toBe(1);
    expect(wpHex).not.toEqual({ q: 1, r: 0 });
  });

  it('caches: a second call on the same tick does not spend another search', () => {
    const router = makeRouter();
    const unit = {};
    const ctx = ctxFor(() => true);
    router.beginTick();
    router.follow(unit, 0, 0, px(6, 0), 0, ctx);
    const after = router.budgetLeft;
    router.follow(unit, 0, 0, px(6, 0), 1, ctx);
    router.follow(unit, 0, 0, px(6, 0), 2, ctx);
    expect(router.budgetLeft).toBe(after);
  });

  it('staggers a crowd across ticks via the shared per-tick budget', () => {
    const router = makeRouter({ budgetPerTick: 3 });
    const units = Array.from({ length: 10 }, () => ({}));
    const ctx = ctxFor(() => true);
    router.beginTick();
    for (const u of units) router.follow(u, 0, 0, px(6, 0), 0, ctx);
    // Only 3 of the 10 got to plan this tick; the rest are still routeless and will ask again.
    expect(router.budgetLeft).toBe(0);
    expect(units.filter((u) => (router.routeFor(u)?.path.length ?? 0) > 0).length).toBe(3);

    router.beginTick();
    expect(router.budgetLeft).toBe(3);
    for (const u of units) router.follow(u, 0, 0, px(6, 0), 0, ctx);
    expect(units.filter((u) => (router.routeFor(u)?.path.length ?? 0) > 0).length).toBe(6);
  });

  it('a sealed-in unit backs off instead of thrashing on repeated failed searches', () => {
    const set = makeWallEdgeSet(sealDefs(centre));
    const router = makeRouter();
    const unit = {};
    const ctx = ctxFor(stepper(new Set(), set, true));
    const goal = px(5, 0);

    router.beginTick();
    expect(router.follow(unit, 0, 0, goal, 0, ctx)).toBeNull();   // no route: caller steers straight
    expect(router.budgetLeft).toBe(3);
    expect(router.routeFor(unit).complete).toBe(false);

    // Many ticks later, still inside the backoff window and with the goal moving every tick
    // (the player runs around) — not one further search is spent.
    for (let t = 1; t < 60; t++) {
      router.beginTick();
      router.follow(unit, 0, 0, { x: goal.x + t * 30, y: goal.y }, t * 16, ctx);
      expect(router.budgetLeft).toBe(4);
    }

    // Once the backoff expires it does try again — it is backed off, not given up.
    router.beginTick();
    router.follow(unit, 0, 0, goal, ROUTE_FAIL_BACKOFF_MS + 1, ctx);
    expect(router.budgetLeft).toBe(3);
  });

  it('invalidate() re-plans immediately, cutting a failure backoff short (a breach)', () => {
    const defs = sealDefs(centre);
    const set = makeWallEdgeSet(defs);
    const router = makeRouter();
    const unit = {};
    const goal = px(4, 0);
    const ctx = ctxFor(stepper(new Set(), set, true));

    router.beginTick();
    expect(router.follow(unit, 0, 0, goal, 0, ctx)).toBeNull();
    expect(router.routeFor(unit).complete).toBe(false);

    // The player blows a span. Without the epoch bump the unit would sit here for 3 more seconds.
    const breached = set.edges.get(edgeKey(defs[0].a, defs[0].b));
    damageWallEdge(set, breached, 99999);
    router.invalidate();

    router.beginTick();
    const wp = router.follow(unit, 0, 0, goal, 10, ctx);      // 10ms later, deep inside the backoff
    expect(wp).not.toBeNull();
    expect(router.routeFor(unit).complete).toBe(true);
    expect(pixelToHex(wp.x, wp.y)).toEqual({ q: defs[0].b.q, r: defs[0].b.r });
  });

  it('invalidate() picks up a gate OPENING and again when it shuts (#309 cycling)', () => {
    const defs = sealDefs(centre);
    defs[0].role = SPAN_ROLE_GATE;
    const set = makeWallEdgeSet(defs);
    const gate = set.edges.get(edgeKey(defs[0].a, defs[0].b));
    const router = makeRouter();
    const unit = {};
    const goal = px(4, 0);
    const ctx = ctxFor(stepper(new Set(), set, true));

    // Shut: no way out.
    router.beginTick();
    router.follow(unit, 0, 0, goal, 0, ctx);
    expect(router.routeFor(unit).complete).toBe(false);

    // Opens — the base woke up.
    setGateOpen(set, gate, true);
    router.invalidate();
    router.beginTick();
    const out = router.follow(unit, 0, 0, goal, 100, ctx);
    expect(out).not.toBeNull();
    expect(router.routeFor(unit).complete).toBe(true);

    // Shuts again ~15s later — the unit must stop believing in its route through it.
    setGateOpen(set, gate, false);
    router.invalidate();
    router.beginTick();
    router.follow(unit, 0, 0, goal, 15000, ctx);
    expect(router.routeFor(unit).complete).toBe(false);
  });

  it('advances through waypoints as the unit reaches them', () => {
    const blocked = new Set([-2, -1, 0, 1, 2].map((r) => axialKey(1, r)));
    const router = makeRouter();
    const unit = {};
    const ctx = ctxFor(stepper(blocked));
    const goal = px(4, 0);

    router.beginTick();
    const first = router.follow(unit, 0, 0, goal, 0, ctx);
    expect(first).not.toBeNull();
    const startIndex = router.routeFor(unit).index;

    // Teleport the unit onto its current waypoint: the router should tick past it, not re-offer it.
    router.beginTick();
    const next = router.follow(unit, first.x, first.y, goal, 16, ctx);
    expect(router.routeFor(unit).index).toBeGreaterThan(startIndex);
    if (next) expect(Math.hypot(next.x - first.x, next.y - first.y)).toBeGreaterThan(0);
  });

  it('a cleared obstacle returns the unit to straight-line steering at once', () => {
    let clear = false;
    const blocked = new Set([-2, -1, 0, 1, 2].map((r) => axialKey(1, r)));
    const router = makeRouter();
    const unit = {};
    const ctx = { canStep: stepper(blocked), clearLine: () => clear, hexOf: (x, y) => pixelToHex(x, y) };
    const goal = px(4, 0);

    router.beginTick();
    expect(router.follow(unit, 0, 0, goal, 0, ctx)).not.toBeNull();

    // The line opens up. Without the epoch bump the cached "not clear" verdict would hold for
    // LINE_CHECK_MS; invalidate() is what the scene calls on a breach, so it re-tests now.
    clear = true;
    router.invalidate();
    router.beginTick();
    expect(router.follow(unit, 0, 0, goal, 1, ctx)).toBeNull();
  });

  it('does not re-run the clear-line test every frame', () => {
    let calls = 0;
    const router = makeRouter();
    const unit = {};
    const ctx = {
      canStep: () => true, hexOf: (x, y) => pixelToHex(x, y),
      clearLine: () => { calls++; return true; },
    };
    // 15 frames at 16ms ≈ 240ms, inside the 300ms throttle window: one test serves them all.
    for (let t = 0; t < 15; t++) { router.beginTick(); router.follow(unit, 0, 0, px(6, 0), t * 16, ctx); }
    expect(calls).toBe(1);
    router.beginTick();
    router.follow(unit, 0, 0, px(6, 0), LINE_CHECK_MS + 1, ctx);
    expect(calls).toBe(2);
  });

  it('refreshes a complete route on the slow cadence even when nothing invalidates it', () => {
    const blocked = new Set([-2, -1, 0, 1, 2].map((r) => axialKey(1, r)));
    const router = makeRouter();
    const unit = {};
    const ctx = ctxFor(stepper(blocked));
    router.beginTick();
    router.follow(unit, 0, 0, px(4, 0), 0, ctx);
    const spent = router.budgetLeft;
    router.beginTick();
    router.follow(unit, 0, 0, px(4, 0), ROUTE_REPLAN_MS + 1, ctx);
    expect(router.budgetLeft).toBeLessThan(spent + 1);
  });

  it('keeps per-unit routes independent', () => {
    const router = makeRouter();
    const a = {}, b = {};
    const blocked = new Set([-2, -1, 0, 1, 2].map((r) => axialKey(1, r)));
    const ctx = ctxFor(stepper(blocked));
    router.beginTick();
    router.follow(a, 0, 0, px(4, 0), 0, ctx);
    router.follow(b, px(0, 2).x, px(0, 2).y, px(4, 2), 0, ctx);
    expect(router.routeFor(a)).not.toBe(router.routeFor(b));
    router.forget(a);
    expect(router.routeFor(a)).toBeNull();
    expect(router.routeFor(b)).not.toBeNull();
  });
});
