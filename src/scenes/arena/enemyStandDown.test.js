// #304 — Jackson (owner), live playtest: "enemies keep firing at me even after I've exploded
// while I wait to return to garage." `_playerDead` (combat.js) only ever gated the PLAYER's own
// input; nothing on the enemy side read it, so the squad kept engaging the crater for the whole
// RUN_OVER_DELAY (3200ms).
//
// Confirmed behaviour: after a SHORT BEAT (not instantly on the death frame — a hard cut
// mid-volley reads as a glitch) enemies stop firing and visibly disengage, heading back toward
// their base / patrol post. Turrets can't move, so they just stop.
//
// The helpers below are exercised directly against a minimal ArenaScene-shaped `this` (real
// EnemiesMixin methods), the same technique enemyDecideState.test.js / enemyFireAngle.test.js
// use. The WIRING of those helpers into the per-frame loops is additionally covered by
// source-text guards at the bottom — same technique playerDeath.test.js uses for the
// player-side `_playerDead` gates, since driving a full `_updateEnemy` frame would need the
// whole Phaser view/texture stack.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
vi.mock('phaser', () => ({ default: {} }));
import { EnemiesMixin } from './enemies.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (...f) => readFileSync(join(HERE, ...f), 'utf8');

function makeScene({ now = 0, playerDead = false, enemyFire = true, bases = [] } = {}) {
  const scene = { time: { now }, enemyFire, bases, _playerDead: playerDead, _standDownAt: null };
  Object.assign(scene, EnemiesMixin);
  return scene;
}

describe('#304 the stand-down clock', () => {
  it('is inactive while the player is alive', () => {
    const scene = makeScene({ now: 10_000 });
    expect(scene._standDownActive()).toBe(false);
    expect(scene._enemyFireAllowed()).toBe(true);
  });

  it('is NOT active on the death frame — the beat has to elapse first (enemies still fire)', () => {
    const scene = makeScene({ now: 1000, playerDead: true });
    expect(scene._standDownActive()).toBe(false);
    expect(scene._enemyFireAllowed()).toBe(true);        // trailing fire, on purpose
    expect(scene._standDownAt).toBeGreaterThan(1000);    // deadline stamped lazily on first ask
  });

  it('stays inactive partway through the beat', () => {
    const scene = makeScene({ now: 1000, playerDead: true });
    scene._standDownActive();                 // stamps the deadline at 1000 + beat
    scene.time.now = 1000 + 200;              // 200ms in — well short of the ~600ms beat
    expect(scene._standDownActive()).toBe(false);
    expect(scene._enemyFireAllowed()).toBe(true);
  });

  it('activates once the beat has elapsed, and firing is gated off from then on', () => {
    const scene = makeScene({ now: 1000, playerDead: true });
    scene._standDownActive();
    scene.time.now = 1000 + 5000;             // comfortably past the beat
    expect(scene._standDownActive()).toBe(true);
    expect(scene._enemyFireAllowed()).toBe(false);
  });

  it('the beat is short — under a second, so the stand-down is visible well inside RUN_OVER_DELAY', () => {
    const scene = makeScene({ now: 0, playerDead: true });
    scene._standDownActive();
    expect(scene._standDownAt).toBeGreaterThan(0);       // not instant
    expect(scene._standDownAt).toBeLessThan(1000);       // but a beat, not a pause
  });

  it('leaves the #28 debug fire toggle authoritative when it is off', () => {
    const scene = makeScene({ now: 0, enemyFire: false });
    expect(scene._enemyFireAllowed()).toBe(false);
  });

  it('never mutates this.enemyFire (the debug toggle is the player\'s switch, not ours)', () => {
    const scene = makeScene({ now: 1000, playerDead: true });
    scene._standDownActive();
    scene.time.now = 9000;
    scene._enemyFireAllowed();
    expect(scene.enemyFire).toBe(true);
  });
});

describe('#304 where a stood-down unit withdraws to', () => {
  it('a dock/base-spawned unit (baseId) heads back to its OWN base', () => {
    const scene = makeScene({ bases: [{ id: 'base0', center: { q: 0, r: 0 } }, { id: 'base1', center: { q: 5, r: -2 } }] });
    const goal = scene._standDownGoal({ baseId: 'base1', spawnX: 999, spawnY: 999, x: 0, y: 0 });
    const other = scene._standDownGoal({ baseId: 'base0', spawnX: 999, spawnY: 999, x: 0, y: 0 });
    expect(goal).not.toEqual(other);          // it picks ITS base, not just any base
    expect(goal.x).not.toBe(999);             // and not its spawn fallback
  });

  it('an unbased roamer (patrol/wave/debug spawn) falls back to its own spawn post', () => {
    const scene = makeScene({ bases: [{ id: 'base0', center: { q: 3, r: 3 } }] });
    // Deliberately NOT the nearest base: a wave spawn has no fictional tie to a base it never
    // came from, and funnelling unrelated units into the nearest one piles them up at the crater.
    expect(scene._standDownGoal({ baseId: null, spawnX: 120, spawnY: -40 })).toEqual({ x: 120, y: -40 });
  });

  it('survives a baseId whose base no longer exists, and an arena with no bases at all', () => {
    const scene = makeScene({ bases: [] });
    scene.bases = undefined;
    expect(scene._standDownGoal({ baseId: 'base9', spawnX: 7, spawnY: 8 })).toEqual({ x: 7, y: 8 });
  });
});

describe('#304 disengage movement', () => {
  it('steers toward the withdrawal point and caches it on the unit', () => {
    const scene = makeScene();
    const e = { baseId: null, spawnX: 100, spawnY: 0, x: 0, y: 0 };
    const { mx, my } = scene._standDownMoveIntent(e);
    expect(mx).toBeCloseTo(1, 5);             // due +x, straight home
    expect(my).toBeCloseTo(0, 5);
    expect(e.standDownGoal).toEqual({ x: 100, y: 0 });
  });

  it('stops once it has arrived, instead of jittering on the spot', () => {
    const scene = makeScene();
    const e = { baseId: null, spawnX: 5, spawnY: 0, x: 0, y: 0 };
    expect(scene._standDownMoveIntent(e)).toEqual({ mx: 0, my: 0 });
  });

  it('a mobile vehicle withdraws: it gains velocity toward home and takes the standdown posture', () => {
    const scene = makeScene();
    const e = {
      baseId: null, spawnX: 1000, spawnY: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, turret: Math.PI,
      kindDef: { move: { maxSpeed: 200, accel: 400, turretSlew: 3 } },
    };
    for (let i = 0; i < 30; i++) scene._standDownVehicleMove(e, 1 / 60);
    expect(e.state).toBe('standdown');
    expect(e.vx).toBeGreaterThan(0);          // moving away from the crater, toward its post
    expect(Math.abs(e.turret)).toBeLessThan(Math.PI);   // gun swung off target, back over travel
  });

  it('a TURRET (immobile) does not try to disengage — it just coasts to a stop', () => {
    const scene = makeScene();
    const e = {
      baseId: null, spawnX: 1000, spawnY: 0, x: 0, y: 0, vx: 0, vy: 0, angle: 0, turret: 0,
      kindDef: { move: { maxSpeed: 0, accel: 400, turretSlew: 3 } },
    };
    for (let i = 0; i < 30; i++) scene._standDownVehicleMove(e, 1 / 60);
    expect(e.state).toBe('standdown');
    expect(e.vx).toBe(0);
    expect(e.vy).toBe(0);
  });

  it('the cached withdrawal point is transient AI state, cleared by _resetAiState', () => {
    expect(src('enemies.js')).toMatch(/_resetAiState\(e\) \{[\s\S]*?e\.standDownGoal = null;/);
  });
});

// ── Wiring guards (source-text, same technique as playerDeath.test.js) ──────────────────
describe('#304 the stand-down gate is actually wired into both enemy loops', () => {
  it('the mech-enemy firing loop fires through _enemyFireAllowed(), not the raw toggle', () => {
    expect(src('enemies.js')).toMatch(/if \(this\._enemyFireAllowed\(\) && reacting\) for \(const w of e\.mech\.readyWeapons\(\)\)/);
    expect(src('enemies.js')).not.toMatch(/if \(this\.enemyFire && reacting\)/);
  });

  it('every vehicle kind fires through _enemyFireAllowed() too (aimAndFire)', () => {
    expect(src('enemyBehaviors.js')).toMatch(/if \(!scene\._enemyFireAllowed\(\)\) return;/);
    expect(src('enemyBehaviors.js')).not.toMatch(/if \(!scene\.enemyFire\) return;/);
  });

  it('a stood-down mech enters the standdown state instead of running the combat brain', () => {
    expect(src('enemies.js')).toMatch(/if \(stood\) \{[\s\S]*?e\.state = 'standdown';[\s\S]*?_standDownMoveIntent\(e\)/);
  });

  it('a stood-down vehicle skips its tactical behavior entirely (which is where its firing lives)', () => {
    expect(src('enemies.js')).toMatch(/if \(this\._standDownActive\(\)\) \{\s*\n\s*this\._standDownVehicleMove\(e, dt\);\s*\n\s*\} else if \(!reacting\)/);
  });

  it('a stood-down mech stops tracking the player with its turret and drops its lock', () => {
    expect(src('enemies.js')).toMatch(/if \(reacting && !stood\) e\.turret = rotateToward\(e\.turret, bearing/);
    expect(src('enemies.js')).toMatch(/if \(reacting && !stood\) this\._updateEnemyLock\(/);
  });
});

// Refs #281's lesson (a first death left the player permanently frozen because scene state
// survived a redeploy on the reused Phaser scene instance) — the enemy-side twin of that bug
// would be a redeploy finding every enemy already stood down.
describe('#304 a redeploy resets the stand-down clock', () => {
  it('ArenaScene.create() clears _standDownAt alongside _playerDead', () => {
    const arena = src('..', 'ArenaScene.js');
    const create = arena.match(/create\(\)[\s\S]*?\n {2}\}/);
    // #348: the `_playerDead = false` line this used to pair against is gone — create() now
    // rebuilds the players collection wholesale, so the dead latch starts clean by construction
    // rather than by assignment (see playerDeath.test.js for that guard).
    expect(create[0]).toMatch(/this\.players = \[\];/);
    expect(create[0]).toMatch(/this\._standDownAt = null;/);
  });
});

// ── #360 co-op: the predicate is ALL players dead, not "player 1 is dead" ──────────────
// Jackson, two-player playtest: "enemies are falsely disengaging/freezing when player 1 dies
// and player 2 is still alive." `_playerDead` is phase 1's delegating accessor onto
// `players[0]`, so #304's stand-down stood the WHOLE squad down the instant player 1 exploded.
// The correct seam (`allPlayersDeadIn`, players.js) already existed — #348 phase 2 built it for
// exactly this distinction, and run.js ends the run on it.
function coopScene({ now = 0, dead = [false, false], enemyFire = true } = {}) {
  const scene = {
    time: { now }, enemyFire, bases: [], _standDownAt: null,
    players: dead.map((d, id) => ({ id, dead: d, x: 0, y: 0, mech: { isDestroyed: () => d } })),
  };
  Object.assign(scene, EnemiesMixin);
  return scene;
}

describe('#360 stand-down in co-op', () => {
  it('does NOT stand down with one player dead and one still alive — the fight is still on', () => {
    const scene = coopScene({ now: 1000, dead: [true, false] });
    expect(scene._standDownActive()).toBe(false);
    expect(scene._enemyFireAllowed()).toBe(true);
    // and no clock was even started, so nothing can elapse into a stand-down later
    expect(scene._standDownAt).toBe(null);
    scene.time.now = 1000 + 60_000;
    expect(scene._standDownActive()).toBe(false);
    expect(scene._enemyFireAllowed()).toBe(true);
  });

  it('it is player TWO dying that used to be ignored and player ONE dying that used to trigger — neither does alone', () => {
    for (const dead of [[true, false], [false, true]]) {
      const scene = coopScene({ now: 1000, dead });
      scene.time.now = 1000 + 60_000;
      expect(scene._standDownActive()).toBe(false);
    }
  });

  it('DOES stand down once every player is down (after the same #304 beat)', () => {
    const scene = coopScene({ now: 1000, dead: [true, true] });
    expect(scene._standDownActive()).toBe(false);   // still the trailing-volley beat
    expect(scene._standDownAt).toBeGreaterThan(1000);
    scene.time.now = 1000 + 5000;
    expect(scene._standDownActive()).toBe(true);
    expect(scene._enemyFireAllowed()).toBe(false);
  });

  it('is unchanged at N=1: a solo player dying still stands the squad down after the beat', () => {
    const scene = coopScene({ now: 1000, dead: [true] });
    expect(scene._standDownActive()).toBe(false);
    scene.time.now = 1000 + 5000;
    expect(scene._standDownActive()).toBe(true);
    expect(scene._enemyFireAllowed()).toBe(false);
    const alive = coopScene({ now: 1000, dead: [false] });
    alive.time.now = 1000 + 60_000;
    expect(alive._standDownActive()).toBe(false);
  });

  // #348 respawn: a downed player returns ~20s later gated on the survivor being out of combat,
  // so "all players dead" can flip back to false mid-sortie. The clock must not latch.
  it('re-engages on respawn and can stand down again cleanly on the NEXT team wipe', () => {
    const scene = coopScene({ now: 1000, dead: [true, true] });
    scene._standDownActive();
    scene.time.now = 1000 + 5000;
    expect(scene._standDownActive()).toBe(true);          // engaged: everyone down

    // Player 2 respawns. Enemies must resume fighting immediately, and the elapsed deadline
    // must be cleared rather than left sitting on the scene.
    scene.players[1].dead = false;
    scene.players[1].mech.isDestroyed = () => false;
    expect(scene._standDownActive()).toBe(false);
    expect(scene._standDownAt).toBe(null);
    expect(scene._enemyFireAllowed()).toBe(true);

    // Now the survivor dies too. The beat has to run again from scratch — a stale elapsed
    // deadline would have stood everyone down on the very death frame.
    scene.players[1].dead = true;
    scene.players[1].mech.isDestroyed = () => true;
    scene.time.now = 1000 + 20_000;
    expect(scene._standDownActive()).toBe(false);
    expect(scene._standDownAt).toBe(1000 + 20_000 + 600);
    scene.time.now = 1000 + 20_000 + 601;
    expect(scene._standDownActive()).toBe(true);
  });

  it('the #28 debug fire toggle still wins while both players are alive', () => {
    const scene = coopScene({ dead: [false, false], enemyFire: false });
    expect(scene._enemyFireAllowed()).toBe(false);
  });
});
