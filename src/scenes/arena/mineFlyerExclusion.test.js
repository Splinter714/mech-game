// Polish pass — Proximity Mines (timedCharge): flying units don't trigger a planted mine.
// Exercises `_updateHazards` directly against a minimal fake scene, mirroring fuse.test.js.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';

function fakeEnemy(x, y, flying = false) {
  return { x, y, flying, mech: { isDestroyed: () => false } };
}

// `_drawHazard` (called every live frame, including a no-op mine tick) draws into `projFx` —
// a minimal chainable stub covering the Graphics calls it makes, mirroring the real Phaser API
// shape closely enough to no-op harmlessly.
function fakeGraphics() {
  const g = {
    lineStyle: () => g, strokeCircle: () => g, fillStyle: () => g, fillCircle: () => g,
  };
  return g;
}

function makeScene(enemies = []) {
  const scene = {
    enemies,
    players: [],
    hazards: [],
    time: { now: 0 },
    projFx: fakeGraphics(),
    _damageEnemyAt: vi.fn(),
    _damagePlayerAt: vi.fn(),
    _impactFx: vi.fn(),
  };
  return Object.assign(scene, ProjectilesMixin);
}

function armedPlayerMine(x, y) {
  // `weaponId` is just relayed through to `_impactFx`/damage-event metadata — no test here
  // asserts on its value, so a placeholder avoids hardcoding a real weapon id (the
  // architecture guard keeps scenes/arena/*.js weapon-agnostic).
  return { x, y, kind: 'mine', radius: 55, damage: 30, armIn: 0, life: 7, owner: 'player', color: 0, weaponId: 'mineHazard' };
}

describe('mine hazard proximity — flying units never trigger it', () => {
  it('a flying enemy standing on top of an armed mine does not detonate it', () => {
    const flyer = fakeEnemy(0, 0, true);
    const scene = makeScene([flyer]);
    scene.hazards.push(armedPlayerMine(0, 0));

    scene._updateHazards(0.1);

    expect(scene.hazards).toHaveLength(1);
    expect(scene.hazards[0].dead).toBeFalsy();
    expect(scene._damageEnemyAt).not.toHaveBeenCalled();
  });

  it('a ground enemy at the same spot still triggers it', () => {
    const ground = fakeEnemy(0, 0, false);
    const scene = makeScene([ground]);
    scene.hazards.push(armedPlayerMine(0, 0));

    scene._updateHazards(0.1);

    expect(scene.hazards).toHaveLength(0); // detonated and filtered out
    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
  });

  it('a flying enemy standing on the mine does not shield a nearby ground enemy from it', () => {
    const flyer = fakeEnemy(0, 0, true);
    const ground = fakeEnemy(5, 0, false);
    const scene = makeScene([flyer, ground]);
    scene.hazards.push(armedPlayerMine(0, 0));

    scene._updateHazards(0.1);

    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
    expect(scene._damageEnemyAt.mock.calls[0][0]).toBe(ground);
  });
});
