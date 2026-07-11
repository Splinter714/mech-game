// #92 (corrected per playtest 2026-07-10): "is the blocking on ground enemies preventing me
// from stomping the tanks? it should be instant smash." The original crush mechanic applied
// gradual DPS over several seconds of sustained pressing, which read as "stuck/blocked" rather
// than "destroying the tank." `_crushGroundEnemyAt` (world.js) must now destroy a tank in ONE
// call, while the sibling outpost-stomp mechanic (`_stompBuildingAt`, #41) is unaffected — it's
// not in scope for this fix and should still chip down gradually over multiple calls.
// #104 (playtest: infantry — the weakest unit in the game — "should be stompable" too) extends
// the exact same instant-kill treatment to infantry; `_crushGroundEnemyAt` itself is generic (it
// was renamed from `_crushTankAt`), so the same assertions below are re-run against an infantry
// trooper to confirm it composes.
import { describe, it, expect, vi } from 'vitest';
import { WorldMixin } from './world.js';

// A minimal HpBody-shaped enemy: single hp pool, mirrors data/HpBody.js's interface just enough
// for _crushGroundEnemyAt/_damageEnemyAt-style callers (the real _damageEnemyAt is stubbed out
// below so we're only asserting what damage `_crushGroundEnemyAt` computes and passes through,
// not the full damage-application/death pipeline — that pipeline is exercised elsewhere,
// unchanged).
function makeTank(hp) {
  return {
    x: 10, y: 10, behavior: 'tank', kind: 'tank',
    mech: { hp, maxHp: 160, isDestroyed: () => hp <= 0 },
  };
}

function makeInfantry(hp) {
  return {
    x: 10, y: 10, behavior: 'infantry', kind: 'infantry',
    mech: { hp, maxHp: 6, isDestroyed: () => hp <= 0 },
  };
}

function makeScene() {
  const damageCalls = [];
  const scene = {
    speed: 999, mech: { movement: { maxSpeed: 100 } },
    buildingHp: new Map([['0,0', 60]]),
    coverHp: new Map(),
    terrain: new Map(),
    tileImages: new Map(),
    _damageEnemyAt: vi.fn((e, x, y, dmg) => { damageCalls.push(dmg); }),
  };
  Object.assign(scene, WorldMixin);
  // Stub out AFTER mixing in WorldMixin so it overrides the mixin's real (Phaser-touching)
  // implementation — mirrors projectiles.test.js's pattern. Mirrors the real gradual chip-down
  // behavior against buildingHp for the stomp assertions, without touching terrain/FX.
  scene._damageBuildingAt = vi.fn(function (x, y, amount) {
    const hp = Math.max(0, (this.buildingHp.get('0,0') ?? 0) - amount);
    this.buildingHp.set('0,0', hp);
    return hp <= 0;
  });
  return { scene, damageCalls };
}

describe('_crushGroundEnemyAt — instant tank kill on contact (#92 correction)', () => {
  it('deals damage >= the tank\'s full remaining hp in a SINGLE call', () => {
    const { scene, damageCalls } = makeScene();
    const tank = makeTank(160);
    scene._crushGroundEnemyAt(tank);
    expect(damageCalls.length).toBe(1);
    expect(damageCalls[0]).toBeGreaterThanOrEqual(160);
  });

  it('still works (dies in one hit) for a tank already partially damaged', () => {
    const { scene, damageCalls } = makeScene();
    const tank = makeTank(37);
    scene._crushGroundEnemyAt(tank);
    expect(damageCalls.length).toBe(1);
    expect(damageCalls[0]).toBeGreaterThanOrEqual(37);
  });

  it('is a no-op against an already-destroyed tank (no double-kill call)', () => {
    const { scene, damageCalls } = makeScene();
    const tank = makeTank(0);
    scene._crushGroundEnemyAt(tank);
    expect(damageCalls.length).toBe(0);
  });

  it('does NOT scale with drive-in speed the way the old gradual crush did — full damage '
    + 'regardless of `this.speed`', () => {
    const { scene, damageCalls } = makeScene();
    scene.speed = 0; // stationary — the old DPS-based crush would deal ~35% damage at rest
    const tank = makeTank(160);
    scene._crushGroundEnemyAt(tank);
    expect(damageCalls[0]).toBeGreaterThanOrEqual(160);
  });
});

describe('_crushGroundEnemyAt — extended to infantry, the weakest unit in the game (#104)', () => {
  it('deals damage >= the trooper\'s full remaining hp in a SINGLE call', () => {
    const { scene, damageCalls } = makeScene();
    const trooper = makeInfantry(6);
    scene._crushGroundEnemyAt(trooper);
    expect(damageCalls.length).toBe(1);
    expect(damageCalls[0]).toBeGreaterThanOrEqual(6);
  });

  it('is a no-op against an already-destroyed trooper (no double-kill call)', () => {
    const { scene, damageCalls } = makeScene();
    const trooper = makeInfantry(0);
    scene._crushGroundEnemyAt(trooper);
    expect(damageCalls.length).toBe(0);
  });

  it('does NOT scale with drive-in speed — full damage regardless of `this.speed`', () => {
    const { scene, damageCalls } = makeScene();
    scene.speed = 0;
    const trooper = makeInfantry(6);
    scene._crushGroundEnemyAt(trooper);
    expect(damageCalls[0]).toBeGreaterThanOrEqual(6);
  });
});

describe('CRUSHABLE_BEHAVIORS — the #104 scope for instant-crush-on-contact', () => {
  it('includes tank and infantry, and excludes other ground behaviors', async () => {
    const { CRUSHABLE_BEHAVIORS } = await import('./shared.js');
    expect(CRUSHABLE_BEHAVIORS.has('tank')).toBe(true);
    expect(CRUSHABLE_BEHAVIORS.has('infantry')).toBe(true);
    expect(CRUSHABLE_BEHAVIORS.has('turret')).toBe(false);
    expect(CRUSHABLE_BEHAVIORS.has(undefined)).toBe(false); // mech enemies (behavior undefined)
  });
});

// #112: the crush TRIGGER (this scan) must be looser than plain ground-enemy blocking
// (`_blockedByGroundEnemy`), which stays untouched. Build a real `this.enemies` list (the two
// helpers above don't need one since they operate on an already-found enemy) to exercise the
// actual scan in world.js.
describe('_crushTargetAt — the #112 looser crush-trigger scan (bigger than plain blocking)', () => {
  function makeSceneWithEnemies(enemies) {
    const scene = { enemies };
    Object.assign(scene, WorldMixin);
    return scene;
  }

  it('finds a crushable tank from farther away than `_blockedByGroundEnemy` would', async () => {
    const { groundEnemyRadius } = await import('./shared.js');
    const tank = { x: 0, y: 0, behavior: 'tank', kind: 'tank', kindDef: { scale: 0.48 },
      mech: { isDestroyed: () => false } };
    const r = groundEnemyRadius(tank);
    const scene = makeSceneWithEnemies([tank]);
    // Just past the tight blocking radius: general blocking says no...
    expect(scene._blockedByGroundEnemy(r + 5, 0)).toBeNull();
    // ...but the crush trigger (player's extra reach) still finds it.
    expect(scene._crushTargetAt(r + 5, 0)).toBe(tank);
  });

  it('ignores a non-crushable ground enemy (mech/turret) even within the bigger crush radius', () => {
    const turret = { x: 0, y: 0, behavior: 'turret', kind: 'turret', kindDef: {},
      mech: { isDestroyed: () => false } };
    const scene = makeSceneWithEnemies([turret]);
    expect(scene._crushTargetAt(5, 0)).toBeNull();
    // But it still blocks movement normally.
    expect(scene._blockedByGroundEnemy(5, 0)).toBe(turret);
  });

  it('ignores a flying kind and an already-destroyed enemy', () => {
    const flyingTank = { x: 0, y: 0, behavior: 'tank', kind: 'tank', flying: true, kindDef: {},
      mech: { isDestroyed: () => false } };
    const deadTank = { x: 0, y: 0, behavior: 'tank', kind: 'tank', kindDef: {},
      mech: { isDestroyed: () => true } };
    const scene = makeSceneWithEnemies([flyingTank, deadTank]);
    expect(scene._crushTargetAt(0, 0)).toBeNull();
  });
});

describe('_stompBuildingAt — outpost stomp keeps its ORIGINAL gradual behavior, unaffected by '
  + 'the tank-only instant-kill fix (#41 unchanged)', () => {
  it('takes multiple calls to flatten a building — a single call does not destroy it outright', () => {
    const { scene } = makeScene();
    const dt = 1 / 60; // one frame
    scene._stompBuildingAt(0, 0, dt);
    expect(scene.buildingHp.get('0,0')).toBeGreaterThan(0);
  });

  it('flattens the building over several frames of sustained pressing, not instantly', () => {
    const { scene } = makeScene();
    const dt = 1 / 60;
    let destroyed = false;
    for (let i = 0; i < 600 && !destroyed; i++) {
      destroyed = scene.buildingHp.get('0,0') <= 0;
      if (!destroyed) scene._stompBuildingAt(0, 0, dt);
    }
    expect(scene.buildingHp.get('0,0')).toBeLessThanOrEqual(0);
    expect(i0Calls(scene)).toBeGreaterThan(1);
  });
});

// How many times _damageBuildingAt was actually invoked (sanity: gradual means "more than once").
function i0Calls(scene) {
  return scene._damageBuildingAt.mock.calls.length;
}
