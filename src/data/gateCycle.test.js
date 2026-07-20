// #309 — the sally-port cycle state machine (data/gateCycle.js). Pure, so this is a plain
// tick-it-forward test with no scene involved.
//
// Rewritten for the 2026-07-19 playtest: the machine is DEMAND-driven, not clock-driven, so almost
// every test here is now a statement about what the gate does with a given demand signal over time.
// The old suite's questions ("does it open N ms after wake", "does it re-sortie after the
// cooldown") no longer have answers, because there is no longer a clock to ask them of — the
// replacements are "does it open when asked", "does it stay shut when not", and the anti-flicker
// properties, which is what the issue actually cares about.
import { describe, it, expect } from 'vitest';
import {
  makeGateState, tickGate, gatePassable,
  GATE_CLOSED, GATE_OPENING, GATE_OPEN, GATE_CLOSING,
  GATE_REACTION_MS, GATE_OPENING_MS, GATE_MIN_OPEN_MS, GATE_CLOSING_MS, GATE_RECLOSE_LOCKOUT_MS,
} from './gateCycle.js';

// Advance `ms` in 16ms frames, the real per-frame granularity, collecting every state it passes
// through — so transitions are observed the way the scene observes them, not by jumping a whole
// phase in one giant dt. `demand` may be a constant or a function of elapsed ms, which is how the
// churn/flicker tests drive a signal that comes and goes.
function run(state, ms, demand = true, awake = true) {
  const seen = [state];
  for (let t = 0; t < ms; t += 16) {
    const d = typeof demand === 'function' ? demand(t) : demand;
    state = tickGate(state, { awake, demand: d, dt: 0.016 });
    seen.push(state);
  }
  return { state, seen };
}

// The full trip from "demand appears" to "doors are open", for tests that just want to get there.
const TO_OPEN_MS = GATE_REACTION_MS + GATE_OPENING_MS + 64;

describe('#309 gate cycle — demand-driven', () => {
  it('starts shut and impassable', () => {
    const s = makeGateState();
    expect(s.phase).toBe(GATE_CLOSED);
    expect(gatePassable(s)).toBe(false);
  });

  // ── The precondition: wake ────────────────────────────────────────────────────────────
  // A base the player has not woken is a shut fortress. Note this is now a stronger claim than it
  // used to be: it must hold even when demand is asserted, because demand is computed from routes
  // that exist whether or not anyone has noticed the player.
  it("a DORMANT base's gate never opens, even with demand present", () => {
    const { state } = run(makeGateState(), 30000, true, /* awake */ false);
    expect(state.phase).toBe(GATE_CLOSED);
    expect(gatePassable(state)).toBe(false);
  });

  // ── THE ISSUE: no clock ───────────────────────────────────────────────────────────────
  // The single most important test in this file. The owner's complaint was that a woken base
  // cycled its gates on a metronome whether or not anything wanted them. An awake base with no
  // demand must sit there, shut, forever.
  it('an AWAKE base with no demand never opens its gate — there is no clock', () => {
    const { state, seen } = run(makeGateState(), 60000, /* demand */ false);
    expect(state.phase).toBe(GATE_CLOSED);
    expect(state.sorties).toBe(0);
    expect(seen.some(gatePassable)).toBe(false);
    expect(seen.some((s) => s.startedOpening)).toBe(false);
  });

  it('opens when a unit needs it, a reaction beat after the demand appears', () => {
    // Just short of the reaction window: the leaves have not moved.
    const early = run(makeGateState(), GATE_REACTION_MS - 100);
    expect(early.state.phase).toBe(GATE_CLOSED);
    // Past the reaction window plus the doors' own travel: open and passable.
    const later = run(makeGateState(), TO_OPEN_MS);
    expect(later.state.phase).toBe(GATE_OPEN);
    expect(gatePassable(later.state)).toBe(true);
    expect(later.state.sorties).toBe(1);
  });

  // ── Closing is demand-driven too ──────────────────────────────────────────────────────
  it('stays open as long as it is still wanted, well past the minimum', () => {
    const { state } = run(makeGateState(), TO_OPEN_MS + GATE_MIN_OPEN_MS * 3);
    expect(state.phase).toBe(GATE_OPEN);
    expect(gatePassable(state)).toBe(true);
  });

  it('shuts once nothing wants it any more', () => {
    // Demand for long enough to open and satisfy the floor, then gone.
    const openPhase = TO_OPEN_MS + GATE_MIN_OPEN_MS + 200;
    const { state, seen } = run(makeGateState(), openPhase + GATE_CLOSING_MS + 400,
      (t) => t < openPhase);
    expect(state.phase).toBe(GATE_CLOSED);
    expect(seen.some((s) => s.justClosed)).toBe(true);
  });

  // ── Anti-flicker ──────────────────────────────────────────────────────────────────────
  // The floor: demand that vanishes the instant the doors finish opening must not slam them shut.
  // This is what protects a sortie whose lead unit briefly loses its routing lock, and (since the
  // playtest) the player's opportunity window to slip inside.
  it('honours the minimum-open floor when demand vanishes immediately', () => {
    const { seen } = run(makeGateState(), TO_OPEN_MS + GATE_MIN_OPEN_MS + GATE_CLOSING_MS + 400,
      (t) => t < TO_OPEN_MS);
    const openFrames = seen.filter(gatePassable).length;
    expect(openFrames * 16).toBeGreaterThanOrEqual(GATE_MIN_OPEN_MS - 100);
    // ...and it does not linger much past the floor once nothing wants it.
    expect(openFrames * 16).toBeLessThan(GATE_MIN_OPEN_MS + 400);
  });

  // A single unit's route churning on and off the span for a frame at a time is the exact failure
  // mode the issue names ("a gate shouldn't stutter open/closed as one unit's route churns"). The
  // reaction accumulator requires demand to be CONTINUOUS, so a signal this ragged never opens it
  // at all — and the scene's grace window (gateDemand.js) means a real demand never looks like
  // this in the first place.
  it('a demand signal that flickers frame-to-frame never moves the doors', () => {
    const { state, seen } = run(makeGateState(), 30000, (t) => Math.floor(t / 16) % 3 === 0);
    expect(state.phase).toBe(GATE_CLOSED);
    expect(seen.some((s) => s.startedOpening)).toBe(false);
  });

  // The re-open lockout: demand that genuinely lapses and genuinely returns a moment later must
  // not read as the door bouncing.
  it('refuses to re-open immediately after closing', () => {
    // Open, satisfy the floor, drop demand to force a close, then reassert it at once.
    const dropAt = TO_OPEN_MS + GATE_MIN_OPEN_MS + 200;
    const resumeAt = dropAt + GATE_CLOSING_MS + 100;
    let s = makeGateState();
    const seen = [];
    for (let t = 0; t < resumeAt + GATE_RECLOSE_LOCKOUT_MS - 200; t += 16) {
      s = tickGate(s, { awake: true, demand: t < dropAt || t >= resumeAt, dt: 0.016 });
      seen.push({ t, phase: s.phase });
    }
    // It closed, and despite demand being back it has NOT started opening again inside the lockout.
    expect(seen.some((f) => f.phase === GATE_CLOSING)).toBe(true);
    expect(s.phase).toBe(GATE_CLOSED);
    // Given enough further time, though, it does come back — the lockout delays, never denies.
    const after = run(s, GATE_RECLOSE_LOCKOUT_MS + TO_OPEN_MS);
    expect(after.state.phase).toBe(GATE_OPEN);
  });

  // ── Safety: no ambiguous half-open frame ──────────────────────────────────────────────
  // "Passable only in the fully-open phase" — there is no frame in which the doors are visibly
  // travelling AND the span is walkable, so nothing can be caught in a closing gate.
  it('is impassable during both door-travel phases', () => {
    const openPhase = TO_OPEN_MS + GATE_MIN_OPEN_MS + 200;
    const { seen } = run(makeGateState(), openPhase + GATE_CLOSING_MS + 400, (t) => t < openPhase);
    for (const s of seen) {
      if (s.phase === GATE_OPENING || s.phase === GATE_CLOSING) expect(gatePassable(s)).toBe(false);
    }
    expect(seen.some((s) => s.phase === GATE_OPENING)).toBe(true);
    expect(seen.some((s) => s.phase === GATE_CLOSING)).toBe(true);
  });

  // Committed once moving: demand evaporating mid-swing must not bail the doors out half-open,
  // which would be the most visible stutter of all.
  it('finishes opening even if demand disappears while the doors are travelling', () => {
    const { state } = run(makeGateState(), TO_OPEN_MS, (t) => t < GATE_REACTION_MS + 32);
    expect(state.phase).toBe(GATE_OPEN);
  });

  it('fires exactly one open/close transition per sortie', () => {
    const openPhase = TO_OPEN_MS + GATE_MIN_OPEN_MS + 200;
    const { seen } = run(makeGateState(), openPhase + GATE_CLOSING_MS + 400, (t) => t < openPhase);
    expect(seen.filter((s) => s.justOpened).length).toBe(1);
    expect(seen.filter((s) => s.justClosed).length).toBe(1);
    expect(seen.filter((s) => s.startedOpening).length).toBe(1);
  });

  // The de-synchroniser: a base's two gates carry different jitter so that when they ARE both
  // wanted at once they still crank a beat apart rather than in lockstep.
  it('jitter staggers two gates that become wanted on the same frame', () => {
    const a = run(makeGateState(0), GATE_REACTION_MS + GATE_OPENING_MS + 64).state;
    const b = run(makeGateState(500), GATE_REACTION_MS + GATE_OPENING_MS + 64).state;
    expect(a.phase).toBe(GATE_OPEN);
    expect(b.phase).not.toBe(GATE_OPEN);   // still catching up
  });

  it('never mutates the state passed in', () => {
    const s = makeGateState();
    const before = { ...s };
    tickGate(s, { awake: true, demand: true, dt: 0.016 });
    expect(s).toEqual(before);
  });
});

// ── #355: the terminal fail-open state ─────────────────────────────────────────────────
// Owner: "gates should lock open after the objective is destroyed." The trigger is the objective
// hex ALONE (confirmed) — the garrison may still be alive. The base is beaten, its systems fail
// open, and nothing after that can shut the door again.
function runFail(state, ms, { failOpen = true, demand = false, awake = true } = {}) {
  const seen = [state];
  for (let t = 0; t < ms; t += 16) {
    const f = typeof failOpen === 'function' ? failOpen(t) : failOpen;
    state = tickGate(state, { awake, demand, failOpen: f, dt: 0.016 });
    seen.push(state);
  }
  return { state, seen };
}

describe('#355 gate cycle — fail open once the objective is destroyed', () => {
  it('cranks a shut gate open with no demand, no reaction delay and no garrison', () => {
    const { state } = runFail(makeGateState(500), GATE_OPENING_MS + 64);
    expect(state.phase).toBe(GATE_OPEN);
    expect(gatePassable(state)).toBe(true);
    expect(state.lockedOpen).toBe(true);
  });

  it('never closes again, however long the run goes and however dead the garrison', () => {
    const { state, seen } = runFail(makeGateState(), 300000);
    expect(state.phase).toBe(GATE_OPEN);
    expect(seen.every((s) => s.phase !== GATE_CLOSING)).toBe(true);
    expect(seen.filter((s) => s.justClosed).length).toBe(0);
  });

  it('latches: the gate stays open even if `failOpen` stops being passed', () => {
    // The scene derives `failOpen` from a permanent world fact, so this can't happen in practice —
    // but the latch is what makes the state TERMINAL rather than merely sticky, so pin it.
    const { state } = runFail(makeGateState(), GATE_OPENING_MS + 64);
    let s = state;
    for (let t = 0; t < 120000; t += 16) s = tickGate(s, { awake: true, demand: false, dt: 0.016 });
    expect(s.phase).toBe(GATE_OPEN);
    expect(gatePassable(s)).toBe(true);
  });

  it('opens a DORMANT base\'s gate too — an objective sniped before the base ever woke', () => {
    const { state } = runFail(makeGateState(), GATE_OPENING_MS + 64, { awake: false });
    expect(state.phase).toBe(GATE_OPEN);
  });

  it('reverses a gate that is mid-close, without the leaves jumping', () => {
    // Get it fully open on ordinary demand, drop demand, let it start closing, then kill the
    // objective partway through the swing.
    let { state } = run(makeGateState(), TO_OPEN_MS);
    ({ state } = run(state, GATE_MIN_OPEN_MS + GATE_CLOSING_MS / 2, false));
    expect(state.phase).toBe(GATE_CLOSING);
    const fracBefore = 1 - state.phaseMs / GATE_CLOSING_MS;
    const flipped = tickGate(state, { awake: true, demand: false, failOpen: true, dt: 0 });
    expect(flipped.phase).toBe(GATE_OPENING);
    // Continuous: the leaves resume from where they stood, not from shut and not from wide.
    expect(flipped.phaseMs / GATE_OPENING_MS).toBeCloseTo(fracBefore, 5);
    const { state: after } = runFail(flipped, GATE_OPENING_MS + 64);
    expect(after.phase).toBe(GATE_OPEN);
  });

  it('fires exactly one open transition, and lets an in-flight opening finish normally', () => {
    const { seen } = runFail(makeGateState(), 60000);
    expect(seen.filter((s) => s.startedOpening).length).toBe(1);
    expect(seen.filter((s) => s.justOpened).length).toBe(1);
  });

  it('parks with zero churn once open — the same object is returned every tick', () => {
    const { state } = runFail(makeGateState(), GATE_OPENING_MS + 64);
    expect(tickGate(state, { awake: true, demand: false, failOpen: true, dt: 0.016 })).toBe(state);
  });

  it('never mutates the state passed in', () => {
    const s = makeGateState();
    const before = { ...s };
    tickGate(s, { awake: true, failOpen: true, dt: 0.016 });
    expect(s).toEqual(before);
  });
});

// ── #369 ELEVATOR DOORS ────────────────────────────────────────────────────────────────
// Jackson, playtest 2026-07-20: "I just got stuck in a gate when it closed while I was in the
// middle", then, choosing between a shove and a door that gives way: "ooo, yeah let's do 'not
// closing while occupied', I actually like that a lot." So: the doors will not close on a body,
// and a gate already closing reverses when one steps in. `occupied` is computed by the scene from
// the real collision geometry (gateClearance.js); here it is just an input to drive.
function runOcc(state, ms, { occupied = false, demand = false, awake = true, failOpen = false } = {}) {
  const seen = [state];
  for (let t = 0; t < ms; t += 16) {
    const o = typeof occupied === 'function' ? occupied(t) : occupied;
    state = tickGate(state, { awake, demand, occupied: o, failOpen, dt: 0.016 });
    seen.push(state);
  }
  return { state, seen };
}

// An open gate that has already outlasted its minimum-open floor and has no demand — i.e. one that
// would shut on the very next tick if nothing were standing in it.
function openAndDue() {
  const { state } = run(makeGateState(), TO_OPEN_MS);
  expect(state.phase).toBe(GATE_OPEN);
  return runOcc(state, GATE_MIN_OPEN_MS + 32, { occupied: true }).state;
}

describe('#369 — a gate does not close while its mouth is occupied', () => {
  it('holds open indefinitely while a body stands in the mouth', () => {
    const held = runOcc(openAndDue(), 20000, { occupied: true }).state;
    expect(held.phase).toBe(GATE_OPEN);
    expect(gatePassable(held)).toBe(true);
  });

  it('closes as soon as the mouth is clear — the hold only defers, it never cancels', () => {
    const { state } = runOcc(openAndDue(), 32, { occupied: false });
    expect(state.phase).toBe(GATE_CLOSING);   // it had been due to shut for 20s; it shuts at once
  });

  it('still needs the minimum-open floor: occupancy adds a reason to stay, not a reason to leave', () => {
    // Fresh open gate, empty mouth, well under the floor: it stays open on the floor alone.
    const { state } = run(makeGateState(), TO_OPEN_MS);
    const early = runOcc(state, 1000, { occupied: false }).state;
    expect(early.phase).toBe(GATE_OPEN);
  });

  it('a body in the mouth of a SHUT gate does not make it open', () => {
    const shut = runOcc(makeGateState(), 10000, { occupied: true, demand: false }).state;
    expect(shut.phase).toBe(GATE_CLOSED);
    expect(gatePassable(shut)).toBe(false);
  });

  it('reverses a gate that is already closing when something steps into the mouth', () => {
    const closing = runOcc(openAndDue(), 32, { occupied: false }).state;
    expect(closing.phase).toBe(GATE_CLOSING);
    const relented = tickGate(closing, { awake: true, occupied: true, dt: 0.016 });
    expect(relented.phase).toBe(GATE_OPENING);
    expect(relented.startedOpening).toBe(true);
  });

  it('the reversal preserves the leaves- position — the doors give way, they never blink', () => {
    // Halfway shut: openFrac ~0.5, so the reversal must start ~halfway through OPENING, not at 0.
    const { state: closing } = runOcc(openAndDue(), 32, { occupied: false });
    const half = runOcc(closing, GATE_CLOSING_MS / 2, { occupied: false }).state;
    expect(half.phase).toBe(GATE_CLOSING);
    const openFrac = 1 - half.phaseMs / GATE_CLOSING_MS;
    const relented = tickGate(half, { awake: true, occupied: true, dt: 0 });
    expect(relented.phaseMs / GATE_OPENING_MS).toBeCloseTo(openFrac, 6);
  });

  it('a reversed gate finishes opening and is passable again', () => {
    const closing = runOcc(openAndDue(), 32, { occupied: false }).state;
    const reopened = runOcc(closing, GATE_OPENING_MS + 64, { occupied: true }).state;
    expect(reopened.phase).toBe(GATE_OPEN);
    expect(gatePassable(reopened)).toBe(true);
  });

  it('a gate that finished closing before anyone arrived stays closed', () => {
    const shut = runOcc(openAndDue(), GATE_CLOSING_MS + 64, { occupied: false }).state;
    expect(shut.phase).toBe(GATE_CLOSED);
    // Occupancy of a shut mouth is the fallback nudge's job, not the state machine's.
    expect(runOcc(shut, 2000, { occupied: true }).state.phase).toBe(GATE_CLOSED);
  });

  it('composes with #355: a LOCKED-OPEN gate ignores occupancy entirely and stays open', () => {
    const locked = runOcc(makeGateState(), TO_OPEN_MS + 2000, { failOpen: true }).state;
    expect(locked.lockedOpen).toBe(true);
    expect(locked.phase).toBe(GATE_OPEN);
    // Both values of `occupied` are inert once the latch is set — it was never going to close, so
    // the two "will not close" rules never meet.
    for (const occupied of [true, false]) {
      const later = runOcc(locked, 30000, { occupied, failOpen: true }).state;
      expect(later.phase).toBe(GATE_OPEN);
      expect(gatePassable(later)).toBe(true);
    }
  });

  it('defaults to unoccupied, so every existing caller is unchanged', () => {
    const { state: a } = run(makeGateState(), TO_OPEN_MS + GATE_MIN_OPEN_MS + 64);
    expect(a.phase).toBe(GATE_OPEN);   // demand true throughout: held by demand, not occupancy
    const { state } = run(makeGateState(), TO_OPEN_MS);
    const shutting = runOcc(state, GATE_MIN_OPEN_MS + 64, {}).state;
    expect(shutting.phase).toBe(GATE_CLOSING);
  });
});
