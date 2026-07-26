// #494 — Anti-Missile Defense. Exercises `_updateInterceptors` directly against a minimal fake
// scene, mirroring fuse.test.js's pattern.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';

function makeMech({ core = null, cooldown = 0 } = {}) {
  return {
    coreMounts: { core },
    _interceptorCooldown: cooldown,
    isDestroyed() { return false; },   // the full-frame test below needs this on `hitPlayer.mech`
    canIntercept() { return this.coreMounts.core === 'antiMissile' && this._interceptorCooldown <= 0; },
    tickInterceptorCooldown(dt) { this._interceptorCooldown = Math.max(0, this._interceptorCooldown - dt); },
    triggerIntercept(s) { this._interceptorCooldown = s; },
  };
}

function makeScene(players, projectiles) {
  const scene = { players, projectiles, _impactFx: vi.fn(), _interceptFx: vi.fn() };
  return Object.assign(scene, ProjectilesMixin);
}

// A minimal ArenaScene-shaped `this` — just enough state/methods for the real
// `_updateProjectiles` frame (not just `_updateInterceptors` in isolation) to run, so these
// tests catch a round that gets marked dead by the interceptor but then still gets fully
// processed (moved, hit-tested, drawn) by the very same frame's per-round loop below it.
function makeFullScene({ players, projectiles }) {
  const scene = {
    players,
    projectiles,
    enemies: [],
    firePatches: [],
    time: { now: 0 },
    projFx: { clear: vi.fn() },
    _hexKeyAt: () => 'h',
    _isWallForRound: () => false,
    _damageBuildingAt: vi.fn(),
    _impactFx: vi.fn(),
    _interceptFx: vi.fn(),
    _damagePlayerAt: vi.fn(),
    _damageEnemyAt: vi.fn(),
    _rangeFactor: () => 1,
  };
  Object.assign(scene, ProjectilesMixin);
  scene._drawProjectile = vi.fn();
  return scene;
}

describe('#494/#527 an intercepted round is fully retired the frame it is shot down', () => {
  it('does not go on to damage the player or get drawn the same frame it is intercepted', () => {
    // Sitting well inside both Anti-Missile Defense's 220px range AND the 32px HIT_RADIUS — if
    // the interceptor's `target.dead = true` doesn't actually stop this frame's per-round loop
    // from processing the round (the #527 bug), it still detonates against the player this same
    // tick before the end-of-frame `dead` filter ever removes it from `scene.projectiles`.
    const round = { owner: 'enemy', x: 20, y: 0, vx: 0, vy: 0, dead: false, kind: 'bullet',
      weaponId: 'machineGun', damage: 10, splash: 0, color: 0xff0000, dist: 0, maxDist: 999,
      speed: 0, angle: 0, homing: false, arc: false, trail: [] };
    const player = { x: 0, y: 0, mech: makeMech({ core: 'antiMissile' }) };
    const scene = makeFullScene({ players: [player], projectiles: [round] });

    scene._updateProjectiles(0.016);

    expect(round.dead).toBe(true);                          // intercepted
    expect(scene._interceptFx).toHaveBeenCalledTimes(1);    // its own dedicated FX
    expect(scene._impactFx).not.toHaveBeenCalled();         // never ran its own normal hit resolution
    expect(scene._damagePlayerAt).not.toHaveBeenCalled(); // never got to hurt the player
    expect(scene._drawProjectile).not.toHaveBeenCalled(); // never got drawn as still in flight
    expect(scene.projectiles).toHaveLength(0);           // removed by the end-of-frame filter
  });
});

describe('#494 _updateInterceptors', () => {
  it('does nothing for a player without Anti-Missile Defense equipped', () => {
    const round = { owner: 'enemy', x: 10, y: 0, dead: false };
    const scene = makeScene([{ x: 0, y: 0, mech: makeMech({ core: 'shield' }) }], [round]);
    scene._updateInterceptors(0.1);
    expect(round.dead).toBe(false);
  });

  it('destroys the nearest incoming enemy round within range when equipped and off cooldown', () => {
    const near = { owner: 'enemy', x: 20, y: 0, dead: false, kind: 'bullet', weaponId: 'machineGun' };
    const far = { owner: 'enemy', x: 9999, y: 9999, dead: false };
    const player = { x: 0, y: 0, mech: makeMech({ core: 'antiMissile' }) };
    const scene = makeScene([player], [near, far]);

    scene._updateInterceptors(0.1);

    expect(near.dead).toBe(true);
    expect(far.dead).toBe(false);
    expect(player.mech._interceptorCooldown).toBeGreaterThan(0);
    expect(scene._interceptFx).toHaveBeenCalledTimes(1);
  });

  it('never targets a player-owned round', () => {
    const own = { owner: 'player', x: 10, y: 0, dead: false };
    const player = { x: 0, y: 0, mech: makeMech({ core: 'antiMissile' }) };
    const scene = makeScene([player], [own]);
    scene._updateInterceptors(0.1);
    expect(own.dead).toBe(false);
  });

  it('does not intercept again while on cooldown', () => {
    const a = { owner: 'enemy', x: 10, y: 0, dead: false };
    const b = { owner: 'enemy', x: 15, y: 0, dead: false };
    const player = { x: 0, y: 0, mech: makeMech({ core: 'antiMissile' }) };
    const scene = makeScene([player], [a, b]);

    scene._updateInterceptors(0.1);   // shoots down `a`, goes on cooldown
    scene._updateInterceptors(0.1);   // still on cooldown — `b` survives

    expect(a.dead).toBe(true);
    expect(b.dead).toBe(false);
  });
});
