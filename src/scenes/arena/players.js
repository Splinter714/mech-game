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
  playerColor,
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

// (2b) The fog-of-war / visibility origin (#337). The PEEK sweep and the redraw gating are still
// swept from ONE origin — the local player — because they are a per-frame raycast and a screen
// overlay, and the shared leashed camera (#348) keeps the second player inside the same frame
// anyway. What phase 2 DOES make a union is compound ENTRY: either player walking into a
// compound reveals it for the team (`fogOriginsOf` below). That is the half that is a persistent
// world-state change rather than a rendering detail, so it is the half that must not depend on
// which player happens to be player 1.
export function fogOriginOf(scene) {
  const p = primaryPlayerOf(scene);
  return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
}

// (2c) #348: EVERY live player's position, for the fog rules that are a union rather than a
// single sweep. Falls back to the single origin when nobody is alive so callers always get at
// least one point to work from.
export function fogOriginsOf(scene) {
  const live = livePlayersOf(scene);
  if (!live.length) return [fogOriginOf(scene)];
  return live.map((p) => ({ x: p.x, y: p.y }));
}

// (3) What the camera frames. #348: the CENTROID of the live players, which is exactly the
// primary player's own position while there is only one of them — so single-player framing is
// untouched. In co-op this is the shared camera, and data/leash.js is what guarantees nobody can
// walk out of the frame it implies (a hard stop, not a zoom-out and not a rubber-band —
// Jackson rejected both by name). `view` is still the primary player's container, because
// Phaser's `startFollow` needs a live GameObject to anchor on; the arena drives the centroid by
// moving a dedicated follow anchor instead (see scenes/arena/coop.js `_updateCoopCamera`).
export function cameraFocusOf(scene) {
  const c = playersCentroid(playersOf(scene));
  const p = primaryPlayerOf(scene);
  if (!c) return p ? { x: p.x, y: p.y, view: p.view } : null;
  return { x: c.x, y: c.y, view: p?.view ?? null };
}

// (4b) #348 FRIENDLY FIRE: is this hit-trace candidate one of the players? Friendly fire is ON
// (Jackson), which means a player-fired shot can now resolve to either an enemy or another
// player, and the two have completely different damage sinks (`_damageEnemyAt` vs
// `_damagePlayerAt`). Rather than have every shot path guess from the shape of the object, they
// all ask here. Identity, not duck-typing: a player is a member of the collection.
export function isPlayerRef(scene, ref) {
  return !!ref && playersOf(scene).includes(ref);
}

// #348: the other live players a shot fired by `shooter` can hit. Friendly fire deliberately
// never includes the shooter themselves — walking into your own muzzle is not the mechanic.
export function otherLivePlayers(scene, shooter) {
  const all = playersOf(scene);
  // Solo play has no allies to hit, and saying so up front matters: a caller that could not
  // name its shooter (a legacy arena test double, an enemy-owned code path) must not have the
  // one and only player handed back to it as a friendly-fire candidate.
  if (all.length < 2) return [];
  return livePlayers(all).filter((p) => p !== shooter);
}

export function playersCentroidOf(scene) { return playersCentroid(playersOf(scene)); }

// (4) Lifecycle. `allPlayersDeadIn` is what ends a run — with one player that is exactly
// "the player died", which is what run.js asked directly before.
export function anyPlayerAliveIn(scene) { return anyPlayerAlive(playersOf(scene)); }
export function allPlayersDeadIn(scene) { return allPlayersDead(playersOf(scene)); }

// Present a legacy scene double (plain `{ mech, px, py, vx, vy, ... }`) as a player object.
function legacyPlayerAdapter(scene) {
  const p = { id: 0, textureKey: 'playerMech', color: playerColor(0), lastHitAt: -Infinity };
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
  // #348: the input-shaped state that moved onto the player. A legacy double still carries these
  // as scene fields (`scene.convergeTarget`, `scene.fireCooldowns`, …) and its assertions read
  // them back off the scene, so they alias exactly like the pose fields above — a write through
  // the adapter lands on the double, which is what makes ~25 hand-built test scenes keep working
  // against per-player firing/targeting without being rewritten.
  alias('convergeTarget', 'convergeTarget');
  alias('aimEnemy', 'aimEnemy');
  alias('reticlePos', '_reticlePos');
  alias('fireCooldowns', 'fireCooldowns');
  alias('heldAudio', '_heldAudio');
  alias('sprint', 'sprint');
  alias('dash', 'dash');
  alias('sprintForcedByOverclock', '_sprintForcedByOverclock');
  alias('overclockWasActive', '_overclockWasActive');
  alias('controls', 'controls');
  return p;
}
