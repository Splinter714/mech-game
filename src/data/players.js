// The PLAYERS collection (#347, phase 1 of local co-op — parent #335).
//
// Everything in the arena used to reason about THE player: `scene.mech`, `scene.px`,
// `scene.py`, `scene.vx/vy`, `scene.playerView`, `scene._playerDead`. That singleton is the
// single biggest obstacle to co-op (#335 measured ~72 references across 13 files), so this
// module introduces the collection the arena now holds — currently with exactly ONE entry.
//
// **This phase deliberately changes nothing observable.** With `players.length === 1` every
// query below provably returns that one player, so the live game behaves bit-identically to
// the singleton it replaced. What changes is that the QUESTIONS are now askable:
// "which player is this enemy fighting?", "who collected this powerup?", "are they all dead?"
// Phase 2 answers them differently by adding a second entry — not by rewriting call sites.
//
// Pure: no Phaser, no scene. The scene-side wiring (and the seams that call into here) live in
// scenes/arena/players.js.

// A player's full per-player state. Everything that used to be a `scene.*` singleton field
// lives here, so "add a player" is "push another one of these" rather than "find every
// `this.px` and decide what it should mean now."
//
// `view` (the Phaser container) and `textureKey` are filled in by the scene once its art
// exists; they're declared here so the shape is complete and obvious in one place.
export function makePlayer({
  id = 0,
  mech = null,
  x = 0,
  y = 0,
  angle = -Math.PI / 2,
  turretAngle = -Math.PI / 2,
  aimX = 0,
  aimY = -200,
  textureKey = 'playerMech',
} = {}) {
  return {
    id,
    mech,
    textureKey,
    // Pose.
    x, y, angle, turretAngle, aimX, aimY,
    // Motion.
    vx: 0, vy: 0, speed: 0,
    // Gait.
    stepMs: 0, hullFrame: 0,
    // Presentation + lifecycle.
    view: null,
    dead: false,
  };
}

// A player is out of the fight when its mech is destroyed. `dead` is the scene's own latch
// (set once, in combat.js, so the death FX/input-gate fire exactly once) — a player with no
// mech at all is treated as live so a half-built test double doesn't read as a corpse.
export function playerAlive(p) {
  return !!p && !p.dead && !(p.mech && p.mech.isDestroyed());
}

export function livePlayers(players) {
  return (players ?? []).filter(playerAlive);
}

export function anyPlayerAlive(players) {
  return (players ?? []).some(playerAlive);
}

// The run ends on death only when EVERY player is down — with one player that is exactly
// "the player died", which is what run.js used to ask directly. Phase 2's respawn/spectate
// decision (#335 open question 5) plugs in here rather than in the run flow.
// An empty collection is NOT "all dead" — there is simply nobody, which must not end a run.
export function allPlayersDead(players) {
  const list = players ?? [];
  return list.length > 0 && !list.some(playerAlive);
}

// THE phase-2 seam. #335's open question 4 ("how do enemies choose between multiple
// players?") was answered NEAREST PLAYER, and this implements exactly that — which at
// N=1 is unconditionally the only player, so wiring it in now is behaviour-preserving.
// Living players are preferred; if every player is down, the nearest corpse is returned so
// callers that just want a position (audio listener, fog origin) still get one rather than
// null. Returns null only for an empty collection.
export function nearestPlayer(players, x, y) {
  const list = players ?? [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const live = livePlayers(list);
  const pool = live.length ? live : list;
  let best = pool[0];
  let bd = Infinity;
  for (const p of pool) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// The "primary" player — the one whose HUD is drawn and who owns the local input device.
// Phase 1: the only player. Phase 2: still a real concept (this machine's own player), which
// is why it is a named query and not just `players[0]` scattered through the scene.
export function primaryPlayer(players) {
  return (players ?? [])[0] ?? null;
}

// Centroid of the live players — the natural focus for phase 2's shared leashed camera and
// for a single-listener audio position. With one player it is exactly that player's position,
// so the camera/audio behaviour is unchanged today.
export function playersCentroid(players) {
  const pool = livePlayers(players);
  const list = pool.length ? pool : (players ?? []);
  if (!list.length) return null;
  let sx = 0, sy = 0;
  for (const p of list) { sx += p.x; sy += p.y; }
  return { x: sx / list.length, y: sy / list.length };
}
