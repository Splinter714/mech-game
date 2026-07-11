// #92 (corrected per playtest 2026-07-10): "is the blocking on ground enemies preventing me
// from stomping the tanks? it should be instant smash." The original crush mechanic applied
// gradual DPS over several seconds of sustained pressing, which read as "stuck/blocked" rather
// than "destroying the tank." `_crushTankAt` (world.js) must now destroy a tank in ONE call,
// while the sibling outpost-stomp mechanic (`_stompBuildingAt`, #41) is unaffected — it's not in
// scope for this fix and should still chip down gradually over multiple calls.
import { describe, it, expect, vi } from 'vitest';
import { WorldMixin } from './world.js';

// A minimal HpBody-shaped enemy: single hp pool, mirrors data/HpBody.js's interface just enough
// for _crushTankAt/_damageEnemyAt-style callers (the real _damageEnemyAt is stubbed out below so
// we're only asserting what damage `_crushTankAt` computes and passes through, not the full
// damage-application/death pipeline — that pipeline is exercised elsewhere, unchanged).
function makeTank(hp) {
  return {
    x: 10, y: 10, behavior: 'tank', kind: 'tank',
    mech: { hp, maxHp: 160, isDestroyed: () => hp <= 0 },
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

describe('_crushTankAt — instant tank kill on contact (#92 correction)', () => {
  it('deals damage >= the tank\'s full remaining hp in a SINGLE call', () => {
    const { scene, damageCalls } = makeScene();
    const tank = makeTank(160);
    scene._crushTankAt(tank);
    expect(damageCalls.length).toBe(1);
    expect(damageCalls[0]).toBeGreaterThanOrEqual(160);
  });

  it('still works (dies in one hit) for a tank already partially damaged', () => {
    const { scene, damageCalls } = makeScene();
    const tank = makeTank(37);
    scene._crushTankAt(tank);
    expect(damageCalls.length).toBe(1);
    expect(damageCalls[0]).toBeGreaterThanOrEqual(37);
  });

  it('is a no-op against an already-destroyed tank (no double-kill call)', () => {
    const { scene, damageCalls } = makeScene();
    const tank = makeTank(0);
    scene._crushTankAt(tank);
    expect(damageCalls.length).toBe(0);
  });

  it('does NOT scale with drive-in speed the way the old gradual crush did — full damage '
    + 'regardless of `this.speed`', () => {
    const { scene, damageCalls } = makeScene();
    scene.speed = 0; // stationary — the old DPS-based crush would deal ~35% damage at rest
    const tank = makeTank(160);
    scene._crushTankAt(tank);
    expect(damageCalls[0]).toBeGreaterThanOrEqual(160);
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
