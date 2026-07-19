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
import { axialKey, hexToPixel } from './hexgrid.js';
import { SPAN_ROLE_GATE } from './wallEdges.js';

// ── PLAYTEST 3: "just in time", not "as soon as somebody decides" ───────────────────────
// Jackson: "gates appear to be opening WAAAAAAY in advance of a ground unit needing to pass through
// it. like it opens when the pathing is decided, but it should open at the last moment when it
// needs to pass through instead."
//
// He is describing exactly what the code did. Demand fired the instant a unit's route CROSSED a
// gate span, with no notion of where along that route the unit actually was — so a tank waking up
// deep in a compound opened the door immediately and then trudged across the yard while it stood
// wide open. The route-crossing test answers "WHICH door do I want", which is the right question;
// it just isn't the whole question. "WHEN do I want it" is the missing half, and the constants
// below are that half. See the block above GATE_AT_DOOR_PX for how the answer was arrived at — it
// took two wrong shapes before the right one, and both wrong shapes were found by measurement.
// How long a gate keeps counting as "wanted" after the last unit that asked for it stopped asking.
// This is the primary anti-flicker device and it lives HERE, on the demand signal, rather than in
// the gate's state machine — because the churn it absorbs is a property of the demand, not of the
// door. A unit's route is re-planned on a budget and a throttle (hexRoute's `ROUTE_REPLAN_MS`,
// `budgetPerTick`), its closing rate is a smoothed estimate that can dip for a sample as it rounds
// a corner or is shoved, and a unit walking THROUGH the mouth stops requesting the gate for the
// frames it is inside it. Each of those is a momentary gap in a demand that has not really gone
// away.
//
// It must ALSO span the scan's own round-robin cycle: the scene asks a few units per scan and
// rotates through the garrison, so any given unit's INTENT is refreshed only once per cycle.
// Measured worst case in a real world: 35 eligible ground movers at 24 units/sec is a ~1.5s cycle.
// 3000ms is double that.
//
// Raising it costs nothing visible: it can only delay a CLOSE, and `GATE_MIN_OPEN_MS` (7000) is
// already a longer floor than this, so the extra grace is entirely hidden inside a hold the gate
// was going to observe anyway. Owner: tunable — raise it if gates ever visibly hunt, lower it if
// they linger after a sortie is plainly done.
export const GATE_DEMAND_GRACE_MS = 3000;

export const GATE_OPEN_LEAD_MS = 2500;

// A unit this close is treated as AT the door and asks for it unconditionally. This is the
// fallback that stops the closing-rate rule below from having a hole in it: a unit that reaches a
// shut gate is physically stopped by it, its closing rate collapses to zero, and a pure rate rule
// would then refuse to open the very door it is standing against. 70px is about a hex and a half —
// near enough that "it is at the doorway" is unambiguous, far enough to cover a unit jostling
// against the span. It should rarely be the rule that fires; if it is firing often, the lead time
// is too short and doors are opening late.
export const GATE_AT_DOOR_PX = 70;

// The minimum closing rate (px/sec) that counts as genuinely approaching rather than milling about.
// Units jitter, get shoved by collisions, and orbit their standoff position, all of which produce
// small non-zero closing rates in both directions; this is the floor that keeps that noise from
// reading as an approach.
export const GATE_MIN_CLOSING_PX_PER_SEC = 12;

// ── Why the trigger is a RATE and not a distance ────────────────────────────────────────
// The first attempt at "just in time" used distance: ask for the door once you are within N px or
// N seconds of it. Both variants failed, in opposite directions, and MEASURING them is what showed
// why (scripts/measure-gate-lead-309.mjs):
//
//   Pure ETA, no floor  — a woken garrison does not queue at its gate. Its units settle at combat
//     standoff positions near the inside of their own wall and HOLD there, typically 110-180px from
//     the doorway. Their distance barely changes, so a travel-time rule never fires and the gate
//     stays shut forever. Strictly worse than the behaviour being fixed.
//   Distance floor of 220px — fires immediately for that same loitering population and then never
//     stops, because they never leave the radius. Measured open duty cycle: 0.95. A door that is
//     open 95% of the time is the most extreme possible version of the original complaint.
//
// The thing both miss is that a loitering unit is not about to use the door, and a unit driving at
// the door is — and those two are indistinguishable by position while being obvious by MOTION. So
// the question asked is "is this unit actually closing on its gate, and will it arrive within the
// lead window at the rate it is currently closing". A unit holding station has a closing rate of
// roughly zero and an infinite ETA, so it asks for nothing and the gate stays shut. A unit that
// commits to leaving starts closing immediately, and the doors are open by the time it arrives.
//
// This also cannot deadlock, which is the property that killed the pure-ETA version. The trigger is
// the unit's own movement, and that movement does not depend on the gate being open: route planning
// stages THROUGH a shut gate (scenes/arena/enemies.js `_canEnemyStep`), so a unit heading for the
// player drives at the doorway whether or not it has opened yet.
//
// Sizing the lead. The mechanism costs a fixed 1400ms between the first request and a walkable
// doorway (GATE_REACTION_MS 600 + GATE_OPENING_MS 800). 2500ms leaves ~1100ms of slack for a unit
// that accelerates as it commits, or crosses slow terrain, or has to round a corner inside its own
// compound. Erring early is deliberate: opening a beat early costs a little realism, while opening
// late means a unit walks into a shut door and stalls, which reads as broken pathing. Owner:
// tunable — lower it if doors still visibly anticipate, raise it if units ever bunch at a gate.

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
export function gateRequestOnRoute(start, path, byHex, pixelOf = hexToPixel) {
  if (!byHex || !path || path.length === 0) return null;
  let from = start;
  let fromPx = pixelOf(from.q, from.r);
  let acc = 0;                     // pixel distance along the route so far, hex centre to hex centre
  for (const to of path) {
    const toPx = pixelOf(to.q, to.r);
    const step = Math.hypot(toPx.x - fromPx.x, toPx.y - fromPx.y);
    const spans = byHex.get(axialKey(from.q, from.r));
    if (spans) {
      for (const e of spans) {
        if (e.role !== SPAN_ROLE_GATE || e.destroyed) continue;
        const onThisEdge = (e.a.q === to.q && e.a.r === to.r) || (e.b.q === to.q && e.b.r === to.r);
        // The doorway sits on the BOUNDARY between these two hexes, so the distance to it is the
        // distance to `from` plus half of the step that crosses it.
        if (onThisEdge) return { key: e.key, pathPx: acc + step / 2 };
      }
    }
    acc += step;
    from = to;
    fromPx = toPx;
  }
  return null;
}

// The key-only form, kept because it is the question most callers (and the audit scripts) actually
// have, and because it reads better at the call sites that do not care how far away the door is.
export function firstGateOnRoute(start, path, byHex) {
  return gateRequestOnRoute(start, path, byHex)?.key ?? null;
}

// How far a unit still has to travel to reach the gate it asked for, in pixels.
//
// The route behind `pathPx` was computed when the unit was last SAMPLED (the demand scan is
// throttled and round-robins, so that can be a second or so ago), and re-running A* every frame to
// keep it exact is precisely the cost that throttling exists to avoid. So this reconstructs the
// remaining distance cheaply, and does it in a way that fails EARLY in both directions:
//
//   pathPx - travelled  — travelled is measured as straight-line displacement from where the unit
//     stood at sample time, which can only UNDER-state progress along a winding route. So this term
//     over-states what is left, and the door opens sooner rather than later.
//   euclidean to mouth  — a floor that catches the stale-intent case: a unit that has already gone
//     THROUGH the gate and walked away would otherwise sit at `pathPx - travelled <= 0` forever and
//     hold the door open until the next scan cleared its intent. Its straight-line distance grows,
//     so taking the larger of the two lets it correctly stop asking.
//
// Taking the max means whichever estimate is more cautious wins, which is the behaviour we want on
// both ends of a sortie.
export function remainingToGate(unitX, unitY, intent, mouthX, mouthY) {
  if (!intent) return Infinity;
  const travelled = Math.hypot(unitX - intent.x, unitY - intent.y);
  const alongPath = intent.pathPx - travelled;
  const direct = Math.hypot(mouthX - unitX, mouthY - unitY);
  return Math.max(alongPath, direct);
}

// Does this unit want its door opened right now? See the block above GATE_AT_DOOR_PX for why this
// is a question about MOTION rather than position.
//
//   `remainingPx`      — how far it still has to travel (`remainingToGate`)
//   `closingPxPerSec`  — how fast that distance is shrinking; zero or negative means holding
//                        station or moving away, and neither of those wants a door
export function requestsGate(remainingPx, closingPxPerSec, {
  leadMs = GATE_OPEN_LEAD_MS,
  atDoorPx = GATE_AT_DOOR_PX,
  minClosing = GATE_MIN_CLOSING_PX_PER_SEC,
} = {}) {
  if (!(remainingPx >= 0)) return false;
  if (remainingPx <= atDoorPx) return true;          // standing at it — open regardless of motion
  if (!(closingPxPerSec > minClosing)) return false; // loitering, or walking away
  return (remainingPx / closingPxPerSec) * 1000 <= leadMs;
}

// Fold a fresh distance sample into a unit's smoothed closing rate. Sampling is throttled and the
// result exponentially smoothed because a per-frame difference of two positions is mostly noise at
// these speeds — a unit nudged by a collision can show a huge instantaneous closing rate for one
// frame, which would pop a door open for no reason.
//
// Returns the new approach record; pass the previous one back in each time.
export function trackApproach(prev, distPx, nowMs, {
  sampleMs = APPROACH_SAMPLE_MS, alpha = APPROACH_SMOOTHING,
} = {}) {
  if (!prev) return { dist: distPx, atMs: nowMs, rate: 0 };
  const dtMs = nowMs - prev.atMs;
  if (dtMs < sampleMs) return prev;
  const instant = ((prev.dist - distPx) / dtMs) * 1000;
  return { dist: distPx, atMs: nowMs, rate: prev.rate * (1 - alpha) + instant * alpha };
}

// How often (ms) the closing rate is re-sampled, and how much a new sample moves the smoothed
// value. 200ms is long enough that real movement dominates positional noise, short enough that a
// unit committing to a sortie is detected within a fraction of the lead window. 0.5 reaches ~90% of
// a step change in three samples (~600ms), which is a reasonable trade between reacting promptly to
// a unit setting off and not reacting to a single shove.
export const APPROACH_SAMPLE_MS = 200;
export const APPROACH_SMOOTHING = 0.5;

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
