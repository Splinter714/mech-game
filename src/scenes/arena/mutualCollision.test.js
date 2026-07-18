// #282 — mutual large-ground-unit collision and mutual flyer collision. Before this, the ONLY
// collision involving an enemy was one-directional: the PLAYER's own movement blocked against
// every live ground enemy (`world.js` `_blockedByGroundEnemy`), but an enemy's own per-frame
// movement integration (`enemies.js` `_updateEnemy`/`_updateVehicle`) only ever checked terrain
// (`_blocked`) — enemies could freely overlap each other and the player, and flying units
// (drone/helicopter) ignored ALL collision, including each other. This adds two NEW world.js
// checks (`_blockedByOtherLargeUnit`, `_blockedByOtherFlyer`) that an enemy's own movement now
// also respects, alongside the pre-existing terrain check — see the #282 comments in world.js/
// enemies.js for the full reasoning.
//
// enemies.js has a vestigial `import Phaser from 'phaser'` whose top-level device detection
// throws under vitest's node env, so it's stubbed (same convention as dormantWake.test.js).
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { WorldMixin } from './world.js';
import { EnemiesMixin } from './enemies.js';
import { ENEMY_BEHAVIORS } from './enemyBehaviors.js';
import { groundEnemyRadius, ENEMY_COLLIDE_RADIUS_MECH, ENEMY_COLLIDE_RADIUS_VEHICLE } from './shared.js';
import { AWARE } from '../../data/awareness.js';

// ── Part 1: pure geometry on the two new WorldMixin methods ──────────────────────────────────
function makeWorldScene({ enemies = [], px = 0, py = 0 } = {}) {
  return Object.assign({ enemies, px, py }, WorldMixin);
}

function makeUnit(x, y, { flying = false, size = 'large', scale = 1, dead = false } = {}) {
  return {
    x, y, flying, kind: 'tank', kindDef: { size, scale },
    mech: { isDestroyed: () => dead },
  };
}

describe('_blockedByOtherLargeUnit (#282) — mutual large-ground-unit + player collision geometry', () => {
  it('blocks against another LARGE ground unit\'s collision circle', () => {
    const other = makeUnit(10, 0, { size: 'large' });
    const scene = makeWorldScene({ enemies: [other], px: 9999, py: 9999 });
    const r = groundEnemyRadius(other);
    expect(scene._blockedByOtherLargeUnit(null, 10 + r - 1, 0)).toBe(true);
    expect(scene._blockedByOtherLargeUnit(null, 10 + r + 5, 0)).toBe(false);
  });

  it('never blocks against a SMALL ground unit — small units are walkable by everyone', () => {
    const small = makeUnit(10, 0, { size: 'small' });
    const scene = makeWorldScene({ enemies: [small], px: 9999, py: 9999 });
    expect(scene._blockedByOtherLargeUnit(null, 10, 0)).toBe(false); // dead centre of it
  });

  it('excludes `self` from the scan — a unit never blocks against its own circle', () => {
    const self = makeUnit(0, 0, { size: 'large' });
    const scene = makeWorldScene({ enemies: [self], px: 9999, py: 9999 });
    expect(scene._blockedByOtherLargeUnit(self, 0, 0)).toBe(false);
  });

  it('ignores a flying unit and an already-destroyed unit', () => {
    const flyer = makeUnit(10, 0, { size: 'large', flying: true });
    const dead = makeUnit(-10, 0, { size: 'large', dead: true });
    const scene = makeWorldScene({ enemies: [flyer, dead], px: 9999, py: 9999 });
    expect(scene._blockedByOtherLargeUnit(null, 10, 0)).toBe(false);
    expect(scene._blockedByOtherLargeUnit(null, -10, 0)).toBe(false);
  });

  it('also blocks against the PLAYER\'s own collision circle', () => {
    const scene = makeWorldScene({ enemies: [], px: 0, py: 0 });
    expect(scene._blockedByOtherLargeUnit(null, ENEMY_COLLIDE_RADIUS_MECH - 1, 0)).toBe(true);
    expect(scene._blockedByOtherLargeUnit(null, ENEMY_COLLIDE_RADIUS_MECH + 5, 0)).toBe(false);
  });
});

describe('_blockedByOtherFlyer (#282) — mutual flyer-only collision geometry', () => {
  it('blocks against another FLYING unit\'s collision circle', () => {
    const other = makeUnit(10, 0, { flying: true, scale: 1 });
    const scene = makeWorldScene({ enemies: [other] });
    const r = groundEnemyRadius(other);
    expect(scene._blockedByOtherFlyer(null, 10 + r - 1, 0)).toBe(true);
    expect(scene._blockedByOtherFlyer(null, 10 + r + 5, 0)).toBe(false);
  });

  it('ignores a non-flying (ground) unit entirely, regardless of size', () => {
    const largeGround = makeUnit(10, 0, { flying: false, size: 'large' });
    const smallGround = makeUnit(-10, 0, { flying: false, size: 'small' });
    const scene = makeWorldScene({ enemies: [largeGround, smallGround] });
    expect(scene._blockedByOtherFlyer(null, 10, 0)).toBe(false);
    expect(scene._blockedByOtherFlyer(null, -10, 0)).toBe(false);
  });

  it('excludes `self` from the scan', () => {
    const self = makeUnit(0, 0, { flying: true });
    const scene = makeWorldScene({ enemies: [self] });
    expect(scene._blockedByOtherFlyer(self, 0, 0)).toBe(false);
  });

  it('ignores an already-destroyed flyer', () => {
    const dead = makeUnit(5, 0, { flying: true, dead: true });
    const scene = makeWorldScene({ enemies: [dead] });
    expect(scene._blockedByOtherFlyer(null, 5, 0)).toBe(false);
  });
});

// ── Part 2: end-to-end movement-resolution integration via `_updateVehicle` ──────────────────
// A deterministic test-only "behavior" (registered into the real ENEMY_BEHAVIORS registry
// `_updateVehicle` dispatches through) that just drives the unit straight at a fixed velocity —
// decouples these tests from the real tactical AI (standoff distance, LOS, etc.), which is
// covered elsewhere, so only the movement-INTEGRATION/collision code under test in #282 drives
// the outcome.
ENEMY_BEHAVIORS.__testForward = (scene, e) => { e.vx = e._testVx ?? 0; e.vy = e._testVy ?? 0; };

function makeVehicleScene({ px = 99999, py = 99999, blockedTerrain = false } = {}) {
  const scene = { time: { now: 0 }, enemies: [], px, py, enemyMove: true, enemyFire: false };
  Object.assign(scene, EnemiesMixin, WorldMixin);
  // Stub AFTER mixing in WorldMixin so these override its real (terrain-Map-touching)
  // implementations — mirrors dormantWake.test.js's makeTickableScene / crush.test.js's pattern.
  scene._blocked = () => blockedTerrain;
  scene._speedFactorAt = () => 1;
  scene._cachedLosToPlayer = () => true;
  scene._fireVehicleWeapon = () => {};
  return scene;
}

function makeVehicleUnit(x, y, { flying = false, size = 'large', scale = 1, vx = 0, vy = 0 } = {}) {
  const view = { setPosition() {}, hull: { setTexture() {}, rotation: 0 }, turret: { rotation: 0 }, shadow: null };
  return {
    key: 'testUnit', kind: 'tank', behavior: '__testForward',
    kindDef: { size, scale, art: flying ? 'drone' : 'tank', move: { maxSpeed: 999, accel: 999, turretSlew: 10 } },
    mech: { isDestroyed: () => false, tickShield() {} },
    x, y, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0, rotorSpin: 0,
    awareness: AWARE, flying, view,
    _testVx: vx, _testVy: vy,
  };
}

describe('_updateVehicle movement resolution (#282) — LARGE ground units', () => {
  it('two large ground units cannot end up overlapping after movement resolution', () => {
    const scene = makeVehicleScene();
    const target = makeVehicleUnit(200, 0, { size: 'large' });
    const mover = makeVehicleUnit(0, 0, { size: 'large', vx: 5000 }); // would tunnel through in one tick
    scene.enemies.push(target, mover);

    scene._updateVehicle(mover, 1, 1000); // big dt: unblocked, this would land well past `target`

    const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
    expect(dist).toBeGreaterThanOrEqual(groundEnemyRadius(target) - 0.001);
  });

  it('a large ground unit cannot walk through the player', () => {
    const scene = makeVehicleScene({ px: 200, py: 0 });
    const mover = makeVehicleUnit(0, 0, { size: 'large', vx: 5000 });
    scene.enemies.push(mover);

    scene._updateVehicle(mover, 1, 1000);

    const dist = Math.hypot(mover.x - scene.px, mover.y - scene.py);
    expect(dist).toBeGreaterThanOrEqual(ENEMY_COLLIDE_RADIUS_MECH - 0.001);
  });

  it('a SMALL ground unit does NOT block another unit\'s movement — freely walkable', () => {
    const scene = makeVehicleScene();
    const small = makeVehicleUnit(200, 0, { size: 'small' });
    const mover = makeVehicleUnit(0, 0, { size: 'large', vx: 5000 });
    scene.enemies.push(small, mover);

    scene._updateVehicle(mover, 1, 1000);

    // Unblocked: the mover sailed straight through/past the small unit's position.
    expect(mover.x).toBeGreaterThan(200);
  });

  it('a SMALL unit\'s own movement is likewise not blocked by a large unit in its way', () => {
    const scene = makeVehicleScene();
    const large = makeVehicleUnit(200, 0, { size: 'large' });
    const mover = makeVehicleUnit(0, 0, { size: 'small', vx: 5000 });
    scene.enemies.push(large, mover);

    scene._updateVehicle(mover, 1, 1000);

    // #282 explicit scope: only LARGE-vs-LARGE (and vs player) collides; a small unit's own
    // movement stays exempt from the new unit-collision check entirely (terrain only).
    expect(mover.x).toBeGreaterThan(200);
  });
});

describe('_updateVehicle movement resolution (#282) — flyers', () => {
  it('two flyers cannot end up overlapping after movement resolution', () => {
    const scene = makeVehicleScene();
    const target = makeVehicleUnit(200, 0, { flying: true });
    const mover = makeVehicleUnit(0, 0, { flying: true, vx: 5000 });
    scene.enemies.push(target, mover);

    scene._updateVehicle(mover, 1, 1000);

    const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
    expect(dist).toBeGreaterThanOrEqual(groundEnemyRadius(target) - 0.001);
  });

  it('a flyer still ignores ground units and terrain (unchanged) even while mutual-colliding '
    + 'with other flyers', () => {
    // Terrain is "always blocked" and a large ground unit sits right in the flight path — a
    // flyer must sail through both exactly as before #282.
    const scene = makeVehicleScene({ blockedTerrain: true });
    const groundBlocker = makeVehicleUnit(200, 0, { size: 'large' });
    const mover = makeVehicleUnit(0, 0, { flying: true, vx: 5000 });
    scene.enemies.push(groundBlocker, mover);

    scene._updateVehicle(mover, 1, 1000);

    expect(mover.x).toBeGreaterThan(200);
  });
});
