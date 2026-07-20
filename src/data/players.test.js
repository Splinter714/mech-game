// #347 — the pure players collection. These tests exist because phase 1's whole claim is
// "nothing changes with one player, and the questions become answerable for more than one."
// Both halves are asserted here: an N=1 identity case next to every N>1 case.
import { describe, it, expect } from 'vitest';
import {
  makePlayer, playerAlive, livePlayers, anyPlayerAlive, allPlayersDead,
  nearestPlayer, primaryPlayer, playersCentroid,
} from './players.js';

const liveMech = () => ({ isDestroyed: () => false });
const deadMech = () => ({ isDestroyed: () => true });

describe('makePlayer', () => {
  it('carries every field the arena singleton used to hold on the scene', () => {
    const p = makePlayer({ id: 3, mech: liveMech(), x: 10, y: 20 });
    expect(p).toMatchObject({
      id: 3, x: 10, y: 20, vx: 0, vy: 0, speed: 0,
      stepMs: 0, hullFrame: 0, view: null, dead: false, textureKey: 'playerMech',
    });
    // The deploy defaults the arena relies on (legs facing up, aim point ahead).
    expect(p.angle).toBeCloseTo(-Math.PI / 2);
    expect(p.turretAngle).toBeCloseTo(-Math.PI / 2);
  });

  it('makes independent players — no shared state between two of them', () => {
    const a = makePlayer({ id: 0 });
    const b = makePlayer({ id: 1 });
    a.x = 500;
    expect(b.x).toBe(0);
  });
});

describe('playerAlive', () => {
  it('is alive until either the latch flips or the mech is destroyed', () => {
    expect(playerAlive(makePlayer({ mech: liveMech() }))).toBe(true);
    expect(playerAlive({ ...makePlayer({ mech: liveMech() }), dead: true })).toBe(false);
    expect(playerAlive(makePlayer({ mech: deadMech() }))).toBe(false);
  });

  it('treats a mech-less player as live, so a half-built test double is not a corpse', () => {
    expect(playerAlive(makePlayer({}))).toBe(true);
  });

  it('is false for null/undefined rather than throwing', () => {
    expect(playerAlive(null)).toBe(false);
    expect(playerAlive(undefined)).toBe(false);
  });
});

describe('livePlayers / anyPlayerAlive', () => {
  it('filters out the downed', () => {
    const a = makePlayer({ id: 0, mech: liveMech() });
    const b = makePlayer({ id: 1, mech: deadMech() });
    expect(livePlayers([a, b])).toEqual([a]);
    expect(anyPlayerAlive([a, b])).toBe(true);
    expect(anyPlayerAlive([b])).toBe(false);
  });

  it('handles a missing collection without throwing', () => {
    expect(livePlayers(undefined)).toEqual([]);
    expect(anyPlayerAlive(undefined)).toBe(false);
  });
});

describe('allPlayersDead — what ends a run (#347, replacing `this.mech.isDestroyed()`)', () => {
  it('one player: exactly the old single-mech check', () => {
    expect(allPlayersDead([makePlayer({ mech: liveMech() })])).toBe(false);
    expect(allPlayersDead([makePlayer({ mech: deadMech() })])).toBe(true);
  });

  it('two players: NOT over while either is still standing', () => {
    const a = makePlayer({ id: 0, mech: deadMech() });
    const b = makePlayer({ id: 1, mech: liveMech() });
    expect(allPlayersDead([a, b])).toBe(false);
    expect(allPlayersDead([a, makePlayer({ id: 1, mech: deadMech() })])).toBe(true);
  });

  it('an EMPTY collection is not "all dead" — nobody must never end a run', () => {
    expect(allPlayersDead([])).toBe(false);
    expect(allPlayersDead(undefined)).toBe(false);
  });
});

describe('nearestPlayer — the phase-2 enemy-targeting rule, live today', () => {
  it('with ONE player it is unconditionally that player, whatever the query point', () => {
    const only = makePlayer({ id: 0, mech: liveMech(), x: 900, y: -400 });
    for (const [x, y] of [[0, 0], [1e6, 1e6], [-50, 7], [900, -400]]) {
      expect(nearestPlayer([only], x, y)).toBe(only);
    }
  });

  it('picks the closer of two', () => {
    const a = makePlayer({ id: 0, mech: liveMech(), x: 0, y: 0 });
    const b = makePlayer({ id: 1, mech: liveMech(), x: 100, y: 0 });
    expect(nearestPlayer([a, b], 10, 0)).toBe(a);
    expect(nearestPlayer([a, b], 90, 0)).toBe(b);
    expect(nearestPlayer([a, b], 50.1, 0)).toBe(b);
  });

  it('prefers a LIVE player over a nearer corpse — enemies fight the living', () => {
    const corpse = makePlayer({ id: 0, mech: deadMech(), x: 0, y: 0 });
    const alive = makePlayer({ id: 1, mech: liveMech(), x: 500, y: 0 });
    expect(nearestPlayer([corpse, alive], 1, 0)).toBe(alive);
  });

  it('falls back to the nearest corpse when everyone is down, so position queries still work', () => {
    const a = makePlayer({ id: 0, mech: deadMech(), x: 0, y: 0 });
    const b = makePlayer({ id: 1, mech: deadMech(), x: 100, y: 0 });
    expect(nearestPlayer([a, b], 95, 0)).toBe(b);
  });

  it('is null only for an empty collection', () => {
    expect(nearestPlayer([], 0, 0)).toBe(null);
    expect(nearestPlayer(undefined, 0, 0)).toBe(null);
  });
});

describe('primaryPlayer / playersCentroid', () => {
  it('primary is the local player', () => {
    const a = makePlayer({ id: 0 }); const b = makePlayer({ id: 1 });
    expect(primaryPlayer([a, b])).toBe(a);
    expect(primaryPlayer([])).toBe(null);
  });

  it('centroid of one player IS that player — so the camera cannot move this phase', () => {
    const only = makePlayer({ id: 0, mech: liveMech(), x: 123, y: -45 });
    expect(playersCentroid([only])).toEqual({ x: 123, y: -45 });
  });

  it('centroid of two is the midpoint, and ignores the downed', () => {
    const a = makePlayer({ id: 0, mech: liveMech(), x: 0, y: 0 });
    const b = makePlayer({ id: 1, mech: liveMech(), x: 100, y: 40 });
    expect(playersCentroid([a, b])).toEqual({ x: 50, y: 20 });
    const dead = makePlayer({ id: 2, mech: deadMech(), x: 1000, y: 1000 });
    expect(playersCentroid([a, b, dead])).toEqual({ x: 50, y: 20 });
  });
});
