// #490/#498 — shieldBurst and jumpBlast, the first two ability effects beyond 'dash'. Exercises
// `updateAbilities` (arena/abilities.js) directly against a minimal fake scene, mirroring the
// pattern in abilityTrigger.test.js.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../audio/index.js', () => ({ Audio: { ui: vi.fn() } }));

import { updateAbilities, initAbilityStates, activeSpeedMult } from './abilities.js';
import { ABILITIES } from '../../data/abilities.js';

function fakeEnemy(x, y, hp = 10) {
  return {
    x, y,
    mech: {
      isDestroyed: () => hp <= 0,
      applyDamage: vi.fn(),
    },
  };
}

function makeScene(enemies = []) {
  return {
    enemies,
    players: [],
    _damageEnemyAt: vi.fn((e, x, y, amount) => { e.mech._lastDamage = amount; }),
    _damagePlayerAt: vi.fn(),
  };
}

function makePlayer(abilityMounts, x = 0, y = 0) {
  return { x, y, id: 0, mech: { abilityMounts }, abilityStates: initAbilityStates() };
}

const noAbility = { abilityY: false, abilityB: false, abilityA: false, abilityX: false };

describe('#490 shieldBurst — fires AoE damage the instant it activates', () => {
  it('damages a living enemy within radius, on the press', () => {
    const near = fakeEnemy(20, 0);
    const far = fakeEnemy(9999, 9999);
    const scene = makeScene([near, far]);
    const player = makePlayer({ abilityB: 'shieldBurst' });

    updateAbilities(scene, { ability: { ...noAbility, abilityB: true } }, 16, player);

    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
    expect(scene._damageEnemyAt.mock.calls[0][0]).toBe(near);
    expect(player.abilityStates.abilityB.active).toBe(true);
  });

  it('does not fire again while the button is merely held', () => {
    const near = fakeEnemy(20, 0);
    const scene = makeScene([near]);
    const player = makePlayer({ abilityB: 'shieldBurst' });

    updateAbilities(scene, { ability: { ...noAbility, abilityB: true } }, 16, player);
    updateAbilities(scene, { ability: { ...noAbility, abilityB: true } }, 16, player);

    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
  });

  it('respects its own cooldown independent of other slots', () => {
    const scene = makeScene([fakeEnemy(20, 0)]);
    const player = makePlayer({ abilityB: 'shieldBurst' });
    updateAbilities(scene, { ability: { ...noAbility, abilityB: true } }, 16, player);
    updateAbilities(scene, { ability: noAbility }, (ABILITIES.shieldBurst.duration) * 1000, player);
    // Mid-cooldown re-press: refused.
    updateAbilities(scene, { ability: { ...noAbility, abilityB: true } }, 16, player);
    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
  });
});

describe('#498 jumpBlast — movement burst that blasts on arrival', () => {
  it('is active immediately (movement burst) and carries the tuned speedMult', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityA: 'jumpBlast' });

    updateAbilities(scene, { ability: { ...noAbility, abilityA: true } }, 16, player);

    expect(player.abilityStates.abilityA.active).toBe(true);
    expect(activeSpeedMult(player, 'jumpBlast')).toBe(ABILITIES.jumpBlast.speedMult);
    expect(scene._damageEnemyAt).not.toHaveBeenCalled();   // not yet — that's on arrival
  });

  it('fires the AoE blast at wherever the player ends up when the burst ends, not the launch point', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityA: 'jumpBlast' }, 0, 0);

    updateAbilities(scene, { ability: { ...noAbility, abilityA: true } }, 16, player);
    // Simulate locomotion actually moving the player during the burst window.
    player.x = 150; player.y = 40;
    const landingEnemy = fakeEnemy(150, 40);
    scene.enemies.push(landingEnemy);

    updateAbilities(scene, { ability: noAbility }, ABILITIES.jumpBlast.duration * 1000, player);

    expect(player.abilityStates.abilityA.active).toBe(false);
    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
    expect(scene._damageEnemyAt.mock.calls[0][0]).toBe(landingEnemy);
  });
});

describe('activeSpeedMult', () => {
  it('is 1 for an unmounted or inactive effect', () => {
    const player = makePlayer({});
    expect(activeSpeedMult(player, 'dash')).toBe(1);
    expect(activeSpeedMult(player, 'jumpBlast')).toBe(1);
  });
});
