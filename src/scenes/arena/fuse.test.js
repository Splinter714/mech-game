// #488 — the fuse primitive: `_tickFuse` (trip detection) + `_detonateFuse` (the actual blast).
// Exercises both directly against a minimal fake scene, mirroring the pattern in
// abilityEffects.test.js.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';

function fakeEnemy(x, y) {
  return { x, y, mech: { isDestroyed: () => false } };
}

function makeScene(enemies = []) {
  const scene = {
    enemies,
    players: [],
    time: { now: 0 },
    _damageEnemyAt: vi.fn(),
    _damagePlayerAt: vi.fn(),
    _impactFx: vi.fn(),
  };
  return Object.assign(scene, ProjectilesMixin);
}

describe('#488 _tickFuse — time mode', () => {
  it('does not trip before its time is up', () => {
    const scene = makeScene();
    const p = { fuse: { mode: 'time', time: 1 }, owner: 'player' };
    expect(scene._tickFuse(p, 0.5)).toBe(false);
  });

  it('trips once elapsed flight time reaches the fuse time, regardless of proximity to anything', () => {
    const scene = makeScene();
    const p = { fuse: { mode: 'time', time: 1 }, owner: 'player', x: 9999, y: 9999 };
    scene._tickFuse(p, 0.6);
    expect(scene._tickFuse(p, 0.5)).toBe(true);   // 1.1s total
  });
});

describe('#488 _tickFuse — proximity mode', () => {
  it('a player round trips once a living enemy is within radius', () => {
    const near = fakeEnemy(10, 0);
    const scene = makeScene([near]);
    const p = { fuse: { mode: 'proximity', radius: 50 }, owner: 'player', x: 0, y: 0 };
    expect(scene._tickFuse(p, 0.1)).toBe(true);
  });

  it('does not trip while every enemy is out of radius', () => {
    const far = fakeEnemy(9999, 9999);
    const scene = makeScene([far]);
    const p = { fuse: { mode: 'proximity', radius: 50 }, owner: 'player', x: 0, y: 0 };
    expect(scene._tickFuse(p, 0.1)).toBe(false);
  });
});

describe('#488 _detonateFuse — a real multi-target blast, not a single-target splash', () => {
  it('damages every living enemy within the fuse radius', () => {
    const a = fakeEnemy(10, 0), b = fakeEnemy(20, 0), farAway = fakeEnemy(9999, 9999);
    const scene = makeScene([a, b, farAway]);
    const p = { x: 0, y: 0, damage: 40, fuse: { radius: 60 }, owner: 'player', color: 0, kind: 'plasma', weaponId: 'timedCharge' };

    scene._detonateFuse(p);

    expect(p.dead).toBe(true);
    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(2);
    const hitTargets = scene._damageEnemyAt.mock.calls.map((c) => c[0]);
    expect(hitTargets).toContain(a);
    expect(hitTargets).toContain(b);
    expect(hitTargets).not.toContain(farAway);
    expect(scene._impactFx).toHaveBeenCalledTimes(1);
  });
});
