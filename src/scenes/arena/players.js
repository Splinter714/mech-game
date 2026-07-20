// Arena players seam (#347) — the scene-side half of the de-singletoned player.
//
// `scene.players` is the collection (data/players.js `makePlayer`), currently holding exactly
// ONE entry. This file provides the SEAMS the rest of the arena asks its player questions
// through, instead of reading `scene.px`/`scene.py`/`scene.mech` directly. Each seam is a
// one-line answer today and stays a one-line answer in phase 2 — that's the point: the change
// lands in one place per question, not across 13 files again.
//
// The four questions the old singleton was silently answering all at once, now separated
// because co-op answers them DIFFERENTLY (this taxonomy is the real deliverable of phase 1):
//
//  1. "Which player is this enemy fighting?"      → `targetPlayerFor(scene, entity)`  (NEAREST)
//  2. "Where are the ears / where is the fog lit" → `listenerOf` / `fogOriginOf`
//  3. "Who is the camera framing?"                → `cameraFocusOf`
//  4. "Who collected this / who is being hit?"    → iterate `livePlayersOf`
//
// Question 1 is already answered with the phase-2 rule (`nearestPlayer`), because at N=1
// "nearest" IS "the only one" — so the seam is genuinely exercised by the live game today
// rather than being a stub that has never run.
//
// These are STANDALONE FUNCTIONS taking the scene, not mixin methods, for one concrete
// reason: the arena's ~25 hand-built test doubles are plain objects composed with
// `Object.assign(scene, SomeMixin)`, so a `this._seam()` method would only exist on doubles
// whose test happened to also assign a players mixin. A function that accepts either a real
// scene or a legacy double works everywhere, and `playersOf` below is what makes a double
// (which carries `px`/`py`/`mech` instead of a collection) present as a one-player array.
import {
  allPlayersDead, anyPlayerAlive, livePlayers, nearestPlayer, playersCentroid, primaryPlayer,
} from '../../data/players.js';

// THE collection. A real ArenaScene sets `scene.players` in create(). A legacy scene double
// gets a synthesized one-player adapter, cached on the double, whose fields are live getters
// onto `px`/`py`/`mech`/... — a VIEW, never a copy, so a test that moves `scene.px` mid-
// assertion still sees the move and a write through the adapter still lands on the double.
export function playersOf(scene) {
  if (scene.players) return scene.players;
  return (scene._legacyPlayers ??= [legacyPlayerAdapter(scene)]);
}

export function livePlayersOf(scene) { return livePlayers(playersOf(scene)); }

// The local player — whose HUD is drawn, who owns the local input device. Phase 1: the only
// one. Phase 2: still a real, distinct concept, which is why it is a named query rather than
// `players[0]` sprinkled through the scene.
export function primaryPlayerOf(scene) { return primaryPlayer(playersOf(scene)); }

// (1) Which player does `entity` (an enemy, an alert tower, a homing round) care about?
// NEAREST PLAYER — #335's agreed rule, live here already. `entity` is anything with x/y.
// A caller with no position falls back to the primary player.
export function targetPlayerFor(scene, entity) {
  const list = playersOf(scene);
  if (!entity || entity.x == null || entity.y == null) return primaryPlayer(list);
  return nearestPlayer(list, entity.x, entity.y);
}

// (1b) The target player an enemy already resolved THIS TICK. `_updateEnemy`/`_updateVehicle`
// stamp `e.targetPlayer` once per frame and every downstream helper (state decision, flank
// goal, cover search, lock, fire angle) reads it back through here — so one enemy can never
// reason about two different players within a single tick, which becomes a real hazard once
// "nearest" can flip as the enemy moves. Falls back to a fresh resolve for the arena tests
// that call those helpers directly, with no preceding `_updateEnemy`.
export function enemyTargetOf(scene, e) {
  return e?.targetPlayer ?? targetPlayerFor(scene, e);
}

// (2) The positional-audio listener, in the `{ listenerX, listenerY }` shape every `Audio.*`
// call takes. One listener, always — even in co-op there is one pair of speakers on this
// machine — so this is the LOCAL player, not a centroid, and phase 2 does not change that.
export function listenerOf(scene) {
  const p = primaryPlayerOf(scene);
  return { listenerX: p?.x ?? 0, listenerY: p?.y ?? 0 };
}

// (2b) The fog-of-war / visibility origin (#337). Phase 2 makes the lit set the UNION of every
// live player's field of view; phase 1 keeps the single origin so the fog is pixel-identical.
// Split from `listenerOf` precisely because the two diverge in phase 2.
export function fogOriginOf(scene) {
  const p = primaryPlayerOf(scene);
  return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
}

// (3) What the camera frames. Phase 1 hands back the primary player, so the existing
// `startFollow(playerView)` is untouched; phase 2's shared leashed camera reads the centroid
// instead (already computed correctly for N players by `playersCentroidOf`).
export function cameraFocusOf(scene) {
  const p = primaryPlayerOf(scene);
  return p ? { x: p.x, y: p.y, view: p.view } : null;
}

export function playersCentroidOf(scene) { return playersCentroid(playersOf(scene)); }

// (4) Lifecycle. `allPlayersDeadIn` is what ends a run — with one player that is exactly
// "the player died", which is what run.js asked directly before.
export function anyPlayerAliveIn(scene) { return anyPlayerAlive(playersOf(scene)); }
export function allPlayersDeadIn(scene) { return allPlayersDead(playersOf(scene)); }

// Present a legacy scene double (plain `{ mech, px, py, vx, vy, ... }`) as a player object.
function legacyPlayerAdapter(scene) {
  const p = { id: 0, textureKey: 'playerMech' };
  const alias = (name, src) => Object.defineProperty(p, name, {
    get: () => scene[src], set: (v) => { scene[src] = v; }, enumerable: true, configurable: true,
  });
  alias('mech', 'mech');
  alias('x', 'px'); alias('y', 'py');
  alias('angle', 'angle'); alias('turretAngle', 'turretAngle');
  alias('aimX', 'aimX'); alias('aimY', 'aimY');
  alias('vx', 'vx'); alias('vy', 'vy'); alias('speed', 'speed');
  alias('stepMs', 'stepMs'); alias('hullFrame', 'hullFrame');
  alias('dead', '_playerDead');
  alias('view', 'playerView');
  return p;
}
