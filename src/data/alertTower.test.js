import { describe, it, expect } from 'vitest';
import { makeAlertState, tickAlertTower, ALERT_COUNTDOWN_MS, ALERT_DETECT_RADIUS } from './alertTower.js';

describe('alert tower countdown state machine (#269 §5)', () => {
  it('starts idle, not counting down, full countdown remaining', () => {
    const s = makeAlertState();
    expect(s.countingDown).toBe(false);
    expect(s.remainingMs).toBe(ALERT_COUNTDOWN_MS);
    expect(s.triggered).toBe(false);
  });

  it('not activated stays idle (no-op)', () => {
    const s = makeAlertState();
    const s1 = tickAlertTower(s, { activate: false, dt: 1 });
    expect(s1.countingDown).toBe(false);
    expect(s1.triggered).toBe(false);
    expect(s1).toBe(s);   // identity return when still idle — nothing changed
  });

  it('activating starts counting down and remainingMs decreases', () => {
    const s = makeAlertState();
    const s1 = tickAlertTower(s, { activate: true, dt: 1 });
    expect(s1.countingDown).toBe(true);
    expect(s1.remainingMs).toBeLessThan(ALERT_COUNTDOWN_MS);
    expect(s1.triggered).toBe(false);
  });

  it('completes the countdown and triggers once remainingMs hits 0', () => {
    let s = makeAlertState(1000);
    s = tickAlertTower(s, { activate: true, dt: 0.6 }, 1000);
    expect(s.triggered).toBe(false);
    s = tickAlertTower(s, { activate: true, dt: 0.6 }, 1000);
    expect(s.triggered).toBe(true);
    expect(s.remainingMs).toBe(0);
  });

  // #269 overhaul: STICKY countdown — once started it never resets, even if the activation signal
  // goes false again (player leaves range, gunshot goes stale, etc.). Only tower destruction
  // (scene-side state drop) stops it — this module has no cancel path at all.
  it('once started, the countdown does NOT reset when activate goes false — it keeps counting', () => {
    let s = makeAlertState(1000);
    s = tickAlertTower(s, { activate: true, dt: 0.3 }, 1000);
    const afterStart = s.remainingMs;
    expect(afterStart).toBeLessThan(1000);
    // activate false now — old behavior reset to idle; sticky behavior keeps decrementing.
    s = tickAlertTower(s, { activate: false, dt: 0.3 }, 1000);
    expect(s.countingDown).toBe(true);
    expect(s.remainingMs).toBeLessThan(afterStart);
    expect(s.triggered).toBe(false);
  });

  it('a countdown started by one trigger completes even if activate is false for every later tick', () => {
    let s = makeAlertState(1000);
    s = tickAlertTower(s, { activate: true, dt: 0.1 }, 1000);   // one activation frame commits it
    // ...then never activated again, but it still counts all the way down and fires.
    for (let i = 0; i < 20 && !s.triggered; i++) s = tickAlertTower(s, { activate: false, dt: 0.1 }, 1000);
    expect(s.triggered).toBe(true);
    expect(s.remainingMs).toBe(0);
  });

  it('a triggered state is terminal — further ticks are a no-op', () => {
    let s = makeAlertState(100);
    s = tickAlertTower(s, { activate: true, dt: 1 }, 100);
    expect(s.triggered).toBe(true);
    const again = tickAlertTower(s, { activate: false, dt: 5 }, 100);
    expect(again).toEqual(s);
  });

  it('tick never mutates the input state object', () => {
    const s = makeAlertState();
    const snapshot = { ...s };
    tickAlertTower(s, { activate: true, dt: 1 });
    expect(s).toEqual(snapshot);
  });

  it('ALERT_DETECT_RADIUS is a sane positive px value', () => {
    expect(ALERT_DETECT_RADIUS).toBeGreaterThan(0);
  });

  // #269 overhaul: Jackson asked for a meaningfully larger activation envelope (was 320px). Pin a
  // floor so an accidental revert back toward the old tight radius fails loudly.
  it('ALERT_DETECT_RADIUS is the bumped, larger envelope (well past the old 320px)', () => {
    expect(ALERT_DETECT_RADIUS).toBeGreaterThanOrEqual(450);
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
        s = tickAlertTower(s, { activate: true, dt: 0.15 }, 1000);
        expect(s.fraction).toBeGreaterThanOrEqual(prev);
        prev = s.fraction;
      }
    });

    it('reaches exactly 1 the instant the countdown triggers', () => {
      let s = makeAlertState(500);
      s = tickAlertTower(s, { activate: true, dt: 1 }, 500);
      expect(s.triggered).toBe(true);
      expect(s.fraction).toBe(1);
    });

    // #269 overhaul: no cancel path — fraction keeps climbing after activate goes false, it does
    // not reset to 0 (that was the old stealth-window behavior, now removed).
    it('does NOT reset to 0 when activate goes false — it keeps climbing (sticky)', () => {
      let s = makeAlertState(1000);
      s = tickAlertTower(s, { activate: true, dt: 0.4 }, 1000);
      const after = s.fraction;
      expect(after).toBeGreaterThan(0);
      s = tickAlertTower(s, { activate: false, dt: 0.1 }, 1000);
      expect(s.fraction).toBeGreaterThanOrEqual(after);
    });
  });
});
