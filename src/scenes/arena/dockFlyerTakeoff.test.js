// #415 — a flyer launched from a dock is HIDDEN until it takes off: invisible while it sits in the
// dock, then on wake it fades in (alpha 0→1) and HOVERS over the pad for a beat before releasing to
// its normal flight AI. Driven through the REAL `_updateVehicle` tick (the seam the takeoff beat
// lives in), not a hand-rolled sim, so the wiring the player actually sees is what's under test.
//
// enemies.js/enemyBehaviors.js import Phaser only for `Phaser.Math.Angle.Wrap`; stub it (same
// convention as carrierDeploy.test.js / gunshipStrafe.test.js).
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { EnemiesMixin } from './enemies.js';
import { HpBody } from '../../data/HpBody.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { AWARE, DORMANT, detectionRangeFor } from '../../data/awareness.js';
import { TAKEOFF_HOVER_MS } from '../../data/takeoff.js';

function makeView() {
  let alpha = 1;
  const stub = {
    setAlpha(a) { alpha = a; return stub; },
    getAlpha() { return alpha; },
    setPosition() { return stub; },
    hull: { setTexture() {}, rotation: 0 },
    turret: { setTexture() {}, rotation: 0 },
    shadow: null,
  };
  return stub;
}

function makeScene() {
  const scene = {
    time: { now: 0 }, enemies: [], px: 900, py: 0, mech: { isDestroyed: () => false },
    enemyMove: true, enemyFire: true,
    _enemyFireAllowed: () => true,
    _cachedLosToPlayer: () => true,
    _speedFactorAt: () => 1,
    _blocked: () => false,
    _blockedByOtherGroundUnit: () => false,
    tweens: { add: () => {} },
  };
  Object.assign(scene, EnemiesMixin);
  // After the mixin so these stubs win: firing would reach the real projectile/spawn machinery
  // (Phaser textures we have no business building here), and the DORMANT gate calls proximity-wake.
  scene._fireVehicleWeapon = () => {};
  scene._maybeProximityWake = () => {};
  return scene;
}

// A helicopter as it comes out of a dock: view already hidden (alpha 0) and tagged for the takeoff
// beat, exactly what bases.js `spawnDockCluster` does for a flying dock unit.
function makeDockFlyer({ awareness = AWARE } = {}) {
  const def = ENEMY_KINDS.helicopter;
  const view = makeView();
  view.setAlpha(0);
  return {
    key: 'heliTest', mech: new HpBody(def), kind: def.kind, kindDef: def, behavior: def.behavior,
    x: 100, y: 0, vx: 0, vy: 0, angle: 0, turret: 0, handed: 1, flying: true,
    awareness, reactDelayMs: 0, detectRange: detectionRangeFor(def.fireRange),
    dockedTakeoff: true, slotCd: {}, slotBurst: {}, weaponSlot: null,
    view,
  };
}

function tick(scene, e, ms, step = 50) {
  for (let t = 0; t < ms; t += step) {
    scene.time.now += step;
    scene._updateVehicle(e, step / 1000, step);
  }
}

describe('#415 dock-flyer takeoff', () => {
  it('starts essentially invisible when it launches', () => {
    const scene = makeScene();
    const e = makeDockFlyer();
    scene.enemies.push(e);
    tick(scene, e, 50);
    expect(e.view.getAlpha()).toBeLessThan(0.2);
    expect(e.dockedTakeoff).toBe(true);
  });

  it('hovers over the dock during the takeoff beat — it does NOT fly at the player yet', () => {
    const scene = makeScene();
    const e = makeDockFlyer();
    scene.enemies.push(e);
    const startDist = Math.hypot(scene.px - e.x, scene.py - e.y);
    // Run most of the beat (but not past it).
    tick(scene, e, TAKEOFF_HOVER_MS - 100);
    const dist = Math.hypot(scene.px - e.x, scene.py - e.y);
    // Held essentially in place over the pad (a small hover-bleed drift is fine, a real approach
    // toward a player 800px away is not).
    expect(Math.abs(dist - startDist)).toBeLessThan(30);
    expect(e.dockedTakeoff).toBe(true);
  });

  it('fades fully in and then releases to normal flight, closing on the player', () => {
    const scene = makeScene();
    const e = makeDockFlyer();
    scene.enemies.push(e);
    tick(scene, e, TAKEOFF_HOVER_MS + 50);
    expect(e.dockedTakeoff).toBe(false);      // released
    expect(e.view.getAlpha()).toBe(1);        // fully visible
    const distAtRelease = Math.hypot(scene.px - e.x, scene.py - e.y);
    // Now fly a while — the gunship AI should begin closing the ~800px gap.
    tick(scene, e, 3000);
    const distLater = Math.hypot(scene.px - e.x, scene.py - e.y);
    expect(distLater).toBeLessThan(distAtRelease);
  });

  it('a DORMANT docked flyer stays hidden and inert until its base wakes it', () => {
    const scene = makeScene();
    const e = makeDockFlyer({ awareness: DORMANT });
    scene.enemies.push(e);
    // A dormant unit's full tick is gated in `_updateEnemy`, so simulate that gate: it should not
    // run its brain. Drive `_updateEnemy` (which early-returns for DORMANT) instead.
    e.baseId = null;   // no base wiring needed; the DORMANT branch returns before touching it
    for (let i = 0; i < 10; i++) { scene.time.now += 50; scene._updateEnemy(e, 0.05, 50); }
    expect(e.view.getAlpha()).toBe(0);        // never faded in
    expect(e.dockedTakeoff).toBe(true);       // still waiting to launch
    // Wake it (as `_wakeBase` would), then tick: it now takes off.
    e.awareness = AWARE;
    tick(scene, e, TAKEOFF_HOVER_MS + 50);
    expect(e.dockedTakeoff).toBe(false);
    expect(e.view.getAlpha()).toBe(1);
  });
});
