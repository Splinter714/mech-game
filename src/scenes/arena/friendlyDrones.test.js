// #497 — Friendly Drone Launcher. Exercises `FriendlyDronesMixin` directly against a minimal
// fake scene, mirroring interceptor.test.js's pattern.
//
// #497 follow-up: the summon now bakes its view from the real Recon Drone art builder
// (art/vehicles/drone.js `drawDrone`, via `buildVehicleTextures`) instead of a plain
// `add.circle`. Real texture generation needs a real Phaser canvas/graphics stack this test has
// no business building (same call carrierDeploy.test.js makes about `_spawnKind`), so the fake
// scene's `textures.exists` always reports true — the build branch is skipped and never
// exercised here; only the pure position/targeting/lifecycle logic is under test.
import { describe, it, expect, vi } from 'vitest';
import { FriendlyDronesMixin } from './friendlyDrones.js';

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
    _damageEnemyAt: vi.fn(),
  };
  return Object.assign(scene, FriendlyDronesMixin);
}

function fakeEnemy(x, y) {
  return { x, y, mech: { isDestroyed: () => false } };
}

describe('#497 _spawnFriendlyDrone / _despawnFriendlyDrone', () => {
  it('creates a drone on the player and a view (hull+turret+shadow) for it', () => {
    const scene = makeScene();
    const player = { x: 10, y: 20, color: 0xff0000 };
    scene._spawnFriendlyDrone(player);
    expect(player.friendlyDrone).toBeTruthy();
    expect(scene.add.container).toHaveBeenCalledWith(10, 20, expect.any(Array));
    expect(player.friendlyDrone.view.hull).toBeTruthy();
    expect(player.friendlyDrone.view.turret).toBeTruthy();
  });

  it('re-summoning replaces rather than leaking a second view', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0 };
    scene._spawnFriendlyDrone(player);
    const first = player.friendlyDrone.view;
    scene._spawnFriendlyDrone(player);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(player.friendlyDrone.view).not.toBe(first);
  });

  it('despawn destroys the view and clears the slot', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0 };
    scene._spawnFriendlyDrone(player);
    const view = player.friendlyDrone.view;
    scene._despawnFriendlyDrone(player);
    expect(view.destroy).toHaveBeenCalledTimes(1);
    expect(player.friendlyDrone).toBe(null);
  });

  it('despawning with no drone out is a safe no-op', () => {
    const scene = makeScene();
    expect(() => scene._despawnFriendlyDrone({ x: 0, y: 0 })).not.toThrow();
  });
});

describe('#497 _updateFriendlyDrones', () => {
  it('zaps the nearest living enemy within range once its cadence is ready', () => {
    const near = fakeEnemy(10, 0);
    const scene = makeScene([near]);
    const player = { x: 0, y: 0, dead: false };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    player.friendlyDrone.x = 0; player.friendlyDrone.y = 0;   // pin position for a deterministic range check

    scene._updateFriendlyDrones(0.1);

    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
    expect(scene._damageEnemyAt.mock.calls[0][0]).toBe(near);
  });

  it('does not fire again until its cadence cooldown clears', () => {
    const near = fakeEnemy(10, 0);
    const scene = makeScene([near]);
    const player = { x: 0, y: 0, dead: false };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    player.friendlyDrone.x = 0; player.friendlyDrone.y = 0;

    scene._updateFriendlyDrones(0.1);
    scene._updateFriendlyDrones(0.1);   // well under DRONE_CYCLE (0.4s) since the first shot

    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
  });

  it('despawns the drone the instant its owner dies, rather than orbiting a corpse', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0, dead: false };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    const view = player.friendlyDrone.view;

    player.dead = true;
    scene._updateFriendlyDrones(0.1);

    expect(view.destroy).toHaveBeenCalledTimes(1);
    expect(player.friendlyDrone).toBe(null);
  });

  it('a player with no drone out is a no-op', () => {
    const scene = makeScene();
    scene.players = [{ x: 0, y: 0, dead: false, friendlyDrone: null }];
    expect(() => scene._updateFriendlyDrones(0.1)).not.toThrow();
  });

  it('spins the rotor overlay every frame, independent of orbit motion', () => {
    const scene = makeScene();
    const player = { x: 0, y: 0, dead: false };
    scene.players = [player];
    scene._spawnFriendlyDrone(player);
    const startSpin = player.friendlyDrone.rotorSpin;

    scene._updateFriendlyDrones(0.1);

    expect(player.friendlyDrone.rotorSpin).toBeGreaterThan(startSpin);
    expect(player.friendlyDrone.view.turret.rotation).toBe(player.friendlyDrone.rotorSpin);
  });
});
