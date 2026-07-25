// #494 — Anti-Missile Defense. Exercises `_updateInterceptors` directly against a minimal fake
// scene, mirroring fuse.test.js's pattern.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';

function makeMech({ core = null, cooldown = 0 } = {}) {
  return {
    coreMounts: { core },
    _interceptorCooldown: cooldown,
    canIntercept() { return this.coreMounts.core === 'antiMissile' && this._interceptorCooldown <= 0; },
    tickInterceptorCooldown(dt) { this._interceptorCooldown = Math.max(0, this._interceptorCooldown - dt); },
    triggerIntercept(s) { this._interceptorCooldown = s; },
  };
}

function makeScene(players, projectiles) {
  const scene = { players, projectiles, _impactFx: vi.fn() };
  return Object.assign(scene, ProjectilesMixin);
}

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
    expect(scene._impactFx).toHaveBeenCalledTimes(1);
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
