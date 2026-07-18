// #282 — mutual ground-unit collision (both size tiers) and mutual flyer collision. Before the
// original #282 landed, the ONLY collision involving an enemy was one-directional: the PLAYER's
// own movement blocked against every live ground enemy (`world.js` `_blockedByGroundEnemy`), but
// an enemy's own per-frame movement integration (`enemies.js` `_updateEnemy`/`_updateVehicle`)
// only ever checked terrain (`_blocked`) — enemies could freely overlap each other and the
// player, and flying units (drone/helicopter) ignored ALL collision, including each other. That
// first pass added `_blockedByOtherLargeUnit` (LARGE-vs-LARGE + vs player only) and
// `_blockedByOtherFlyer`, deliberately leaving SMALL-vs-SMALL uncollided on the assumption that
// "small units are walkable, so probably fine to leave uncollided unless it reads obviously
// wrong" — playtest confirmed it reads obviously wrong ("tanks nearly on top of one another").
//
// This follow-up generalizes `_blockedByOtherLargeUnit` into `_blockedByOtherGroundUnit`, which
// now handles BOTH size tiers via one consistent rule (see its comment in world.js): a LARGE
// obstacle blocks any other ground unit; a SMALL obstacle only blocks other SMALL units. So a
// small unit's own movement now also respects large obstacles and the player (previously it
// skipped this check entirely), and two small units now push apart from each other too.
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

// ── Part 1: pure geometry on the two WorldMixin collision-check methods ──────────────────────
function makeWorldScene({ enemies = [], px = 0, py = 0 } = {}) {
  return Object.assign({ enemies, px, py }, WorldMixin);
}

function makeUnit(x, y, { flying = false, size = 'large', scale = 1, dead = false } = {}) {
  return {
    x, y, flying, kind: 'tank', kindDef: { size, scale },
    mech: { isDestroyed: () => dead },
  };
}

describe('_blockedByOtherGroundUnit (#282) — mutual ground-unit + player collision geometry', () => {
  it('self LARGE: blocks against another LARGE ground unit\'s collision circle', () => {
    const self = makeUnit(-9999, -9999, { size: 'large' });
    const other = makeUnit(10, 0, { size: 'large' });
    const scene = makeWorldScene({ enemies: [self, other], px: 9999, py: 9999 });
    const r = groundEnemyRadius(other);
    expect(scene._blockedByOtherGroundUnit(self, 10 + r - 1, 0)).toBe(true);
    expect(scene._blockedByOtherGroundUnit(self, 10 + r + 5, 0)).toBe(false);
  });

  it('self LARGE: never blocks against a SMALL ground unit — a small obstacle isn\'t an obstacle to large units', () => {
    const self = makeUnit(-9999, -9999, { size: 'large' });
    const small = makeUnit(10, 0, { size: 'small' });
    const scene = makeWorldScene({ enemies: [self, small], px: 9999, py: 9999 });
    expect(scene._blockedByOtherGroundUnit(self, 10, 0)).toBe(false); // dead centre of it
  });

  it('self SMALL: blocks against another SMALL ground unit (#282 fix)', () => {
    const self = makeUnit(-9999, -9999, { size: 'small' });
    const other = makeUnit(10, 0, { size: 'small' });
    const scene = makeWorldScene({ enemies: [self, other], px: 9999, py: 9999 });
    const r = groundEnemyRadius(other);
    expect(scene._blockedByOtherGroundUnit(self, 10 + r - 1, 0)).toBe(true);
    expect(scene._blockedByOtherGroundUnit(self, 10 + r + 5, 0)).toBe(false);
  });

  it('self SMALL: also blocks against a LARGE ground unit (#282 fix — small units used to skip this check entirely)', () => {
    const self = makeUnit(-9999, -9999, { size: 'small' });
    const large = makeUnit(10, 0, { size: 'large' });
    const scene = makeWorldScene({ enemies: [self, large], px: 9999, py: 9999 });
    const r = groundEnemyRadius(large);
    expect(scene._blockedByOtherGroundUnit(self, 10 + r - 1, 0)).toBe(true);
    expect(scene._blockedByOtherGroundUnit(self, 10 + r + 5, 0)).toBe(false);
  });

  it('excludes `self` from the scan — a unit never blocks against its own circle', () => {
    const self = makeUnit(0, 0, { size: 'large' });
    const scene = makeWorldScene({ enemies: [self], px: 9999, py: 9999 });
    expect(scene._blockedByOtherGroundUnit(self, 0, 0)).toBe(false);
  });

  it('ignores a flying unit and an already-destroyed unit, regardless of self tier', () => {
    const self = makeUnit(-9999, -9999, { size: 'small' });
    const flyer = makeUnit(10, 0, { size: 'large', flying: true });
    const dead = makeUnit(-10, 0, { size: 'large', dead: true });
    const scene = makeWorldScene({ enemies: [self, flyer, dead], px: 9999, py: 9999 });
    expect(scene._blockedByOtherGroundUnit(self, 10, 0)).toBe(false);
    expect(scene._blockedByOtherGroundUnit(self, -10, 0)).toBe(false);
  });

  it('also blocks against the PLAYER\'s own collision circle, for either self tier', () => {
    const large = makeUnit(-9999, -9999, { size: 'large' });
    const small = makeUnit(-9999, -9999, { size: 'small' });
    const scene = makeWorldScene({ enemies: [large, small], px: 0, py: 0 });
    expect(scene._blockedByOtherGroundUnit(large, ENEMY_COLLIDE_RADIUS_MECH - 1, 0)).toBe(true);
    expect(scene._blockedByOtherGroundUnit(large, ENEMY_COLLIDE_RADIUS_MECH + 5, 0)).toBe(false);
    expect(scene._blockedByOtherGroundUnit(small, ENEMY_COLLIDE_RADIUS_MECH - 1, 0)).toBe(true);
    expect(scene._blockedByOtherGroundUnit(small, ENEMY_COLLIDE_RADIUS_MECH + 5, 0)).toBe(false);
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

  it('a SMALL ground unit does NOT block a LARGE unit\'s movement — large units still walk through small ones', () => {
    const scene = makeVehicleScene();
    const small = makeVehicleUnit(200, 0, { size: 'small' });
    const mover = makeVehicleUnit(0, 0, { size: 'large', vx: 5000 });
    scene.enemies.push(small, mover);

    scene._updateVehicle(mover, 1, 1000);

    // Unblocked: the mover sailed straight through/past the small unit's position.
    expect(mover.x).toBeGreaterThan(200);
  });
});

describe('_updateVehicle movement resolution (#282 follow-up) — SMALL ground units', () => {
  it('two SMALL ground units (e.g. two tanks) cannot end up overlapping after movement resolution', () => {
    const scene = makeVehicleScene();
    const target = makeVehicleUnit(200, 0, { size: 'small' });
    const mover = makeVehicleUnit(0, 0, { size: 'small', vx: 5000 }); // would tunnel through in one tick
    scene.enemies.push(target, mover);

    scene._updateVehicle(mover, 1, 1000); // big dt: unblocked, this would land well past `target`

    const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
    expect(dist).toBeGreaterThanOrEqual(groundEnemyRadius(target) - 0.001);
  });

  it('a tank and infantry (both SMALL, different kinds) also push apart from each other', () => {
    const scene = makeVehicleScene();
    const infantry = makeVehicleUnit(200, 0, { size: 'small', scale: 0.38 });
    const tank = makeVehicleUnit(0, 0, { size: 'small', scale: 0.48, vx: 5000 });
    scene.enemies.push(infantry, tank);

    scene._updateVehicle(tank, 1, 1000);

    const dist = Math.hypot(tank.x - infantry.x, tank.y - infantry.y);
    expect(dist).toBeGreaterThanOrEqual(groundEnemyRadius(infantry) - 0.001);
  });

  it('a SMALL unit\'s own movement IS now blocked by a LARGE unit in its way (#282 fix)', () => {
    const scene = makeVehicleScene();
    const large = makeVehicleUnit(200, 0, { size: 'large' });
    const mover = makeVehicleUnit(0, 0, { size: 'small', vx: 5000 });
    scene.enemies.push(large, mover);

    scene._updateVehicle(mover, 1, 1000);

    const dist = Math.hypot(mover.x - large.x, mover.y - large.y);
    expect(dist).toBeGreaterThanOrEqual(groundEnemyRadius(large) - 0.001);
  });

  it('a SMALL unit\'s own movement is also blocked by the player', () => {
    const scene = makeVehicleScene({ px: 200, py: 0 });
    const mover = makeVehicleUnit(0, 0, { size: 'small', vx: 5000 });
    scene.enemies.push(mover);

    scene._updateVehicle(mover, 1, 1000);

    const dist = Math.hypot(mover.x - scene.px, mover.y - scene.py);
    expect(dist).toBeGreaterThanOrEqual(ENEMY_COLLIDE_RADIUS_MECH - 0.001);
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

// ── Part 3: per-frame cost audit (#237 — "frame rate dropped after a recent merge") ──────────
// #237's ranked suspect list named this O(n²) mutual-collision scan (landed AFTER #237's first
// investigation pass, whose comment cleared #205/#211/#222/#227/#230/#231/#185/#200 but never
// touched this system) as worth auditing "at realistic enemy counts (dozens)". This locks in
// that audit's empirical result rather than just asserting it in a comment: `_blockedByOtherGroundUnit`
// scans every OTHER live enemy per call, and each blocked-ground-unit's own movement integration
// (enemies.js `_updateEnemy`/`_updateVehicle`) can call it up to 3x/frame (candidate position +
// two axis-slide fallbacks) — so worst case is 3 scans/enemy/frame, ~3n² comparisons total.
// This game's base-population design (3 bases × a handful of docks/turrets/patrols each, see
// data/worldgen.js BASE_COUNT/DOCKS_PER_BASE_MAX, bases.js TOWER_PATROL_COUNT) tops out around
// several dozen LIVE (non-DORMANT) enemies at once even in a worst-case simultaneous multi-base
// engagement — nowhere near where an O(n²) scan of cheap comparisons (a handful of property
// reads + one Math.hypot each) becomes visible in a 16.67ms (60fps) frame budget. The threshold
// below is deliberately generous (budget-fraction, not a tight number) — it's a canary against a
// FUTURE regression (e.g. the scan growing an allocation, or enemy counts growing well past
// "dozens"), not a tight perf lock-in.
describe('_blockedByOtherGroundUnit / _blockedByOtherFlyer (#237) — per-frame cost at realistic enemy counts', () => {
  function makeCollisionEnemies(n) {
    const enemies = [];
    for (let i = 0; i < n; i++) {
      const flying = i % 7 === 0;
      const small = !flying && i % 3 === 0;
      enemies.push(makeUnit((i % 20) * 40 - 400, Math.floor(i / 20) * 40 - 400, {
        flying, size: small ? 'small' : 'large',
      }));
    }
    return enemies;
  }

  // NOTE: this deliberately does NOT assert wall-clock time. An earlier version of this test
  // measured `performance.now()` and asserted a per-frame-millisecond ceiling — that flaked under
  // CPU load (it's a wall-clock timing assertion, inherently sensitive to whatever else the host
  // is doing, and would trip spuriously on a busy CI runner). The empirical perf characterization
  // (~sub-1% of a 60fps frame budget at 60 live enemies, measured during #237's investigation)
  // lives in issue #237, not as a hard gate here. What this test DOES guard, deterministically, is
  // that the scan runs to completion for a realistic worst-case enemy count without throwing or
  // hanging — which still catches the failure modes that matter (an infinite loop, a crash, or an
  // accidental unbounded blowup that would time the whole suite out), just not via a flaky number.
  it('runs one frame\'s worth of collision checks for dozens of enemies to completion (no crash/hang)', () => {
    const REALISTIC_MAX_LIVE_ENEMIES = 60;   // generous upper bound — see comment above
    const enemies = makeCollisionEnemies(REALISTIC_MAX_LIVE_ENEMIES);
    const scene = makeWorldScene({ enemies, px: 0, py: 0 });

    const simulateOneFrame = () => {
      for (const e of enemies) {
        if (e.flying) {
          scene._blockedByOtherFlyer(e, e.x + 1, e.y);
          scene._blockedByOtherFlyer(e, e.x + 1, e.y);
          scene._blockedByOtherFlyer(e, e.x, e.y + 1);
        } else {
          scene._blockedByOtherGroundUnit(e, e.x + 1, e.y);
          scene._blockedByOtherGroundUnit(e, e.x + 1, e.y);
          scene._blockedByOtherGroundUnit(e, e.x, e.y + 1);
        }
      }
    };

    // A handful of frames is plenty to prove it completes; the count is irrelevant to the
    // (removed) timing claim now, it just exercises the scan repeatedly against real state.
    expect(() => { for (let i = 0; i < 10; i++) simulateOneFrame(); }).not.toThrow();
  });
});
