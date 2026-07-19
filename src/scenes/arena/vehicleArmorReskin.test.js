// #300: shooting an armored non-mech unit (tank / quadruped) must visibly STRIP its plating the
// moment its armor pool empties. Mechs already did this via `reskinMech` on `res.armorBrokeNow`;
// vehicles had no reskin path at all. This exercises the real CombatMixin `_damageEnemyAt` and the
// real EnemiesMixin `_reskinVehicle` against a minimal fake scene (same harness style as
// projectiles.test.js / crush.test.js) and asserts the sprite texture actually swaps — and only
// on the hit that breaks the armor, not on every hit.
import { describe, it, expect, vi } from 'vitest';
// enemies.js pulls in Phaser transitively (scene/sprite construction), which throws under
// vitest's node env — stubbed out the same way vehicleFire.test.js/flyerCover.test.js do. Nothing
// under test here touches it.
vi.mock('phaser', () => ({ default: {} }));

import { CombatMixin } from './combat.js';
import { EnemiesMixin } from './enemies.js';
import { HpBody } from '../../data/HpBody.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { ARMORED_SUFFIX } from '../../art/index.js';

const BASE_KEY = 'vehicle_tank_0';

function makeVehicle(kindId = 'tank') {
  const def = ENEMY_KINDS[kindId];
  const body = new HpBody(def);
  const sprite = (tex) => ({ tex, setTexture(t) { this.tex = t; return this; } });
  const view = { hull: sprite(`${BASE_KEY}${ARMORED_SUFFIX}_hull`), turret: sprite(`${BASE_KEY}${ARMORED_SUFFIX}_turret`) };
  return {
    key: BASE_KEY, texKey: BASE_KEY + ARMORED_SUFFIX, mech: body, view,
    x: 0, y: 0, kind: def.kind, kindDef: def, hullFrame: 0,
  };
}

function makeScene(e) {
  const scene = {
    enemies: [e],
    px: 0, py: 0,
    time: { now: 0 },
    _wakeBase: vi.fn(),
    _hitFx: vi.fn(), _impactFx: vi.fn(), _deathFx: vi.fn(),
    _floatText: vi.fn(), _removeEnemy: vi.fn(),
    _maybeDropPowerup: vi.fn(), _maybeDropSalvage: vi.fn(),
    _shieldHitFx: vi.fn(),
  };
  Object.assign(scene, CombatMixin, EnemiesMixin);
  return scene;
}

describe('an armored vehicle strips its plating when the armor pool empties (#300)', () => {
  it('keeps the plated texture set while armor holds, and swaps to the bare set on the breaking hit', () => {
    const e = makeVehicle('tank');
    const scene = makeScene(e);
    const armor = ENEMY_KINDS.tank.armor;
    expect(armor).toBeGreaterThan(0);

    // Chip the armor without emptying it — still plated.
    scene._damageEnemyAt(e, 0, 0, armor - 1);
    expect(e.mech.hasArmor()).toBe(true);
    expect(e.texKey).toBe(BASE_KEY + ARMORED_SUFFIX);
    expect(e.view.hull.tex).toBe(`${BASE_KEY}${ARMORED_SUFFIX}_hull`);

    // The hit that finishes the armor strips the plating.
    scene._damageEnemyAt(e, 0, 0, 1);
    expect(e.mech.hasArmor()).toBe(false);
    expect(e.texKey).toBe(BASE_KEY);
    expect(e.view.hull.tex).toBe(`${BASE_KEY}_hull`);
    expect(e.view.turret.tex).toBe(`${BASE_KEY}_turret`);

    // Further hits (now chewing structure) don't churn the textures again.
    const before = e.view.hull.tex;
    scene._damageEnemyAt(e, 0, 0, 5);
    expect(e.view.hull.tex).toBe(before);
  });

  it('re-plates on repair (the arena reset path)', () => {
    const e = makeVehicle('tank');
    const scene = makeScene(e);
    scene._damageEnemyAt(e, 0, 0, ENEMY_KINDS.tank.armor);
    expect(e.texKey).toBe(BASE_KEY);

    e.mech.repairAll();
    scene._reskinVehicle(e);
    expect(e.texKey).toBe(BASE_KEY + ARMORED_SUFFIX);
    expect(e.view.hull.tex).toBe(`${BASE_KEY}${ARMORED_SUFFIX}_hull`);
  });

  it('uses the CURRENT walk-cycle frame when re-pointing a legged kind (quadruped)', () => {
    const e = makeVehicle('quadruped');
    e.key = 'vehicle_quadruped_0';
    e.texKey = `vehicle_quadruped_0${ARMORED_SUFFIX}`;
    e.hullFrame = 2;
    e.view.hull.tex = `vehicle_quadruped_0${ARMORED_SUFFIX}_hull_2`;
    const scene = makeScene(e);
    expect(ENEMY_KINDS.quadruped.legFrames).toBeGreaterThan(0);

    // The quadruped carries all three layers — one hit big enough to burn through the shield
    // AND the armor pool in the same swing is what trips `armorBrokeNow`.
    scene._damageEnemyAt(e, 0, 0, (ENEMY_KINDS.quadruped.shield?.max ?? 0) + ENEMY_KINDS.quadruped.armor);
    expect(e.mech.hasArmor()).toBe(false);
    expect(e.view.hull.tex).toBe('vehicle_quadruped_0_hull_2');
  });

  it('leaves an unarmored kind (drone) entirely alone', () => {
    const def = ENEMY_KINDS.drone;
    expect(def.armor ?? 0).toBe(0);
    const e = makeVehicle('drone');
    e.texKey = BASE_KEY;
    e.view.hull.tex = `${BASE_KEY}_hull`;
    const scene = makeScene(e);
    scene._damageEnemyAt(e, 0, 0, 1);   // #299: a drone only has 3 hp — keep it alive
    expect(e.texKey).toBe(BASE_KEY);
    expect(e.view.hull.tex).toBe(`${BASE_KEY}_hull`);
  });
});
