// #309 — the SALLY PORT: a pure state machine for a base's gate opening because its garrison needs
// out, holding open long enough for them to pour through (and long enough for the player to chance
// it), and shutting again once nothing wants it. No Phaser, no world positions; the scene
// (scenes/arena/bases.js `_updateGates`) feeds it `awake` and `demand` each frame and reacts to the
// phase it reports by flipping the span's `open` flag and playing the door FX.
//
// ── What changed, and why (playtest 2026-07-19) ────────────────────────────────────────
// The first pass hung a fixed SCHEDULE off the base's wake: first sortie at 2200ms, hold open 7s,
// rest 15s, repeat forever. Owner: "gates seem to open on a timer instead of based on enemy
// proximity; let them open when an enemy needs it, not on a timer." He is describing exactly what
// the code did — the clock ran whether or not a single unit wanted the door, so a woken base with
// its garrison already outside (or dead, or sealed off from the player by terrain) still cranked
// its gates open and shut on a metronome, and the one event that should have read as causal —
// units coming out — was uncorrelated with it.
//
// So the driver is now DEMAND, computed from the routing layer (data/gateDemand.js: a garrison
// unit's counterfactual route to the player crosses this span). Wake is still the PRECONDITION — a
// base the player has not discovered keeps its gates shut and does not even ask the question — but
// wake no longer starts a clock. Nothing here counts toward opening. The only timers left are the
// doors' own travel, a minimum open time, and a short re-open lockout, and every one of them exists
// to stop the door from stuttering, never to decide that it should move.
//
// ── The other playtest change: the gate is open to EVERYONE ────────────────────────────
// Owner: "player should be able to pass through the gate when it's open, it just shouldn't open FOR
// the player." The enemies-only passability rule is gone (wallEdges.js `blocksSpan` no longer takes
// a `passOpenGates` opt-in, and the amber barrier field that used to stop the player at an open
// mouth is gone with it). What stays enemies-only is the TRIGGER, which is this file's entire job:
// no player action opens a gate. The consequence is that the open window is now a real tactical
// object — wake a base, wait for the sortie, and either fight through the mouth or slip inside
// while it stands open, as an alternative to breaching a span. `GATE_MIN_OPEN_MS` below is sized
// with that second job in mind.

// The doors' own travel time, each way. Matches the 500ms door slide in `_resupplyDock`'s FX
// sequence closely enough that the two read as the same mechanism at different scales, with a
// little extra for a gate being a much bigger door than a dock hatch. The gate is NOT passable
// during either travel phase — it is solid until fully open and solid again the instant it starts
// to close, so there is no ambiguous half-open frame in which anything could be caught in the span.
export const GATE_OPENING_MS = 800;
export const GATE_CLOSING_MS = 800;

// How long demand must be CONTINUOUSLY present before the leaves start to move. Three jobs at once:
// it is the first line of anti-flicker (a single unit's route flickering onto the span for one scan
// never moves the door), it keeps the causal chain legible on screen (tower fires → base rouses →
// units decide they want out → gate cranks open) rather than having the door snap the instant a
// base wakes, and it is short enough that a player who woke a base by walking up to it is not left
// waiting on an empty field. Note this is a delay from DEMAND, not from wake — a base whose
// garrison never wants out waits here forever, which is the whole point.
export const GATE_REACTION_MS = 600;

// Per-gate random jitter added to `GATE_REACTION_MS`, rolled once in `makeGateState`. A base's two
// gates crank a beat apart rather than in lockstep — two gates opening on the same frame reads as
// one scripted event, two opening a beat apart reads as a base reacting. Much smaller than the
// first pass's 1800ms, because it no longer has to de-synchronise two independent clocks; the
// demand signal already differs per gate (different units route through different doors), so this
// is only breaking the tie in the case where it does not.
export const GATE_STAGGER_MAX_MS = 600;

// The floor on how long a gate stays open once it has committed to opening — it will NOT close
// before this even if demand vanishes the instant the doors finish. Survives from the first pass at
// its original 7000ms, but demoted from being the DRIVER (it used to be the whole hold phase, after
// which the gate shut regardless) to being a FLOOR (the gate now stays open as long as it is wanted,
// and this only sets a minimum).
//
// It is doing two jobs, and 7000ms is defensible for both:
//   1. A sortie has to be able to finish. A unit starting at the far side of a radius-2 compound at
//      the slowest ground speed reaches the opening and clears it inside this window — sized off
//      that worst case, not the best one. Less critical than it was, since demand now holds the
//      door open on its own while anyone is still routing through it, but it still guarantees that
//      a sortie which briefly loses its routing lock is not shut in.
//   2. Since the playtest change, this is ALSO the player's opportunity window — the time he has to
//      spot an open mouth, commit, and drive through it instead of spending several seconds
//      shooting a 200hp span. 7s is long enough to be usable if he is already close and watching,
//      short enough that he has to actually commit rather than stroll. That risk/reward is the
//      point: he is driving into a compound through the door its garrison is currently coming out
//      of. Owner: tunable, and this is the knob to turn if slipping in feels impossible or free.
export const GATE_MIN_OPEN_MS = 7000;

// After the doors finish closing, refuse to re-open for this long. The last anti-flicker guard, and
// the one that catches the case the others cannot: demand that genuinely lapses and then genuinely
// returns a moment later (a unit that reached the mouth, got shoved off its route by a collision,
// and re-planned). Without it that reads as the door bouncing. Well under the grace window, so a
// real sustained demand only ever waits out the lockout once.
export const GATE_RECLOSE_LOCKOUT_MS = 1200;

// Phase names. `open` is the ONLY phase in which the span is passable.
export const GATE_CLOSED = 'closed';
export const GATE_OPENING = 'opening';
export const GATE_OPEN = 'open';
export const GATE_CLOSING = 'closing';

// Is the gate passable in this phase?
export function gatePassable(state) {
  return state?.phase === GATE_OPEN;
}

// Fresh gate state: shut, with no clock running and nothing pending. `jitterMs` staggers this gate's
// reaction against its sibling's (see `GATE_STAGGER_MAX_MS`); pass a seeded roll for a reproducible
// run.
//
// `armedMs` accumulates continuously-present demand toward the reaction threshold; `phaseMs` is
// time spent in the current phase (the door-travel timers and the minimum-open floor both read it);
// `lockoutMs` counts the post-close re-open refusal down.
export function makeGateState(jitterMs = 0) {
  return {
    phase: GATE_CLOSED,
    armedMs: 0,
    phaseMs: 0,
    lockoutMs: 0,
    reactionMs: GATE_REACTION_MS + Math.max(0, jitterMs),
    sorties: 0,
  };
}

// Advance one tick.
//
//   `awake`  — is this gate's base awake? A dormant base's gate holds shut and nothing progresses
//              at all (the same rule dockResupply applies, for the same reason: nothing about a
//              base the player has not discovered should be quietly ticking).
//   `demand` — does any garrison unit's route currently want this gate (gateDemand.js)? This is
//              the ONLY thing that can cause the door to open.
//   `dt`     — seconds.
//
// Returns a NEW state whenever anything changed, plus a transient `startedOpening` / `justOpened` /
// `justClosed` on the exact tick a transition happens, so the scene can fire the door FX once
// rather than diffing phases itself. Pure — never mutates `state`.
// The PERSISTENT fields of a gate state, with the transient one-tick FX flags (`startedOpening` /
// `justOpened` / `justClosed`) deliberately dropped. Every return below is built through this
// rather than by spreading `state` directly, because spreading would carry the previous tick's
// flags forward and the scene would re-fire the door FX on every frame of the phase that followed
// a transition. Regression-tested by "fires exactly one open/close transition per sortie".
function carry(state) {
  return {
    phase: state.phase,
    armedMs: state.armedMs,
    phaseMs: state.phaseMs,
    lockoutMs: state.lockoutMs,
    reactionMs: state.reactionMs,
    sorties: state.sorties,
  };
}

export function tickGate(state, { awake, demand = false, dt = 0 }) {
  const ms = Math.max(0, dt) * 1000;

  // A dormant base is fully inert — but a gate that is already MOVING is allowed to finish, so a
  // base going quiet mid-cycle can never strand its doors half-open. In practice bases do not
  // re-sleep; this is here so the invariant "the span is solid unless phase is open" holds without
  // depending on that.
  if (!awake && state.phase === GATE_CLOSED) {
    if (state.armedMs === 0 && state.lockoutMs === 0) return state;
    return { ...carry(state), armedMs: 0, lockoutMs: Math.max(0, state.lockoutMs - ms) };
  }

  const phaseMs = state.phaseMs + ms;

  switch (state.phase) {
    case GATE_CLOSED: {
      const lockoutMs = Math.max(0, state.lockoutMs - ms);
      // Demand only accumulates once the post-close lockout has expired, and any gap in demand
      // resets the accumulator outright rather than decaying it — "continuously present for the
      // reaction window" is a deliberately strict reading, because this is the cheapest place to
      // reject churn and the grace window in gateDemand.js has already smoothed the real signal.
      const armedMs = (demand && lockoutMs === 0) ? state.armedMs + ms : 0;
      if (armedMs >= state.reactionMs) {
        return { ...carry(state), phase: GATE_OPENING, armedMs: 0, phaseMs: 0, lockoutMs: 0, startedOpening: true };
      }
      if (armedMs === state.armedMs && lockoutMs === state.lockoutMs) return state;
      return { ...carry(state), armedMs, lockoutMs, phaseMs: 0 };
    }

    case GATE_OPENING:
      // Committed: the doors finish opening even if demand evaporates while they travel. Bailing
      // mid-swing would be the most visible flicker of all.
      if (phaseMs >= GATE_OPENING_MS) {
        return { ...carry(state), phase: GATE_OPEN, phaseMs: 0, sorties: state.sorties + 1, justOpened: true };
      }
      return { ...carry(state), phaseMs };

    case GATE_OPEN:
      // The only conditional transition in the machine: shut once nothing wants the door AND the
      // minimum-open floor has elapsed. Demand carries its own grace window, so `demand` being
      // false here already means "nobody has asked for roughly a second and a half".
      if (!demand && phaseMs >= GATE_MIN_OPEN_MS) {
        return { ...carry(state), phase: GATE_CLOSING, phaseMs: 0, justClosed: true };
      }
      return { ...carry(state), phaseMs };

    case GATE_CLOSING:
    default:
      if (phaseMs >= GATE_CLOSING_MS) {
        return { ...carry(state), phase: GATE_CLOSED, phaseMs: 0, armedMs: 0, lockoutMs: GATE_RECLOSE_LOCKOUT_MS };
      }
      return { ...carry(state), phaseMs };
  }
}
