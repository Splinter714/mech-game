import { describe, it, expect } from 'vitest';
import {
  makeDockResupplyState, tickDockResupply, DOCK_RESUPPLY_COOLDOWN_MS, DOCK_RESUPPLY_MAX_PER_DOCK,
} from './dockResupply.js';

describe('#269 §3 "rare multi-spawn exception": tickDockResupply', () => {
  it('does not tick down while the base is dormant (not awake), regardless of cleared', () => {
    let state = makeDockResupplyState();
    for (let i = 0; i < 50; i++) {
      state = tickDockResupply(state, { awake: false, cleared: true, dt: 1 });
    }
    expect(state.remainingMs).toBe(DOCK_RESUPPLY_COOLDOWN_MS);
    expect(state.count).toBe(0);
    expect(state.ready).toBeFalsy();
  });

  it('#269 playtest follow-up: ticks down once the base is awake even while the original unit is still alive (not cleared)', () => {
    let state = makeDockResupplyState();
    state = tickDockResupply(state, { awake: true, cleared: false, dt: (DOCK_RESUPPLY_COOLDOWN_MS / 1000) - 1 });
    expect(state.ready).toBeFalsy();
    expect(state.remainingMs).toBeCloseTo(1000, 0);
    expect(state.count).toBe(0);
  });

  it('becomes ready exactly once the cooldown elapses while cleared', () => {
    let state = makeDockResupplyState();
    state = tickDockResupply(state, { awake: true, cleared: true, dt: DOCK_RESUPPLY_COOLDOWN_MS / 1000 });
    expect(state.ready).toBe(true);
    expect(state.count).toBe(1);
  });

  it('does NOT fire when the cooldown elapses while the dock is still occupied — holds at 0 instead of restarting', () => {
    let state = makeDockResupplyState();
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
    let state = makeDockResupplyState();
    state = tickDockResupply(state, { awake: true, cleared: false, dt: DOCK_RESUPPLY_COOLDOWN_MS / 1000 });
    expect(state.remainingMs).toBe(0);
    expect(state.ready).toBeFalsy();

    // Unit finally leaves/dies — the very next tick (even with a tiny dt) fires right away.
    state = tickDockResupply(state, { awake: true, cleared: true, dt: 0.016 });
    expect(state.ready).toBe(true);
    expect(state.count).toBe(1);
  });

  it('a dock whose base goes back to sleep partway through the cooldown does not lose progress permanently — it holds at full cooldown and must count down again from scratch', () => {
    let state = makeDockResupplyState();
    state = tickDockResupply(state, { awake: true, cleared: false, dt: 10 });
    expect(state.remainingMs).toBeLessThan(DOCK_RESUPPLY_COOLDOWN_MS);
    state = tickDockResupply(state, { awake: false, cleared: false, dt: 1 });
    expect(state.remainingMs).toBe(DOCK_RESUPPLY_COOLDOWN_MS);
    expect(state.ready).toBeFalsy();
  });

  it('is capped at DOCK_RESUPPLY_MAX_PER_DOCK — never fires `ready` beyond that many times', () => {
    let state = makeDockResupplyState();
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
    const state = makeDockResupplyState();
    const frozen = { ...state };
    tickDockResupply(state, { awake: true, cleared: true, dt: 5 });
    expect(state).toEqual(frozen);
  });
});
