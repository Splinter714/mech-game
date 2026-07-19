// #319 — burning ground is INDISCRIMINATE. The patch tick used to damage `this.enemies`
// and never call `_damagePlayerAt`, so enemy-fired ground fire (the artillery mech's whole
// payload) burned its own escort and left the player completely untouched — exactly the
// "napalm doesn't appear to be doing damage over time on the ground, at least not from
// turrets" playtest report. Fire now burns whatever stands in it, owner included: the
// player takes the tick from anyone's patch (their own included), enemies take it from
// anyone's patch, and soft cover burns either way.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile } from '../../data/delivery.js';

function makeEnemy(id, x, y) {
  return { id, x, y, vx: 0, vy: 0, mech: { isDestroyed: () => false } };
}

// The burning-ground decal is real Phaser canvas art and every call chains, so a Proxy
// that returns itself for any method is enough to let the damage tick run under vitest.
function fakeGraphics() {
  const g = new Proxy({}, { get: () => (() => g) });
  return g;
}

function makeScene({ enemies = [], px = 0, py = 0, cover = [] } = {}) {
  const damaged = [];
  const scene = {
    enemies,
    projectiles: [],
    firePatches: [],
    px, py,
    mech: { isDestroyed: () => false },
    time: { now: 0 },
    coverHp: new Map(cover.map((k) => [k, 10])),
    projFx: { clear: vi.fn() },
    groundFx: fakeGraphics(),
    _hexKeyAt: () => 'h',
    _isWallForRound: () => false,
    _impactFx: vi.fn(),
    _damageBuildingAt: vi.fn(() => damaged.push({ target: 'cover' })),
    _damagePlayerAt: vi.fn((dmg) => damaged.push({ target: 'player', dmg })),
    _damageEnemyAt: vi.fn((e, x, y, dmg) => damaged.push({ target: e.id, dmg })),
    _rangeFactor: () => 1,
  };
  Object.assign(scene, ProjectilesMixin);
  scene._drawProjectile = vi.fn();
  return { scene, damaged };
}

const patch = (over = {}) => ({ x: 0, y: 0, r: 46, dps: 8, until: 99999, nextTick: 500, ...over });

// Run one 500ms damage tick of whatever patches are live.
function tick(scene) {
  scene.time.now += 500;
  scene._updateFirePatches();
}

describe('burning ground damages everything standing in it (#319)', () => {
  it('damages the PLAYER standing in it — the reported bug (it never did before)', () => {
    const { scene, damaged } = makeScene({ px: 10, py: 0 });
    scene.firePatches.push(patch());
    tick(scene);
    expect(damaged.some((d) => d.target === 'player')).toBe(true);
  });

  it('damages ENEMIES standing in it — preserved from before the fix', () => {
    const { scene, damaged } = makeScene({ enemies: [makeEnemy('grunt', 5, 5)], px: 9999, py: 9999 });
    scene.firePatches.push(patch());
    tick(scene);
    expect(damaged.some((d) => d.target === 'grunt')).toBe(true);
  });

  it('burns player and enemies in the SAME tick, from one ownerless patch', () => {
    const { scene, damaged } = makeScene({ enemies: [makeEnemy('grunt', 5, 5)], px: 10, py: 0 });
    scene.firePatches.push(patch());
    tick(scene);
    expect(damaged.some((d) => d.target === 'player')).toBe(true);
    expect(damaged.some((d) => d.target === 'grunt')).toBe(true);
  });

  it('spares whatever stands OUTSIDE the radius', () => {
    const { scene, damaged } = makeScene({ enemies: [makeEnemy('grunt', 500, 500)], px: 500, py: -500 });
    scene.firePatches.push(patch());
    tick(scene);
    expect(damaged.filter((d) => d.target !== 'cover')).toEqual([]);
  });

  it('burns soft cover it overlaps', () => {
    const { scene, damaged } = makeScene({ px: 9999, py: 9999, cover: ['0,0'] });
    scene.firePatches.push(patch());
    tick(scene);
    expect(damaged.some((d) => d.target === 'cover')).toBe(true);
  });

  it('ticks half dps (min 1) to both player and enemies, and only on the 500ms beat', () => {
    const { scene, damaged } = makeScene({ enemies: [makeEnemy('grunt', 0, 0)], px: 0, py: 0 });
    scene.firePatches.push(patch({ dps: 8 }));
    tick(scene);
    expect(damaged.find((d) => d.target === 'player').dmg).toBe(4);
    expect(damaged.find((d) => d.target === 'grunt').dmg).toBe(4);

    // A frame that does not cross the next 500ms beat adds nothing.
    const before = damaged.length;
    scene.time.now += 100;
    scene._updateFirePatches();
    expect(damaged.length).toBe(before);
  });

  it('a low-dps patch still lands at least 1 per tick', () => {
    const { scene, damaged } = makeScene({ px: 0, py: 0 });
    scene.firePatches.push(patch({ dps: 0.2 }));
    tick(scene);
    expect(damaged.find((d) => d.target === 'player').dmg).toBe(1);
  });

  it('a destroyed player is not burned further', () => {
    const { scene, damaged } = makeScene({ px: 0, py: 0 });
    scene.mech.isDestroyed = () => true;
    scene.firePatches.push(patch());
    tick(scene);
    expect(damaged.some((d) => d.target === 'player')).toBe(false);
  });

  it('a burnt-out patch stops ticking and is retired', () => {
    const { scene, damaged } = makeScene({ px: 0, py: 0 });
    scene.firePatches.push(patch({ until: 400 }));
    tick(scene);
    expect(scene.firePatches).toEqual([]);
    const after = damaged.length;
    scene._updateFirePatches();
    expect(damaged.length).toBe(after);
  });
});

describe('a landing ground-fire round leaves an ownerless patch (#319)', () => {
  // End-to-end through _updateProjectiles: the patch spawned at impact must carry no owner,
  // so the tick loop above burns both sides no matter who fired.
  function landRound(owner, sceneOpts) {
    const { scene } = makeScene(sceneOpts);
    const round = makeProjectile(WEAPONS.napalm, 0, 0, 0, { maxDist: 40 });
    round.owner = owner;
    round.trail = [];
    scene.projectiles = [round];
    for (let i = 0; i < 200 && scene.projectiles.length; i++) scene._updateProjectiles(0.016);
    return scene;
  }

  it('the ground-fire weapon fixture actually carries groundFire', () => {
    expect(WEAPONS.napalm.delivery.groundFire).toBeTruthy();
  });

  it('an enemy-fired round leaves a patch that then damages the player', () => {
    const scene = landRound('enemy', { px: 5000, py: 5000 });
    expect(scene.firePatches.length).toBe(1);
    const fp = scene.firePatches[0];
    scene.px = fp.x; scene.py = fp.y;
    scene.time.now = fp.nextTick;
    scene._updateFirePatches();
    expect(scene._damagePlayerAt).toHaveBeenCalled();
  });

  it('a player-fired round leaves a patch that damages enemies AND the player in it', () => {
    const scene = landRound('player', { enemies: [makeEnemy('grunt', 5000, 5000)] });
    expect(scene.firePatches.length).toBe(1);
    const fp = scene.firePatches[0];
    scene.enemies[0].x = fp.x; scene.enemies[0].y = fp.y;
    scene.px = fp.x; scene.py = fp.y;
    scene.time.now = fp.nextTick;
    scene._updateFirePatches();
    expect(scene._damageEnemyAt).toHaveBeenCalled();
    expect(scene._damagePlayerAt).toHaveBeenCalled();
  });
});
