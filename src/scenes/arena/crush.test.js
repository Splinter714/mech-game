// #92 (corrected per playtest 2026-07-10): "is the blocking on ground enemies preventing me
// from stomping the tanks? it should be instant smash." The original crush mechanic applied
// gradual DPS over several seconds of sustained pressing, which read as "stuck/blocked" rather
// than "destroying the tank." `_crushGroundEnemyAt` (world.js) must now destroy a tank in ONE
// call. (The sibling outpost-stomp mechanic `_stompBuildingAt` (#41) that used to live alongside
// it was deleted by #365 — buildings take no damage from being walked into any more.)
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
    x: 10, y: 10, behavior: 'tank', kind: 'tank', kindDef: { size: 'small' },
    mech: { hp, maxHp: 160, isDestroyed: () => hp <= 0 },
  };
}

function makeInfantry(hp) {
  return {
    x: 10, y: 10, behavior: 'infantry', kind: 'infantry', kindDef: { size: 'small' },
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
  // implementation — mirrors projectiles.test.js's pattern. Keeps terrain damage inert (nothing
  // in the crush path should reach it) without touching terrain/FX.
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

// #269: the #104 crush-eligibility scope moved from a hardcoded `behavior`-keyed Set
// (CRUSHABLE_BEHAVIORS, now removed) to the formal 'small'/'large' size tier, queried via
// shared.js's `isSmallUnit`/`unitSize`. Same real-world scope (tank + infantry, nothing else) —
// this is a pure refactor of HOW it's expressed, verified identical here.
describe('isSmallUnit/unitSize (#269) — same #104 scope for instant-crush-on-contact', () => {
  it('is true for tank and infantry (size: small), false for other vehicle kinds', async () => {
    const { isSmallUnit, unitSize } = await import('./shared.js');
    const tank = { kind: 'tank', kindDef: { size: 'small' } };
    const infantry = { kind: 'infantry', kindDef: { size: 'small' } };
    const turret = { kind: 'turret', kindDef: { size: 'large' } };
    const drone = { kind: 'drone', kindDef: { size: 'large' } };
    const helicopter = { kind: 'helicopter', kindDef: { size: 'large' } };
    const carrier = { kind: 'carrier', kindDef: { size: 'large' } };
    expect(isSmallUnit(tank)).toBe(true);
    expect(isSmallUnit(infantry)).toBe(true);
    expect(isSmallUnit(turret)).toBe(false);
    expect(isSmallUnit(drone)).toBe(false);
    expect(isSmallUnit(helicopter)).toBe(false);
    expect(isSmallUnit(carrier)).toBe(false);
    expect(unitSize(tank)).toBe('small');
    expect(unitSize(turret)).toBe('large');
  });

  it('is always false/large for a mech enemy (kind "mech" or undefined — no kindDef at all)', async () => {
    const { isSmallUnit, unitSize } = await import('./shared.js');
    expect(isSmallUnit({ kind: 'mech' })).toBe(false);
    expect(isSmallUnit({ kind: undefined })).toBe(false);
    expect(unitSize({ kind: 'mech' })).toBe('large');
    expect(unitSize({})).toBe('large');
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
    const tank = { x: 0, y: 0, behavior: 'tank', kind: 'tank', kindDef: { scale: 0.48, size: 'small' },
      mech: { isDestroyed: () => false } };
    const r = groundEnemyRadius(tank);
    const scene = makeSceneWithEnemies([tank]);
    // Just past the tight blocking radius: general blocking says no...
    expect(scene._blockedByGroundEnemy(r + 5, 0)).toBeNull();
    // ...but the crush trigger (player's extra reach) still finds it.
    expect(scene._crushTargetAt(r + 5, 0)).toBe(tank);
  });

  it('ignores a non-crushable ground enemy (mech/turret) even within the bigger crush radius', () => {
    const turret = { x: 0, y: 0, behavior: 'turret', kind: 'turret', kindDef: { size: 'large' },
      mech: { isDestroyed: () => false } };
    const scene = makeSceneWithEnemies([turret]);
    expect(scene._crushTargetAt(5, 0)).toBeNull();
    // But it still blocks movement normally.
    expect(scene._blockedByGroundEnemy(5, 0)).toBe(turret);
  });

  it('ignores a flying kind and an already-destroyed enemy', () => {
    const flyingTank = { x: 0, y: 0, behavior: 'tank', kind: 'tank', flying: true, kindDef: { size: 'small' },
      mech: { isDestroyed: () => false } };
    const deadTank = { x: 0, y: 0, behavior: 'tank', kind: 'tank', kindDef: { size: 'small' },
      mech: { isDestroyed: () => true } };
    const scene = makeSceneWithEnemies([flyingTank, deadTank]);
    expect(scene._crushTargetAt(0, 0)).toBeNull();
  });
});

// #106: a crush kill must be TAGGED as such when it enters the damage pipeline, so the powerup
// drop roll can swap the toughness curve for the flat CRUSH_KILL_DROP_CHANCE (a stomp is free —
// it shouldn't pay out like a fought kill). This asserts the flag actually reaches
// `_damageEnemyAt`; the chance math itself is covered in data/powerups.test.js.
describe('#106: _crushGroundEnemyAt flags the kill as a crush', () => {
  it('passes isCrush = true as the 6th arg to _damageEnemyAt', () => {
    const { scene } = makeScene();
    const tank = makeTank();
    scene._crushGroundEnemyAt(tank);
    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
    expect(scene._damageEnemyAt.mock.calls[0][5]).toBe(true);
  });
});
