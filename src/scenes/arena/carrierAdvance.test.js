// #416 — an ALERTED Broodhauler ADVANCES on the player instead of camping its base. When a base is
// woken (bases.js `_wakeBase`) the carrier is flagged `advanceOnAlert`, which makes carrierMoveIntent
// (enemyBehaviors.js) press in to a much tighter standoff than its normal 320px camp — bringing its
// drone production into the fight rather than letting a stack of drones pile up back at the base.
//
// Driven through the REAL `_updateVehicle` tick. Phaser is stubbed for `Angle.Wrap` (same
// convention as carrierDeploy.test.js).
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { EnemiesMixin } from './enemies.js';
import { HpBody } from '../../data/HpBody.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { AWARE, detectionRangeFor } from '../../data/awareness.js';

function makeScene() {
  const scene = {
    time: { now: 0 }, enemies: [], px: 400, py: 0, mech: { isDestroyed: () => false },
    enemyMove: true, enemyFire: true,
    _speedFactorAt: () => 1,
    _blocked: () => false,
    _blockedByOtherGroundUnit: () => false,
    tweens: { add: () => {} },
  };
  Object.assign(scene, EnemiesMixin);
  // Deploy spawns go through `_spawnKind`; stub it (no textures in the node env).
  scene._spawnKind = () => null;
  return scene;
}

// A carrier parked 300px from the player — inside its normal 320px camp standoff, so a NON-alerted
// carrier holds/strafes there rather than closing. `advanceOnAlert` is the only difference.
function makeCarrier({ advanceOnAlert = false } = {}) {
  const def = ENEMY_KINDS.carrier;
  return {
    key: 'carrierTest', mech: new HpBody(def), kind: def.kind, kindDef: def, behavior: def.behavior,
    x: 100, y: 0, vx: 0, vy: 0, angle: 0, turret: 0, handed: 1,
    awareness: AWARE, reactDelayMs: 0, detectRange: detectionRangeFor(def.fireRange),
    advanceOnAlert,
    view: { setAlpha() {}, setPosition() {}, hull: { setTexture() {}, rotation: 0 }, turret: { setTexture() {}, rotation: 0 }, shadow: null },
  };
}

function tick(scene, e, ms, step = 50) {
  for (let t = 0; t < ms; t += step) {
    scene.time.now += step;
    scene._updateVehicle(e, step / 1000, step);
  }
}

describe('#416 alerted Broodhauler advances on the player', () => {
  it('an alerted carrier closes the distance to the player', () => {
    const scene = makeScene();
    const e = makeCarrier({ advanceOnAlert: true });
    scene.enemies.push(e);
    const startDist = Math.hypot(scene.px - e.x, scene.py - e.y);
    tick(scene, e, 5000);
    const endDist = Math.hypot(scene.px - e.x, scene.py - e.y);
    expect(endDist).toBeLessThan(startDist - 60);   // meaningfully advanced, not just jittered
  });

  it('a NON-alerted carrier holds its camp standoff instead of closing', () => {
    const scene = makeScene();
    const e = makeCarrier({ advanceOnAlert: false });
    scene.enemies.push(e);
    const startDist = Math.hypot(scene.px - e.x, scene.py - e.y);
    tick(scene, e, 5000);
    const endDist = Math.hypot(scene.px - e.x, scene.py - e.y);
    // Sits roughly where it started (300px, well inside its 320px standoff) — no meaningful advance.
    expect(endDist).toBeGreaterThan(startDist - 60);
  });

  it('the alerted carrier ends up closer than the camping one', () => {
    const scene = makeScene();
    const alerted = makeCarrier({ advanceOnAlert: true });
    const camping = makeCarrier({ advanceOnAlert: false });
    scene.enemies.push(alerted);
    tick(scene, alerted, 6000);
    const scene2 = makeScene();
    scene2.enemies.push(camping);
    tick(scene2, camping, 6000);
    const alertedDist = Math.hypot(scene.px - alerted.x, scene.py - alerted.y);
    const campingDist = Math.hypot(scene2.px - camping.x, scene2.py - camping.y);
    expect(alertedDist).toBeLessThan(campingDist);
  });
});
