// #491 playtest fix — Jackson: "gravity charge or whatever shouldn't pull stationary units like
// turrets off of their positions." All three force/pull-or-push call sites (`_tickTravelForce`
// and the Gravity Well hazard field tick in projectiles.js, and Repulsor Pulse's instant wave
// push in firing.js) share the same `computeImpulse` math and used to apply it to every living
// enemy unconditionally. They now skip any enemy `isMobileEnemy` (data/bases.js) reports as
// stationary — the same maxSpeed-0 signal `_separateGroundUnits`'s massOf and base-clear's own
// `isMobileEnemy` check already use for turret/wallTurret. Mirrors mineFlyerExclusion.test.js's
// pattern of exercising the mixins directly against a minimal fake scene.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';
import { FiringMixin } from './firing.js';

function fakeEnemy(x, y, { stationary = false } = {}) {
  return {
    x, y,
    mech: { isDestroyed: () => false },
    // A real spawned enemy always carries `kindDef` (enemies.js `_spawnKind`); `isMobileEnemy`
    // reads its `move.maxSpeed` — 0 is the wallTurret/turret convention, anything else is mobile.
    kindDef: { move: { maxSpeed: stationary ? 0 : 100 } },
  };
}

function fakeGraphics() {
  const g = {
    lineStyle: () => g, strokeCircle: () => g, fillStyle: () => g, fillCircle: () => g,
  };
  return g;
}

function makeProjScene(enemies) {
  const scene = {
    enemies,
    hazards: [],
    time: { now: 0 },
    groundFx: fakeGraphics(),
    _damageEnemyAt: vi.fn(),
    _damagePlayerAt: vi.fn(),
    _impactFx: vi.fn(),
  };
  return Object.assign(scene, ProjectilesMixin);
}

describe('#491 — force/pull weapons never displace a stationary/emplaced enemy kind', () => {
  it('_tickTravelForce (an in-flight force round) pulls a mobile enemy but leaves a stationary one in place', () => {
    const mobile = fakeEnemy(100, 0);
    const stationary = fakeEnemy(-100, 0, { stationary: true });
    const scene = makeProjScene([mobile, stationary]);
    const p = { x: 0, y: 0, force: { radius: 300, strength: 200, sign: -1, tickMs: 250 } };

    scene._tickTravelForce(p);

    expect(mobile.x).not.toBe(100);
    expect(stationary.x).toBe(-100);
    expect(stationary.y).toBe(0);
  });

  it("_updateHazards' field tick (Gravity Well) pulls a mobile enemy but leaves a stationary one in place", () => {
    const mobile = fakeEnemy(100, 0);
    const stationary = fakeEnemy(-100, 0, { stationary: true });
    const scene = makeProjScene([mobile, stationary]);
    scene.hazards.push({
      x: 0, y: 0, kind: 'field', radius: 300, visualRadius: 65, life: 5, armIn: 0,
      force: { strength: 330, sign: -1 },
    });

    scene._updateHazards(0.1);

    expect(mobile.x).not.toBe(100);
    expect(stationary.x).toBe(-100);
    expect(stationary.y).toBe(0);
  });

  it('_fireWave (Repulsor Pulse push) shoves a mobile enemy but leaves a stationary one in place', () => {
    const mobile = fakeEnemy(50, 0);
    const stationary = fakeEnemy(-50, 0, { stationary: true });
    const scene = {
      enemies: [mobile, stationary],
      time: { delayedCall: vi.fn() },
      fx: { clear: vi.fn() },
      _damageEnemyAt: vi.fn(),
    };
    Object.assign(scene, FiringMixin);
    const w = {
      weapon: {
        damage: 10, category: 'support',
        delivery: { force: { radius: 200, strength: 320, sign: 1, coneDeg: 360 } },
      },
    };

    scene._fireWave(w, 0, 0, 0, {});

    expect(mobile.x).not.toBe(50);
    expect(stationary.x).toBe(-50);
    expect(stationary.y).toBe(0);
    // Both still take the wave's damage — only position is locked for the stationary one.
    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(2);
  });
});
