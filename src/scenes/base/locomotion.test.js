// #522 regression coverage: BaseScene's drive (`_driveBase`, base/locomotion.js) used to read
// `player.mech.movement` raw, never applying the fast/legacy override the arena defaults every
// fresh player to (arena/locomotion.js `_drive`) — so a fresh base walk was silently stuck on
// the #501 slow/twist-slew re-experiment's numbers even after #501's follow-up made fast/legacy
// the game-wide default, reading as "in-base movement is much slower than the arena." This test
// drives `_driveBase` end-to-end (not just the shared resolver in isolation, which shared.test.js
// already covers) to prove BaseScene now resolves the same fast/legacy default the arena does,
// and that the same D-pad toggle works here too.
//
// locomotion.js has a vestigial `import Phaser from 'phaser'` whose top-level device detection
// throws under vitest's node env, so it's stubbed (same convention as playerCrushRegression.test.js).
import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
vi.mock('phaser', () => ({
  default: { Math: { Clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)) } },
}));

import { BaseLocomotionMixin } from './locomotion.js';
import { LEGACY_MOVEMENT_OVERRIDE, MEDIUM_PLAYER_CONFIG } from '../../data/chassis/mediumPlayer.js';

// Sanity precondition the whole test file leans on: the raw chassis numbers (the #501 slow
// re-experiment) and the legacy/fast override are actually different, so a test that asserts
// "used the fast numbers" can't pass by accident.
const RAW = MEDIUM_PLAYER_CONFIG.movement;
if (RAW.maxSpeed === LEGACY_MOVEMENT_OVERRIDE.maxSpeed) {
  throw new Error('test precondition violated: raw chassis speed now equals the legacy override');
}

function makeScene() {
  const scene = {
    player: {
      mech: { movement: RAW, legFactor: () => 1 },
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, turretAngle: 0, aimX: 0, aimY: 0, speed: 0,
      stepMs: 0, hullFrame: 0, textureKey: 'baseMech',
      view: { hull: { setTexture: () => {}, rotation: 0 }, turret: { rotation: 0 }, setPosition: () => {} },
    },
  };
  Object.assign(scene, BaseLocomotionMixin);
  scene._blockedAlongSegment = () => false;
  scene._speedFactorAt = () => 1;
  scene._syncTilts = () => {};
  scene._footImpactFx = () => {};
  scene._footShake = () => {};
  return scene;
}

const DRIVE_EAST = { move: { x: 1, y: 0 }, aim: { mode: 'pointer', x: 100, y: 0 } };

describe('#522 — BaseScene _driveBase defaults to fast/legacy movement, matching the arena', () => {
  it('a fresh player drives at the LEGACY_MOVEMENT_OVERRIDE speed, not the raw slow chassis numbers', () => {
    const scene = makeScene();
    scene._driveBase(DRIVE_EAST, 1 / 30);

    expect(scene.player.legacyMovement).toBe(true);
    expect(scene.player.vx).toBeCloseTo(LEGACY_MOVEMENT_OVERRIDE.maxSpeed);
    expect(scene.player.vx).not.toBeCloseTo(RAW.maxSpeed);
  });

  it('D-pad down (intent.movementTogglePressed) toggles into the slow #501 numbers, same as the arena', () => {
    const scene = makeScene();
    scene._driveBase(DRIVE_EAST, 1 / 30);   // seeds legacyMovement = true

    scene._driveBase({ ...DRIVE_EAST, movementTogglePressed: true }, 1 / 30);
    expect(scene.player.legacyMovement).toBe(false);
    expect(scene.player.vx).toBeCloseTo(RAW.maxSpeed);

    // Toggling again flips back to fast/legacy.
    scene._driveBase({ ...DRIVE_EAST, movementTogglePressed: true }, 1 / 30);
    expect(scene.player.legacyMovement).toBe(true);
    expect(scene.player.vx).toBeCloseTo(LEGACY_MOVEMENT_OVERRIDE.maxSpeed);
  });

  it('_stepGaitBase resolves the same fast/legacy movement config _driveBase used (maxSpeed drives gait cadence)', () => {
    const scene = makeScene();
    scene._driveBase(DRIVE_EAST, 1 / 30);
    scene.player.speed = LEGACY_MOVEMENT_OVERRIDE.maxSpeed;   // as if actually moving at top speed

    // Should not throw, and should advance the gait clock using the resolved (fast) maxSpeed —
    // a regression here would silently divide by the wrong maxSpeed if _stepGaitBase ever went
    // back to reading `p.mech.movement` raw instead of the shared resolver.
    expect(() => scene._stepGaitBase(1 / 30)).not.toThrow();
    expect(scene.player.stepMs).toBeGreaterThan(0);
  });
});
