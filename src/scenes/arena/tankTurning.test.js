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

import Phaser from 'phaser';
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

// #295 ("tanks still feel like they're kinda sliding around as they turn... they start moving in
// a direction and the turning kinda happens to match in response instead of turning and THEN
// moving"): thrust must be applied ALONG the hull's current facing (e.angle), gated by how well
// that facing aligns with the desired heading — not toward the raw desired direction (mx, my)
// the way it used to be. These tests exercise the thrust/alignment side specifically, leaving the
// heading-commit and turret-drag mechanics (#294, tested above) untouched.
describe('tankBehavior — thrust follows hull alignment, not raw desired direction (#295)', () => {
  const mv = ENEMY_KINDS.tank.move;

  it('produces near-zero speed when the hull faces significantly away from the desired heading', () => {
    const scene = makeScene();
    // Hull faces due west; the player (and so the desired advance heading) is due east — roughly
    // a 180 degree mismatch, well past the 90 degree cutoff where alignment clamps to zero.
    const e = makeTank({ angle: Math.PI });
    tankBehavior(scene, e, makeCtx({ bearing: 0, dist: 380 }));
    // The old bug would have driven e.vx/e.vy straight toward the desired direction (mx*maxSpeed
    // ~ +x) regardless of hull facing; the fix must NOT do that — speed stays near zero instead of
    // sliding off toward +x at any real fraction of maxSpeed.
    expect(Math.hypot(e.vx, e.vy)).toBeLessThan(mv.maxSpeed * 0.1);
  });

  it('drives at full speed once the hull IS aligned with the desired heading', () => {
    const scene = makeScene();
    // Hull already faces roughly where the advance heading points (~+x, given the small strafe
    // component) — should ramp all the way up to maxSpeed over a few accel-limited ticks.
    const e = makeTank({ angle: 0 });
    let peakSpeed = 0;
    for (let i = 0; i < 60; i++) {
      tankBehavior(scene, e, makeCtx({ dt: 0.016, delta: 16, bearing: 0, dist: 380 }));
      peakSpeed = Math.max(peakSpeed, Math.hypot(e.vx, e.vy));
    }
    expect(peakSpeed).toBeGreaterThan(mv.maxSpeed * 0.9);
  });

  it('turns the hull before ramping velocity back up when it commits to a sharply different heading', () => {
    const scene = makeScene();
    const e = makeTank({ angle: 0 });
    // Get the tank up to full speed, hull aligned, cruising toward the player (advance band).
    for (let i = 0; i < 60; i++) {
      tankBehavior(scene, e, makeCtx({ dt: 0.016, delta: 16, bearing: 0, dist: 380 }));
    }
    const speedCruising = Math.hypot(e.vx, e.vy);
    const angleCruising = e.angle;
    expect(speedCruising).toBeGreaterThan(mv.maxSpeed * 0.9);

    // Force a sharply different desired heading: point-blank range trips tankMoveIntent's reverse
    // band (radial -0.8 instead of advance's +1), swinging the desired heading ~150+ degrees from
    // where the hull is currently pointed. Tick with ordinary per-frame dt until the next commit
    // window elapses and the new heading actually lands.
    let recommitTick = -1;
    for (let i = 0; i < 80 && recommitTick < 0; i++) {
      const before = e._heading;
      tankBehavior(scene, e, makeCtx({ dt: 0.016, delta: 16, bearing: 0, dist: 50 }));
      if (e._heading !== before) recommitTick = i;
    }
    expect(recommitTick).toBeGreaterThanOrEqual(0);

    // The instant the new (sharply different) heading commits, the hull has barely begun turning
    // toward it — alignment collapses and speed starts bleeding off immediately.
    const speedAtRecommit = Math.hypot(e.vx, e.vy);
    const angleAtRecommit = e.angle;
    expect(angleAtRecommit).not.toBe(angleCruising); // hull has already started rotating

    // A further short stretch of frames: the hull keeps turning (visibly, in real angle terms)
    // while speed keeps dropping — turning happens BEFORE the velocity ramps back up, not
    // simultaneously with a slide in the new direction.
    let angleAfterDip = angleAtRecommit;
    let speedAfterDip = speedAtRecommit;
    for (let i = 0; i < 15; i++) {
      tankBehavior(scene, e, makeCtx({ dt: 0.016, delta: 16, bearing: 0, dist: 50 }));
      angleAfterDip = e.angle;
      speedAfterDip = Math.hypot(e.vx, e.vy);
    }
    const rotatedSoFar = Math.abs(Phaser.Math.Angle.Wrap(angleAfterDip - angleCruising));
    expect(rotatedSoFar).toBeGreaterThan(0.15); // hull has visibly rotated toward the new heading
    expect(speedAfterDip).toBeLessThan(speedCruising * 0.6); // and speed has meaningfully dropped

    // Given many more frames, the hull finishes turning onto the new heading and speed climbs
    // back up toward maxSpeed again — the "turn, THEN drive" read, not simultaneous sliding.
    let speedLate = speedAfterDip;
    for (let i = 0; i < 200; i++) {
      tankBehavior(scene, e, makeCtx({ dt: 0.016, delta: 16, bearing: 0, dist: 50 }));
      speedLate = Math.hypot(e.vx, e.vy);
    }
    expect(speedLate).toBeGreaterThan(speedAfterDip);
    expect(speedLate).toBeGreaterThan(mv.maxSpeed * 0.8);
  });
});
