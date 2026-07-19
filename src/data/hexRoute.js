// #312: A* path planning over the axial hex grid, with EDGE-aware traversability.
//
// Every enemy goal in this game used to be a straight-line steer, so a ground unit with a wall or
// an impassable tile between it and its target drove into the obstacle and stalled there. This
// module is the graph half of the fix: it answers "what sequence of hexes gets me from A to B",
// and the existing movement integrator (scenes/arena/enemies.js) still does the actual steering —
// it just steers at the next WAYPOINT instead of at the far-away goal. The final leg is unchanged.
//
// Pure: no Phaser, no scene, no game state. All hex knowledge is imported from hexgrid.js per the
// repo's "hexgrid.js is the only file that knows hexes exist" rule — no new hex math is invented
// here, only graph search over `neighbors`/`distance`.
//
// ── The crux: traversability is per-EDGE, not per-tile ─────────────────────────────────
// #288's base walls live on hex BOUNDARIES, not on tiles. Both hexes flanking a wall span are
// perfectly ordinary ground, so a conventional tile-only A* plans a route straight THROUGH a wall
// and the feature does nothing for the case that prompted the issue. So the search's primitive is
// deliberately `canStep(from, to)` — "can this unit move from this hex to that adjacent one" —
// which the caller implements as tile passability of `to` AND no blocking span on the edge
// between. A tile-only predicate is expressible as a `canStep` that ignores `from`; the reverse is
// not, which is why the edge form is the one baked in here.
import { axialKey, neighbors, distance, hexToPixel } from './hexgrid.js';

// ── Tuning (owner: tunable) ─────────────────────────────────────────────────────────────
// How many nodes one search may expand before giving up. The world is a disc a few dozen hexes
// across, so a complete search of everything reachable is well under this; the cap exists so a
// pathological case (a unit sealed in a large open pocket with the goal outside it) costs a
// bounded amount rather than sweeping the whole map. On exhaustion the search still returns its
// BEST partial route (see below), so hitting the cap degrades into "walk as far that way as you
// can" rather than into "give up and stall".
// MEASURED, not guessed (scripts/audit-routing-312.mjs, paired A/B on a real 130-unit fight): at
// 1200 this cost +12.3% engine step time. The expensive searches are the ones that never find the
// goal — a sealed garrison sweeps its entire reachable pocket before giving up — and with #288's
// rings sealed and #309's gates shut most of the time, those are the COMMON case, not the rare
// one. 400 bounds that worst case to roughly a third while still being far more than any real
// route needs (the whole world disc is a few dozen hexes across, and a complete route is found
// long before the cap because A* is goal-directed). Dropping to 400 took the same measurement to
// +2.6%. Owner: tunable, but raise it only with a fresh A/B.
export const ROUTE_MAX_NODES = 400;

// A unit re-plans on this cadence even when nothing invalidated its route — the world has moving
// goals (the player), so a path computed against where he stood two seconds ago goes stale on its
// own. Deliberately slow: this is a per-unit timer, and with dozens of units the aggregate replan
// rate is what costs frame time. Correctness against a MOVING goal is handled by the goal-changed
// check (a goal that moves more than a hex invalidates immediately), so this is only a backstop.
export const ROUTE_REPLAN_MS = 1500;

// After a search that found no complete route — the normal state of a garrison sealed inside an
// intact ring (#288's rings are fully sealed, and #309's gates are shut most of the time) — wait
// this long before trying again. Without it, every sealed unit would run a full failed search
// every replan tick forever, which is exactly the "thrashing on repeated failed searches" the
// issue calls out. A real change to the world (a breached span, a gate opening) bumps the epoch
// and cuts the backoff short immediately, so this never delays reacting to a genuine breach.
export const ROUTE_FAIL_BACKOFF_MS = 3000;

// A goal that has drifted more than this far (px) from the one the cached path was planned
// against forces a replan. About a hex and a half — enough that a chased player jinking around
// doesn't cause a replan storm, tight enough that the path still points somewhere useful.
export const GOAL_DRIFT_PX = 72;

// How close (px) a unit must get to a waypoint's centre to count as having reached it and advance
// to the next. Generously larger than a hex's inradius so a unit that clips a corner still ticks
// the waypoint over rather than orbiting it.
export const WAYPOINT_ARRIVE_PX = 40;

// How often (ms) a unit re-tests whether it has a clear straight line to its goal. This is the
// "do I even need to route" question, and it is asked far more often than a route is planned, so
// it gets its own faster-but-still-throttled cadence. An epoch bump re-tests immediately.
export const LINE_CHECK_MS = 300;

// ── Binary min-heap ─────────────────────────────────────────────────────────────────────
// A* is only as good as its open set. A sorted-array or linear-scan frontier turns each pop into
// O(n) and is the usual reason a "cheap" A* shows up in a profile; with dozens of units replanning
// this is the difference between routing being free and routing being the frame budget. Keyed on
// `f` (g + heuristic), storing plain node records.
function heapPush(heap, node) {
  heap.push(node);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p].f <= heap[i].f) break;
    const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
    i = p;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < heap.length && heap[l].f < heap[m].f) m = l;
      if (r < heap.length && heap[r].f < heap[m].f) m = r;
      if (m === i) break;
      const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
      i = m;
    }
  }
  return top;
}

// ── The search ──────────────────────────────────────────────────────────────────────────
// A* from `start` to `goal` over the axial grid.
//
// `canStep(from, to)` is the ONLY traversability input — see the header. It is called with two
// adjacent axial coords and must return whether this unit may make that one-hex move; the caller
// folds tile passability (terrain.js `passable`/`movement`, including #269's small-unit
// exemptions) and wall-span blocking (wallEdges.js `blocksSpan`, with #309's `passOpenGates` for
// enemies) into it. Note the start hex's own passability is never tested: a unit already standing
// somewhere it "can't be" (shoved into a wall band, or on terrain that collapsed underneath it)
// must still be able to route its way OUT, and refusing to plan for it would freeze it there.
//
// Uniform step cost of 1. Weighting slow terrain (`movement: 'slow'`) higher was considered and
// deliberately left out: it doubles the tuning surface for a barely-visible routing difference,
// and the movement integrator already applies the real speed penalty when the unit drives over it.
//
// Returns `{ path, complete, expanded }`:
//   path     — array of axial coords from the hex AFTER `start` through the reached hex, or []
//   complete — true iff `path` ends on `goal`
//   expanded — nodes popped, for tests and profiling
//
// The partial-route behaviour is the graceful degradation the issue asks for, and it matters more
// than it sounds: with #288's sealed rings and #309's mostly-shut gates, "no complete route" is
// the NORMAL state of every garrison, not an edge case. Rather than returning nothing and leaving
// the unit stalled, the search reports the route to the reachable hex that got CLOSEST to the goal
// — so a sealed garrison walks to the inside of its own wall nearest the player and holds there,
// which is both sensible-looking and stable. When not even that is possible (the unit is already
// the closest reachable hex) `path` is empty, and the caller falls back to its straight-line steer.
export function findHexPath(start, goal, canStep, maxNodes = ROUTE_MAX_NODES) {
  const goalKey = axialKey(goal.q, goal.r);
  const startKey = axialKey(start.q, start.r);
  if (startKey === goalKey) return { path: [], complete: true, expanded: 0 };

  const startNode = { q: start.q, r: start.r, key: startKey, g: 0, f: distance(start, goal), from: null };
  const open = [startNode];
  const seen = new Map([[startKey, startNode]]);
  let expanded = 0;
  // Best-so-far by heuristic, for the partial route described above. Ties break on lower g so the
  // fallback is the CHEAPEST way to get that close, not merely the first one found.
  let best = startNode, bestH = startNode.f;

  while (open.length > 0 && expanded < maxNodes) {
    const cur = heapPop(open);
    if (cur.key === goalKey) return { path: unwind(cur), complete: true, expanded };
    // A stale duplicate: this node was re-reached more cheaply after being queued. `seen` holds the
    // authoritative record, so anything whose g no longer matches has already been superseded.
    if (seen.get(cur.key) !== cur) continue;
    expanded++;

    for (const n of neighbors(cur.q, cur.r)) {
      // The neighbour's key is computed HERE and handed to `canStep` as a third argument. The
      // predicate needs it anyway (to look the destination terrain up) and so does the `seen` map,
      // and at ~6 keys per expansion across a few hundred expansions per search this string
      // building was measurable in the live profile. `cur.key` is likewise already known, so the
      // predicate never has to rebuild either side of the step.
      const nk = axialKey(n.q, n.r);
      if (!canStep(cur, n, nk)) continue;
      const g = cur.g + 1;
      const prev = seen.get(nk);
      if (prev && prev.g <= g) continue;
      const h = distance(n, goal);
      const node = { q: n.q, r: n.r, key: nk, g, f: g + h, from: cur };
      seen.set(nk, node);
      heapPush(open, node);
      if (h < bestH || (h === bestH && g < best.g)) { best = node; bestH = h; }
    }
  }

  return { path: best === startNode ? [] : unwind(best), complete: false, expanded };
}

// Walk `from` links back to the start, dropping the start hex itself (the unit is already there,
// so it is never a waypoint) and reversing into travel order.
function unwind(node) {
  const out = [];
  for (let n = node; n && n.from; n = n.from) out.push({ q: n.q, r: n.r });
  out.reverse();
  return out;
}

// ── Per-unit route state + the planning budget ──────────────────────────────────────────
// The router owns "when may this unit plan, and what does it follow right now". It is what keeps
// the feature off the per-unit-per-frame path the issue forbids:
//
//   1. A unit only plans when its cached route is INVALID — the goal moved a hex and a half, the
//      world changed (epoch bump), the slow refresh timer elapsed, or it has no route at all.
//   2. Even then it only plans if this tick's search BUDGET has room. Budget is per tick and
//      shared across all units, so a crowd whose routes all invalidate on the same frame (exactly
//      what a gate opening does — #309 cycles them roughly every 15s per awake base) spreads its
//      replanning over the following frames instead of spiking one. A unit denied budget keeps
//      following its existing path, which is stale but sane, and asks again next tick.
//   3. A unit that failed to find a complete route backs off hard (ROUTE_FAIL_BACKOFF_MS) so
//      sealed garrisons cost almost nothing.
//
// State lives in a WeakMap keyed by the unit object, so a destroyed enemy's route is collected
// with it — no id bookkeeping, no leak, nothing to remember to clear.
export function makeRouter({
  maxNodes = ROUTE_MAX_NODES,
  replanMs = ROUTE_REPLAN_MS,
  failBackoffMs = ROUTE_FAIL_BACKOFF_MS,
  budgetPerTick = 4,
} = {}) {
  const states = new WeakMap();
  // Monotonic world version. Every cached route records the epoch it was planned under; any bump
  // makes every route stale at once, which is O(1) rather than hunting down which units' paths a
  // particular breached span happened to cross. Coarse on purpose — invalidation events are rare
  // (a span destroyed, a gate cycling, terrain collapsing) and the replan is budgeted anyway.
  let epoch = 0;
  let budget = budgetPerTick;

  function stateFor(unit) {
    let s = states.get(unit);
    if (!s) {
      s = {
        path: [], index: 0, epoch: -1, complete: false, goal: null, planAt: 0,
        lineClear: false, lineAt: 0,
      };
      states.set(unit, s);
    }
    return s;
  }

  return {
    // Bump the world version, invalidating every cached route. Called when a wall span is
    // destroyed, a gate opens or closes, or terrain collapses.
    invalidate() { epoch++; },
    get epoch() { return epoch; },

    // Start a tick: refill the shared search budget. Called once per frame before the unit loop.
    beginTick() { budget = budgetPerTick; },
    get budgetLeft() { return budget; },

    // Drop a unit's route entirely (e.g. it teleported, or changed what it is doing wholesale).
    forget(unit) { states.delete(unit); },

    // Read-only peek at a unit's cached route, for tests and debug overlays.
    routeFor(unit) { return states.get(unit) || null; },

    // The heart of it. Given a unit at world (x, y) wanting to reach world `goal`, return the
    // world-space point it should actually steer at right now — either a routed waypoint, or
    // null meaning "no routing needed or possible, steer straight at the goal as before".
    //
    // `ctx` supplies the world queries the router must not know about itself:
    //   canStep(from, to)  — the edge-aware traversability predicate (see findHexPath)
    //   clearLine(x0,y0,x1,y1) — is the straight line to the goal unobstructed? Optional; when
    //     given, a unit with a clear shot at its goal drops its route and steers straight, which
    //     keeps movement in the open exactly as smooth as it was before this feature and avoids
    //     the tell-tale hex-centre zigzag of a unit that routes when it doesn't need to.
    //   hexOf(x, y) / pixelOf(q, r) — coordinate conversion (defaults to hexgrid's own).
    follow(unit, x, y, goal, nowMs, ctx) {
      if (!goal) return null;
      const s = stateFor(unit);
      const hexOf = ctx.hexOf;
      const pixelOf = ctx.pixelOf || ((q, r) => hexToPixel(q, r));

      const worldChanged = s.epoch !== epoch;

      // Cheap out: a clear straight line to the goal needs no routing at all, and steering
      // straight keeps movement in the open exactly as smooth as it was before this feature.
      //
      // The check itself is NOT free — it walks every hex along the segment and does a swept wall
      // test — so running it per unit per frame would just relocate the cost the caching is
      // supposed to avoid. It's throttled to LINE_CHECK_MS and the verdict cached, with an epoch
      // bump forcing an immediate re-test so a span the player just blew open returns units to
      // direct steering at once rather than after the throttle.
      if (ctx.clearLine) {
        if (worldChanged || nowMs >= s.lineAt) {
          s.lineClear = ctx.clearLine(x, y, goal.x, goal.y);
          s.lineAt = nowMs + LINE_CHECK_MS;
        }
        if (s.lineClear) {
          s.path = []; s.index = 0; s.complete = false; s.goal = null;
          s.epoch = epoch;
          return null;
        }
      }

      const noRoute = s.path.length === 0 || s.index >= s.path.length;
      const drifted = !s.goal || Math.hypot(s.goal.x - goal.x, s.goal.y - goal.y) > GOAL_DRIFT_PX;
      const backoffOver = nowMs >= s.planAt;

      // When may this unit spend a search?
      //   - The world changed: always, and it overrides an outstanding failure backoff — that bump
      //     is exactly when a previously-sealed unit might have gained a way out, and without this
      //     an enemy would sit inside a freshly-breached wall for the rest of its backoff window.
      //   - It has a COMPLETE route: whenever the route ran out, the goal drifted a hex and a
      //     half, or the slow refresh timer elapsed.
      //   - It has NO complete route (sealed in, or the search hit its node cap): ONLY once the
      //     failure backoff expires. Goal drift deliberately does NOT bypass this — a sealed
      //     garrison unit's goal is the player, who moves constantly, so honouring drift here
      //     would have every trapped unit running a full failed search several times a second.
      //     That is the thrashing the issue calls out, and this branch is what prevents it.
      const wantPlan = worldChanged ? true : (s.complete ? (noRoute || drifted || backoffOver) : backoffOver);

      if (wantPlan && budget > 0) {
        budget--;
        const res = findHexPath(hexOf(x, y), hexOf(goal.x, goal.y), ctx.canStep, maxNodes);
        s.path = res.path;
        s.index = 0;
        s.complete = res.complete;
        s.epoch = epoch;
        s.goal = { x: goal.x, y: goal.y };
        s.planAt = nowMs + (res.complete ? replanMs : failBackoffMs);
      }

      if (s.index >= s.path.length) return null;   // nothing to follow — caller steers straight

      // Advance past any waypoint already reached. A loop rather than a single step because a fast
      // unit can cover more than one hex between calls, and because the first waypoint is often
      // the hex the unit is already standing in by the time it next asks.
      while (s.index < s.path.length) {
        const w = s.path[s.index];
        const p = pixelOf(w.q, w.r);
        if (Math.hypot(p.x - x, p.y - y) <= WAYPOINT_ARRIVE_PX) { s.index++; continue; }
        return { x: p.x, y: p.y, complete: s.complete, remaining: s.path.length - s.index };
      }
      return null;
    },
  };
}
