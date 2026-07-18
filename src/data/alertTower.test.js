import { describe, it, expect } from 'vitest';
import { makeAlertState, tickAlertTower, ALERT_COUNTDOWN_MS, ALERT_DETECT_RADIUS } from './alertTower.js';

describe('alert tower countdown state machine (#269 §5)', () => {
  it('starts idle, not counting down, full countdown remaining', () => {
    const s = makeAlertState();
    expect(s.countingDown).toBe(false);
    expect(s.remainingMs).toBe(ALERT_COUNTDOWN_MS);
    expect(s.triggered).toBe(false);
  });

  it('out of range stays idle (no-op)', () => {
    const s = makeAlertState();
    const s1 = tickAlertTower(s, { inRange: false, dt: 1 });
    expect(s1.countingDown).toBe(false);
    expect(s1.triggered).toBe(false);
  });

  it('in range starts counting down and remainingMs decreases', () => {
    const s = makeAlertState();
    const s1 = tickAlertTower(s, { inRange: true, dt: 1 });
    expect(s1.countingDown).toBe(true);
    expect(s1.remainingMs).toBeLessThan(ALERT_COUNTDOWN_MS);
    expect(s1.triggered).toBe(false);
  });

  it('completes the countdown and triggers once remainingMs hits 0', () => {
    let s = makeAlertState(1000);
    s = tickAlertTower(s, { inRange: true, dt: 0.6 }, 1000);
    expect(s.triggered).toBe(false);
    s = tickAlertTower(s, { inRange: true, dt: 0.6 }, 1000);
    expect(s.triggered).toBe(true);
    expect(s.remainingMs).toBe(0);
  });

  it('leaving range before completion resets the countdown to idle (no partial credit)', () => {
    let s = makeAlertState(1000);
    s = tickAlertTower(s, { inRange: true, dt: 0.8 }, 1000);
    expect(s.remainingMs).toBeLessThan(1000);
    s = tickAlertTower(s, { inRange: false, dt: 0.1 }, 1000);
    expect(s.countingDown).toBe(false);
    expect(s.remainingMs).toBe(1000);
    expect(s.triggered).toBe(false);
  });

  it('a triggered state is terminal — further ticks are a no-op', () => {
    let s = makeAlertState(100);
    s = tickAlertTower(s, { inRange: true, dt: 1 }, 100);
    expect(s.triggered).toBe(true);
    const again = tickAlertTower(s, { inRange: false, dt: 5 }, 100);
    expect(again).toEqual(s);
  });

  it('tick never mutates the input state object', () => {
    const s = makeAlertState();
    const snapshot = { ...s };
    tickAlertTower(s, { inRange: true, dt: 1 });
    expect(s).toEqual(snapshot);
  });

  it('ALERT_DETECT_RADIUS is a sane positive px value', () => {
    expect(ALERT_DETECT_RADIUS).toBeGreaterThan(0);
  });

  // #269 playtest follow-up: `fraction` is the "how close to completion" number the scene-side
  // visual/audio escalation (bases.js `_updateAlertTowers`) drives its pulsing ring + quickening
  // beep from — 0 at idle/start, monotonically increasing toward 1 as the countdown completes.
  describe('fraction (spool-up progress, #269 playtest follow-up)', () => {
    it('starts at 0 in a fresh idle state', () => {
      const s = makeAlertState();
      expect(s.fraction).toBe(0);
    });

    it('increases monotonically toward 1 as the countdown ticks toward completion', () => {
      let s = makeAlertState(1000);
      let prev = s.fraction;
      for (let i = 0; i < 5; i++) {
        s = tickAlertTower(s, { inRange: true, dt: 0.15 }, 1000);
        expect(s.fraction).toBeGreaterThanOrEqual(prev);
        prev = s.fraction;
      }
    });

    it('reaches exactly 1 the instant the countdown triggers', () => {
      let s = makeAlertState(500);
      s = tickAlertTower(s, { inRange: true, dt: 1 }, 500);
      expect(s.triggered).toBe(true);
      expect(s.fraction).toBe(1);
    });

    it('resets to 0 when the player leaves range before completion (cancel signal)', () => {
      let s = makeAlertState(1000);
      s = tickAlertTower(s, { inRange: true, dt: 0.8 }, 1000);
      expect(s.fraction).toBeGreaterThan(0);
      s = tickAlertTower(s, { inRange: false, dt: 0.1 }, 1000);
      expect(s.fraction).toBe(0);
    });
  });
});
