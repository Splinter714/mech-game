// #497 — Friendly Drone Launcher. Exercises `FriendlyDronesMixin` directly against a minimal
// fake scene, mirroring interceptor.test.js's pattern.
import { describe, it, expect, vi } from 'vitest';
import { FriendlyDronesMixin } from './friendlyDrones.js';

function fakeView() {
  return { setStrokeStyle() { return this; }, setDepth() { return this; }, setPosition: vi.fn(), destroy: vi.fn() };
}

function makeScene(enemies = []) {
  const scene = {
    enemies,
    players: [],
    time: { now: 0 },
    add: { circle: vi.fn(() => fakeView()) },   // a FRESH view each call — spawn never reuses one
    _damageEnemyAt: vi.fn(),
  };
  return Object.assign(scene, FriendlyDronesMixin);
}

function fakeEnemy(x, y) {
  return { x, y, mech: { isDestroyed: () => false } };
}

describe('#497 _spawnFriendlyDrone / _despawnFriendlyDrone', () => {
  it('creates a drone on the player and a view for it', () => {
    const scene = makeScene();
    const player = { x: 10, y: 20, color: 0xff0000 };
    scene._spawnFriendlyDrone(player);
    expect(player.friendlyDrone).toBeTruthy();
    expect(scene.add.circle).toHaveBeenCalledWith(10, 20, 7, 0xff0000);
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
});
