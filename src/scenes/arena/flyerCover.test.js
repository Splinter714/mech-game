// #316 — "let's let cover be actual cover." This file used to encode the OPPOSITE intent and has
// been rewritten in place (rather than deleted) so the reversal is legible:
//
//   #245 gave a FLYING enemy's shots a total cover exemption — spawned rounds were stamped
//        `ignoresCover` and skipped projectiles.js's in-flight wall check; hitscan traces skipped
//        `_hitscanReach` entirely; and enemyBehaviors.js passed `needLos: false` so a flyer would
//        open fire with no sight line at all.
//   #257 mirrored that for the PLAYER — `fireWeapon` read `this.convergeTarget.flying` and
//        threaded `ignoreCover: true`, so the player's own rounds passed through walls when aimed
//        at a flyer.
//
// Jackson played it and found the resulting targeting rules confusing. #316 removed BOTH
// directions structurally — the `ignoreCover` parameter, the `ignoresCover` round stamp, and
// `aimAndFire`'s `needLos` option all left the source rather than being passed false.
//
// ── #338 restores ONE of those two directions, deliberately and narrowly ──
// #316's removal was too wide in one specific place. Targeting exempts airborne enemies from the
// sight gate BY RULE, so the player could still lock a helicopter over a base wall — and then
// watch every shot splash on the stone, because firing exempted nobody BY GEOMETRY. Two rules in
// two files, disagreeing by construction. Jackson's invariant: "you should only be able to lock
// what you could actually hit."
//
// So `targetCoverExempt` (data/visibility.js) is now THE predicate, and both target eligibility
// and the shot call it. What came back is only #257's direction (the player's shots AT an airborne
// LOCKED target), and only via that shared call. #245's direction — a flying SHOOTER's rounds
// passing through walls — stays gone, as does `needLos`. Everything below that asserts a flying
// enemy's own fire respects cover is therefore still live and still correct.
//
// The rule flyers now follow is exactly a ground mech's: HARD cover (walls, structures) blocks
// them; SOFT cover (forest/scrub) does not — originally because both flyer kinds are
// `size: 'large'` and so shared a mech's size-tier exemption, and since #374 simply because soft
// cover blocks no one's ray at all (terrain.js `coverBlocksForRay`).
// That third case is the one most likely to regress silently, so it's asserted explicitly below.
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
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { TERRAIN, coverBlocksForRay, isSoftCover } from '../../data/terrain.js';
import { isSmallUnit } from './shared.js';

// Referenced via WEAPONS.<id>.id (no string literals) per the architecture guard's convention
// in this directory's other tests. machineGun (Repeater) is the helicopter's actual straight
// projectile stream; pulseLaser is the registry's canonical hitscan burst weapon.
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

function runRound(scene, owner, extra = {}) {
  const round = makeProjectile(STRAIGHT_PROJECTILE, 0, 0, 0, { maxDist: 9999 });
  round.owner = owner;
  round.homing = false;
  round.trail = [];
  round.originHexes = [];
  Object.assign(round, extra);
  scene.projectiles = [round];
  for (let i = 0; i < 400 && scene.projectiles.length && !scene.projectiles[0].dead; i++) {
    scene._updateProjectiles(0.016);
  }
  return round;
}

describe('#316 in-flight projectile: EVERY round respects terrain cover (reverses #245/#257)', () => {
  it('a ground enemy\'s straight round detonates on the wall (unchanged)', () => {
    const scene = makeProjectileScene();
    runRound(scene, 'enemy');
    expect(scene._damageBuildingAt).toHaveBeenCalled();   // chipped the cover it died on
    expect(scene._damagePlayerAt).not.toHaveBeenCalled(); // never reached the player
  });

  // The reversal of #245: this exact round used to sail through and hit the player.
  it('a FLYING enemy\'s round now detonates on that same wall instead of sailing over it', () => {
    const scene = makeProjectileScene();
    runRound(scene, 'enemy');
    expect(scene._damageBuildingAt).toHaveBeenCalled();
    expect(scene._damagePlayerAt).not.toHaveBeenCalled();
  });

  // #338 reinstates the `ignoresCover` stamp that #316 deleted, so projectiles.js reads it again —
  // but ONLY the player's `_spawnProjectile` can ever set it, and only while the locked target is
  // airborne (see the spawn describe below). The stamp is now the shot half of the one predicate
  // that also decides eligibility, not the shooter-side "flying enemies shoot through walls" rule
  // #245/#257 had. This test therefore only proves the flag is WIRED; the tests above and below
  // are what prove no enemy round and no ground-target shot can obtain it.
  it('#338: a round carrying the `ignoresCover` stamp passes through the wall again', () => {
    const scene = makeProjectileScene();
    runRound(scene, 'enemy', { ignoresCover: true });
    expect(scene._damageBuildingAt).not.toHaveBeenCalled();   // never detonated on the cover
  });

  it('a PLAYER round detonates on the wall (unchanged)', () => {
    const scene = makeProjectileScene();
    const round = runRound(scene, 'player');
    expect(round.dead).toBe(true);
    expect(scene._damageBuildingAt).toHaveBeenCalled();
  });

  // An ARCING round still lobs over cover — that was never a flying exemption, it's the round's
  // own trajectory (delivery.js `path: 'arcing'`), and #316 deliberately leaves it alone.
  it('an ARCING round still lobs over cover, unrelated to who fired it', () => {
    const scene = makeProjectileScene();
    runRound(scene, 'enemy', { arc: true });
    expect(scene._damageBuildingAt).not.toHaveBeenCalled();
  });
});

// ── Hitscan trace vs. wall ─────────────────────────────────────────────────────────────────
// The REAL _fireHitscan runs against a minimal scene: the player sits 300px downrange and
// `_hitscanReach` reports a wall at 50px. EVERY beam must now consult that wall trace.
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

describe('#316 hitscan: EVERY beam consults the wall trace (reverses #245)', () => {
  it('a ground enemy\'s beam is blocked by the wall (unchanged)', () => {
    const scene = makeHitscanScene();
    scene._fireHitscan(HITSCAN_W, 0, 0, 0, 'enemy', 'tank');
    expect(scene._hitscanReach).toHaveBeenCalled();
    expect(scene._damagePlayerAt).not.toHaveBeenCalled();
    // The beam visual stops at the wall, not at the player.
    expect(scene.beams[0].x1).toBeCloseTo(50, 3);
  });

  // The reversal of #245: this call used to skip `_hitscanReach` entirely and damage the player.
  it('a FLYING enemy\'s beam is now blocked by that same wall', () => {
    const scene = makeHitscanScene();
    scene._fireHitscan(HITSCAN_W, 0, 0, 0, 'enemy', 'drone');
    expect(scene._hitscanReach).toHaveBeenCalled();
    expect(scene._damagePlayerAt).not.toHaveBeenCalled();
    expect(scene.beams[0].x1).toBeCloseTo(50, 3);
  });

  it('the PLAYER\'s beam (default args) honors cover (unchanged)', () => {
    const scene = makeHitscanScene();
    scene.enemies = [{ x: 300, y: 0, mech: { isDestroyed: () => false } }];
    scene._fireHitscan(HITSCAN_W, 0, 0, 0);
    expect(scene._hitscanReach).toHaveBeenCalled();
    expect(scene._damageEnemyAt).not.toHaveBeenCalled();
  });
});

// ── _fireVehicleWeapon no longer threads any flying-cover flag ─────────────────────────────
// Same harness shape as vehicleFire.test.js: the REAL _fireVehicleWeapon dispatch runs with the
// two fire helpers spied, so we can read the exact arguments each path received. Post-#316 the
// only per-shot flag left was #269's `smallUnitInvolved` (soft-cover size tier); #374 removed that
// too, so there is now NO per-shot cover flag at all — `flying` is not consulted either.
function makeVehicleScene() {
  const calls = { hitscan: [], projectile: [] };
  const scene = { time: { now: 0, delayedCall: () => {} } };
  Object.assign(scene, EnemiesMixin, FiringMixin);
  scene._melee = vi.fn();
  scene._fireHitscan = vi.fn((...args) => calls.hitscan.push(args));
  scene._spawnProjectile = vi.fn((...args) => calls.projectile.push(args));
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

// Muzzle position and per-shot aim carry real randomness (delivery.js's spread stagger and
// speed/angle jitter), so these compare the DETERMINISTIC tail of each call — owner, shooter key,
// and the surviving flags — rather than the whole arg array.
describe('#316 _fireVehicleWeapon dispatches a flying and a ground shooter identically', () => {
  for (const flying of [true, false]) {
    const label = flying ? 'FLYING' : 'GROUND';

    it(`a ${label} kind's _fireHitscan args carry no cover-exemption flag`, () => {
      const { scene, calls } = makeVehicleScene();
      scene._fireVehicleWeapon(makeKindEnemy(HITSCAN_WEAPON.id, flying), {}, 0);
      // owner, shooterKey, then #307's lane descriptor — #374 removed the `smallUnitInvolved`
      // flag that used to sit between them. Nothing else; `flying` is not consulted. #310 added
      // `ignoreSpanKey` to that descriptor — null for anything that isn't a wall turret, which is
      // every shooter here.
      // #423 added `statKind` + `statShotId` to the descriptor (the shooter's stats kind and its
      // per-shot id, for damage-taken attribution + enemy-accuracy dedupe) — telemetry, not a cover flag.
      expect(calls.hitscan[0].slice(4)).toEqual(['enemy', 'testKind', { lane: 0, lateral: 0, ignoreSpanKey: null, statKind: 'turret', statShotId: null }]);
    });

    // #269 playtest follow-up (streams bug fix): STRAIGHT_PROJECTILE (machineGun) is a twin-lane
    // stream weapon (`delivery.count: 2`), so one trigger pull spawns TWO rounds.
    it(`a ${label} kind's _spawnProjectile args carry no cover-exemption flag (both stream lanes)`, () => {
      const { scene, calls } = makeVehicleScene();
      scene._fireVehicleWeapon(makeKindEnemy(STRAIGHT_PROJECTILE.id, flying), {}, 0);
      expect(calls.projectile).toHaveLength(2);
      for (const args of calls.projectile) {
        expect(args[4]).toBe('enemy');
        expect(args[6]).toBe(null);        // seekOverride
        // #374 dropped #269's `smallUnitInvolved` (formerly arg 8), so there is no cover flag on a
        // shot any more. #423 appended two telemetry args — the shooter (null for an enemy) and a
        // stats-meta object `{ statKind, statShotId }` (NOT a cover flag) — so the tail is now shooter, meta.
        expect(args).toHaveLength(10);
        expect(args[8]).toBe(null);        // shooter (enemy rounds carry none)
        expect(args[9]).toEqual({ statKind: expect.anything(), statShotId: null });
      }
    });
  }
});

// ── _spawnProjectile no longer stamps a cover exemption ────────────────────────────────────
describe('#316 _spawnProjectile stamps no cover-exemption flag on the round', () => {
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

  // #338: the stamp is back, but derived from the ONE shared predicate rather than from who is
  // shooting. With no lock at all — and with a ground target — no round gets it, which is what
  // keeps cover real for everything on the deck.
  it('#338: no target and a GROUND target both yield `ignoresCover: false`', () => {
    const scene = makeSpawnScene();
    expect(scene._spawnProjectile(w, 0, 0, 0, 'enemy', 0, null, 0).ignoresCover).toBe(false);
    expect(scene._spawnProjectile(w, 0, 0, 0).ignoresCover).toBe(false);
    scene.convergeTarget = { x: 400, y: 0, mech: {} };
    expect(scene._spawnProjectile(w, 0, 0, 0).ignoresCover).toBe(false);
  });

  it('#338: a locked AIRBORNE target stamps the exemption — on the PLAYER\'s round only', () => {
    const scene = makeSpawnScene();
    scene.convergeTarget = { x: 400, y: 0, flying: true, mech: {} };
    expect(scene._spawnProjectile(w, 0, 0, 0).ignoresCover).toBe(true);
    expect(scene._spawnProjectile(w, 0, 0, 0, 'enemy', 0, null, 0).ignoresCover).toBe(false);
  });

  // #374 UPDATED. This used to guard #269's `smallUnitInvolved` sitting at arg 8 (it had shifted
  // from 9 when #316 dropped `ignoreCover`). #374 removed the flag from the signature AND from the
  // round's stamp — soft cover is rolled at impact now, not carried by the round — so the guard
  // inverts: no such property may reappear on a spawned round, and arg 8 is the `shooter` handle.
  it('#374: a spawned round carries no soft-cover flag at all', () => {
    const scene = makeSpawnScene();
    const round = scene._spawnProjectile(w, 0, 0, 0, 'enemy', 0, null, 0);
    expect(round).not.toHaveProperty('smallUnitInvolved');
    const player = { id: 'p1' };
    expect(scene._spawnProjectile(w, 0, 0, 0, 'player', 0, null, 0, player).shooter).toBe(player);
  });
});

// ── The player's own shots vs. a flying convergence target (reverses #257) ─────────────────
// Real `fireWeapon` runs end-to-end against a minimal scene; `_fireHitscan`/`_spawnProjectile`
// are spied so we can read the exact args the dispatch computed, without needing a full
// muzzle/aim/ammo/audio rig.
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

describe('#316 fireWeapon: the player\'s shot respects cover whatever it is aimed at', () => {
  // Post-#374 `_fireHitscan` has no per-shot cover flag at all — its 7th arg is #307's lane
  // descriptor. The whole point of these cases is that the convergence target's `flying` no longer
  // changes ANY argument.
  const CASES = [
    ['no convergence target', null],
    ['a GROUND enemy', { x: 10, y: 0, flying: false, mech: {} }],
    ['a #250 destructible hex (no .flying)', { x: 10, y: 0 }],
    ['a FLYING enemy — the case #257 used to exempt', { x: 10, y: 0, flying: true, mech: {} }],
  ];

  for (const [label, convergeTarget] of CASES) {
    it(`converged on ${label} ⇒ the hitscan beam gets no cover exemption`, () => {
      const scene = makeFireWeaponScene({ convergeTarget });
      scene.fireWeapon(PLAYER_HITSCAN_W);
      expect(scene._fireHitscan.mock.calls[0].slice(0, 6))
        .toEqual([PLAYER_HITSCAN_W, 0, 0, 0, 'player', 'player']);
    });
  }

  it('a FLYING and a GROUND convergence target produce byte-identical projectile args', () => {
    const flyer = makeFireWeaponScene({ convergeTarget: { x: 10, y: 0, flying: true, mech: {} } });
    flyer.fireWeapon(PLAYER_PROJECTILE_W);
    const ground = makeFireWeaponScene({ convergeTarget: { x: 10, y: 0, flying: false, mech: {} } });
    ground.fireWeapon(PLAYER_PROJECTILE_W);
    expect(flyer._spawnProjectile.mock.calls.length).toBeGreaterThan(0);
    // #348 added a trailing `shooter` arg (the PLAYER firing, for per-player aim + friendly
    // fire). That handle necessarily differs between these two scenes — it carries each one's
    // own `convergeTarget`, which is the very thing being varied — so the comparison is over the
    // SHOT arguments, which are what #316 is about. Anything the flying-ness of the target could
    // leak into a shot still lands inside this slice.
    const shotArgs = (calls) => calls.map((c) => c.slice(0, 8));
    expect(shotArgs(flyer._spawnProjectile.mock.calls))
      .toEqual(shotArgs(ground._spawnProjectile.mock.calls));
    // ...and no trailing cover-exemption arg survives on either. #423 appended a stats-meta arg
    // (`{ pullId }`, for pull-level accuracy) after #348's `shooter` handle — neither is a cover
    // flag, and the byte-identical slice above (args 0..7) already covers everything a shot's
    // geometry could leak into.
    for (const call of flyer._spawnProjectile.mock.calls) {
      expect(call[4]).toBe('player');
      expect(call.length).toBeLessThanOrEqual(10);
      if (call.length === 10) expect(call[9]).toHaveProperty('pullId');
    }
  });
});

// ── SOFT cover still does NOT block flyers (#316 point 4) ──────────────────────────────────
// The case most likely to regress silently. #316 does NOT invent a flyer-specific cover rule —
// it removes the exemptions so flyers fall through to the SHARED logic. #374 UPDATED what that
// shared logic is: soft cover used to exempt LARGE units by size tier (`softCoverBlocksLOS`, #269)
// and flyers rode on being `size: 'large'`; now soft cover blocks NOBODY geometrically, so the
// conclusion ("a helicopter over woodland sees and shoots normally; only hard cover stops it")
// holds for a strictly simpler reason and no longer depends on the flyers' size tag. The size
// assertion is kept because #374's own shot-block roll puts air units at 0% via `flying`, and the
// kinds' size/flying data staying coherent is still worth pinning.
describe('#316 point 4: soft cover (forest/scrub) does not block flyers, hard cover does', () => {
  const FLYER_KINDS = Object.values(ENEMY_KINDS).filter((k) => k.flying);

  it('there are flying kinds to test, and every one is size large — so soft cover exempts them', () => {
    expect(FLYER_KINDS.length).toBeGreaterThan(0);
    for (const def of FLYER_KINDS) {
      expect(def.size).toBe('large');
      // ...which is exactly what the shared LOS call sites read (`isSmallUnit(e)`).
      expect(isSmallUnit({ kindDef: def })).toBe(false);
    }
  });

  it('forest and scrub are SOFT cover and do not block a large unit\'s ray (flyer or mech)', () => {
    for (const id of [TERRAIN.forest.id, TERRAIN.scrub.id]) {
      expect(isSoftCover(id)).toBe(true);
      expect(coverBlocksForRay(id, false)).toBe(false);   // #374 — true for every unit now
    }
  });

  it('hard cover (the objective structure) blocks a large unit\'s ray — flyers included', () => {
    expect(isSoftCover(TERRAIN.objective.id)).toBe(false);
    expect(coverBlocksForRay(TERRAIN.objective.id, false)).toBe(true);
  });
});
