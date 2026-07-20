// #347 — the arena's player SEAMS. Two things are proved here:
//
//  (a) the legacy adapter, which is what lets ~25 existing arena test doubles keep working:
//      a plain `{ mech, px, py, ... }` scene must present as a one-player collection whose
//      fields are a live VIEW of those same properties, in both directions;
//  (b) each seam answers its own question, and answers it identically at N=1 to what the
//      singleton did — that identity is the whole "nothing observable changed" claim.
import { describe, it, expect } from 'vitest';
import { makePlayer } from '../../data/players.js';
import {
  playersOf, livePlayersOf, primaryPlayerOf, targetPlayerFor, enemyTargetOf,
  listenerOf, fogOriginOf, cameraFocusOf, playersCentroidOf,
  anyPlayerAliveIn, allPlayersDeadIn,
} from './players.js';

const liveMech = () => ({ isDestroyed: () => false });
const deadMech = () => ({ isDestroyed: () => true });

// A scene shaped the way the LIVE ArenaScene is: a real collection.
function modernScene(players) { return { players }; }

// A scene shaped the way the arena's existing test doubles are: loose singleton fields.
function legacyScene(over = {}) {
  return {
    mech: liveMech(), px: 40, py: -10, angle: 0, turretAngle: 1,
    aimX: 0, aimY: 0, vx: 3, vy: 4, speed: 5, stepMs: 0, hullFrame: 0,
    playerView: { tag: 'view' }, _playerDead: false, ...over,
  };
}

describe('playersOf — the legacy scene-double adapter', () => {
  it('presents a singleton-shaped double as a one-player collection', () => {
    const list = playersOf(legacyScene());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ x: 40, y: -10, vx: 3, vy: 4, speed: 5, dead: false });
    expect(list[0].view).toEqual({ tag: 'view' });
  });

  it('READS through live — moving scene.px moves the player', () => {
    const scene = legacyScene();
    const p = playersOf(scene)[0];
    scene.px = 999;
    expect(p.x).toBe(999);
  });

  it('WRITES through live — this is what keeps the death latch and gait counters working', () => {
    const scene = legacyScene();
    const p = playersOf(scene)[0];
    p.x = 12; p.vx = 0; p.dead = true; p.hullFrame = 3;
    expect(scene.px).toBe(12);
    expect(scene.vx).toBe(0);
    expect(scene._playerDead).toBe(true);
    expect(scene.hullFrame).toBe(3);
  });

  it('caches the adapter so repeated calls in a hot loop return the same object', () => {
    const scene = legacyScene();
    expect(playersOf(scene)[0]).toBe(playersOf(scene)[0]);
  });

  it('prefers a real collection when the scene has one', () => {
    const players = [makePlayer({ mech: liveMech() })];
    expect(playersOf(modernScene(players))).toBe(players);
  });
});

describe('targetPlayerFor — "which player is this enemy fighting?"', () => {
  it('N=1: always the only player, which is why nothing changed this phase', () => {
    const only = makePlayer({ id: 0, mech: liveMech(), x: 0, y: 0 });
    const scene = modernScene([only]);
    expect(targetPlayerFor(scene, { x: 5000, y: 5000 })).toBe(only);
    expect(targetPlayerFor(scene, { x: -1, y: -1 })).toBe(only);
  });

  it('N=1 on a legacy double: the adapter player', () => {
    const scene = legacyScene();
    expect(targetPlayerFor(scene, { x: 900, y: 900 })).toBe(playersOf(scene)[0]);
  });

  it('N=2: each enemy gets its own nearest', () => {
    const a = makePlayer({ id: 0, mech: liveMech(), x: 0, y: 0 });
    const b = makePlayer({ id: 1, mech: liveMech(), x: 1000, y: 0 });
    const scene = modernScene([a, b]);
    expect(targetPlayerFor(scene, { x: 100, y: 0 })).toBe(a);
    expect(targetPlayerFor(scene, { x: 900, y: 0 })).toBe(b);
  });

  it('falls back to the primary for a caller with no position', () => {
    const a = makePlayer({ id: 0, mech: liveMech() });
    const b = makePlayer({ id: 1, mech: liveMech() });
    const scene = modernScene([a, b]);
    expect(targetPlayerFor(scene, null)).toBe(a);
    expect(targetPlayerFor(scene, {})).toBe(a);
  });
});

describe('enemyTargetOf — one target per enemy per tick', () => {
  it('reads back the pick stamped on the enemy, even if it is no longer the nearest', () => {
    const a = makePlayer({ id: 0, mech: liveMech(), x: 0, y: 0 });
    const b = makePlayer({ id: 1, mech: liveMech(), x: 1000, y: 0 });
    const scene = modernScene([a, b]);
    // The enemy is sitting next to `a`, but committed to `b` earlier this tick.
    const e = { x: 10, y: 0, targetPlayer: b };
    expect(enemyTargetOf(scene, e)).toBe(b);
  });

  it('resolves fresh when nothing was stamped — the arena tests that call helpers directly', () => {
    const a = makePlayer({ id: 0, mech: liveMech(), x: 0, y: 0 });
    const scene = modernScene([a]);
    expect(enemyTargetOf(scene, { x: 10, y: 0 })).toBe(a);
  });
});

describe('listener / fog / camera — separated because co-op splits them', () => {
  const a = makePlayer({ id: 0, mech: liveMech(), x: 100, y: 200 });
  const b = makePlayer({ id: 1, mech: liveMech(), x: 900, y: 200 });

  it('the listener is the LOCAL player, not the centroid — one machine, one pair of speakers', () => {
    expect(listenerOf(modernScene([a, b]))).toEqual({ listenerX: 100, listenerY: 200 });
  });

  it('the listener on a legacy double comes from px/py', () => {
    expect(listenerOf(legacyScene())).toEqual({ listenerX: 40, listenerY: -10 });
  });

  it('the fog origin is the local player this phase, so the fog renders identically', () => {
    expect(fogOriginOf(modernScene([a]))).toEqual({ x: 100, y: 200 });
    expect(fogOriginOf(modernScene([a, b]))).toEqual({ x: 100, y: 200 });
  });

  it('the camera focus is the primary player and carries the view it must follow', () => {
    const withView = { ...a, view: { tag: 'playerView' } };
    expect(cameraFocusOf(modernScene([withView]))).toEqual({
      x: 100, y: 200, view: { tag: 'playerView' },
    });
  });

  it('the centroid — phase 2\'s camera target — equals the single player at N=1', () => {
    expect(playersCentroidOf(modernScene([a]))).toEqual({ x: 100, y: 200 });
    expect(playersCentroidOf(modernScene([a, b]))).toEqual({ x: 500, y: 200 });
  });
});

describe('lifecycle seams', () => {
  it('livePlayersOf drops the downed', () => {
    const a = makePlayer({ id: 0, mech: liveMech() });
    const b = makePlayer({ id: 1, mech: deadMech() });
    expect(livePlayersOf(modernScene([a, b]))).toEqual([a]);
  });

  it('a legacy double with a destroyed mech reads as all-dead — the old run-end check', () => {
    expect(allPlayersDeadIn(legacyScene({ mech: deadMech() }))).toBe(true);
    expect(allPlayersDeadIn(legacyScene())).toBe(false);
  });

  it('a legacy double whose _playerDead latch flipped also reads as all-dead', () => {
    expect(allPlayersDeadIn(legacyScene({ _playerDead: true }))).toBe(true);
  });

  it('two players: the run is not over while one still stands', () => {
    const scene = modernScene([
      makePlayer({ id: 0, mech: deadMech() }),
      makePlayer({ id: 1, mech: liveMech() }),
    ]);
    expect(allPlayersDeadIn(scene)).toBe(false);
    expect(anyPlayerAliveIn(scene)).toBe(true);
  });

  it('primaryPlayerOf is stable across both scene shapes', () => {
    const a = makePlayer({ id: 0, mech: liveMech() });
    expect(primaryPlayerOf(modernScene([a]))).toBe(a);
    expect(primaryPlayerOf(legacyScene()).x).toBe(40);
  });
});
