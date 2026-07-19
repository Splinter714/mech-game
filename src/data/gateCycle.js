// #309 — the SALLY PORT cycle: a pure state machine for a base's gate opening, holding open long
// enough for its garrison to pour out, and shutting again. No Phaser, no world positions; the scene
// (scenes/arena/bases.js `_updateGates`) feeds it `awake` each frame and reacts to the phase it
// reports by flipping the span's `open` flag and playing the door FX.
//
// Deliberately the same shape as data/dockResupply.js and data/alertTower.js — a small tick
// function plus tunable constants — because a gate IS the dock mechanic scaled up to the wall line:
// a door that opens, produces units, and closes. #309 was explicit about reusing that machinery
// rather than inventing a second door system, and this is what "reuse" means at the model layer
// (the FX layer reuses `_resupplyDock`'s doors-open/rise/doors-close beat directly).
//
// WHY IT TRIGGERS ON WAKE: #269 already models "this base has noticed you" as a single crisp event
// (`_wakeBase`, fired by an alert tower completing its countdown, by proximity, or by taking a
// hit). Hanging the sortie off a separate proximity or timer trigger would give the base a second,
// invisible notion of awareness that could disagree with the first — the player would see a base
// visibly rouse itself and its gate stay shut, or a gate open on a base that is still dormant.
// One awareness signal, one gate. The FIRST sortie is delayed a beat after wake (see below) so the
// causal chain reads on screen: tower fires -> base rouses -> gate cranks open -> units come out.

// Delay from the base waking to its gates first cracking open. Long enough to read as a REACTION
// to the alarm rather than as something that was already happening — the alert tower's own
// countdown is 3000ms (alertTower.js), and stacking a beat on top of that keeps the "you tripped
// something, and now something is coming" chain legible. Short enough that a player who woke the
// base by walking up to it is not left waiting on an empty field. Owner: tunable.
export const GATE_FIRST_SORTIE_MS = 2200;

// The doors' own travel time, each way. Matches the 500ms door slide in `_resupplyDock`'s FX
// sequence closely enough that the two read as the same mechanism at different scales, with a
// little extra for a gate being a much bigger door than a dock hatch. The gate is NOT passable
// during either travel phase — it is solid until fully open and solid again the instant it starts
// to close, so there is no ambiguous half-open frame in which a unit could be caught in the span.
// The most a gate's first sortie can be staggered past `GATE_FIRST_SORTIE_MS` by its own random
// offset. A base's two gates each roll somewhere in [0, this], so they crank a beat apart rather
// than in perfect lockstep — two gates opening on the same frame reads as one scripted event, two
// opening a beat apart reads as a base reacting. Same de-synchronisation reasoning #311 applied to
// docks, at a much smaller scale because a gate cycle is much shorter than a dock's.
export const GATE_STAGGER_MAX_MS = 1800;

export const GATE_OPENING_MS = 800;
export const GATE_CLOSING_MS = 800;

// How long the gate stays fully open. This is the number that decides whether a sortie actually
// HAPPENS: a garrison unit inside the compound has to steer from wherever it is, through the
// opening, and out — and since #312 (A* pathfinding) is not built, that steering is straight-line,
// so a unit whose route to the gate is not roughly direct will spend some of this window grinding
// along the inside of its own wall before slipping out. 7000ms is sized off that worst case rather
// than off the best one: a unit starting at the far side of a radius-2 compound (~200px) at the
// slowest ground speed still has time to reach the opening and clear it with room to spare. Owner:
// tunable — shorten it if sorties feel too generous, lengthen it if units visibly get shut out.
export const GATE_OPEN_HOLD_MS = 7000;

// Rest between sorties, measured from the gate finishing its close to it starting to open again.
// Roughly the dock resupply cadence (18s) — the two reinforcement channels should feel like one
// base breathing, not two unrelated timers. Slightly under it so that during a long assault the
// gate is the more frequent of the two, which is right: the gate spends existing garrison, the
// dock manufactures new units. Owner: tunable.
export const GATE_SORTIE_COOLDOWN_MS = 15000;

// Phase names. `open` is the ONLY phase in which the span is passable to enemies.
export const GATE_CLOSED = 'closed';
export const GATE_OPENING = 'opening';
export const GATE_OPEN = 'open';
export const GATE_CLOSING = 'closing';

// Is the gate passable to enemy ground units in this phase?
export function gatePassable(state) {
  return state?.phase === GATE_OPEN;
}

// Fresh gate state: shut, waiting on its base to wake. `jitterMs` lets a caller stagger a base's
// two gates so they don't crank in perfect lockstep (the same de-synchronisation reasoning #311
// applied to docks); pass a seeded roll for a reproducible run.
export function makeGateState(jitterMs = 0) {
  return { phase: GATE_CLOSED, remainingMs: GATE_FIRST_SORTIE_MS + Math.max(0, jitterMs), sorties: 0 };
}

// Advance one tick. `awake` — is this gate's base awake? A dormant base's gate holds shut and does
// not count down at all (same rule dockResupply applies, and for the same reason: nothing about a
// base the player has not discovered should be quietly progressing).
//
// Returns a NEW state whenever anything changed, plus a transient `justOpened` / `justClosed` on
// the exact tick a transition happens, so the scene can fire the door FX once rather than having to
// diff phases itself. Pure — never mutates `state`.
export function tickGate(state, { awake, dt }) {
  if (!awake) return state;
  const remainingMs = Math.max(0, state.remainingMs - Math.max(0, dt) * 1000);
  if (remainingMs > 0) {
    if (remainingMs === state.remainingMs) return state;
    return { phase: state.phase, remainingMs, sorties: state.sorties };
  }
  // The phase's timer has elapsed — advance around the cycle.
  switch (state.phase) {
    case GATE_CLOSED:
      return { phase: GATE_OPENING, remainingMs: GATE_OPENING_MS, sorties: state.sorties, startedOpening: true };
    case GATE_OPENING:
      return { phase: GATE_OPEN, remainingMs: GATE_OPEN_HOLD_MS, sorties: state.sorties + 1, justOpened: true };
    case GATE_OPEN:
      return { phase: GATE_CLOSING, remainingMs: GATE_CLOSING_MS, sorties: state.sorties, justClosed: true };
    case GATE_CLOSING:
    default:
      return { phase: GATE_CLOSED, remainingMs: GATE_SORTIE_COOLDOWN_MS, sorties: state.sorties };
  }
}
