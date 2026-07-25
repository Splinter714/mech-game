// #500 Cloak / #507 Smoke Screen — the shared `isPlayerStealthed` predicate plus the smoke
// cloud spawn/despawn lifecycle. Mirrors friendlyDrones.test.js's pattern.
import { describe, it, expect, vi } from 'vitest';
import { StealthMixin, isPlayerStealthed } from './stealth.js';

function fakeView() {
  return { setStrokeStyle() { return this; }, setDepth() { return this; }, destroy: vi.fn() };
}

function makeScene() {
  const scene = { players: [], add: { circle: vi.fn(() => fakeView()) } };
  return Object.assign(scene, StealthMixin);
}

describe('isPlayerStealthed', () => {
  it('true while the player has an active cloak effect', () => {
    const player = {
      x: 0, y: 0,
      mech: { abilityMounts: { abilityX: 'cloak' } },
      abilityStates: { abilityX: { active: true, burstRemaining: 1, cooldown: 0 } },
    };
    expect(isPlayerStealthed({ players: [player] }, player)).toBe(true);
  });

  it('true while standing inside ANY live player\'s smoke cloud, not just their own', () => {
    const caster = { x: 100, y: 0, mech: { abilityMounts: {} }, abilityStates: {}, smokeCloud: { x: 100, y: 0, radius: 50 } };
    const other = { x: 110, y: 0, mech: { abilityMounts: {} }, abilityStates: {} };
    expect(isPlayerStealthed({ players: [caster, other] }, other)).toBe(true);
  });

  it('false with no cloak and no covering cloud nearby', () => {
    const player = { x: 9999, y: 9999, mech: { abilityMounts: {} }, abilityStates: {} };
    const caster = { x: 0, y: 0, smokeCloud: { x: 0, y: 0, radius: 50 } };
    expect(isPlayerStealthed({ players: [player, caster] }, player)).toBe(false);
  });
});

describe('#507 _spawnSmokeCloud / _despawnSmokeCloud', () => {
  it('creates a cloud at the player\'s current position with the given radius', () => {
    const scene = makeScene();
    const player = { x: 30, y: 40 };
    scene._spawnSmokeCloud(player, 100);
    expect(player.smokeCloud).toMatchObject({ x: 30, y: 40, radius: 100 });
    expect(scene.add.circle).toHaveBeenCalledWith(30, 40, 100, 0xc8d2dd, 0.28);
  });

  it('re-casting replaces the caster\'s own cloud rather than leaking a view', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0 };
    scene._spawnSmokeCloud(player, 100);
    const firstView = player.smokeCloud.view;
    scene._spawnSmokeCloud(player, 100);
    expect(firstView.destroy).toHaveBeenCalledTimes(1);
  });

  it('despawn destroys the view and clears the slot', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0 };
    scene._spawnSmokeCloud(player, 100);
    const view = player.smokeCloud.view;
    scene._despawnSmokeCloud(player);
    expect(view.destroy).toHaveBeenCalledTimes(1);
    expect(player.smokeCloud).toBe(null);
  });
});
