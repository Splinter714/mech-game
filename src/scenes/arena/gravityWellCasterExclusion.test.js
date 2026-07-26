// #491 follow-up — Jackson found live: an enemy mech mounted with Gravity Well pulled ITSELF.
// The earlier #491 fix (forceStationaryExclusion.test.js) excluded STATIONARY units from the
// field's pull, but a MOBILE enemy carrying the weapon is itself a living, mobile entry in
// `this.enemies` — the very list its own field pulls — so it dragged itself toward its own
// hazard's centre. The fix threads the firing entity through as `caster` (enemies.js
// `_fireEnemyShots` -> firing.js `_spawnProjectile` -> projectiles.js `_plantHazard`) and
// excludes it from the pull loop in `_updateHazards`'s 'field' branch.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';

function fakeEnemy(x, y) {
  return { x, y, mech: { isDestroyed: () => false }, kindDef: { move: { maxSpeed: 100 } } };
}

function fakeGraphics() {
  const g = { lineStyle: () => g, strokeCircle: () => g, fillStyle: () => g, fillCircle: () => g };
  return g;
}

function makeScene(enemies) {
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

describe('#491 follow-up — Gravity Well excludes its own caster from the pull', () => {
  it('an enemy standing at the field\'s own centre (its planted Gravity Well) is not pulled', () => {
    const caster = fakeEnemy(0, 0);       // planted the field, and happens to be sitting on it
    const bystander = fakeEnemy(100, 0);  // a different mobile enemy, should still get pulled
    const scene = makeScene([caster, bystander]);
    scene.hazards.push({
      x: 0, y: 0, kind: 'field', radius: 300, visualRadius: 65, life: 5, armIn: 0,
      force: { strength: 330, sign: -1 }, caster,
    });

    scene._updateHazards(0.1);

    expect(caster.x).toBe(0);
    expect(caster.y).toBe(0);
    expect(bystander.x).not.toBe(100);
  });

  it('with no caster stamped (a player-planted field, unchanged behaviour) every mobile enemy is pulled', () => {
    const a = fakeEnemy(100, 0);
    const b = fakeEnemy(0, 100);
    const scene = makeScene([a, b]);
    scene.hazards.push({
      x: 0, y: 0, kind: 'field', radius: 300, visualRadius: 65, life: 5, armIn: 0,
      force: { strength: 330, sign: -1 }, caster: null,
    });

    scene._updateHazards(0.1);

    expect(a.x).not.toBe(100);
    expect(b.y).not.toBe(100);
  });
});
