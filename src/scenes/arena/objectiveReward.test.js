// #315: the Armor Patch left the random drop pool and became the GUARANTEED reward for
// destroying a base's objective hex — exactly one per objective, no roll. These tests exercise
// the real bases-mixin hook (`_onTerrainCollapsed` → `_maybeDropObjectiveReward`) against a
// stub scene, so the "exactly one, only for an objective hex" contract is pinned independently
// of Phaser. The data-side half (armorPatch absent from `pickPowerupType`) lives in
// data/powerups.test.js.
import { describe, it, expect, beforeEach } from 'vitest';
import { BasesMixin } from './bases.js';
import { POWERUPS } from '../../data/powerups.js';
import { hexToPixel } from '../../data/hexgrid.js';

// Just enough scene for the collapse hook: the bases list it searches, and a `spawnPowerup` spy
// standing in for the real arena mixin's world-space collectible spawn.
function makeScene(bases = []) {
  const spawned = [];
  const scene = {
    bases, enemies: [], time: { now: 0 },
    _dockResupplyStates: new Map(),
    spawnPowerup(x, y, typeId) {
      const pk = { x, y, type: typeId };
      spawned.push(pk);
      return pk;
    },
    spawned,
  };
  Object.assign(scene, BasesMixin);
  return scene;
}

const BASES = () => ([
  { id: 'base0', center: { q: 0, r: 0 }, objectiveHex: { q: 2, r: -1 } },
  { id: 'base1', center: { q: 10, r: 0 }, objectiveHex: { q: 11, r: 3 } },
]);

describe('#315: destroying a base objective drops exactly one Armor Patch', () => {
  let scene;
  beforeEach(() => { scene = makeScene(BASES()); });

  it('drops one, and it is an armorPatch', () => {
    scene._onTerrainCollapsed('2,-1');
    expect(scene.spawned).toHaveLength(1);
    expect(scene.spawned[0].type).toBe('armorPatch');
  });

  it('drops it at the objective hex\'s own world position', () => {
    const { x, y } = hexToPixel(2, -1);
    scene._onTerrainCollapsed('2,-1');
    expect(scene.spawned[0].x).toBeCloseTo(x, 6);
    expect(scene.spawned[0].y).toBeCloseTo(y, 6);
  });

  it('is GUARANTEED — no roll: 200 fresh scenes all drop, whatever Math.random does', () => {
    for (let i = 0; i < 200; i++) {
      const s = makeScene(BASES());
      s._onTerrainCollapsed('2,-1');
      expect(s.spawned).toHaveLength(1);
    }
  });

  it('EXACTLY one — a repeated collapse signal for the same hex never awards a second', () => {
    scene._onTerrainCollapsed('2,-1');
    scene._onTerrainCollapsed('2,-1');
    scene._onTerrainCollapsed('2,-1');
    expect(scene.spawned).toHaveLength(1);
  });

  it('one per BASE — each objective pays out its own, independently', () => {
    scene._onTerrainCollapsed('2,-1');
    scene._onTerrainCollapsed('11,3');
    expect(scene.spawned).toHaveLength(2);
    expect(scene.spawned.every((p) => p.type === 'armorPatch')).toBe(true);
    // ...and still exactly one each after repeats of both.
    scene._onTerrainCollapsed('2,-1');
    scene._onTerrainCollapsed('11,3');
    expect(scene.spawned).toHaveLength(2);
  });

  it('is a NO-OP for every other destructible hex (docks, walls, cover, turret bunkers)', () => {
    for (const k of ['0,0', '10,0', '3,-1', '-7,4', '11,4']) scene._onTerrainCollapsed(k);
    expect(scene.spawned).toHaveLength(0);
  });

  it('is a no-op for a base whose objectiveHex was cleared to null by worldgen re-validation', () => {
    const s = makeScene([{ id: 'base0', center: { q: 0, r: 0 }, objectiveHex: null }]);
    s._onTerrainCollapsed('0,0');
    expect(s.spawned).toHaveLength(0);
  });

  it('does not throw when the scene has no bases at all', () => {
    const s = makeScene(undefined);
    expect(() => s._onTerrainCollapsed('0,0')).not.toThrow();
  });

  it('the awarded powerup applies its repair INSTANTLY on pickup, on top of #381\'s free-ammo window', () => {
    expect(POWERUPS.armorPatch.instant).toBe(true);
    expect(POWERUPS.armorPatch.duration).toBe(10);   // #381: the free-ammo window (repair stays instant)
  });
});
