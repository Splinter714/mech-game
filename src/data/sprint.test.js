import { describe, it, expect } from 'vitest';
import {
  initialSprintState, toggleSprint, updateSprintFuel,
  SPRINT_FUEL_MAX, SPRINT_DRAIN_RATE, SPRINT_REGEN_RATE,
} from './sprint.js';

describe('Sprint (#188) — press-to-toggle fuel state machine', () => {
  it('starts inactive with a full tank', () => {
    const s = initialSprintState();
    expect(s.active).toBe(false);
    expect(s.fuel).toBe(SPRINT_FUEL_MAX);
  });

  it('toggling on drains fuel over time while active', () => {
    let state = { active: true, fuel: SPRINT_FUEL_MAX };
    state = updateSprintFuel(state, 1);
    expect(state.active).toBe(true);
    expect(state.fuel).toBeCloseTo(SPRINT_FUEL_MAX - SPRINT_DRAIN_RATE, 5);
    state = updateSprintFuel(state, 1);
    expect(state.fuel).toBeCloseTo(SPRINT_FUEL_MAX - 2 * SPRINT_DRAIN_RATE, 5);
  });

  it('toggling off stops the drain and starts regen', () => {
    let state = { active: false, fuel: 1 };
    state = updateSprintFuel(state, 1);
    expect(state.active).toBe(false);
    expect(state.fuel).toBeCloseTo(1 + SPRINT_REGEN_RATE, 5);
  });

  it('fuel hitting 0 while active forces sprint off automatically', () => {
    let state = { active: true, fuel: 0.3 };
    state = updateSprintFuel(state, 1); // drains 1 unit/s — well past the remaining 0.3
    expect(state.fuel).toBe(0);
    expect(state.active).toBe(false);
  });

  it('regen never exceeds the capacity', () => {
    let state = { active: false, fuel: SPRINT_FUEL_MAX - 0.1 };
    state = updateSprintFuel(state, 10); // would massively overshoot without the cap
    expect(state.fuel).toBe(SPRINT_FUEL_MAX);
  });

  it('a custom cap/drain/regen config is respected', () => {
    const opts = { cap: 2, drainRate: 4, regenRate: 1 };
    let state = { active: true, fuel: 2 };
    state = updateSprintFuel(state, 0.5, opts); // drains 2 units in 0.5s -> exactly empty
    expect(state.fuel).toBe(0);
    expect(state.active).toBe(false);
    state = updateSprintFuel({ active: false, fuel: 0 }, 3, opts); // regen 3 units, capped at 2
    expect(state.fuel).toBe(2);
  });

  describe('toggleSprint', () => {
    it('turning ON succeeds when there is fuel', () => {
      expect(toggleSprint(false, 0.01)).toBe(true);
      expect(toggleSprint(false, SPRINT_FUEL_MAX)).toBe(true);
    });

    it('turning ON with 0 fuel does nothing — cannot sprint on empty', () => {
      expect(toggleSprint(false, 0)).toBe(false);
    });

    it('turning OFF always succeeds, regardless of remaining fuel', () => {
      expect(toggleSprint(true, 0)).toBe(false);
      expect(toggleSprint(true, SPRINT_FUEL_MAX)).toBe(false);
    });
  });

  it('end-to-end: toggle on, drain to empty, forced off, then regen back up', () => {
    let state = initialSprintState(4); // cap 4, so drain rate 1/s empties it in 4s
    state.active = toggleSprint(state.active, state.fuel);
    expect(state.active).toBe(true);

    for (let i = 0; i < 4; i++) state = updateSprintFuel(state, 1, { cap: 4 });
    expect(state.fuel).toBe(0);
    expect(state.active).toBe(false); // forced off at empty

    // Can't re-toggle on immediately at 0 fuel.
    expect(toggleSprint(state.active, state.fuel)).toBe(false);

    // Regenerate a bit, then re-toggle succeeds.
    state = updateSprintFuel(state, 1, { cap: 4 });
    expect(state.fuel).toBeGreaterThan(0);
    state.active = toggleSprint(state.active, state.fuel);
    expect(state.active).toBe(true);
  });
});
