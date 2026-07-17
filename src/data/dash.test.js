import { describe, it, expect } from 'vitest';
import {
  initialDashState, canDash, triggerDash, updateDash,
  DASH_SPEED_MULT, DASH_BURST_DURATION, DASH_COOLDOWN,
} from './dash.js';

describe('Dash (#261) — single-shot burst + cooldown state machine', () => {
  it('starts inactive, no burst, ready immediately (no cooldown)', () => {
    const s = initialDashState();
    expect(s.active).toBe(false);
    expect(s.burstRemaining).toBe(0);
    expect(s.cooldown).toBe(0);
    expect(canDash(s)).toBe(true);
  });

  describe('triggerDash', () => {
    it('activates the burst and stamps the cooldown when ready', () => {
      const state = triggerDash(initialDashState());
      expect(state.active).toBe(true);
      expect(state.burstRemaining).toBe(DASH_BURST_DURATION);
      expect(state.cooldown).toBe(DASH_COOLDOWN);
    });

    it('is a no-op (returns the SAME state) while already mid-burst', () => {
      const active = { active: true, burstRemaining: 0.1, cooldown: 3 };
      const result = triggerDash(active);
      expect(result).toBe(active);   // identity: untouched, not just equal
    });

    it('is a no-op while still on cooldown after the burst has ended', () => {
      const cooling = { active: false, burstRemaining: 0, cooldown: 2.5 };
      const result = triggerDash(cooling);
      expect(result).toBe(cooling);
    });

    it('can be re-triggered the instant cooldown hits exactly 0', () => {
      const ready = { active: false, burstRemaining: 0, cooldown: 0 };
      const result = triggerDash(ready);
      expect(result.active).toBe(true);
    });

    it('respects a custom cooldown/burstDuration config', () => {
      const state = triggerDash(initialDashState(), { cooldown: 1, burstDuration: 0.05 });
      expect(state.burstRemaining).toBe(0.05);
      expect(state.cooldown).toBe(1);
    });
  });

  describe('updateDash', () => {
    it('counts the burst down while active, ending it exactly at 0', () => {
      let state = triggerDash(initialDashState());
      state = updateDash(state, DASH_BURST_DURATION / 2);
      expect(state.active).toBe(true);
      expect(state.burstRemaining).toBeCloseTo(DASH_BURST_DURATION / 2, 5);

      state = updateDash(state, DASH_BURST_DURATION / 2);
      expect(state.active).toBe(false);
      expect(state.burstRemaining).toBe(0);
    });

    it('a large dt cannot leave burstRemaining negative', () => {
      let state = triggerDash(initialDashState());
      state = updateDash(state, 100);
      expect(state.active).toBe(false);
      expect(state.burstRemaining).toBe(0);
    });

    it('counts the cooldown down after the burst ends, cannot go negative', () => {
      let state = triggerDash(initialDashState());
      state = updateDash(state, DASH_BURST_DURATION); // burst just ended
      expect(state.active).toBe(false);
      expect(state.cooldown).toBeCloseTo(DASH_COOLDOWN - DASH_BURST_DURATION, 5);

      state = updateDash(state, 1000); // way more than remains
      expect(state.cooldown).toBe(0);
    });

    it('cannot be re-triggered until the cooldown fully elapses', () => {
      let state = triggerDash(initialDashState());
      state = updateDash(state, DASH_COOLDOWN - 0.01);
      expect(canDash(state)).toBe(false);
      expect(triggerDash(state)).toBe(state);   // still refused

      state = updateDash(state, 0.02);
      expect(canDash(state)).toBe(true);
      expect(triggerDash(state).active).toBe(true);
    });
  });

  it('end-to-end: trigger, burst runs out, cooldown ticks down, then it is ready again', () => {
    let state = initialDashState();
    expect(canDash(state)).toBe(true);

    state = triggerDash(state);
    expect(state.active).toBe(true);

    // Advance in small steps through the whole cooldown window.
    let elapsed = 0;
    while (elapsed < DASH_COOLDOWN + 0.1) {
      state = updateDash(state, 0.05);
      elapsed += 0.05;
    }
    expect(state.active).toBe(false);
    expect(state.cooldown).toBe(0);
    expect(canDash(state)).toBe(true);

    // And it can fire again from here.
    const again = triggerDash(state);
    expect(again.active).toBe(true);
  });

  it('DASH_SPEED_MULT is meaningfully stronger than Sprint\'s old 1.5x multiplier', () => {
    expect(DASH_SPEED_MULT).toBeGreaterThan(2);
  });
});
