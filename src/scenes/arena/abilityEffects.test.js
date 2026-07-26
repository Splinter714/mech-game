// #490/#498 — shieldBurst and jumpBlast, the first two ability effects beyond 'dash'. Exercises
// `updateAbilities` (arena/abilities.js) directly against a minimal fake scene, mirroring the
// pattern in abilityTrigger.test.js.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../audio/index.js', () => ({ Audio: { ui: vi.fn() } }));

import { updateAbilities, initAbilityStates, activeSpeedMult, CLOAK_TINT, CLOAK_ALPHA } from './abilities.js';
import { ABILITIES } from '../../data/abilities.js';

// Mirrors abilities.js's own local `MECH_PART_KEYS` (kept private there, and deliberately not
// imported from shieldOutline.js — see that file's comment on why: it pulls in the real
// `phaser` package, which this test suite runs without).
const MECH_PART_KEYS = ['hull', 'torL', 'torR', 'armL', 'armR', 'turret'];

function fakeEnemy(x, y, hp = 10) {
  return {
    x, y,
    mech: {
      isDestroyed: () => hp <= 0,
      applyDamage: vi.fn(),
    },
  };
}

function fakePartSprite() {
  return { setTint: vi.fn(), clearTint: vi.fn() };
}

// A minimal stand-in for a `_makeMechView` container: `setAlpha` plus the six named part
// sprites `setCloakVisual` (abilities.js) reaches into.
function fakeMechView() {
  const view = { setAlpha: vi.fn() };
  for (const part of MECH_PART_KEYS) view[part] = fakePartSprite();
  return view;
}

function makeScene(enemies = []) {
  return {
    enemies,
    players: [],
    _damageEnemyAt: vi.fn((e, x, y, amount) => { e.mech._lastDamage = amount; }),
    _damagePlayerAt: vi.fn(),
    _aoeBlastFx: vi.fn(),
  };
}

function makePlayer(abilityMounts, x = 0, y = 0) {
  return { x, y, id: 0, mech: { abilityMounts }, abilityStates: initAbilityStates() };
}

const noAbility = { abilityY: false, abilityX: false };

describe('#490 shieldBurst — fires AoE damage the instant it activates', () => {
  it('damages a living enemy within radius, on the press', () => {
    const near = fakeEnemy(20, 0);
    const far = fakeEnemy(9999, 9999);
    const scene = makeScene([near, far]);
    const player = makePlayer({ abilityX: 'shieldBurst' });

    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);

    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
    expect(scene._damageEnemyAt.mock.calls[0][0]).toBe(near);
    expect(player.abilityStates.abilityX.active).toBe(true);
  });

  it('does not fire again while the button is merely held', () => {
    const near = fakeEnemy(20, 0);
    const scene = makeScene([near]);
    const player = makePlayer({ abilityX: 'shieldBurst' });

    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);
    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);

    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
  });

  it('respects its own cooldown independent of other slots', () => {
    const scene = makeScene([fakeEnemy(20, 0)]);
    const player = makePlayer({ abilityX: 'shieldBurst' });
    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);
    updateAbilities(scene, { ability: noAbility }, (ABILITIES.shieldBurst.duration) * 1000, player);
    // Mid-cooldown re-press: refused.
    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);
    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
  });
});

describe('#498 jumpBlast — movement burst that blasts on arrival', () => {
  it('is active immediately (movement burst) and carries the tuned speedMult', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityY: 'jumpBlast' });

    updateAbilities(scene, { ability: { ...noAbility, abilityY: true } }, 16, player);

    expect(player.abilityStates.abilityY.active).toBe(true);
    expect(activeSpeedMult(player, 'jumpBlast')).toBe(ABILITIES.jumpBlast.speedMult);
    expect(scene._damageEnemyAt).not.toHaveBeenCalled();   // not yet — that's on arrival
    // #498: the launch itself now plays a (smaller) blast FX too, so the jump is felt immediately.
    expect(scene._aoeBlastFx).toHaveBeenCalledTimes(1);
    expect(scene._aoeBlastFx.mock.calls[0][2]).toBeLessThan(ABILITIES.jumpBlast.radius);
  });

  it('fires the AoE blast at wherever the player ends up when the burst ends, not the launch point', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityY: 'jumpBlast' }, 0, 0);

    updateAbilities(scene, { ability: { ...noAbility, abilityY: true } }, 16, player);
    // Simulate locomotion actually moving the player during the burst window.
    player.x = 150; player.y = 40;
    const landingEnemy = fakeEnemy(150, 40);
    scene.enemies.push(landingEnemy);

    updateAbilities(scene, { ability: noAbility }, ABILITIES.jumpBlast.duration * 1000, player);

    expect(player.abilityStates.abilityY.active).toBe(false);
    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
    expect(scene._damageEnemyAt.mock.calls[0][0]).toBe(landingEnemy);
    // #498: the landing blast plays FX at the FULL radius, at the arrival point — not the launch
    // point. (Called once at launch above, once here at landing — total 2 across the exchange.)
    expect(scene._aoeBlastFx).toHaveBeenCalledTimes(2);
    const landingCall = scene._aoeBlastFx.mock.calls[1];
    expect(landingCall[0]).toBe(150);
    expect(landingCall[1]).toBe(40);
    expect(landingCall[2]).toBe(ABILITIES.jumpBlast.radius);
  });
});

describe('#500 cloak — greyscale/phantom tint + translucency on the mech view', () => {
  it('tints every part sprite and sets the container translucent on activation', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityX: 'cloak' });
    player.view = fakeMechView();

    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);

    expect(player.view.setAlpha).toHaveBeenCalledWith(CLOAK_ALPHA);
    for (const part of MECH_PART_KEYS) {
      expect(player.view[part].setTint).toHaveBeenCalledWith(CLOAK_TINT);
      expect(player.view[part].clearTint).not.toHaveBeenCalled();
    }
  });

  it('restores full colour and opacity the instant the burst ends', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityX: 'cloak' });
    player.view = fakeMechView();

    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);
    updateAbilities(scene, { ability: noAbility }, ABILITIES.cloak.duration * 1000, player);

    expect(player.view.setAlpha).toHaveBeenLastCalledWith(1);
    for (const part of MECH_PART_KEYS) {
      expect(player.view[part].clearTint).toHaveBeenCalledTimes(1);
    }
  });

  it('is a safe no-op with no view at all (a bare test double)', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityX: 'cloak' });
    expect(() => updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player)).not.toThrow();
  });
});

describe('activeSpeedMult', () => {
  it('is 1 for an unmounted or inactive effect', () => {
    const player = makePlayer({});
    expect(activeSpeedMult(player, 'dash')).toBe(1);
    expect(activeSpeedMult(player, 'jumpBlast')).toBe(1);
  });
});
