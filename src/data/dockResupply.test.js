import { describe, it, expect } from 'vitest';
import {
  makeDockResupplyState, tickDockResupply, spendDockResupply,
  DOCK_RESUPPLY_COOLDOWN_MS, DOCK_RESUPPLY_MAX_PER_DOCK,
  DOCK_RESUPPLY_COOLDOWN_JITTER, DOCK_RESUPPLY_PHASE_MIN, DOCK_RESUPPLY_PHASE_MAX,
} from './dockResupply.js';

// Since #311 every dock rolls its own cooldown AND its own starting phase, so a bare
// `makeDockResupplyState()` no longer produces a predictable 18s-from-full timer. The cooldown
// state machine's own rules (dormant gating, cleared gating, the per-dock cap) are orthogonal to
// that randomness, so those tests below pin the rolls to their neutral values — an rng returning
// 0.5 for the jitter draw (mid-band → exactly the baseline interval) then 1.0 for the phase draw
// (top of the band → a full, un-offset cooldown). That reproduces the exact pre-#311 baseline
// dock, keeping those tests about what they were always about. #311's own randomness is covered
// by its dedicated describe block at the bottom of this file.
function flatState() {
  const draws = [0.5, DOCK_RESUPPLY_PHASE_MAX];
  let i = 0;
  return makeDockResupplyState(DOCK_RESUPPLY_COOLDOWN_MS, () => draws[i++]);
}

// A deterministic stand-in for the seeded `mulberry32` the real scene threads in — distinct docks
// get distinct draws, and the sequence is reproducible across runs.
function seqRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('#269 §3 "rare multi-spawn exception": tickDockResupply', () => {
  it('does not tick down while the base is dormant (not awake), regardless of cleared', () => {
    let state = flatState();
    for (let i = 0; i < 50; i++) {
      state = tickDockResupply(state, { awake: false, cleared: true, dt: 1 });
    }
    expect(state.remainingMs).toBe(DOCK_RESUPPLY_COOLDOWN_MS);
    expect(state.count).toBe(0);
    expect(state.ready).toBeFalsy();
  });

  it('#269 playtest follow-up: ticks down once the base is awake even while the original unit is still alive (not cleared)', () => {
    let state = flatState();
    state = tickDockResupply(state, { awake: true, cleared: false, dt: (DOCK_RESUPPLY_COOLDOWN_MS / 1000) - 1 });
    expect(state.ready).toBeFalsy();
    expect(state.remainingMs).toBeCloseTo(1000, 0);
    expect(state.count).toBe(0);
  });

  it('becomes ready exactly once the cooldown elapses while cleared', () => {
    let state = flatState();
    state = tickDockResupply(state, { awake: true, cleared: true, dt: DOCK_RESUPPLY_COOLDOWN_MS / 1000 });
    expect(state.ready).toBe(true);
    expect(state.count).toBe(1);
  });

  it('does NOT fire when the cooldown elapses while the dock is still occupied — holds at 0 instead of restarting', () => {
    let state = flatState();
    // Cooldown fully elapses, but the original unit is still alive (not cleared) — must not fire.
    state = tickDockResupply(state, { awake: true, cleared: false, dt: DOCK_RESUPPLY_COOLDOWN_MS / 1000 });
    expect(state.ready).toBeFalsy();
    expect(state.count).toBe(0);
    expect(state.remainingMs).toBe(0);

    // Further ticks while still occupied hold at 0 — no restart, no re-draining below 0.
    state = tickDockResupply(state, { awake: true, cleared: false, dt: 5 });
    expect(state.ready).toBeFalsy();
    expect(state.remainingMs).toBe(0);
  });

  it('fires immediately (no additional wait) once the dock clears AFTER the cooldown already elapsed', () => {
    let state = flatState();
    state = tickDockResupply(state, { awake: true, cleared: false, dt: DOCK_RESUPPLY_COOLDOWN_MS / 1000 });
    expect(state.remainingMs).toBe(0);
    expect(state.ready).toBeFalsy();

    // Unit finally leaves/dies — the very next tick (even with a tiny dt) fires right away.
    state = tickDockResupply(state, { awake: true, cleared: true, dt: 0.016 });
    expect(state.ready).toBe(true);
    expect(state.count).toBe(1);
  });

  it('a dock whose base goes back to sleep partway through the cooldown does not lose progress permanently — it holds at full cooldown and must count down again from scratch', () => {
    let state = flatState();
    state = tickDockResupply(state, { awake: true, cleared: false, dt: 10 });
    expect(state.remainingMs).toBeLessThan(DOCK_RESUPPLY_COOLDOWN_MS);
    state = tickDockResupply(state, { awake: false, cleared: false, dt: 1 });
    expect(state.remainingMs).toBe(DOCK_RESUPPLY_COOLDOWN_MS);
    expect(state.ready).toBeFalsy();
  });

  it('is capped at DOCK_RESUPPLY_MAX_PER_DOCK — never fires `ready` beyond that many times', () => {
    let state = flatState();
    // Drive the cooldown to elapse exactly `DOCK_RESUPPLY_MAX_PER_DOCK` times — each elapse
    // should report `ready: true` and bump `count`, up to (but never past) the cap.
    for (let i = 1; i <= DOCK_RESUPPLY_MAX_PER_DOCK; i++) {
      state = tickDockResupply(state, { awake: true, cleared: true, dt: DOCK_RESUPPLY_COOLDOWN_MS / 1000 });
      expect(state.ready).toBe(true);
      expect(state.count).toBe(i);
    }
    expect(state.count).toBe(DOCK_RESUPPLY_MAX_PER_DOCK);

    // Further ticks, even fully awake+cleared and well past cooldown again, never report ready
    // again, and the stale `ready: true` from the tick that just fired does not leak into
    // subsequent ticks.
    for (let i = 0; i < 5; i++) {
      state = tickDockResupply(state, { awake: true, cleared: true, dt: DOCK_RESUPPLY_COOLDOWN_MS / 1000 });
      expect(state.ready).toBeFalsy();
      expect(state.count).toBe(DOCK_RESUPPLY_MAX_PER_DOCK);
    }
  });

  it('never mutates the state object passed in (pure)', () => {
    const state = flatState();
    const frozen = { ...state };
    tickDockResupply(state, { awake: true, cleared: true, dt: 5 });
    expect(state).toEqual(frozen);
  });
});

// #311: docks used to share one flat cooldown and be constructed/woken together, so a base's
// reinforcements arrived as one synchronized pulse. Each dock now rolls both its own interval
// (±15%) and its own starting phase at construction.
describe('#311 dock resupply jitter: per-dock cooldown + starting phase', () => {
  const LO = DOCK_RESUPPLY_COOLDOWN_MS * (1 - DOCK_RESUPPLY_COOLDOWN_JITTER);
  const HI = DOCK_RESUPPLY_COOLDOWN_MS * (1 + DOCK_RESUPPLY_COOLDOWN_JITTER);
  // Ten docks off ONE shared generator — exactly how the real scene builds a run's docks.
  const rng = seqRng(20260719);
  const docks = Array.from({ length: 10 }, () => makeDockResupplyState(DOCK_RESUPPLY_COOLDOWN_MS, rng));

  it('gives every dock a DISTINCT cooldown interval', () => {
    const intervals = docks.map((d) => d.cooldownMs);
    expect(new Set(intervals).size).toBe(docks.length);
  });

  it('keeps every rolled interval inside ±15% of the baseline (~15.3-20.7s)', () => {
    expect(LO).toBeCloseTo(15300, 0);
    expect(HI).toBeCloseTo(20700, 0);
    for (const d of docks) {
      expect(d.cooldownMs).toBeGreaterThanOrEqual(LO);
      expect(d.cooldownMs).toBeLessThanOrEqual(HI);
    }
  });

  it('gives every dock a DISTINCT starting phase — they do not all begin at a full cooldown', () => {
    const starts = docks.map((d) => d.remainingMs);
    expect(new Set(starts).size).toBe(docks.length);
    // The whole point: not every dock starts at its own full interval (which is what would keep
    // them firing in lockstep on the first cycle).
    expect(starts.some((ms, i) => ms < docks[i].cooldownMs)).toBe(true);
  });

  it('keeps every starting phase inside its own dock cooldown band, never zero and never above one full cycle', () => {
    for (const d of docks) {
      expect(d.remainingMs).toBeGreaterThanOrEqual(d.cooldownMs * DOCK_RESUPPLY_PHASE_MIN);
      expect(d.remainingMs).toBeLessThanOrEqual(d.cooldownMs * DOCK_RESUPPLY_PHASE_MAX);
      expect(d.remainingMs).toBeGreaterThan(0);
    }
  });

  it('spreads the FIRST resupply of two docks woken on the same frame across different times', () => {
    // The reported symptom, reduced to its core: drive two docks with identical awake/cleared
    // input from the same instant and confirm they do not fire on the same tick.
    const r = seqRng(7);
    let a = makeDockResupplyState(DOCK_RESUPPLY_COOLDOWN_MS, r);
    let b = makeDockResupplyState(DOCK_RESUPPLY_COOLDOWN_MS, r);
    let firedA = null; let firedB = null;
    for (let t = 0; t < 3000 && (firedA === null || firedB === null); t++) {
      a = tickDockResupply(a, { awake: true, cleared: true, dt: 0.016 });
      b = tickDockResupply(b, { awake: true, cleared: true, dt: 0.016 });
      if (a.ready && firedA === null) firedA = t;
      if (b.ready && firedB === null) firedB = t;
    }
    expect(firedA).not.toBeNull();
    expect(firedB).not.toBeNull();
    expect(firedA).not.toBe(firedB);
  });

  it('a jittered dock keeps its OWN interval for every later cycle, and still respects DOCK_RESUPPLY_MAX_PER_DOCK', () => {
    let state = makeDockResupplyState(DOCK_RESUPPLY_COOLDOWN_MS, seqRng(99));
    const own = state.cooldownMs;
    expect(own).not.toBe(DOCK_RESUPPLY_COOLDOWN_MS);
    let fires = 0;
    // Run far longer than the cap could ever need (well past maxPerDock full cycles).
    for (let t = 0; t < 20000; t++) {
      state = tickDockResupply(state, { awake: true, cleared: true, dt: 0.016 });
      if (state.ready) {
        fires++;
        // Recharges to this dock's own jittered interval, never back to the flat constant.
        expect(state.cooldownMs).toBe(own);
        expect(state.remainingMs).toBe(own);
      }
    }
    expect(fires).toBe(DOCK_RESUPPLY_MAX_PER_DOCK);
    expect(state.count).toBe(DOCK_RESUPPLY_MAX_PER_DOCK);
  });

  it('a dormant dock holds at its rolled starting phase — a dormant tick must not wipe the phase roll back to a full cooldown', () => {
    const state = makeDockResupplyState(DOCK_RESUPPLY_COOLDOWN_MS, seqRng(1234));
    const phase = state.remainingMs;
    expect(phase).toBeLessThan(state.cooldownMs);
    let s = state;
    for (let i = 0; i < 20; i++) s = tickDockResupply(s, { awake: false, cleared: true, dt: 1 });
    expect(s.remainingMs).toBe(phase);
    // And a partially-drained dock that goes back to sleep restores to its PHASE, not to a full
    // interval — otherwise re-sleeping a base would quietly re-synchronize its docks.
    s = tickDockResupply(state, { awake: true, cleared: false, dt: 1 });
    s = tickDockResupply(s, { awake: false, cleared: false, dt: 1 });
    expect(s.remainingMs).toBe(phase);
  });

  it('spendDockResupply preserves the per-dock roll while retiring the dock', () => {
    const state = makeDockResupplyState(DOCK_RESUPPLY_COOLDOWN_MS, seqRng(55));
    const spent = spendDockResupply(state);
    expect(spent.count).toBe(DOCK_RESUPPLY_MAX_PER_DOCK);
    expect(spent.cooldownMs).toBe(state.cooldownMs);
    expect(spent.startMs).toBe(state.startMs);
    expect(tickDockResupply(spent, { awake: true, cleared: true, dt: 999 }).ready).toBeFalsy();
  });

  it('defaults to Math.random when no rng is injected (callers without a seeded generator still get jitter)', () => {
    const a = makeDockResupplyState();
    const b = makeDockResupplyState();
    expect(a.cooldownMs).toBeGreaterThanOrEqual(LO);
    expect(a.cooldownMs).toBeLessThanOrEqual(HI);
    expect(b.cooldownMs).toBeGreaterThanOrEqual(LO);
    // Astronomically unlikely to collide; guards against the rng being ignored entirely.
    expect(a.cooldownMs).not.toBe(b.cooldownMs);
  });
});
