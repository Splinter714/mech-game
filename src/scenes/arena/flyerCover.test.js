// #245 — "flying enemies' weapons should never be affected by cover." The fire GATE already
// exempted flyers (enemyBehaviors.js passes needLos: false for drone/helicopter), but the SHOTS
// themselves still collided with terrain: a straight enemy projectile detonated on the first
// wall hex it crossed (projectiles.js's `if (!p.arc)` cover check), and an enemy hitscan beam
// was cut short by `_hitscanReach` (firing.js). Fix: shots fired by a FLYING enemy
// (enemyKinds.js `flying: true`) thread an ignore-cover flag — spawned rounds are stamped
// `ignoresCover` and skip the in-flight wall check; hitscan traces skip the wall trace
// entirely. Player-fired shots and ground-enemy shots are byte-for-byte unchanged.
//
// enemies.js has a vestigial `import Phaser from 'phaser'` whose top-level device detection
// throws under vitest's node env, so we stub the module out (same as vehicleFire.test.js).
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));
// Spy the shared fire-cue scheduler (audio) — irrelevant to cover mechanics.
vi.mock('../../audio/fireCues.js', () => ({ scheduleFireCues: vi.fn() }));

import { ProjectilesMixin } from './projectiles.js';
import { FiringMixin } from './firing.js';
import { EnemiesMixin } from './enemies.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile } from '../../data/delivery.js';

// Referenced via WEAPONS.<id>.id (no string literals) per the architecture guard's convention
// in this directory's other tests. machineGun (Repeater) is the helicopter's actual straight
// projectile stream; pulseLaser is the registry's canonical hitscan burst weapon (no longer
// the drone's own mount as of #243's further follow-up — the drone now fires plasmaLance, a
// projectile stream — but still a real hitscan weapon a live kind's shots could plausibly use).
const STRAIGHT_PROJECTILE = WEAPONS.machineGun;
const HITSCAN_WEAPON = WEAPONS.pulseLaser;

// ── In-flight projectile vs. wall ──────────────────────────────────────────────────────────
// Minimal ArenaScene-shaped `this` (same harness as projectiles.test.js) with EVERY hex
// reading as a wall (`_isWallForRound` always true) — the harshest cover field possible.
function makeProjectileScene({ playerAt = { x: 300, y: 0 } } = {}) {
  const scene = {
    enemies: [],
    projectiles: [],
    firePatches: [],
    px: playerAt.x, py: playerAt.y,
    mech: { isDestroyed: () => false },
    time: { now: 0 },
    projFx: { clear: vi.fn() },
    _hexKeyAt: () => 'h',
    _isWallForRound: () => true,   // wall-to-wall cover: any cover-respecting round dies instantly
    _damageBuildingAt: vi.fn(),
    _impactFx: vi.fn(),
    _damagePlayerAt: vi.fn(),
    _damageEnemyAt: vi.fn(),
    _rangeFactor: () => 1,
  };
  Object.assign(scene, ProjectilesMixin);
  scene._drawProjectile = vi.fn();
  return scene;
}

function fireEnemyRound(scene, { ignoresCover }) {
  const round = makeProjectile(STRAIGHT_PROJECTILE, 0, 0, 0, { maxDist: 9999 });
  round.owner = 'enemy';
  round.homing = false;
  round.trail = [];
  round.originHexes = [];
  round.ignoresCover = ignoresCover;
  scene.projectiles = [round];
  for (let i = 0; i < 400 && scene.projectiles.length && !scene.projectiles[0].dead; i++) {
    scene._updateProjectiles(0.016);
  }
  return round;
}

describe('#245 in-flight projectile: a flying enemy\'s round ignores terrain cover', () => {
  it('a GROUND enemy\'s straight round still detonates on the wall (unchanged)', () => {
    const scene = makeProjectileScene();
    fireEnemyRound(scene, { ignoresCover: false });
    expect(scene._damageBuildingAt).toHaveBeenCalled();   // chipped the cover it died on
    expect(scene._damagePlayerAt).not.toHaveBeenCalled(); // never reached the player
  });

  it('a FLYING enemy\'s identical round (ignoresCover) sails over the same wall and hits the player', () => {
    const scene = makeProjectileScene();
    fireEnemyRound(scene, { ignoresCover: true });
    expect(scene._damageBuildingAt).not.toHaveBeenCalled();
    expect(scene._damagePlayerAt).toHaveBeenCalled();
  });

  it('a PLAYER round without the flag still detonates on the wall (unchanged)', () => {
    const scene = makeProjectileScene();
    const round = makeProjectile(STRAIGHT_PROJECTILE, 0, 0, 0, { maxDist: 9999 });
    round.owner = 'player';
    round.homing = false;
    round.trail = [];
    round.originHexes = [];
    round.ignoresCover = false;   // what _spawnProjectile stamps for every player shot
    scene.projectiles = [round];
    scene._updateProjectiles(0.016);
    expect(round.dead).toBe(true);
    expect(scene._damageBuildingAt).toHaveBeenCalled();
  });
});

// ── Hitscan trace vs. wall ─────────────────────────────────────────────────────────────────
// The REAL _fireHitscan runs against a minimal scene: the player sits 300px downrange and
// `_hitscanReach` reports a wall at 50px. A cover-respecting beam stops there (blocked, no
// damage); a flying shooter's beam (ignoreCover) must never even consult the wall trace.
function makeHitscanScene() {
  const scene = {
    enemies: [],
    beams: [],
    dyingBeams: [],
    px: 300, py: 0,
    mech: { isDestroyed: () => false },
    _hexKeyAt: () => 'h',
    _damagePlayerAt: vi.fn(),
    _damageEnemyAt: vi.fn(),
    _impactFx: vi.fn(),
  };
  Object.assign(scene, FiringMixin);
  // Stub AFTER mixing in FiringMixin so it overrides the mixin's real implementation
  // (same convention as projectiles.test.js's _drawProjectile stub).
  scene._hitscanReach = vi.fn(() => 50);   // wall 50px out, well short of the player at 300
  return scene;
}

const HITSCAN_W = { weapon: HITSCAN_WEAPON, location: 'drone', index: 0 };

describe('#245 hitscan: a flying enemy\'s beam ignores terrain blockers', () => {
  it('a GROUND enemy\'s beam is still blocked by the wall (unchanged)', () => {
    const scene = makeHitscanScene();
    scene._fireHitscan(HITSCAN_W, 0, 0, 0, 'enemy', 'tank', false);
    expect(scene._hitscanReach).toHaveBeenCalled();
    expect(scene._damagePlayerAt).not.toHaveBeenCalled();
    // The beam visual stops at the wall, not at the player.
    expect(scene.beams[0].x1).toBeCloseTo(50, 3);
  });

  it('a FLYING enemy\'s beam (ignoreCover) skips the wall trace and damages the player', () => {
    const scene = makeHitscanScene();
    scene._fireHitscan(HITSCAN_W, 0, 0, 0, 'enemy', 'drone', true);
    expect(scene._hitscanReach).not.toHaveBeenCalled();
    expect(scene._damagePlayerAt).toHaveBeenCalled();
  });

  it('the PLAYER\'s beam (default args) still honors cover (unchanged)', () => {
    const scene = makeHitscanScene();
    scene.enemies = [{ x: 300, y: 0, mech: { isDestroyed: () => false } }];
    scene._fireHitscan(HITSCAN_W, 0, 0, 0);   // owner/shooterKey/ignoreCover all defaulted
    expect(scene._hitscanReach).toHaveBeenCalled();
    expect(scene._damageEnemyAt).not.toHaveBeenCalled();
  });
});

// ── Flag threading: _fireVehicleWeapon passes the shooter's `flying` through ───────────────
// Same harness shape as vehicleFire.test.js: the REAL _fireVehicleWeapon dispatch runs with
// the two fire helpers spied, so we can read the exact arguments each path received.
function makeVehicleScene() {
  const calls = { hitscan: [], projectile: [] };
  const scene = { time: { now: 0, delayedCall: () => {} } };
  Object.assign(scene, EnemiesMixin, FiringMixin);
  scene._melee = vi.fn();
  scene._fireHitscan = vi.fn((w, mx, my, angle, owner, key, ignoreCover) =>
    calls.hitscan.push({ owner, key, ignoreCover }));
  scene._spawnProjectile = vi.fn((w, mx, my, angle, owner, angleOffset, seek, aimAngle, ignoreCover) =>
    calls.projectile.push({ owner, ignoreCover }));
  return { scene, calls };
}

function makeKindEnemy(weaponId, flying) {
  return {
    key: 'testKind', kind: 'turret', fireCd: 0, x: 100, y: 0, flying,
    kindDef: {
      name: 'Test Kind', kind: 'turret', scale: 0.5,
      parts: { base: { x: 0, y: 6, w: 26, h: 16 }, gun: { x: 0, y: -8, w: 12, h: 20 } },
      muzzlePart: 'gun',
      weaponId,
    },
  };
}

describe('#245 _fireVehicleWeapon threads the shooter\'s flying flag into both fire paths', () => {
  it('a FLYING kind passes ignoreCover: true to _fireHitscan', () => {
    const { scene, calls } = makeVehicleScene();
    scene._fireVehicleWeapon(makeKindEnemy(HITSCAN_WEAPON.id, true), {}, 0);
    expect(calls.hitscan).toEqual([{ owner: 'enemy', key: 'testKind', ignoreCover: true }]);
  });

  it('a GROUND kind passes ignoreCover: false to _fireHitscan (unchanged)', () => {
    const { scene, calls } = makeVehicleScene();
    scene._fireVehicleWeapon(makeKindEnemy(HITSCAN_WEAPON.id, false), {}, 0);
    expect(calls.hitscan).toEqual([{ owner: 'enemy', key: 'testKind', ignoreCover: false }]);
  });

  // #269 playtest follow-up (streams bug fix): STRAIGHT_PROJECTILE (machineGun) is a twin-lane
  // stream weapon (`delivery.count: 2`) — `_fireVehicleWeapon` now dispatches EVERY emission
  // in the plan (see enemies.js `_fireEnemyShots`), so one trigger pull spawns TWO rounds, both
  // carrying the same owner/ignoreCover — not one, like the old single-shot-only dispatch did.

  it('a FLYING kind\'s projectile spawns with ignoreCover: true (both stream lanes)', () => {
    const { scene, calls } = makeVehicleScene();
    scene._fireVehicleWeapon(makeKindEnemy(STRAIGHT_PROJECTILE.id, true), {}, 0);
    expect(calls.projectile).toEqual([
      { owner: 'enemy', ignoreCover: true },
      { owner: 'enemy', ignoreCover: true },
    ]);
  });

  it('a GROUND kind\'s projectile spawns with ignoreCover: false (unchanged, both stream lanes)', () => {
    const { scene, calls } = makeVehicleScene();
    scene._fireVehicleWeapon(makeKindEnemy(STRAIGHT_PROJECTILE.id, false), {}, 0);
    expect(calls.projectile).toEqual([
      { owner: 'enemy', ignoreCover: false },
      { owner: 'enemy', ignoreCover: false },
    ]);
  });
});

// ── _spawnProjectile stamps the round ──────────────────────────────────────────────────────
describe('#245 _spawnProjectile stamps ignoresCover onto the spawned round', () => {
  function makeSpawnScene() {
    const scene = {
      projectiles: [],
      px: 300, py: 0,
      _hexKeyAt: () => 'h',
      _lockAimPoint: () => null,
    };
    Object.assign(scene, FiringMixin);
    return scene;
  }
  const w = { weapon: STRAIGHT_PROJECTILE, location: 'rightArm', index: 0 };

  it('true when the flying flag is threaded; false when omitted (player default)', () => {
    const scene = makeSpawnScene();
    const flyer = scene._spawnProjectile(w, 0, 0, 0, 'enemy', 0, null, 0, true);
    const player = scene._spawnProjectile(w, 0, 0, 0);
    expect(flyer.ignoresCover).toBe(true);
    expect(player.ignoresCover).toBe(false);
  });
});

// ── #257: the PLAYER's own shots ignore cover when aimed at a flying enemy ─────────────────
// #245 made a flyer's OWN shots ignore cover; that fix's report flagged the reverse asymmetry
// unaddressed — a flyer sitting over/behind terrain the player can't shoot through was
// effectively unhittable from the ground, even though it could freely shoot back through that
// same terrain. Fix: `fireWeapon` (firing.js) reads `this.convergeTarget` — the same live pick
// `_fireAngle` already aims muzzles at, set every frame by `_updateLock` (targeting.js) with NO
// LOS gate of its own — and threads `ignoreCover: true` into both fire paths whenever that
// target is a flying enemy (`.flying`, enemyKinds.js). A non-flying enemy or a #250
// destructible-hex convergence target (no `.flying` property) leaves `ignoreCover: false`,
// unchanged from before.
//
// Real `fireWeapon` runs end-to-end against a minimal scene; `_fireHitscan`/`_spawnProjectile`
// are spied (same pattern as `makeVehicleScene` above) so we can read the exact `ignoreCover`
// arg the dispatch computed, without needing a full muzzle/aim/ammo/audio rig.
function makeFireWeaponScene({ convergeTarget = null } = {}) {
  const scene = {
    scene: { isActive: () => true },
    lock: {},
    mech: { consumeAmmo: vi.fn() },
    time: { now: 0, delayedCall: vi.fn() },
    px: 0, py: 0,
    convergeTarget,
  };
  Object.assign(scene, FiringMixin);
  scene._muzzle = () => ({ x: 0, y: 0 });
  scene._fireAngle = () => 0;
  scene._fireHitscan = vi.fn();
  scene._spawnProjectile = vi.fn(() => ({}));
  scene._melee = vi.fn();
  return scene;
}

const PLAYER_HITSCAN_W = { weapon: HITSCAN_WEAPON, location: 'rightArm', index: 0 };
const PLAYER_PROJECTILE_W = { weapon: STRAIGHT_PROJECTILE, location: 'leftArm', index: 0 };

describe('#257 fireWeapon: the player\'s own shot ignores cover when aimed at a flying enemy', () => {
  it('no convergence target ⇒ ignoreCover: false (unchanged)', () => {
    const scene = makeFireWeaponScene({ convergeTarget: null });
    scene.fireWeapon(PLAYER_HITSCAN_W);
    expect(scene._fireHitscan).toHaveBeenCalledWith(PLAYER_HITSCAN_W, 0, 0, 0, 'player', 'player', false);
  });

  it('converged on a GROUND enemy ⇒ ignoreCover: false (unchanged)', () => {
    const scene = makeFireWeaponScene({ convergeTarget: { x: 10, y: 0, flying: false, mech: {} } });
    scene.fireWeapon(PLAYER_HITSCAN_W);
    expect(scene._fireHitscan).toHaveBeenCalledWith(PLAYER_HITSCAN_W, 0, 0, 0, 'player', 'player', false);
  });

  it('converged on a #250 destructible hex (no .flying) ⇒ ignoreCover: false (unchanged)', () => {
    const scene = makeFireWeaponScene({ convergeTarget: { x: 10, y: 0 } });
    scene.fireWeapon(PLAYER_HITSCAN_W);
    expect(scene._fireHitscan).toHaveBeenCalledWith(PLAYER_HITSCAN_W, 0, 0, 0, 'player', 'player', false);
  });

  it('converged on a FLYING enemy ⇒ the hitscan beam gets ignoreCover: true', () => {
    const scene = makeFireWeaponScene({ convergeTarget: { x: 10, y: 0, flying: true, mech: {} } });
    scene.fireWeapon(PLAYER_HITSCAN_W);
    expect(scene._fireHitscan).toHaveBeenCalledWith(PLAYER_HITSCAN_W, 0, 0, 0, 'player', 'player', true);
  });

  it('converged on a FLYING enemy ⇒ the spawned projectile gets ignoreCover: true', () => {
    const scene = makeFireWeaponScene({ convergeTarget: { x: 10, y: 0, flying: true, mech: {} } });
    scene.fireWeapon(PLAYER_PROJECTILE_W);
    // machineGun (STRAIGHT_PROJECTILE) is a 2-stream weapon, so each shot's muzzle x/y is offset
    // laterally (a real, non-zero float) — only the trailing `ignoreCover` arg matters here.
    for (const call of scene._spawnProjectile.mock.calls) {
      expect(call[4]).toBe('player');
      expect(call[8]).toBe(true);
    }
  });

  it('converged on a GROUND enemy ⇒ the spawned projectile keeps ignoreCover: false (unchanged)', () => {
    const scene = makeFireWeaponScene({ convergeTarget: { x: 10, y: 0, flying: false, mech: {} } });
    scene.fireWeapon(PLAYER_PROJECTILE_W);
    for (const call of scene._spawnProjectile.mock.calls) {
      expect(call[4]).toBe('player');
      expect(call[8]).toBe(false);
    }
  });
});
