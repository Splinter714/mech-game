// #189 — Overclock redesign: instead of a flat moveMult/slewMult buff, Overclock now
// force-activates Sprint (fuel-free) for its whole duration. This exercises the state
// machine in `FiringMixin._handleSprint` (arena/firing.js) directly against a minimal fake
// scene (mirrors the pattern in crush.test.js/vehicleFire.test.js), since the real thing is
// a Phaser-scene mixin method that reads `this.sprint`/`this._buffMods()`/`this.registry`.
//
// State-machine contract under test (see the comment above `_handleSprint` for the full
// reasoning): `this._sprintForcedByOverclock` tracks whether the CURRENT sprint-active state
// is "because Overclock is holding it on" vs. the player's own manual toggle.
//   - Overclock's rising edge force-activates Sprint, fuel-free, regardless of prior state.
//   - A manual toggle press ALWAYS wins immediately, even mid-Overclock (pressing while
//     forced-on reads as "turn it off"), and hands back normal fuel rules from that exact
//     frame — no waiting for Overclock's own expiry.
//   - If Overclock expires while it still owns the state (no manual press reclaimed it),
//     Sprint is handed back off, exactly as if Overclock had never touched it.
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

describe('#189 Overclock force-activates Sprint (FiringMixin._handleSprint)', () => {
  it('force-activates Sprint the instant Overclock goes active, even with an empty tank', () => {
    const scene = makeScene({ overclockActive: false });
    scene.sprint.fuel = 0;   // player couldn't have manually toggled on right now
    expect(scene.sprint.active).toBe(false);

    scene._overclockActive = true;   // Overclock just picked up
    scene._handleSprint({ sprintPressed: false }, 16);

    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(true);
  });

  it('does not drain fuel while Overclock is the one holding Sprint on', () => {
    const scene = makeScene({ overclockActive: true });
    const startFuel = scene.sprint.fuel;
    scene._handleSprint({ sprintPressed: false }, 16);   // rising edge: force on
    expect(scene.sprint.active).toBe(true);

    for (let i = 0; i < 60; i++) scene._handleSprint({ sprintPressed: false }, 1000);  // 60s of frames
    expect(scene.sprint.active).toBe(true);
    expect(scene.sprint.fuel).toBe(startFuel);   // untouched — free ride the whole time
  });

  it('expiry with no manual toggle hands Sprint back OFF, exactly as if Overclock never touched it', () => {
    const scene = makeScene({ overclockActive: true });
    scene.sprint.fuel = 1;   // partial tank, so we can observe regen resuming below
    scene._handleSprint({ sprintPressed: false }, 16);   // Overclock forces it on
    expect(scene.sprint.active).toBe(true);
    expect(scene.sprint.fuel).toBe(1);   // frozen — Overclock's free ride, no drain

    scene._overclockActive = false;   // Overclock's duration ends
    scene._handleSprint({ sprintPressed: false }, 16);

    expect(scene.sprint.active).toBe(false);
    expect(scene._sprintForcedByOverclock).toBe(false);
    // Normal Sprint rules apply from here — fuel regenerates like it was never forced at all.
    const fuelAfter = scene.sprint.fuel;
    scene._handleSprint({ sprintPressed: false }, 1000);
    expect(scene.sprint.fuel).toBeGreaterThan(fuelAfter);
  });

  it('a manual toggle-OFF press mid-Overclock is respected — Sprint goes off and STAYS off even though the buff is still nominally active', () => {
    const scene = makeScene({ overclockActive: true });
    scene._handleSprint({ sprintPressed: false }, 16);   // Overclock forces it on
    expect(scene.sprint.active).toBe(true);

    scene._handleSprint({ sprintPressed: true }, 16);    // player explicitly presses the toggle
    expect(scene.sprint.active).toBe(false);
    expect(scene._sprintForcedByOverclock).toBe(false);   // manual ownership reclaimed

    // Overclock is STILL active (buff hasn't expired) but must not re-force Sprint back on.
    scene._handleSprint({ sprintPressed: false }, 1000);
    expect(scene.sprint.active).toBe(false);
    scene._handleSprint({ sprintPressed: false }, 5000);
    expect(scene.sprint.active).toBe(false);

    // Even once Overclock's window later actually ends, nothing changes — it already lost
    // ownership, so there's no forced-off transition left to apply.
    scene._overclockActive = false;
    scene._handleSprint({ sprintPressed: false }, 16);
    expect(scene.sprint.active).toBe(false);
  });

  it('manually keeping Sprint on past Overclock\'s expiry resumes normal fuel drain immediately — no free lunch', () => {
    const scene = makeScene({ overclockActive: true });
    scene._handleSprint({ sprintPressed: false }, 16);   // Overclock forces it on, fuel-free
    // Player explicitly toggles: OFF then back ON — takes manual ownership while Overclock is
    // still active, so from here Sprint is normal/fuel-costing, not free, even though the
    // Overclock buff is still nominally running.
    scene._handleSprint({ sprintPressed: true }, 16);   // manual off
    expect(scene.sprint.active).toBe(false);
    scene._handleSprint({ sprintPressed: true }, 16);   // manual back on (fuel is available)
    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(false);

    const fuelBeforeDrain = scene.sprint.fuel;
    scene._handleSprint({ sprintPressed: false }, 1000);   // 1s of sprinting, still "during" Overclock
    expect(scene.sprint.fuel).toBeLessThan(fuelBeforeDrain);   // draining normally, no free ride

    // Overclock's window ends later — no discontinuity, sprint was already fully manual.
    scene._overclockActive = false;
    const fuelAtExpiry = scene.sprint.fuel;
    scene._handleSprint({ sprintPressed: false }, 1000);
    expect(scene.sprint.active).toBe(true);           // still on — player's own choice, untouched
    expect(scene.sprint.fuel).toBeLessThan(fuelAtExpiry);   // drain continues seamlessly
  });

  it('Overclock activating while the player was ALREADY manually sprinting just takes over as fuel-free (no interruption)', () => {
    const scene = makeScene({ overclockActive: false });
    scene._handleSprint({ sprintPressed: true }, 16);   // manual toggle on
    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(false);
    const fuelBefore = scene.sprint.fuel;

    scene._overclockActive = true;   // Overclock picked up mid-manual-sprint
    scene._handleSprint({ sprintPressed: false }, 1000);
    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(true);
    expect(scene.sprint.fuel).toBe(fuelBefore);   // now free — Overclock owns it

    scene._overclockActive = false;   // expires — player never re-pressed, so hand back off
    scene._handleSprint({ sprintPressed: false }, 16);
    expect(scene.sprint.active).toBe(false);
  });
});
