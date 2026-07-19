// #328 follow-up — the Broodhauler carrier is an INFINITE spawner, and its cadence no longer
// stalls when the player breaks engagement.
//
// Playtest report: "broodthing isn't dispensing drones consistently or for long enough". Two
// separate causes, both covered here by driving the REAL `_updateVehicle` tick (not a hand-rolled
// simulation of it):
//   1. `deployCap: 24` was a LIFETIME limit — at 4s/5-8-per-batch a carrier exhausted itself in
//      ~12-16s and never deployed again. Jackson: "yes make broodhauler an infinite spawner,
//      yes". Removed; killing it is the only lever, exactly as docks work post-#326.
//   2. The deploy tick lived INSIDE `carrierBehavior`, so it only advanced on frames the unit ran
//      its full tactical brain. It now runs outside that branch with a grace period
//      (`CARRIER_DEPLOY_GRACE_MS`) once the carrier has engaged.
//
// enemies.js has a vestigial `import Phaser from 'phaser'` whose top-level device detection throws
// under vitest's node env, so it's stubbed (same convention as dormantWake.test.js).
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { EnemiesMixin } from './enemies.js';
import { CARRIER_DEPLOY_GRACE_MS } from './enemyBehaviors.js';
import { HpBody } from '../../data/HpBody.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { AWARE, detectionRangeFor } from '../../data/awareness.js';

// Just enough scene for a carrier's full `_updateVehicle` tick to run end to end. `_spawnKind` is
// the seam the deploy mechanic actually goes through, so counting its calls counts drones.
function makeScene() {
  const spawned = [];
  const scene = {
    time: { now: 0 }, enemies: [], px: 400, py: 0, bases: [], alertTowerHexes: [],
    enemyMove: true, enemyFire: true,
    _blocked: () => false,
    _blockedByOtherGroundUnit: () => false,
    _speedFactorAt: () => 1,
    _cachedLosToPlayer: () => true,
    _fireVehicleWeapon: () => {},
    tweens: { add: () => {} },
  };
  Object.assign(scene, EnemiesMixin);
  // After the mixin, so the stub wins: `_spawnKind` is the seam the deploy mechanic spawns
  // through, and the real one needs Phaser textures we have no business building here.
  scene._spawnKind = (x, y, kindId) => { spawned.push(kindId); return null; };
  return { scene, spawned };
}

function makeCarrier() {
  const def = ENEMY_KINDS.carrier;
  return {
    key: 'carrierTest', mech: new HpBody(def), kind: def.kind, kindDef: def, behavior: def.behavior,
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0, handed: 1,
    awareness: AWARE, reactDelayMs: 0, detectRange: detectionRangeFor(def.fireRange),
    view: { setPosition() {}, hull: { setTexture() {}, rotation: 0 }, turret: { setTexture() {}, rotation: 0 }, shadow: null },
  };
}

// Drive N milliseconds of real frames through `_updateVehicle`.
function run(scene, e, ms, step = 100) {
  for (let t = 0; t < ms; t += step) {
    scene.time.now += step;
    scene._updateVehicle(e, step / 1000, step);
  }
}

describe('#328 follow-up: carrier deploy has no lifetime cap', () => {
  it('keeps deploying far past the old 24-drone cap for as long as it lives', () => {
    const { scene, spawned } = makeScene();
    const e = makeCarrier();
    scene.enemies.push(e);
    // Two full minutes of engagement — the old cap would have stopped this dead at 24 after
    // roughly the first 16 seconds.
    run(scene, e, 120000);
    expect(spawned.length).toBeGreaterThan(24);
    expect(spawned.every((k) => k === 'drone')).toBe(true);
  });

  it('is still deploying in the LAST stretch of a long fight, not just front-loaded', () => {
    const { scene, spawned } = makeScene();
    const e = makeCarrier();
    scene.enemies.push(e);
    run(scene, e, 60000);
    const early = spawned.length;
    run(scene, e, 60000);
    expect(spawned.length).toBeGreaterThan(early);
  });
});

describe('#328 follow-up: the cadence survives a break in engagement', () => {
  it('keeps deploying through the grace period after it stops reacting', () => {
    const { scene, spawned } = makeScene();
    const e = makeCarrier();
    scene.enemies.push(e);
    run(scene, e, 12000);          // engage — arms the bay
    const armed = spawned.length;
    expect(armed).toBeGreaterThan(0);
    // Now stop reacting (the same state a post-wake stagger / disengaged unit is in).
    e.reactDelayMs = Number.MAX_SAFE_INTEGER;
    run(scene, e, CARRIER_DEPLOY_GRACE_MS - 1000);
    expect(spawned.length).toBeGreaterThan(armed);   // cadence did NOT stall
  });

  it('eventually buttons up once the grace period has fully elapsed', () => {
    const { scene, spawned } = makeScene();
    const e = makeCarrier();
    scene.enemies.push(e);
    run(scene, e, 12000);
    e.reactDelayMs = Number.MAX_SAFE_INTEGER;
    run(scene, e, CARRIER_DEPLOY_GRACE_MS + 1000);
    const afterGrace = spawned.length;
    run(scene, e, 30000);
    expect(spawned.length).toBe(afterGrace);
  });
});
