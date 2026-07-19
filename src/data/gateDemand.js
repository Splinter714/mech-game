// #309 playtest ("gates seem to open on a timer instead of based on enemy proximity; let them open
// when an enemy needs it, not on a timer") — the DEMAND half of the sally port.
//
// The first pass ran the gate off a fixed schedule hung on the base's wake: a first sortie after a
// couple of seconds, hold open, rest, repeat, forever, whether or not a single unit wanted to use
// it. That reads as a clock, because it is one. This module answers the question the clock was
// standing in for — "does any garrison unit actually need this gate right now" — and gateCycle.js
// consumes the answer instead of counting down.
//
// ── The chicken-and-egg, and how it is resolved ─────────────────────────────────────────
// #312 gave ground units real A* routes (data/hexRoute.js) over an edge-aware `canStep`, so "this
// unit's way out is that gate" is answerable from the routing layer rather than guessed from
// geometry. But routing against the LIVE world can never discover a gate: a closed gate blocks, so
// no route is ever planned through one, so nothing ever asks for it, so it never opens. The demand
// query would be self-defeating.
//
// The fix is to ask the COUNTERFACTUAL question, and to ask it with a different predicate from the
// one that governs movement:
//
//   MOVEMENT routes against the world as it IS   — a closed gate is solid (scenes/arena/enemies.js
//                                                  `_canEnemyStep`, via wallEdges `blocksSpan`).
//   DEMAND   routes against the world as it COULD BE — every standing gate span is treated as
//                                                  passable regardless of its current phase
//                                                  (`_canEnemyStepGatesOpen`).
//
// A unit's demand route is therefore "the way I would go if the doors were open for me", and the
// FIRST gate span that route crosses is the door it is actually asking for. Downstream gates on the
// same route are not requested — a unit two rings deep asks for the ring it is standing behind, and
// asks for the next one only once it is through the first and that one has become its first
// crossing. That falls out of taking the first crossing rather than needing a rule of its own.
//
// Why this shape rather than the alternatives:
//   - "Would a route exist if this gate were open" (one search PER GATE) answers a weaker question
//     at higher cost: it says the gate is useful to somebody, not that any unit has chosen it. With
//     two gates on a ring both would usually qualify and both would open, which is the clock's
//     problem wearing a different hat.
//   - Routing against gates-as-passable for movement too would let units walk through shut doors.
//
// ── A genuinely sealed-in garrison ─────────────────────────────────────────────────────
// This is the case the counterfactual has to get right, and it does so for free. Opening every gate
// hypothetically is the MOST generous world the units could possibly be given; if A* still finds no
// COMPLETE route to the player in that world, then no gate can help — the unit is walled in by
// terrain, sitting in an inner pocket, or on a ring with no gate span at all — and it registers no
// demand, so nothing opens pointlessly. Note the completeness requirement is what carries this:
// hexRoute returns a best-effort PARTIAL route on failure (a unit walks to the inside of its own
// wall and holds), and a partial route that happens to end near a gate must not count as wanting
// it. Only `complete` routes are ever handed to `firstGateOnRoute`.
import { axialKey } from './hexgrid.js';
import { SPAN_ROLE_GATE } from './wallEdges.js';

// How long a gate keeps counting as "wanted" after the last unit that asked for it stopped asking.
// This is the primary anti-flicker device and it lives HERE, on the demand signal, rather than in
// the gate's state machine — because the churn it absorbs is a property of the demand, not of the
// door. A unit's route is re-planned on a budget and a throttle (hexRoute's `ROUTE_REPLAN_MS`,
// `budgetPerTick`), it flips between routed and straight-line steering as `clearLine` re-tests, and
// a unit walking THROUGH the mouth stops requesting the gate for the frames it is inside it. Each
// of those is a momentary gap in a demand that has not really gone away.
//
// It must ALSO span the scan's own round-robin cycle, which is the constraint that actually sizes
// it. The scene asks a few units per scan and rotates through the garrison, so any given unit is
// re-asked once per (eligible units / units-per-second) seconds. Measured worst case in a real
// world: 35 eligible ground movers across five woken bases, at 24 units/sec, is a ~1.5s cycle. A
// gate wanted by only a FEW units — a depleted garrison late in a fight, which is exactly when a
// sortie matters — is refreshed only once per cycle, so a grace shorter than the cycle would let
// its request expire and the door would hunt. 3000ms is double that worst case.
//
// Raising it costs nothing visible: it can only delay a CLOSE, and `GATE_MIN_OPEN_MS` (7000) is
// already a longer floor than this, so the extra grace is entirely hidden inside a hold the gate
// was going to observe anyway. Owner: tunable — raise it if gates ever visibly hunt, lower it if
// they linger after a sortie is plainly done.
export const GATE_DEMAND_GRACE_MS = 3000;

// Which GATE span, if any, does this route ask for? Walks the route edge by edge from the unit's
// own hex and returns the key of the first standing gate span it crosses, or null if it crosses
// none (the unit has a way out that does not need a door — a breach, or it is already outside).
//
// `byHex` is the wall-edge set's own index (`set.byHex`: hex key → the spans incident to that hex).
// Using it rather than building a canonical edge key per step matters because this runs over whole
// routes for several units per scan: every span in `byHex.get(from)` already has `from` as one
// endpoint, so "is this the span between from and to" is a numeric compare against its other
// endpoint, and the list is at most six long. Same reasoning as `_canEnemyStep`'s hot loop.
//
// Destroyed gates are skipped, not returned: a blown gate is a permanent hole, so a route through
// one needs nothing opened. Pure — reads `byHex` and the path, mutates nothing.
export function firstGateOnRoute(start, path, byHex) {
  if (!byHex || !path || path.length === 0) return null;
  let from = start;
  for (const to of path) {
    const spans = byHex.get(axialKey(from.q, from.r));
    if (spans) {
      for (const e of spans) {
        if (e.role !== SPAN_ROLE_GATE || e.destroyed) continue;
        const onThisEdge = (e.a.q === to.q && e.a.r === to.r) || (e.b.q === to.q && e.b.r === to.r);
        if (onThisEdge) return e.key;
      }
    }
    from = to;
  }
  return null;
}

// The demand signal itself: a tiny per-gate "when was this last asked for" ledger with the grace
// window folded in. The scene notes demand as it discovers it (one `note` per unit whose route
// wants a gate) and the gate cycle reads `wanted` every frame.
//
// Deliberately NOT a per-frame recomputation of the full answer. The scan that produces demand is
// throttled and round-robins across the garrison (a full A* per unit per frame is exactly the cost
// #312 built its budget to avoid), so on most frames NO unit is re-asked and the ledger is the only
// thing that knows the gate is still wanted. The grace window is what makes a sampled signal safe
// to read continuously: it holds the last answer alive across the gaps between samples.
export function makeGateDemand({ graceMs = GATE_DEMAND_GRACE_MS } = {}) {
  const lastAskedAt = new Map();
  return {
    // A unit's route wants this gate, as of `nowMs`.
    note(gateKey, nowMs) {
      if (gateKey != null) lastAskedAt.set(gateKey, nowMs);
    },
    // Is this gate wanted right now — asked for within the grace window?
    wanted(gateKey, nowMs) {
      const t = lastAskedAt.get(gateKey);
      return t != null && nowMs - t <= graceMs;
    },
    // Milliseconds since this gate was last asked for, or Infinity if it never has been. For the
    // audit script and debug overlays.
    ageMs(gateKey, nowMs) {
      const t = lastAskedAt.get(gateKey);
      return t == null ? Infinity : nowMs - t;
    },
    // Forget a gate entirely — called when a gate span is destroyed, so a blown door's stale demand
    // can never keep anything alive.
    forget(gateKey) { lastAskedAt.delete(gateKey); },
    get size() { return lastAskedAt.size; },
  };
}
