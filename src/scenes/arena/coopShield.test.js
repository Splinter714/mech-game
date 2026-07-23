// #364 — "I wasn't able to see a shield visual on the player 2 mech; does it have shields, or
// what's the deal?" (Jackson, co-op playtest).
//
// Two separate claims live in that one sentence, and they had different answers:
//
//   (b) the BALANCE one — does player 2 have a shield AT ALL? The player's 100-point shield is
//       configured at DEPLOY (`activeMech.configureShield(PLAYER_SHIELD)`), not in the chassis
//       data, so a joining player who never gets that call fights with zero shield and is
//       meaningfully weaker than player 1. This was already handled (coop.js `_mechForPlayer`
//       re-applies the remembered `_playerShieldConfig`) — these tests lock it down so it stays
//       handled on both join paths, since nothing was asserting it.
//
//   (a) the COSMETIC one — the actual bug. There was exactly ONE outline set, built against the
//       phase-1 `this.playerView` accessor onto `players[0]`, so player 2's real shield had
//       nothing to show for it. The outline now lives per PLAYER.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../audio/index.js', () => ({ Audio: { ui: vi.fn() } }));
vi.mock('phaser', () => ({ default: { BlendModes: { ADD: 1 } } }));

import { CoopMixin } from './coop.js';
import { PowerupsMixin } from './powerups.js';
import { Mech } from '../../data/Mech.js';
import { makePlayer } from '../../data/players.js';
import { SHIELD_MECH_PART_KEYS } from './shieldOutline.js';

const PLAYER_SHIELD = { max: 100 };  // #382: just a pool size — pause/regen are shared constants

// ── (b) every player's mech gets the deploy-time shield config ──────────────────────────────

describe('#364(b): player 2 is not deployed with a weaker machine than player 1', () => {
  // The joiner path, run for real: `_mechForPlayer` is what builds the second player's Mech on
  // BOTH ways in — the mid-sortie START join and the garage co-op flow both funnel through
  // `_addPlayer` → `_mechForPlayer`, so covering it covers both.
  const joinerScene = (shieldConfig) => Object.assign({
    players: [{ ...makePlayer({ id: 0, x: 0, y: 0 }), mech: new Mech({ chassisId: 'mediumPlayer' }) }],
    allMechs: {},
    _playerShieldConfig: shieldConfig,
  }, CoopMixin);

  it('gives the joining player the identical native shield baseline player 1 got', () => {
    const scene = joinerScene(PLAYER_SHIELD);
    const host = scene.players[0].mech;
    host.configureShield(PLAYER_SHIELD);

    const mech = scene._mechForPlayer(1);

    expect(mech).not.toBe(host);                       // an independent damage sink
    expect(mech.shield.max).toBe(host.shield.max);
    expect(mech.shield.max).toBe(PLAYER_SHIELD.max);
  });

  it('starts that shield FULL, so player 2 does not walk on with an empty pool', () => {
    const mech = joinerScene(PLAYER_SHIELD)._mechForPlayer(1);
    expect(mech.shield.hp).toBe(PLAYER_SHIELD.max);
  });

  it('deploy remembers PLAYER_SHIELD for the joiner instead of applying it to one mech only', () => {
    // The wiring that makes the above reachable in the real game: ArenaScene must both configure
    // the active mech AND publish the same config for `_mechForPlayer` to re-apply. Asserted
    // against the source because create() needs a full Phaser scene to run.
    const src = readFileSync(new URL('../ArenaScene.js', import.meta.url), 'utf8');
    expect(src).toMatch(/activeMech\.configureShield\(PLAYER_SHIELD\)/);
    expect(src).toMatch(/this\._playerShieldConfig = PLAYER_SHIELD/);
  });
});

// ── (a) a shield visual per player ──────────────────────────────────────────────────────────

// A fake outline sprite factory standing in for scene.add.sprite. Chainable like the real thing.
const fakeSprite = () => {
  const s = {
    texture: { key: 'outline' }, visible: false,
    setOrigin: () => s, setScale: () => s, setTintFill: () => s, setBlendMode: () => s,
    setVisible: vi.fn((v) => { s.visible = v; return s; }),
    setTexture: vi.fn(() => s), setPosition: vi.fn(() => s), setAlpha: vi.fn(() => s),
  };
  return s;
};

const fakeView = () => {
  const view = { addAt: vi.fn() };
  for (const key of SHIELD_MECH_PART_KEYS) {
    view[key] = { x: 0, y: 0, originX: 0.5, originY: 0.5, rotation: 0, texture: { key: `${key}_tex` } };
  }
  return view;
};

const playerWithShield = (id, hp, max = 100) => ({
  ...makePlayer({ id, x: id * 200, y: 0 }),
  mech: { shield: { hp, max } },
  view: fakeView(),
});

const visualScene = (players) => Object.assign({
  players,
  add: { sprite: vi.fn(fakeSprite), graphics: vi.fn(() => ({})) },
  tweens: { add: vi.fn() },
}, PowerupsMixin);

describe('#364(a): every player wears their own shield outline', () => {
  it('builds one outline set per player, not one for the whole scene', () => {
    const scene = visualScene([playerWithShield(0, 100), playerWithShield(1, 100)]);
    scene._initShieldVisual();

    for (const p of scene.players) {
      expect(Object.keys(p.shieldVisual.outlines)).toEqual(SHIELD_MECH_PART_KEYS);
    }
    // Two distinct sets of sprites — not the same objects handed to both players.
    expect(scene.players[0].shieldVisual).not.toBe(scene.players[1].shieldVisual);
    expect(scene.players[0].shieldVisual.outlines.hull)
      .not.toBe(scene.players[1].shieldVisual.outlines.hull);
    // Each player's outlines were added to that player's OWN view container.
    expect(scene.players[0].view.addAt).toHaveBeenCalledTimes(SHIELD_MECH_PART_KEYS.length);
    expect(scene.players[1].view.addAt).toHaveBeenCalledTimes(SHIELD_MECH_PART_KEYS.length);
  });

  it('gives a player who JOINS mid-sortie an outline too, without any join-path wiring', () => {
    // The regression that #364 actually was: the single outline was built once, at arena create,
    // so anyone arriving later could never get one. Building is lazy per player now.
    const scene = visualScene([playerWithShield(0, 100)]);
    scene._initShieldVisual();
    const joiner = playerWithShield(1, 100);
    scene.players.push(joiner);

    scene._updateShieldVisual(16.67);

    expect(joiner.shieldVisual).toBeTruthy();
    for (const key of SHIELD_MECH_PART_KEYS) {
      expect(joiner.shieldVisual.outlines[key].setVisible).toHaveBeenCalledWith(true);
    }
  });

  it('shows each outline off that player OWN shield, so one bubble cannot speak for both', () => {
    const scene = visualScene([playerWithShield(0, 0), playerWithShield(1, 100)]);
    scene._initShieldVisual();

    scene._updateShieldVisual(16.67);

    expect(scene.players[0].shieldVisual.active).toBe(false);   // P1's pool is down: hidden
    expect(scene.players[1].shieldVisual.active).toBe(true);    // P2's is up: showing
  });

  it('flashes the outline of the player who was actually hit', () => {
    const scene = visualScene([playerWithShield(0, 100), playerWithShield(1, 100)]);
    scene._initShieldVisual();
    scene._updateShieldVisual(16.67);   // both active, so a flash has something to pulse

    scene._shieldHitFlash(scene.players[1]);

    // #456: the flash is an OPACITY pop on the hit player's visual state (the shell's size is now
    // constant), so the tween targets that player's shieldVisual — and nobody else's.
    expect(scene.tweens.add).toHaveBeenCalledTimes(1);
    const flashed = scene.tweens.add.mock.calls[0][0].targets;
    expect(flashed).toBe(scene.players[1].shieldVisual);
    expect(scene.players[1].shieldVisual.flash).toBe(1);
    expect(scene.players[0].shieldVisual.flash).toBe(0);
  });
});
