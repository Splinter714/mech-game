// #500 Cloak / #507 Smoke Screen — the shared `isPlayerStealthed` predicate, the LOS-blocking
// `smokeBlocksPoint` (#507 follow-up — the cloud now actually blocks the per-enemy firing-lane
// raycast, not just noise-aggro), and the smoke cloud (multi-puff) spawn/despawn lifecycle.
// Mirrors friendlyDrones.test.js's pattern.
import { describe, it, expect, vi } from 'vitest';
import { StealthMixin, isPlayerStealthed, smokeBlocksPoint, ensureSmokeTextures, SMOKE_TEX_KEYS } from './stealth.js';

function fakeView() {
  const view = {
    setDepth() { return this; },
    setScale() { return this; },
    setRotation() { return this; },
    setAlpha() { return this; },
    destroy: vi.fn(),
  };
  return view;
}

// #507 third pass: puffs are now stamped `add.image` instances of a baked texture (see
// stealth.js's `bakeSmokePuffTexture`/`ensureSmokeTextures`) rather than `add.circle` Graphics
// shapes. `textures.exists` always reports true so the real canvas-gradient bake — which needs a
// real Phaser canvas stack this test has no business building — is never exercised here, same
// pattern as friendlyDrones.test.js. These tests assert spawn/despawn orchestration only.
function makeScene() {
  const scene = {
    players: [],
    textures: { exists: () => true },
    add: { image: vi.fn(() => fakeView()) },
    tweens: { add: vi.fn(), killTweensOf: vi.fn() },
  };
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

describe('#507 smokeBlocksPoint — the LOS-blocking predicate world.js\'s raycast consumes', () => {
  it('true for a point inside a live cloud', () => {
    const players = [{ smokeCloud: { x: 0, y: 0, radius: 50 } }];
    expect(smokeBlocksPoint(players, 10, 10)).toBe(true);
  });

  it('false for a point outside every cloud, and with no players/clouds at all', () => {
    const players = [{ smokeCloud: { x: 0, y: 0, radius: 50 } }];
    expect(smokeBlocksPoint(players, 500, 500)).toBe(false);
    expect(smokeBlocksPoint([], 0, 0)).toBe(false);
    expect(smokeBlocksPoint(undefined, 0, 0)).toBe(false);
  });

  it('true if ANY player\'s cloud covers the point, not just the first', () => {
    const players = [{ smokeCloud: null }, { smokeCloud: { x: 200, y: 200, radius: 40 } }];
    expect(smokeBlocksPoint(players, 210, 200)).toBe(true);
  });
});

describe('#507 _spawnSmokeCloud / _despawnSmokeCloud', () => {
  it('creates a cloud at the player\'s current position with the given radius, as several puffs', () => {
    const scene = makeScene();
    const player = { x: 30, y: 40 };
    scene._spawnSmokeCloud(player, 100);
    expect(player.smokeCloud).toMatchObject({ x: 30, y: 40, radius: 100 });
    expect(player.smokeCloud.puffs.length).toBeGreaterThan(1);   // #507: several discrete puffs, not one circle
    expect(scene.add.image).toHaveBeenCalledTimes(player.smokeCloud.puffs.length);
    // Every puff lands within the cloud's own radius of the cast position.
    for (const p of player.smokeCloud.puffs) {
      expect(Math.hypot(p.ox, p.oy)).toBeLessThanOrEqual(100);
    }
  });

  it('re-casting replaces the caster\'s own cloud rather than leaking views', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0 };
    scene._spawnSmokeCloud(player, 100);
    const firstPuffs = player.smokeCloud.puffs.map((p) => p.view);
    scene._spawnSmokeCloud(player, 100);
    for (const c of firstPuffs) expect(c.destroy).toHaveBeenCalledTimes(1);
  });

  it('despawn destroys every puff and clears the slot', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0 };
    scene._spawnSmokeCloud(player, 100);
    const puffs = player.smokeCloud.puffs.map((p) => p.view);
    scene._despawnSmokeCloud(player);
    for (const c of puffs) expect(c.destroy).toHaveBeenCalledTimes(1);
    expect(player.smokeCloud).toBe(null);
  });

  it('despawning with no cloud out is a safe no-op', () => {
    const scene = makeScene();
    expect(() => scene._despawnSmokeCloud({ x: 0, y: 0 })).not.toThrow();
  });
});

// #507 third pass: the actual rendering fix is a baked Canvas-2D radial-gradient texture (real
// `createRadialGradient`, never a flat fill/stroke) instead of Graphics `fillCircle`. The bake
// itself has no meaningfully assertable pixel output, but its ORCHESTRATION is pure and testable
// against a hand-rolled canvas-2D-context double: bake exactly once per variant (idempotent, like
// `gen()`), never draw a stroke, and no-op safely against scenes with no texture-baking API.
describe('#507 ensureSmokeTextures — baked-gradient puff texture bake', () => {
  function fakeCtx() {
    return {
      save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    };
  }

  it('bakes each puff variant exactly once, even across repeated calls', () => {
    const created = new Set();
    const scene = {
      textures: {
        exists: (key) => created.has(key),
        createCanvas: vi.fn((key) => {
          created.add(key);
          return { context: fakeCtx(), refresh: vi.fn() };
        }),
      },
    };
    ensureSmokeTextures(scene);
    ensureSmokeTextures(scene);
    expect(scene.textures.createCanvas).toHaveBeenCalledTimes(SMOKE_TEX_KEYS.length);
  });

  it('draws only real radial gradients — a core plus several wisps per variant — and never a stroke', () => {
    const ctx = fakeCtx();
    const scene = {
      textures: {
        exists: () => false,
        createCanvas: vi.fn(() => ({ context: ctx, refresh: vi.fn() })),
      },
    };
    ensureSmokeTextures(scene);
    // 1 core + at least 4 wisps per variant (see bakeSmokePuffTexture's `wisps` range).
    expect(ctx.createRadialGradient.mock.calls.length).toBeGreaterThanOrEqual(5 * SMOKE_TEX_KEYS.length);
    expect(ctx.fill).toHaveBeenCalledTimes(ctx.createRadialGradient.mock.calls.length);
    expect(ctx.stroke).not.toHaveBeenCalled();   // no hard edge anywhere — the whole point of the bake
  });

  it('is a safe no-op against a scene with no texture-baking API at all', () => {
    expect(() => ensureSmokeTextures({})).not.toThrow();
    expect(() => ensureSmokeTextures({ textures: {} })).not.toThrow();
  });
});
