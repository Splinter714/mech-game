// #348 (co-op phase 2) — the scene-side seams that only exist once there are two players.
// The RULES are pure and tested in data/leash.test.js, data/respawn.test.js and
// data/players.test.js; what's covered here is the wiring those rules plug into, plus friendly
// fire, which is a routing decision rather than a formula.
import { describe, it, expect, vi } from 'vitest';
import { FiringMixin } from './firing.js';
import { cameraFocusOf, isPlayerRef, otherLivePlayers, targetPlayerFor } from './players.js';
import { makePlayer, playerAccent, playerColor } from '../../data/players.js';

const P = (id, x, y) => ({ ...makePlayer({ id, x, y }), mech: { isDestroyed: () => false } });

const twoPlayerScene = (extra = {}) => {
  const a = P(0, 0, 0);
  const b = P(1, 200, 0);
  return {
    players: [a, b], a, b,
    enemies: [],
    ...FiringMixin,
    ...extra,
  };
};

describe('the shared camera frames the centroid, not player 1', () => {
  it('is exactly the player, solo — single-player framing is untouched', () => {
    const solo = { players: [P(0, 120, -40)] };
    expect(cameraFocusOf(solo)).toMatchObject({ x: 120, y: -40 });
  });

  it('sits between two players', () => {
    const scene = twoPlayerScene();
    expect(cameraFocusOf(scene)).toMatchObject({ x: 100, y: 0 });
  });

  it('ignores a downed player, so the camera does not sit on a corpse', () => {
    const scene = twoPlayerScene();
    scene.b.dead = true;
    expect(cameraFocusOf(scene)).toMatchObject({ x: 0, y: 0 });
  });
});

describe('enemies target the NEAREST player (Jackson)', () => {
  it('picks whichever player is closer', () => {
    const scene = twoPlayerScene();
    expect(targetPlayerFor(scene, { x: 190, y: 0 })).toBe(scene.b);
    expect(targetPlayerFor(scene, { x: 10, y: 0 })).toBe(scene.a);
  });

  it('will not target a downed player while a live one exists', () => {
    const scene = twoPlayerScene();
    scene.b.dead = true;
    expect(targetPlayerFor(scene, { x: 199, y: 0 })).toBe(scene.a);
  });
});

describe('friendly fire is ON', () => {
  it('a player is a candidate for another player\'s shot', () => {
    const scene = twoPlayerScene();
    expect(otherLivePlayers(scene, scene.a)).toEqual([scene.b]);
  });

  it('never puts the shooter in their own line of fire', () => {
    const scene = twoPlayerScene();
    expect(otherLivePlayers(scene, scene.a)).not.toContain(scene.a);
  });

  it('is a no-op in single player — there is nobody to hit', () => {
    const solo = { players: [P(0, 0, 0)] };
    expect(otherLivePlayers(solo, null)).toEqual([]);
  });

  it('a downed teammate cannot be shot', () => {
    const scene = twoPlayerScene();
    scene.b.dead = true;
    expect(otherLivePlayers(scene, scene.a)).toEqual([]);
  });

  it('_liveTargetsForTrace offers allies alongside enemies for a player shot', () => {
    const enemy = { x: 500, y: 0, mech: { isDestroyed: () => false } };
    const scene = twoPlayerScene({ enemies: [enemy] });
    const refs = scene._liveTargetsForTrace('player', scene.a).map((c) => c.ref);
    expect(refs).toContain(enemy);
    expect(refs).toContain(scene.b);
    expect(refs).not.toContain(scene.a);
  });

  it('an ENEMY shot still only offers players — allies are a player-side concept', () => {
    const enemy = { x: 500, y: 0, mech: { isDestroyed: () => false } };
    const scene = twoPlayerScene({ enemies: [enemy] });
    const refs = scene._liveTargetsForTrace('enemy').map((c) => c.ref);
    expect(refs).toEqual([scene.a, scene.b]);
  });

  it('routes a player-fired hit on a teammate to the PLAYER damage sink, not the enemy one', () => {
    // The routing decision friendly fire actually turns on: the same shot path must reach a
    // different function depending on WHAT it hit.
    const scene = twoPlayerScene();
    expect(isPlayerRef(scene, scene.b)).toBe(true);
    expect(isPlayerRef(scene, { x: 0, y: 0, mech: {} })).toBe(false);
  });
});

describe('player identification', () => {
  it('gives each player a distinct colour', () => {
    expect(playerColor(0)).not.toBe(playerColor(1));
  });

  it('leaves player 1 art untouched — only later players are tinted', () => {
    expect(playerAccent(0)).toBeNull();
    expect(playerAccent(1)).toBeTruthy();
  });

  it('carries the colour on the player itself, so every draw site reads one source', () => {
    expect(makePlayer({ id: 1 }).color).toBe(playerColor(1));
  });
});

describe('per-player firing state (what phase 1 deliberately left shared)', () => {
  const weapon = (location) => ({
    location, index: 0, ready: true,
    weapon: { id: 'w', location, category: 'ballistic', damage: 1, cycleTime: 500, range: { max: 100 }, delivery: { hit: 'projectile', pattern: 'single' } },
  });

  it('two players hold independent fire cooldowns for the same slot', () => {
    const scene = twoPlayerScene({
      fireWeapon: vi.fn(),
      _fireInterval: () => 500,
      _isHeldBeam: () => false,
      _buffMods: () => ({}),
    });
    scene.a.mech.weapons = () => [weapon('rightArm')];
    scene.b.mech.weapons = () => [weapon('rightArm')];
    const fire = { fire: { rightArm: true } };

    scene._handleFiring(fire, 16, scene.a);
    // Player 1 is now on cooldown; player 2 has never pulled a trigger.
    expect(scene.a.fireCooldowns.rightArm).toBeGreaterThan(0);
    expect(scene.b.fireCooldowns.rightArm ?? 0).toBe(0);

    // ...and player 2 firing does not consume player 1's cooldown, or vice versa.
    scene._handleFiring(fire, 16, scene.b);
    expect(scene.fireWeapon).toHaveBeenCalledTimes(2);
  });

  it('each player converges on its OWN target', () => {
    const scene = twoPlayerScene();
    scene.a.convergeTarget = { x: 1, y: 0 };
    scene.b.convergeTarget = null;
    expect(scene._shotIgnoresCover('player', scene.b)).toBe(false);
    expect(scene.a.convergeTarget).not.toBe(scene.b.convergeTarget);
  });
});
