// #188 (device split, per playtest feedback) — keyboard Space is HOLD-to-sprint while
// gamepad L3 stays press-to-TOGGLE. This exercises `FiringMixin._handleSprint`'s per-device
// branch directly (mirrors the fake-scene pattern in sprintOverclock.test.js), including how
// it interacts with #189 Overclock's forced-on window: a manual toggle press on gamepad
// always reclaims control (unchanged, see sprintOverclock.test.js); on keyboard, a CHANGE in
// the held state (press or release) is the equivalent reclaim — simply not touching Space
// during Overclock does not cancel the forced ride, but releasing it does turn Sprint off
// immediately even mid-Overclock, since "hold" has no discrete press to wait for the way a
// toggle does.
import { describe, it, expect } from 'vitest';
import { FiringMixin } from './firing.js';
import { initialSprintState } from '../../data/sprint.js';

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

describe('#188 keyboard hold-to-sprint (FiringMixin._handleSprint, mode: kbm)', () => {
  it('is active only while Space is held, off the instant it is released', () => {
    const scene = makeScene();
    scene._handleSprint({ mode: 'kbm', sprintHeld: true }, 16);
    expect(scene.sprint.active).toBe(true);

    scene._handleSprint({ mode: 'kbm', sprintHeld: true }, 16);
    expect(scene.sprint.active).toBe(true);   // still held: stays on

    scene._handleSprint({ mode: 'kbm', sprintHeld: false }, 16);
    expect(scene.sprint.active).toBe(false);  // released: off immediately
  });

  it('cannot start on an empty tank, and drains normally while held', () => {
    const scene = makeScene();
    scene.sprint.fuel = 0;
    scene._handleSprint({ mode: 'kbm', sprintHeld: true }, 16);
    expect(scene.sprint.active).toBe(false);   // refused — empty tank

    scene.sprint.fuel = 2;
    scene._handleSprint({ mode: 'kbm', sprintHeld: true }, 16);
    expect(scene.sprint.active).toBe(true);
    scene._handleSprint({ mode: 'kbm', sprintHeld: true }, 1000);
    expect(scene.sprint.fuel).toBeLessThan(2);   // drains like normal sprint
  });

  it('gamepad toggle semantics are untouched when mode is "pad"', () => {
    const scene = makeScene();
    scene._handleSprint({ mode: 'pad', sprintPressed: true }, 16);
    expect(scene.sprint.active).toBe(true);
    scene._handleSprint({ mode: 'pad', sprintPressed: false }, 16);
    expect(scene.sprint.active).toBe(true);   // no repeat toggle without a fresh press
    scene._handleSprint({ mode: 'pad', sprintPressed: true }, 16);
    expect(scene.sprint.active).toBe(false);  // second press toggles off
  });
});

describe('#188/#189 keyboard hold vs. Overclock\'s forced-on window', () => {
  it('not touching Space during Overclock does not cancel the forced ride', () => {
    const scene = makeScene({ overclockActive: true });
    scene._handleSprint({ mode: 'kbm', sprintHeld: false }, 16);   // rising edge forces on
    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(true);

    // Several more frames of NOT holding Space: state doesn't change, so no reclaim.
    scene._handleSprint({ mode: 'kbm', sprintHeld: false }, 1000);
    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(true);
    expect(scene.sprint.fuel).toBe(initialSprintState().fuel);   // still free — untouched
  });

  it('releasing Space mid-Overclock (after having held it) turns Sprint off immediately', () => {
    const scene = makeScene({ overclockActive: false });
    scene._handleSprint({ mode: 'kbm', sprintHeld: true }, 16);   // player is already holding
    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(false);

    scene._overclockActive = true;   // Overclock kicks in while already held — no interruption
    scene._handleSprint({ mode: 'kbm', sprintHeld: true }, 1000);
    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(true);   // now free-riding on Overclock
    const fuelDuringOverclock = scene.sprint.fuel;

    scene._handleSprint({ mode: 'kbm', sprintHeld: false }, 16);   // player releases Space
    expect(scene.sprint.active).toBe(false);   // off immediately, even though Overclock is
    expect(scene._sprintForcedByOverclock).toBe(false);   // still nominally active
    // No drain on the release frame itself — regen may have ticked a hair, but fuel must not
    // have dropped (which would mean it kept draining after release).
    expect(scene.sprint.fuel).toBeGreaterThanOrEqual(fuelDuringOverclock);
  });

  it('re-pressing Space after reclaiming resumes normal (fuel-costing) hold-sprint', () => {
    const scene = makeScene({ overclockActive: true });
    scene._handleSprint({ mode: 'kbm', sprintHeld: false }, 16);   // Overclock forces on
    expect(scene.sprint.active).toBe(true);

    scene._handleSprint({ mode: 'kbm', sprintHeld: true }, 16);   // press: reclaims + stays on
    expect(scene.sprint.active).toBe(true);
    expect(scene._sprintForcedByOverclock).toBe(false);

    const fuelBefore = scene.sprint.fuel;
    scene._handleSprint({ mode: 'kbm', sprintHeld: true }, 1000);   // still "during" Overclock
    expect(scene.sprint.fuel).toBeLessThan(fuelBefore);   // draining normally now, no free lunch
  });

  it('Overclock expiring after the player never touched Space hands control back off, same as the toggle case', () => {
    const scene = makeScene({ overclockActive: true });
    scene._handleSprint({ mode: 'kbm', sprintHeld: false }, 16);   // forced on
    expect(scene.sprint.active).toBe(true);

    scene._overclockActive = false;   // buff window ends
    scene._handleSprint({ mode: 'kbm', sprintHeld: false }, 16);
    expect(scene.sprint.active).toBe(false);
    expect(scene._sprintForcedByOverclock).toBe(false);
  });
});
