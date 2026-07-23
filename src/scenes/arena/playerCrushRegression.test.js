// #282 follow-up regression coverage: generalizing enemy-vs-enemy ground-unit collision
// (`_blockedByOtherGroundUnit`, world.js) to also cover small-vs-small must NOT touch the
// PLAYER's own movement resolution — the player still instantly crushes a small unit (tank/
// infantry) on contact via `_crushTargetAt`/`_crushGroundEnemyAt`, and still just BLOCKS against
// a large unit (mech/turret/carrier) via `_blockedByGroundEnemy`, exactly as before this issue.
// Those two functions (and the player's `_drive` in locomotion.js) were deliberately left
// completely untouched by the #282 fix — this test drives `_drive` end-to-end (not just the
// isolated helpers crush.test.js/collision.test.js already cover) to prove the full player-side
// path still behaves identically.
//
// locomotion.js has a vestigial `import Phaser from 'phaser'` whose top-level device detection
// throws under vitest's node env, so it's stubbed (same convention as dormantWake.test.js).
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { RotateTo: (cur) => cur, Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { LocomotionMixin } from './locomotion.js';
import { WorldMixin } from './world.js';

function makeTank(x, y, hp = 160) {
  // `isDestroyed` reads `mech.hp` off the object itself (not a captured local) so mutating
  // `e.mech.hp` — exactly what the real damage pipeline, and this test's `_damageEnemyAt`
  // stub below, both do — is actually observed. A closure over the local `hp` param instead
  // would silently never reflect the mutation, leaving `isDestroyed()` permanently false and
  // spinning `_drive`'s crush-repeat loop forever.
  const mech = { hp, maxHp: 160 };
  mech.isDestroyed = () => mech.hp <= 0;
  return { x, y, flying: false, behavior: 'tank', kind: 'tank', kindDef: { size: 'small', scale: 0.48 }, mech };
}

function makeTurret(x, y) {
  return {
    x, y, flying: false, behavior: 'turret', kind: 'turret', kindDef: { size: 'large' },
    mech: { hp: 90, maxHp: 90, isDestroyed: () => false },
  };
}

function makeScene({ enemies = [] } = {}) {
  const damageCalls = [];
  const scene = {
    px: 0, py: 0, vx: 0, vy: 0, angle: 0, turretAngle: 0, aimX: 0, aimY: 0, speed: 0,
    mech: {
      movement: { maxSpeed: 300, accel: 99999, decel: 99999, turnRate: 10, turretSlew: 10 },
      legFactor: () => 1,
    },
    terrain: new Map(), buildingHp: new Map(), coverHp: new Map(), tileImages: new Map(),
    enemies,
    registry: { set: () => {} },
    _damageEnemyAt: vi.fn((e) => { damageCalls.push(e); e.mech.hp = 0; }),
  };
  Object.assign(scene, LocomotionMixin, WorldMixin);
  // Stub AFTER mixing in WorldMixin so these override its real terrain/segment-walking
  // implementations — mirrors crush.test.js/dormantWake.test.js's convention. Terrain is never
  // the thing under test here (unit collision is), so it's just "always open."
  scene._blockedAlongSegment = () => false;
  scene._speedFactorAt = () => 1;
  return { scene, damageCalls };
}

// Straight-line drive-forward intent (east), with INSTANT_VELOCITY/INSTANT_TURNING (both true
// in locomotion.js currently) snapping velocity/facing immediately to this input each frame.
const DRIVE_EAST = { move: { x: 1, y: 0 }, aim: { mode: 'pointer', x: 100, y: 0 } };

describe('#282 regression — player _drive still crushes small units and blocks on large units, unchanged', () => {
  it('driving into a TANK crushes it instantly and the player passes through (not blocked)', () => {
    const tank = makeTank(50, 0);
    const { scene, damageCalls } = makeScene({ enemies: [tank] });

    // A few frames of driving east are enough to reach + crush it, then continue past.
    for (let i = 0; i < 10; i++) scene._drive(DRIVE_EAST, 1 / 30);

    expect(damageCalls.length).toBeGreaterThanOrEqual(1);
    expect(damageCalls[0]).toBe(tank);
    expect(tank.mech.isDestroyed()).toBe(true);
    // The player rolled through into/past the crushed tank's position, not stuck short of it.
    expect(scene.px).toBeGreaterThan(50);
  });

  it('driving into a TURRET (large unit) just blocks — no crush, player halts short of it', () => {
    const turret = makeTurret(50, 0);
    const { scene, damageCalls } = makeScene({ enemies: [turret] });

    for (let i = 0; i < 10; i++) scene._drive(DRIVE_EAST, 1 / 30);

    expect(damageCalls.length).toBe(0);
    expect(turret.mech.isDestroyed()).toBe(false);
    // Blocked well short of the turret's centre — never crossed into/through it.
    expect(scene.px).toBeLessThan(50);
  });
});

describe('#466 — a crush pass that removes no hp bails out instead of spinning forever', () => {
  it('driving into a SHIELDED crushable unit terminates the frame (would hang without the guard)', () => {
    // A small (crushable) unit whose shield eats the whole crush hit: `_damageEnemyAt` leaves
    // `mech.hp` untouched and the unit alive, so `_crushTargetAt` keeps finding the very same
    // enemy. Before the fix this is an infinite loop inside a single `_drive` call — a true
    // hard hang, not a dropped frame — and this test never returns (vitest kills it on timeout).
    const shielded = makeTank(50, 0);
    shielded.mech.shield = 9999;
    const { scene, damageCalls } = makeScene({ enemies: [shielded] });
    scene._damageEnemyAt = vi.fn((e, x, y, dmg) => {
      damageCalls.push(e);
      e.mech.shield = Math.max(0, e.mech.shield - dmg);   // absorbs everything; hp never drops
    });

    for (let i = 0; i < 10; i++) scene._drive(DRIVE_EAST, 1 / 30);

    // It still got crushed at (dealt damage), just never died — and the drive completed.
    expect(damageCalls.length).toBeGreaterThanOrEqual(1);
    expect(shielded.mech.isDestroyed()).toBe(false);
    expect(shielded.mech.hp).toBe(160);
    // One crush attempt per substep at most — the guard stops the re-scan repeat dead.
    expect(damageCalls.length).toBeLessThan(50);
  });
});
