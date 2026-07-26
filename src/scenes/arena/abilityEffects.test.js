// #490/#498 — shieldBurst and jumpBlast, the first two ability effects beyond 'dash'. Exercises
// `updateAbilities` (arena/abilities.js) directly against a minimal fake scene, mirroring the
// pattern in abilityTrigger.test.js.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../audio/index.js', () => ({ Audio: { ui: vi.fn() } }));

import { updateAbilities, initAbilityStates, activeSpeedMult, CLOAK_ALPHA, CLOAK_GLOW_ALPHA, CLOAK_GLOW_TINT } from './abilities.js';
import { ABILITIES } from '../../data/abilities.js';

// Mirrors art/mechArt.js's own `PIVOT_LOCATIONS` (side torsos then arms) — the four weapon-carrying
// slots that get a muzzle-glow overlay sprite (mechView.js `makeMechParts`).
const PIVOT_LOCATIONS = ['leftTorso', 'rightTorso', 'leftArm', 'rightArm'];

// Mirrors abilities.js's own local `MECH_PART_KEYS` (kept private there, and deliberately not
// imported from shieldOutline.js — see that file's comment on why: it pulls in the real
// `phaser` package, which this test suite runs without).
const MECH_PART_KEYS = ['hull', 'torL', 'torR', 'armL', 'armR', 'turret'];
// setCloakVisual swaps every part EXCEPT the hull (locomotion.js `_stepGait` owns the hull's
// texture every gait tick, cloaked or not — see abilities.js's CLOAK_SWAPPABLE_PARTS comment).
const CLOAK_SWAPPABLE_PARTS = MECH_PART_KEYS.filter((p) => p !== 'hull');

function fakeEnemy(x, y, hp = 10) {
  return {
    x, y,
    mech: {
      isDestroyed: () => hp <= 0,
      applyDamage: vi.fn(),
    },
  };
}

// `desaturateTexture` (art/mechArt.js) needs a real `scene.textures`/canvas to actually bake
// pixels — against this suite's Phaser-free fake scene (no `.textures` at all) it degrades to its
// documented safe fallback: handing back the deterministic `${key}_grey` key with no side effect.
// That's exactly what these tests want to exercise: that `setCloakVisual` points each part at the
// RIGHT key, not the pixel math itself (which has its own pure test, data/desaturate.test.js).
function fakePartSprite(key) {
  const sprite = {
    texture: { key },
    setTexture: vi.fn((k) => { sprite.texture = { key: k }; }),
  };
  return sprite;
}

// A minimal stand-in for a per-slot muzzle-glow overlay sprite (mechView.js `makeMechParts`'s
// `glow[loc]`) — just enough surface for setCloakVisual's mute/restore branch.
function fakeGlowSprite() {
  return { setAlpha: vi.fn(), setTint: vi.fn(), clearTint: vi.fn() };
}

// A minimal stand-in for a `_makeMechView` container: `setAlpha` plus the six named part
// sprites `setCloakVisual` (abilities.js) reaches into, plus a `glow` map of per-slot overlays.
function fakeMechView() {
  const view = { setAlpha: vi.fn(), glow: {} };
  for (const part of MECH_PART_KEYS) view[part] = fakePartSprite(`mechTex_${part}`);
  for (const loc of PIVOT_LOCATIONS) view.glow[loc] = fakeGlowSprite();
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

describe('#500 cloak (follow-up) — GENUINE desaturation (not a tint) + translucency, ring excluded', () => {
  it('swaps every non-hull part sprite to its own desaturated _grey texture and sets the container translucent on activation', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityX: 'cloak' });
    player.view = fakeMechView();

    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);

    expect(player.view.setAlpha).toHaveBeenCalledWith(CLOAK_ALPHA);
    for (const part of CLOAK_SWAPPABLE_PARTS) {
      expect(player.view[part].setTexture).toHaveBeenCalledWith(`mechTex_${part}_grey`);
      expect(player.view[part].texture.key).toBe(`mechTex_${part}_grey`);
    }
    // The hull's texture is deliberately left untouched here — see CLOAK_SWAPPABLE_PARTS'
    // comment: locomotion.js's `_stepGait` is the sole owner of which hull frame is showing,
    // cloaked or not, because it re-picks it every gait tick regardless of ability state.
    expect(player.view.hull.setTexture).not.toHaveBeenCalled();
  });

  it('restores each part to its EXACT pre-cloak texture key and full opacity the instant the burst ends', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityX: 'cloak' });
    player.view = fakeMechView();

    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);
    updateAbilities(scene, { ability: noAbility }, ABILITIES.cloak.duration * 1000, player);

    expect(player.view.setAlpha).toHaveBeenLastCalledWith(1);
    for (const part of CLOAK_SWAPPABLE_PARTS) {
      expect(player.view[part].texture.key).toBe(`mechTex_${part}`);
    }
  });

  it('rebakes from whatever texture a part is CURRENTLY showing on each fresh activation (so a damage reskin between cloaks is picked up, not a stale first-press snapshot)', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityX: 'cloak' });
    player.view = fakeMechView();

    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);
    // Advance past BOTH the burst duration and the full cooldown so a second press is honoured.
    updateAbilities(scene, { ability: noAbility }, ABILITIES.cloak.cooldown * 1000, player);
    // Stand in for a reskin (damage) having changed what this part is showing since the last cloak.
    player.view.turret.texture.key = 'mechTex_turret_damaged';

    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);

    expect(player.view.turret.setTexture).toHaveBeenLastCalledWith('mechTex_turret_damaged_grey');
  });

  it('never touches the co-op identity ring (player.marker) — it is not part of player.view at all, and stays the player colour while the mech greys out', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityX: 'cloak' });
    player.view = fakeMechView();
    // Mirrors coop.js's real ring: a separate GameObject on `player.marker`, never inside `view`.
    player.marker = { setStrokeStyle: vi.fn(), setVisible: vi.fn(), setPosition: vi.fn(), setFillStyle: vi.fn() };

    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);
    updateAbilities(scene, { ability: noAbility }, ABILITIES.cloak.duration * 1000, player);

    for (const fn of Object.values(player.marker)) expect(fn).not.toHaveBeenCalled();
  });

  it('is a safe no-op with no view at all (a bare test double)', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityX: 'cloak' });
    expect(() => updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player)).not.toThrow();
  });

  it('#500 (fourth pass) mutes every per-slot muzzle-glow overlay on activation and restores it on deactivation', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityX: 'cloak' });
    player.view = fakeMechView();

    updateAbilities(scene, { ability: { ...noAbility, abilityX: true } }, 16, player);
    for (const loc of PIVOT_LOCATIONS) {
      expect(player.view.glow[loc].setAlpha).toHaveBeenCalledWith(CLOAK_GLOW_ALPHA);
      expect(player.view.glow[loc].setTint).toHaveBeenCalledWith(CLOAK_GLOW_TINT);
    }

    updateAbilities(scene, { ability: noAbility }, ABILITIES.cloak.duration * 1000, player);
    for (const loc of PIVOT_LOCATIONS) {
      expect(player.view.glow[loc].setAlpha).toHaveBeenLastCalledWith(1);
      expect(player.view.glow[loc].clearTint).toHaveBeenCalled();
    }
  });

  it('#500 (fourth pass) is a safe no-op when a view has no glow map at all (e.g. an enemy-shaped or older test double)', () => {
    const scene = makeScene([]);
    const player = makePlayer({ abilityX: 'cloak' });
    player.view = fakeMechView();
    delete player.view.glow;

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
