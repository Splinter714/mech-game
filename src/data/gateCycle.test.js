// #309 — the sally-port cycle state machine (data/gateCycle.js). Pure, so this is a plain
// tick-it-forward test with no scene involved.
import { describe, it, expect } from 'vitest';
import {
  makeGateState, tickGate, gatePassable,
  GATE_CLOSED, GATE_OPENING, GATE_OPEN, GATE_CLOSING,
  GATE_FIRST_SORTIE_MS, GATE_OPENING_MS, GATE_OPEN_HOLD_MS, GATE_CLOSING_MS, GATE_SORTIE_COOLDOWN_MS,
} from './gateCycle.js';

// Advance `ms` in 16ms frames, the real per-frame granularity, collecting every state it passes
// through — so the transitions are observed the way the scene observes them, not by jumping the
// whole phase in one giant dt.
function run(state, ms) {
  const seen = [state];
  for (let t = 0; t < ms; t += 16) {
    state = tickGate(state, { awake: true, dt: 0.016 });
    seen.push(state);
  }
  return { state, seen };
}

describe('#309 gate cycle', () => {
  it('starts shut and impassable', () => {
    const s = makeGateState();
    expect(s.phase).toBe(GATE_CLOSED);
    expect(gatePassable(s)).toBe(false);
  });

  // The trigger. A base the player has not woken is a shut fortress — its gate must not be
  // quietly counting down toward a sortie he has not earned, the same rule dockResupply applies.
  it('a DORMANT base\'s gate never moves, however long it is ticked', () => {
    let s = makeGateState();
    for (let i = 0; i < 5000; i++) s = tickGate(s, { awake: false, dt: 0.016 });
    expect(s.phase).toBe(GATE_CLOSED);
    expect(gatePassable(s)).toBe(false);
  });

  it('opens a beat after the base wakes, and not before', () => {
    // Just short of the first-sortie delay: still shut.
    const early = run(makeGateState(), GATE_FIRST_SORTIE_MS - 200);
    expect(early.state.phase).toBe(GATE_CLOSED);
    // Past the delay plus the doors' own travel: open.
    const later = run(makeGateState(), GATE_FIRST_SORTIE_MS + GATE_OPENING_MS + 100);
    expect(later.state.phase).toBe(GATE_OPEN);
    expect(gatePassable(later.state)).toBe(true);
  });

  // The safety property behind "passable only in the fully-open phase": there is no frame in which
  // the doors are visibly travelling AND the span is walkable, so nothing can be caught in a
  // closing gate.
  it('is impassable during both door-travel phases', () => {
    const { seen } = run(makeGateState(), GATE_FIRST_SORTIE_MS + GATE_OPENING_MS
      + GATE_OPEN_HOLD_MS + GATE_CLOSING_MS + 200);
    for (const s of seen) {
      if (s.phase === GATE_OPENING || s.phase === GATE_CLOSING) expect(gatePassable(s)).toBe(false);
    }
    expect(seen.some((s) => s.phase === GATE_OPENING)).toBe(true);
    expect(seen.some((s) => s.phase === GATE_CLOSING)).toBe(true);
  });

  it('holds open for the full sortie window, then shuts again', () => {
    const { seen } = run(makeGateState(), GATE_FIRST_SORTIE_MS + GATE_OPENING_MS
      + GATE_OPEN_HOLD_MS + GATE_CLOSING_MS + 200);
    const openFrames = seen.filter(gatePassable).length;
    // ~GATE_OPEN_HOLD_MS worth of 16ms frames, within a frame or two either way.
    expect(openFrames * 16).toBeGreaterThan(GATE_OPEN_HOLD_MS - 100);
    expect(openFrames * 16).toBeLessThan(GATE_OPEN_HOLD_MS + 100);
    expect(seen[seen.length - 1].phase).toBe(GATE_CLOSED);
  });

  it('fires exactly one open/close transition per sortie', () => {
    const { seen } = run(makeGateState(), GATE_FIRST_SORTIE_MS + GATE_OPENING_MS
      + GATE_OPEN_HOLD_MS + GATE_CLOSING_MS + 200);
    expect(seen.filter((s) => s.justOpened).length).toBe(1);
    expect(seen.filter((s) => s.justClosed).length).toBe(1);
    expect(seen.filter((s) => s.startedOpening).length).toBe(1);
  });

  // Sorties REPEAT while the base stays awake — a base that only ever counterattacks once would
  // let the player win by outlasting one wave.
  it('sorties again after the cooldown, for as long as the base stays awake', () => {
    const full = GATE_OPENING_MS + GATE_OPEN_HOLD_MS + GATE_CLOSING_MS + GATE_SORTIE_COOLDOWN_MS;
    const { state, seen } = run(makeGateState(), GATE_FIRST_SORTIE_MS + full * 3);
    expect(state.sorties).toBeGreaterThanOrEqual(3);
    expect(seen.filter((s) => s.justOpened).length).toBeGreaterThanOrEqual(3);
  });

  // The de-synchroniser: a base's two gates are built with different jitter so they don't crank in
  // perfect lockstep (the same reasoning #311 applied to docks).
  it('jitter staggers two gates of the same base', () => {
    const a = run(makeGateState(0), GATE_FIRST_SORTIE_MS + GATE_OPENING_MS + 100).state;
    const b = run(makeGateState(1500), GATE_FIRST_SORTIE_MS + GATE_OPENING_MS + 100).state;
    expect(a.phase).toBe(GATE_OPEN);
    expect(b.phase).not.toBe(GATE_OPEN);   // still catching up
  });

  it('never mutates the state passed in', () => {
    const s = makeGateState();
    const before = { ...s };
    tickGate(s, { awake: true, dt: 0.016 });
    expect(s).toEqual(before);
  });
});
