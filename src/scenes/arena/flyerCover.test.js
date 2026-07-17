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
vi.mock('../../audio/fireCues.js', () => ({ scheduleFireCues: vi.fn(), ENEMY_FIRE_GAIN_SCALE: 0.85 }));

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

  it('a FLYING kind\'s projectile spawns with ignoreCover: true', () => {
    const { scene, calls } = makeVehicleScene();
    scene._fireVehicleWeapon(makeKindEnemy(STRAIGHT_PROJECTILE.id, true), {}, 0);
    expect(calls.projectile).toEqual([{ owner: 'enemy', ignoreCover: true }]);
  });

  it('a GROUND kind\'s projectile spawns with ignoreCover: false (unchanged)', () => {
    const { scene, calls } = makeVehicleScene();
    scene._fireVehicleWeapon(makeKindEnemy(STRAIGHT_PROJECTILE.id, false), {}, 0);
    expect(calls.projectile).toEqual([{ owner: 'enemy', ignoreCover: false }]);
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
