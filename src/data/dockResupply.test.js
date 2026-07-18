import { describe, it, expect } from 'vitest';
import {
  makeDockResupplyState, tickDockResupply, DOCK_RESUPPLY_COOLDOWN_MS, DOCK_RESUPPLY_MAX_PER_DOCK,
} from './dockResupply.js';

describe('#269 §3 "rare multi-spawn exception": tickDockResupply', () => {
  it('does not tick down while not eligible (dock still has a live unit, or base is dormant)', () => {
    let state = makeDockResupplyState();
    for (let i = 0; i < 50; i++) {
      state = tickDockResupply(state, { eligible: false, dt: 1 });
    }
    expect(state.remainingMs).toBe(DOCK_RESUPPLY_COOLDOWN_MS);
    expect(state.count).toBe(0);
    expect(state.ready).toBeFalsy();
  });

  it('counts down once eligible, and is not ready before the cooldown elapses', () => {
    let state = makeDockResupplyState();
    state = tickDockResupply(state, { eligible: true, dt: (DOCK_RESUPPLY_COOLDOWN_MS / 1000) - 1 });
    expect(state.ready).toBeFalsy();
    expect(state.remainingMs).toBeCloseTo(1000, 0);
    expect(state.count).toBe(0);
  });

  it('becomes ready exactly once the cooldown elapses', () => {
    let state = makeDockResupplyState();
    state = tickDockResupply(state, { eligible: true, dt: DOCK_RESUPPLY_COOLDOWN_MS / 1000 });
    expect(state.ready).toBe(true);
    expect(state.count).toBe(1);
  });

  it('a dock that goes ineligible partway through the cooldown does not lose progress permanently — it holds at full cooldown and must clear again from scratch', () => {
    let state = makeDockResupplyState();
    state = tickDockResupply(state, { eligible: true, dt: 10 });
    expect(state.remainingMs).toBeLessThan(DOCK_RESUPPLY_COOLDOWN_MS);
    state = tickDockResupply(state, { eligible: false, dt: 1 });
    expect(state.remainingMs).toBe(DOCK_RESUPPLY_COOLDOWN_MS);
    expect(state.ready).toBeFalsy();
  });

  it('is capped at DOCK_RESUPPLY_MAX_PER_DOCK — never fires `ready` a second time once spent', () => {
    let state = makeDockResupplyState();
    state = tickDockResupply(state, { eligible: true, dt: DOCK_RESUPPLY_COOLDOWN_MS / 1000 });
    expect(state.ready).toBe(true);
    expect(state.count).toBe(DOCK_RESUPPLY_MAX_PER_DOCK);

    // Further ticks, even fully eligible and well past cooldown again, never report ready again,
    // and the stale `ready: true` from the tick that just fired does not leak into subsequent ticks.
    for (let i = 0; i < 5; i++) {
      state = tickDockResupply(state, { eligible: true, dt: DOCK_RESUPPLY_COOLDOWN_MS / 1000 });
      expect(state.ready).toBeFalsy();
      expect(state.count).toBe(DOCK_RESUPPLY_MAX_PER_DOCK);
    }
  });

  it('never mutates the state object passed in (pure)', () => {
    const state = makeDockResupplyState();
    const frozen = { ...state };
    tickDockResupply(state, { eligible: true, dt: 5 });
    expect(state).toEqual(frozen);
  });
});
