// #294 — tank turning-feel fixes: (1) the hull commits to a movement heading for a beat instead
// of re-targeting every frame, and (2) the turret gets knocked off-target by a jolt when the
// hull commits to a new heading, re-settling over subsequent frames via its normal turretSlew
// correction (rather than staying perfectly world-locked through the hull's own reorientation).
//
// enemyBehaviors.js imports Phaser only for `Phaser.Math.Angle.Wrap` — stub it out the same way
// the other arena test files do (dormantWake.test.js / mutualCollision.test.js) so this runs
// under vitest's node env without a real Phaser device-detection pass.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { ENEMY_BEHAVIORS } from './enemyBehaviors.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';

const tankBehavior = ENEMY_BEHAVIORS.tank;

// A minimal scene stub: enemyFire on, LOS always clear, and a spy standing in for
// `_fireVehicleWeapon` so tests can assert whether a shot was actually taken this tick.
function makeScene() {
  return {
    enemyFire: true,
    _cachedLosToPlayer: () => true,
    _fireVehicleWeapon: vi.fn(),
  };
}

// A freshly-spawned tank record, shaped like `_spawnKind` builds one (minus the Phaser view).
function makeTank({ angle = 0, turret = 0 } = {}) {
  return {
    kind: 'tank', kindDef: ENEMY_KINDS.tank, x: 0, y: 0, vx: 0, vy: 0,
    angle, turret, handed: 1,
  };
}

// Builds the per-frame ctx a behavior fn expects (see enemyBehaviors.js's header comment).
// `bearing` is also used as ux/uy's angle for simplicity (player straight out along `bearing`).
function makeCtx({ dt = 0.016, delta = 16, dist = 1000, bearing = 0 } = {}) {
  return {
    dt, delta, dxp: Math.cos(bearing) * dist, dyp: Math.sin(bearing) * dist,
    dist, bearing, ux: Math.cos(bearing), uy: Math.sin(bearing),
  };
}

describe('tankBehavior — heading commit (#294: "turns too often/too smoothly")', () => {
  it('holds the same committed movement direction across frames within the commit window, even as the bearing to the player keeps drifting', () => {
    const scene = makeScene();
    const e = makeTank();
    // First tick always computes a heading (e._heading starts null).
    tankBehavior(scene, e, makeCtx({ bearing: 0 }));
    const firstHeading = e._heading;
    expect(firstHeading).toBeTruthy();
    // Drastically different bearing on every subsequent tick (as if orbiting fast) — if the
    // fix weren't in place, tankMoveIntent would recompute a new mx/my every single frame.
    for (let i = 1; i <= 10; i++) {
      tankBehavior(scene, e, makeCtx({ bearing: (i * Math.PI) / 5, dist: 380 }));
    }
    // Held steady: still the exact same intent object, not recomputed each frame.
    expect(e._heading).toBe(firstHeading);
  });

  it('recomputes the heading once the commit window elapses, picking up the changed situation', () => {
    const scene = makeScene();
    const e = makeTank();
    tankBehavior(scene, e, makeCtx({ dist: 380, bearing: 0 })); // advance (radial +1)
    const advancing = e._heading;
    expect(advancing.mx).toBeGreaterThan(0); // heading toward +x, i.e. toward the player

    // Flip to "very close" (triggers the reverse band) and tick past the max commit window
    // (650ms * 1.25 = 812.5ms) in coarse steps so we don't depend on the exact jittered value.
    let elapsed = 0;
    let sawReverse = false;
    while (elapsed < 1000) {
      tankBehavior(scene, e, makeCtx({ dt: 0.05, delta: 50, dist: 50, bearing: 0 }));
      elapsed += 50;
      if (e._heading !== advancing && e._heading.mx < 0) { sawReverse = true; break; }
    }
    expect(sawReverse).toBe(true);
  });
});

describe('tankBehavior — turret drag on heading commit (#294 follow-up: "turret stays perfect on target")', () => {
  it('does not jolt the turret on the very first heading commit (no prior heading to swing from)', () => {
    const scene = makeScene();
    const e = makeTank({ turret: 0 });
    tankBehavior(scene, e, makeCtx({ bearing: 0, dist: 380 }));
    // Nothing to have knocked it off yet — it should fire on the very first tick.
    expect(scene._fireVehicleWeapon).toHaveBeenCalledTimes(1);
  });

  it('knocks the turret off the on-target gate the instant a new heading commit swings the '
    + 'desired direction sharply, then re-settles and resumes firing within a handful of frames', () => {
    const scene = makeScene();
    const e = makeTank({ turret: 0 }); // starts exactly on-target (bearing is 0 throughout)
    // Commit an initial heading: player straight ahead (+x), tank advances toward it — fires
    // immediately since it starts on-target.
    tankBehavior(scene, e, makeCtx({ bearing: 0, dist: 380 }));
    expect(scene._fireVehicleWeapon).toHaveBeenCalledTimes(1);
    scene._fireVehicleWeapon.mockClear();

    // Switch to point-blank range (triggers tankMoveIntent's reverse band, radial -0.8 instead
    // of advance's +1 — very nearly the opposite travel direction) so the NEXT committed
    // heading swings sharply, while the player bearing itself stays fixed at 0 throughout
    // (isolates the turret jolt from aimAndFire's own bearing-tracking, whose target never
    // moves). Tick with ORDINARY per-frame dt/delta (realistic — no single frame is actually
    // ~1s long) until the heading commit window elapses and a new heading is chosen.
    let recommitTick = -1;
    for (let i = 0; i < 80 && recommitTick < 0; i++) {
      const before = e._heading;
      tankBehavior(scene, e, makeCtx({ dt: 0.016, delta: 16, bearing: 0, dist: 50 }));
      if (e._heading !== before) recommitTick = i;
    }
    expect(recommitTick).toBeGreaterThanOrEqual(0); // the commit window did elapse within 80 frames

    // On every ordinary frame BEFORE the recommit, the turret was already on bearing 0 with
    // nothing to knock it off, so it kept firing each tick.
    expect(scene._fireVehicleWeapon.mock.calls.length).toBe(recommitTick);

    // The recommit tick itself is the one where the swing jolts the turret — firing must NOT
    // have happened on that specific tick (still off-target the instant the jolt lands).
    expect(scene._fireVehicleWeapon.mock.calls.length).toBe(recommitTick); // unchanged by the jolt tick
    scene._fireVehicleWeapon.mockClear();

    // Ordinary frames after the jolt — turretSlew (2.2 rad/s) should walk the turret back onto
    // bearing 0 within a handful of frames, and firing resumes.
    let refired = false;
    for (let i = 0; i < 60; i++) {
      tankBehavior(scene, e, makeCtx({ dt: 0.016, delta: 16, bearing: 0, dist: 380 }));
      if (scene._fireVehicleWeapon.mock.calls.length > 0) { refired = true; break; }
    }
    expect(refired).toBe(true);
  });
});
