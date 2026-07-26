// #497 — Friendly Drone Launcher. Exercises `FriendlyDronesMixin` directly against a minimal
// fake scene, mirroring interceptor.test.js's pattern.
//
// #497 rework (fresh playtest feedback): a whole squad (3-5) instead of a single pet, borrowing
// the enemy Recon Drone's own weapon/range/cadence/movement-feel data, with an owner-target
// priority for what it shoots at. `player.friendlyDrone` (singular) is gone — it's
// `player.friendlyDrones` (an array) now.
//
// The summon still bakes its view from the real Recon Drone art builder (art/vehicles/drone.js
// `drawDrone`, via `buildVehicleTextures`) instead of a plain `add.circle`. Real texture
// generation needs a real Phaser canvas/graphics stack this test has no business building (same
// call carrierDeploy.test.js makes about `_spawnKind`), so the fake scene's `textures.exists`
// always reports true — the build branch is skipped and never exercised here; only the pure
// position/targeting/lifecycle logic is under test.
// #530: spy on the shared fire-cue scheduler the same way vehicleFire.test.js does for the enemy
// Recon Drone's own fire path — proves the friendly drone now plays a real fire cue on each shot
// instead of firing silently (the root cause of "doesn't seem like it" — see friendlyDrones.js's
// own #530 comment at the call site).
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../audio/fireCues.js', () => ({ scheduleFireCues: vi.fn() }));

import { FriendlyDronesMixin, DRONE_HP, DRONE_RANGE, DRONE_LEASH_RADIUS } from './friendlyDrones.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { getWeapon } from '../../data/weapons.js';
import { DRONE_COUNT_MIN, DRONE_COUNT_MAX } from '../../data/friendlyDroneAI.js';
import { scheduleFireCues } from '../../audio/fireCues.js';

function fakeSprite() {
  return { rotation: 0, setScale: vi.fn(function () { return this; }) };
}

function fakeGameObject() {
  return { setScale: vi.fn(function () { return this; }) };
}

function fakeContainer(x, y) {
  return {
    x, y,
    setDepth: vi.fn(function () { return this; }),
    setPosition: vi.fn(function (nx, ny) { this.x = nx; this.y = ny; return this; }),
    destroy: vi.fn(),
  };
}

function makeScene(enemies = []) {
  const scene = {
    enemies,
    players: [],
    time: { now: 0 },
    textures: { exists: () => true },   // skip real art generation — see file header
    add: {
      ellipse: vi.fn(() => fakeGameObject()),
      sprite: vi.fn(() => fakeSprite()),
      container: vi.fn((x, y) => fakeContainer(x, y)),
    },
    // #530: the drone now fires through the real projectile pipeline (`_spawnProjectile`) rather
    // than calling `_damageEnemyAt` directly — see friendlyDrones.js's own comment at the call
    // site for the root cause this replaced.
    _spawnProjectile: vi.fn(),
  };
  return Object.assign(scene, FriendlyDronesMixin);
}

function fakeEnemy(x, y) {
  return { x, y, mech: { isDestroyed: () => false } };
}

describe('#497 _spawnFriendlyDrone / _despawnFriendlyDrone', () => {
  it('spawns 3-5 drones on the player, each with its own view (hull+turret+shadow) and durability', () => {
    const scene = makeScene();
    const player = { x: 10, y: 20, color: 0xff0000 };
    scene._spawnFriendlyDrone(player);
    expect(player.friendlyDrones.length).toBeGreaterThanOrEqual(DRONE_COUNT_MIN);
    expect(player.friendlyDrones.length).toBeLessThanOrEqual(DRONE_COUNT_MAX);
    for (const d of player.friendlyDrones) {
      expect(d.view.hull).toBeTruthy();
      expect(d.view.turret).toBeTruthy();
      expect(d.hp).toBe(DRONE_HP);
    }
  });

  it('is tougher than the enemy Recon Drone it borrows its loadout from', () => {
    const enemyTotal = ENEMY_KINDS.drone.hp + (ENEMY_KINDS.drone.shield?.max ?? 0);
    expect(DRONE_HP).toBeGreaterThan(enemyTotal);
  });

  it('re-summoning replaces the whole squad rather than leaking old views', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0 };
    scene._spawnFriendlyDrone(player);
    const firstViews = player.friendlyDrones.map((d) => d.view);
    scene._spawnFriendlyDrone(player);
    for (const v of firstViews) expect(v.destroy).toHaveBeenCalledTimes(1);
    for (const d of player.friendlyDrones) expect(firstViews).not.toContain(d.view);
  });

  it('despawn destroys every view and clears the squad', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0 };
    scene._spawnFriendlyDrone(player);
    const views = player.friendlyDrones.map((d) => d.view);
    scene._despawnFriendlyDrone(player);
    for (const v of views) expect(v.destroy).toHaveBeenCalledTimes(1);
    expect(player.friendlyDrones).toBe(null);
  });

  it('despawning with no squad out is a safe no-op', () => {
    const scene = makeScene();
    expect(() => scene._despawnFriendlyDrone({ x: 0, y: 0 })).not.toThrow();
  });
});

describe('#497 friendly drone weapon (same as the enemy Recon Drone)', () => {
  it('fires the enemy Recon Drone\'s own weapon, for the same per-bolt damage', () => {
    const near = fakeEnemy(10, 0);
    const scene = makeScene([near]);
    const player = { x: 0, y: 0, dead: false };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    player.friendlyDrones = [player.friendlyDrones[0]];   // isolate to one drone for a focused hit check
    player.friendlyDrones[0].x = 0; player.friendlyDrones[0].y = 0;

    scene._updateFriendlyDrones(0.1);

    expect(scene._spawnProjectile).toHaveBeenCalledTimes(1);
    const [w, , , , owner, , seekOverride] = scene._spawnProjectile.mock.calls[0];
    expect(w.weapon).toBe(getWeapon(ENEMY_KINDS.drone.weaponId));
    expect(owner).toBe('player');   // damages enemies, not players — see #530 comment
    expect(seekOverride).toBe(near);
    // A real fire cue plays too (previously silent — the actual #530 bug).
    expect(scheduleFireCues).toHaveBeenCalledTimes(1);
  });

  it('shares the enemy Recon Drone\'s own engagement range', () => {
    expect(DRONE_RANGE).toBe(ENEMY_KINDS.drone.fireRange);
  });
});

describe('#497 _updateFriendlyDrones', () => {
  it('zaps the nearest living enemy within range once its cadence is ready', () => {
    const near = fakeEnemy(10, 0);
    const scene = makeScene([near]);
    const player = { x: 0, y: 0, dead: false };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    player.friendlyDrones = [player.friendlyDrones[0]];
    player.friendlyDrones[0].x = 0; player.friendlyDrones[0].y = 0;

    scene._updateFriendlyDrones(0.1);

    expect(scene._spawnProjectile).toHaveBeenCalledTimes(1);
    expect(scene._spawnProjectile.mock.calls[0][6]).toBe(near);   // seekOverride — the picked target
  });

  it('does not fire again until its cadence cooldown clears', () => {
    const near = fakeEnemy(10, 0);
    const scene = makeScene([near]);
    const player = { x: 0, y: 0, dead: false };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    player.friendlyDrones = [player.friendlyDrones[0]];
    player.friendlyDrones[0].x = 0; player.friendlyDrones[0].y = 0;

    scene._updateFriendlyDrones(0.1);
    scene._updateFriendlyDrones(0.1);   // well under the enemy drone's own burst-rest cadence

    expect(scene._spawnProjectile).toHaveBeenCalledTimes(1);
  });

  it('prefers the player\'s own locked target over a nearer enemy', () => {
    const near = fakeEnemy(10, 0);
    const locked = fakeEnemy(50, 0);
    const scene = makeScene([near, locked]);
    const player = { x: 0, y: 0, dead: false, aimEnemy: locked };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    player.friendlyDrones = [player.friendlyDrones[0]];
    player.friendlyDrones[0].x = 0; player.friendlyDrones[0].y = 0;

    scene._updateFriendlyDrones(0.1);

    expect(scene._spawnProjectile).toHaveBeenCalledTimes(1);
    expect(scene._spawnProjectile.mock.calls[0][6]).toBe(locked);   // seekOverride
  });

  it('falls back to the nearest enemy when the player has no locked target', () => {
    const near = fakeEnemy(10, 0);
    const far = fakeEnemy(50, 0);
    const scene = makeScene([near, far]);
    const player = { x: 0, y: 0, dead: false, aimEnemy: null };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    player.friendlyDrones = [player.friendlyDrones[0]];
    player.friendlyDrones[0].x = 0; player.friendlyDrones[0].y = 0;

    scene._updateFriendlyDrones(0.1);

    expect(scene._spawnProjectile.mock.calls[0][6]).toBe(near);   // seekOverride
  });

  it('ignores a locked target that is no longer in the live-enemy list (e.g. died this frame)', () => {
    const near = fakeEnemy(10, 0);
    const staleLock = fakeEnemy(5, 0);   // not in `enemies` below — simulates a same-frame kill
    const scene = makeScene([near]);
    const player = { x: 0, y: 0, dead: false, aimEnemy: staleLock };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    player.friendlyDrones = [player.friendlyDrones[0]];
    player.friendlyDrones[0].x = 0; player.friendlyDrones[0].y = 0;

    scene._updateFriendlyDrones(0.1);

    expect(scene._spawnProjectile.mock.calls[0][6]).toBe(near);   // seekOverride
  });

  it('despawns the whole squad the instant its owner dies, rather than hovering over a corpse', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0, dead: false };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    const views = player.friendlyDrones.map((d) => d.view);

    player.dead = true;
    scene._updateFriendlyDrones(0.1);

    for (const v of views) expect(v.destroy).toHaveBeenCalledTimes(1);
    expect(player.friendlyDrones).toBe(null);
  });

  it('a player with no squad out is a no-op', () => {
    const scene = makeScene();
    scene.players = [{ x: 0, y: 0, dead: false, friendlyDrones: null }];
    expect(() => scene._updateFriendlyDrones(0.1)).not.toThrow();
  });

  it('spins the rotor overlay every frame, independent of orbit motion', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0, dead: false };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    const d = player.friendlyDrones[0];
    const startSpin = d.rotorSpin;

    scene._updateFriendlyDrones(0.1);

    expect(d.rotorSpin).toBeGreaterThan(startSpin);
    expect(d.view.turret.rotation).toBe(d.rotorSpin);
  });

  it('stays leashed close to its owner even when spawned far away', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0, dead: false };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    player.friendlyDrones = [player.friendlyDrones[0]];
    player.friendlyDrones[0].x = 1000; player.friendlyDrones[0].y = 0;

    for (let i = 0; i < 60; i++) scene._updateFriendlyDrones(1 / 30);

    const d = player.friendlyDrones[0];
    const dist = Math.hypot(d.x - player.x, d.y - player.y);
    expect(dist).toBeLessThanOrEqual(DRONE_LEASH_RADIUS + 1);
  });
});
