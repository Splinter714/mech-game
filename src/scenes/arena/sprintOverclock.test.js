// #189 — Overclock redesign: instead of a flat moveMult/slewMult buff, Overclock
// force-activates Sprint (fuel-free) for its whole duration. #261 removed the PLAYER's own
// means of triggering Sprint (L3/Space now triggers a Dash instead, see dash.test.js /
// dashTrigger.test.js) — Overclock's force-activation is now the ONLY way Sprint's `active`
// flag is ever set, so this file is trimmed down to just that contract: does Overclock still
// force it on, keep it fuel-free, and hand it back off cleanly at expiry. The manual-reclaim/
// toggle-vs-hold cases from the old device-split test suite no longer apply — there's no
// player input path left to reclaim control from Overclock.
//
// This exercises the state machine in `FiringMixin._handleSprint` (arena/firing.js) directly
// against a minimal fake scene (mirrors the pattern in crush.test.js/vehicleFire.test.js), since
// the real thing is a Phaser-scene mixin method that reads `this.sprint`/`this._buffMods()`/
// `this.registry`.
import { describe, it, expect } from 'vitest';
import { FiringMixin } from './firing.js';
import { initialSprintState } from '../../data/sprint.js';

// A minimal fake ArenaScene: just enough state for `_handleSprint` to run against.
// `overclockActive` is a controllable flag the fake `_buffMods()` reads, so tests can drive
// Overclock's active window directly without going through the full powerup pickup/countdown
// pipeline (that pipeline itself is exercised in data/powerups.test.js).
function makeScene({ overclockActive = false } = {}) {
  const scene = {
    sprint: initialSprintState(),
    _sprintForcedByOverclock: false,
    _overclockWasActive: false,
    _overclockActive: overclockActive,
    _buffMods() { return { overclockActive: this._overclockActive }; },
    registry: { set() {} },
  };
  Object.assign(scene, FiringMixin);
  return scene;
}

describe('#189 Overclock force-activates Sprint (FiringMixin._handleSprint), player-trigger removed by #261', () => {
  it('force-activates Sprint the instant Overclock goes active, even with an empty tank', () => {
    const scene = makeScene({ overclockActive: false });
    scene.sprint.fuel = 0;   // no player-manual path could have turned it on anyway (#261)
    expect(scene.sprint.active).toBe(false);

    scene._overclockActive = true;   // Overclock just picked up
    scene._handleSprint({}, 16);

    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(true);
  });

  it('does not drain fuel while Overclock is the one holding Sprint on', () => {
    const scene = makeScene({ overclockActive: true });
    const startFuel = scene.sprint.fuel;
    scene._handleSprint({}, 16);   // rising edge: force on
    expect(scene.sprint.active).toBe(true);

    for (let i = 0; i < 60; i++) scene._handleSprint({}, 1000);  // 60s of frames
    expect(scene.sprint.active).toBe(true);
    expect(scene.sprint.fuel).toBe(startFuel);   // untouched — free ride the whole time
  });

  it('expiry hands Sprint back OFF, exactly as if Overclock never touched it, and fuel resumes regenerating normally', () => {
    const scene = makeScene({ overclockActive: true });
    scene.sprint.fuel = 1;   // partial tank, so we can observe regen resuming below
    scene._handleSprint({}, 16);   // Overclock forces it on
    expect(scene.sprint.active).toBe(true);
    expect(scene.sprint.fuel).toBe(1);   // frozen — Overclock's free ride, no drain

    scene._overclockActive = false;   // Overclock's duration ends
    scene._handleSprint({}, 16);

    expect(scene.sprint.active).toBe(false);
    expect(scene._sprintForcedByOverclock).toBe(false);
    // Normal Sprint rules apply from here — fuel regenerates like it was never forced at all.
    const fuelAfter = scene.sprint.fuel;
    scene._handleSprint({}, 1000);
    expect(scene.sprint.fuel).toBeGreaterThan(fuelAfter);
  });

  it('re-activating Overclock later force-activates Sprint again from a clean, off state', () => {
    const scene = makeScene({ overclockActive: true });
    scene._handleSprint({}, 16);
    expect(scene.sprint.active).toBe(true);

    scene._overclockActive = false;
    scene._handleSprint({}, 16);
    expect(scene.sprint.active).toBe(false);

    scene._overclockActive = true;   // picked up again later in the run
    scene._handleSprint({}, 16);
    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(true);
  });

  it('does not re-force Sprint on merely because Overclock is still nominally active, once already handed off', () => {
    const scene = makeScene({ overclockActive: true });
    scene._handleSprint({}, 16);         // rising edge: force on
    scene._overclockActive = false;
    scene._handleSprint({}, 16);         // expiry: hand off
    expect(scene.sprint.active).toBe(false);

    // No new rising edge — Overclock never goes active again — so nothing should re-trigger it.
    scene._handleSprint({}, 1000);
    expect(scene.sprint.active).toBe(false);
  });
});
