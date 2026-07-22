// #269 §4/§6/§7 — scene-level coverage for the base-population system's dormant-unit tick and
// the alert-tower wake routing/response split. enemies.js has a vestigial `import Phaser from
// 'phaser'` whose top-level device detection throws under vitest's node env, so it's stubbed
// out (same convention as enemyFireAngle.test.js/vehicleFire.test.js).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Audio } from '../../audio/index.js';
import { MAX_AUDIBLE_DISTANCE } from '../../data/positionalAudio.js';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { EnemiesMixin } from './enemies.js';
import { BasesMixin, TOWER_PATROL_COUNT } from './bases.js';
import { towerPatrolComposition, TOWER_PATROL_TIERS } from '../../data/worldgen.js';
import { CombatMixin } from './combat.js';
import { HpBody } from '../../data/HpBody.js';
import { Mech } from '../../data/Mech.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { ENEMIES } from '../../data/enemies.js';
import { DORMANT, AWARE, UNAWARE, detectionRangeFor } from '../../data/awareness.js';
import { hexToPixel, axialKey, pixelToHex } from '../../data/hexgrid.js';
import { dockCountFor, DOCK_SWARM_COUNT } from '../../data/worldgen.js';
import { isPassable } from '../../data/terrain.js';

// A small all-passable terrain map — the real scene always has `terrain`/`worldRadius` set by
// `_buildWorld`, and `_spawnDormantUnits` reads them (#314: dock-cluster points are snapped through
// `nearestValidPixel`), so the stub scene needs them too or every cluster point collapses onto one
// fallback hex. `blocked` marks hexes impassable, for the tests that check the snapping works.
function groundTerrain(radius, blocked = []) {
  const t = new Map();
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.abs(q + r) > radius) continue;
      t.set(axialKey(q, r), 'grass');
    }
  }
  for (const { q, r } of blocked) t.set(axialKey(q, r), 'deepWater');
  return t;
}

function makeScene() {
  const scene = {
    time: { now: 0 }, enemies: [], px: 0, py: 0, bases: [], alertTowerHexes: [],
    worldRadius: 8, terrain: groundTerrain(8),
  };
  Object.assign(scene, EnemiesMixin, BasesMixin);
  scene._initAlertTowers();   // sets up `_wokenBases` (real production init, not hand-rolled)
  return scene;
}

// A dormant docked unit, shaped the same way `_spawnKind` builds one (enemies.js), minus the
// Phaser view/textures a real spawn creates (irrelevant to the logic under test here).
function makeDockedUnit(kindId, { baseId = 'base0' } = {}) {
  const def = ENEMY_KINDS[kindId];
  const mech = new HpBody(def);
  return {
    key: `${kindId}Test`, mech, kind: def.kind, kindDef: def, x: 0, y: 0, vx: 0, vy: 0,
    angle: 0, turret: 0, fireCd: 0, awareness: DORMANT, baseId,
    detectRange: detectionRangeFor(def.fireRange),   // same computation `_spawnKind` uses
  };
}

// A scene with just enough real-ish stubs (view/`_blocked`/LOS/fire) for a woken unit's FULL
// `_updateEnemy` → `_updateVehicle` → behavior fn tick to actually run end to end, unlike the
// lighter `makeScene` above (whose tests stub `_updateVehicle` itself away). This is what lets
// the bug-1 regression tests below observe REAL post-wake velocity/angle changes, not just the
// awareness/holdGround flag flip.
function makeTickableScene({ px = 900, py = 300 } = {}) {
  const scene = {
    time: { now: 0 }, enemies: [], px, py, bases: [], alertTowerHexes: [],
    enemyMove: true, enemyFire: true,
    _blocked: () => false,
    // #282: mutual ground-unit collision — not under test here, so stub to "never blocks"
    // (mirrors `_blocked` above) so these pre-existing wake-behavior tests keep exercising only
    // what they already covered. (Flyer-vs-flyer is now soft separation in the behaviours, no
    // scene-level gate to stub — see enemyBehaviors.js `flyerSeparation`.)
    _blockedByOtherGroundUnit: () => false,
    _speedFactorAt: () => 1,
    _cachedLosToPlayer: () => true,
    _fireVehicleWeapon: () => {},
  };
  Object.assign(scene, EnemiesMixin, BasesMixin);
  scene._initAlertTowers();
  return scene;
}

function makeTickableUnit(kindId, { baseId = 'base0' } = {}) {
  const def = ENEMY_KINDS[kindId];
  const mech = new HpBody(def);
  const view = { setPosition() {}, hull: { setTexture() {}, rotation: 0 }, turret: { rotation: 0 }, shadow: null };
  return {
    key: `${kindId}Test`, mech, view, kind: def.kind, kindDef: def, behavior: def.behavior,
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0, handed: 1,
    awareness: DORMANT, baseId, detectRange: detectionRangeFor(def.fireRange),
  };
}

// #285: bypasses the post-wake reaction stagger (`e.reactDelayMs`, see enemies.js
// `_isReacting`) so a test that isn't specifically about the stagger itself gets the exact
// same "reacts on its very next tick" behavior these tests had before #285 introduced it.
function skipWakeStagger(e) {
  e.reactDelayMs = 0;
}

describe('#269 §4: a DORMANT enemy is fully inert — _updateEnemy skips all AI/movement/firing', () => {
  it('never calls _updateVehicle, and leaves position/velocity untouched', () => {
    const scene = makeScene();
    const e = makeDockedUnit('turret');
    e.x = 42; e.y = 17;
    scene._updateVehicle = vi.fn();
    scene._updateEnemy(e, 0.016, 16);
    expect(scene._updateVehicle).not.toHaveBeenCalled();
    expect(e.x).toBe(42);
    expect(e.y).toBe(17);
    expect(e.vx).toBe(0);
    expect(e.vy).toBe(0);
  });

  it('a destroyed dormant enemy still short-circuits on the isDestroyed check first', () => {
    const scene = makeScene();
    const e = makeDockedUnit('turret');
    e.mech.hp = 0;   // HpBody treats hp<=0 as destroyed
    scene._updateVehicle = vi.fn();
    expect(() => scene._updateEnemy(e, 0.016, 16)).not.toThrow();
    expect(scene._updateVehicle).not.toHaveBeenCalled();
  });
});

describe('#269 §6: _wakeBase wakes only the target base\'s dormant units', () => {
  it('flips awareness to AWARE for the target base only, leaving other bases dormant', () => {
    const scene = makeScene();
    const a1 = makeDockedUnit('turret', { baseId: 'base0' });
    const a2 = makeDockedUnit('tank', { baseId: 'base0' });
    const b1 = makeDockedUnit('turret', { baseId: 'base1' });
    scene.enemies.push(a1, a2, b1);

    scene._wakeBase('base0');

    expect(a1.awareness).toBe(AWARE);
    expect(a2.awareness).toBe(AWARE);
    expect(b1.awareness).toBe(DORMANT);   // untouched — different base
  });

  it('is idempotent — waking an already-woken base a second time is a harmless no-op', () => {
    const scene = makeScene();
    const a1 = makeDockedUnit('turret', { baseId: 'base0' });
    scene.enemies.push(a1);
    scene._wakeBase('base0');
    a1.awareness = UNAWARE;   // simulate some other transition happening after wake
    scene._wakeBase('base0');   // must NOT re-run the wake logic (would stomp UNAWARE back to AWARE)
    expect(a1.awareness).toBe(UNAWARE);
  });
});

describe('#269 §7: wake-response split by speed (data/bases.js isFastWakeKind)', () => {
  it('fast kinds (drone/helicopter) get no holdGround flag — free to sortie', () => {
    const scene = makeScene();
    const drone = makeDockedUnit('drone', { baseId: 'base0' });
    const heli = makeDockedUnit('helicopter', { baseId: 'base0' });
    scene.enemies.push(drone, heli);
    scene._wakeBase('base0');
    expect(drone.holdGround).toBeUndefined();
    expect(heli.holdGround).toBeUndefined();
  });

  it('slow/defensive kinds (turret/tank/carrier/infantry) get holdGround: true', () => {
    const scene = makeScene();
    const units = ['turret', 'tank', 'carrier', 'infantry'].map((k) => makeDockedUnit(k, { baseId: 'base0' }));
    scene.enemies.push(...units);
    scene._wakeBase('base0');
    for (const u of units) expect(u.holdGround).toBe(true);
  });
});

describe('#269 playtest follow-up: multi-count dock composition (_spawnDormantUnits)', () => {
  // `_spawnKind` normally builds real Phaser textures/views (buildVehicleTextures,
  // `this.textures.exists`, `this._makeVehicleView`) — out of scope for this pure logic test, so
  // it's stubbed to a lightweight plain-object stand-in (mirrors the shape `makeDockedUnit`
  // above hand-builds) that also pushes into `scene.enemies`, matching the one real side effect
  // `_spawnDormantUnits`/`_wakeBase` actually depend on.
  function makeSceneWithSpawnStub() {
    const scene = makeScene();
    scene._spawnKind = (x, y, kindId) => {
      const def = ENEMY_KINDS[kindId];
      const e = {
        key: `${kindId}Test`, mech: new HpBody(def), kind: def.kind, kindDef: def,
        x, y, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0, typeId: kindId,
      };
      scene.enemies.push(e);
      return e;
    };
    return scene;
  }

  it('a count:3 dock spawns 3 units, scattered (not stacked), all sharing baseId/dockKey', () => {
    const scene = makeSceneWithSpawnStub();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'tank', count: 3 }], turrets: [],
    }];
    scene._spawnDormantUnits();

    expect(scene.enemies.length).toBe(3);
    for (const e of scene.enemies) {
      expect(e.typeId).toBe('tank');
      expect(e.awareness).toBe(DORMANT);
      expect(e.baseId).toBe('base0');
    }
    const dockKeys = new Set(scene.enemies.map((e) => e.dockKey));
    expect(dockKeys.size).toBe(1);   // one shared dockKey for the whole cluster
    // Scattered around the dock's centre pixel, not stacked exactly on top of one another.
    const positions = new Set(scene.enemies.map((e) => `${e.x},${e.y}`));
    expect(positions.size).toBe(3);
  });

  it('a count:2 helicopter dock spawns exactly 2 units', () => {
    const scene = makeSceneWithSpawnStub();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'helicopter', count: 2 }], turrets: [],
    }];
    scene._spawnDormantUnits();
    expect(scene.enemies.length).toBe(2);
    expect(scene.enemies.every((e) => e.typeId === 'helicopter')).toBe(true);
  });

  it('a count:1 dock (e.g. carrier) spawns exactly one unit, at the dock hex centre', () => {
    const scene = makeSceneWithSpawnStub();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'carrier', count: 1 }], turrets: [],
    }];
    scene._spawnDormantUnits();
    expect(scene.enemies.length).toBe(1);
  });

  // #287 (owner, 2026-07-19): a base descriptor no longer carries interior turret emplacements at
  // all — its fixed guns are the WALL turrets (`_spawnWallTurrets`, covered in wallTurrets.test.js).
  // A stale `turrets` array on a base must therefore spawn nothing rather than resurrecting them.
  it('ignores any legacy `turrets` array on a base — interior emplacements are gone', () => {
    const scene = makeSceneWithSpawnStub();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 }, docks: [], turrets: [{ q: 1, r: 0 }],
    }];
    scene._spawnDormantUnits();
    expect(scene.enemies.length).toBe(0);
  });

  it('a multi-unit dock cluster all wake together as one group', () => {
    const scene = makeSceneWithSpawnStub();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'tank', count: 3 }], turrets: [],
    }];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    expect(scene.enemies.length).toBe(3);
    expect(scene.enemies.every((e) => e.awareness === AWARE)).toBe(true);
    // Tanks are a slow/defensive kind (data/bases.js isFastWakeKind) — they hold ground rather
    // than sortie, same as the existing single-unit wake-response-split coverage above.
    expect(scene.enemies.every((e) => e.holdGround === true)).toBe(true);
  });

});

// #269 playtest follow-up ("fold mechs into the dock system"): a dock's kindId can now be a full
// mech loadout id (data/enemies.js ENEMIES), not just a non-mech ENEMY_KINDS id. `_spawnDormantUnits`
// must dispatch to `_spawnMech` (not `_spawnKind`) for one of these, while applying the exact same
// DORMANT/baseId/dockKey tagging — and every woken mech defaults to `holdGround: true` regardless
// of chassis (scenes/arena/bases.js `_wakeBase`'s comment explains why: a chassis-derived "fast/
// slow" split isn't meaningful for mechs, and a mech reads better as a dock-defending boss anyway).
describe('#269 playtest follow-up: mech-kind docks (_spawnDormantUnits branches to _spawnMech)', () => {
  // A lightweight `_spawnMech` stand-in mirroring the real one's shape (enemies.js `_spawnMech`)
  // closely enough for the dock/wake logic under test: kind: 'mech', a real Mech instance (so
  // .movement/.readyWeapons/.isDestroyed etc. all work), no Phaser textures/view.
  function makeSceneWithSpawnStubs() {
    const scene = makeScene();
    scene._spawnKind = (x, y, kindId) => {
      const def = ENEMY_KINDS[kindId];
      const e = {
        key: `${kindId}Test`, mech: new HpBody(def), kind: def.kind, kindDef: def,
        x, y, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0, typeId: kindId,
      };
      scene.enemies.push(e);
      return e;
    };
    scene._spawnMech = (x, y, typeId) => {
      const def = ENEMIES[typeId];
      const mech = new Mech(def);
      mech.repairAll();
      const e = {
        key: `${typeId}Test`, mech, kind: 'mech', x, y, vx: 0, vy: 0,
        angle: Math.PI / 2, turret: Math.PI / 2, fireCd: {}, typeId,
        // Minimal #44 tactical-AI state a real `_spawnMech` also sets (via `_resetAiState`) —
        // needed for `_updateEnemy`'s mech dispatch (lock/decide/goal bookkeeping) to run cleanly.
        role: 'skirmisher', standoff: 200, handed: 1, allIndirect: false,
        state: 'flank', decideAt: 0, goal: null, lastHealth: 1, hurtUntil: 0, recampAt: 0,
        coverSpot: null, lockTarget: null, idleGoal: null, idleAt: 0,
        // #398 third pass: lumbering-gait + aim-slop state a real `_spawnMech` also sets (via
        // `_resetAiState`) — needed so the movement/aim block in `_updateEnemy` doesn't compute
        // against `undefined` timers.
        lurchDriving: true, lurchAt: 900, aimOffset: 0, aimSlopAt: 0,
      };
      scene.enemies.push(e);
      return e;
    };
    return scene;
  }

  it('a mech-kind dock (e.g. raider) spawns via _spawnMech, not _spawnKind', () => {
    const scene = makeSceneWithSpawnStubs();
    scene._spawnKind = vi.fn(scene._spawnKind);
    scene._spawnMech = vi.fn(scene._spawnMech);
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'raider', count: 1 }], turrets: [],
    }];
    scene._spawnDormantUnits();

    expect(scene._spawnMech).toHaveBeenCalledTimes(1);
    expect(scene._spawnKind).not.toHaveBeenCalled();
    expect(scene.enemies.length).toBe(1);
    expect(scene.enemies[0].kind).toBe('mech');
    expect(scene.enemies[0].typeId).toBe('raider');
  });

  it('a mixed base (vehicle-kind dock + mech-kind dock) dispatches each to the right constructor', () => {
    const scene = makeSceneWithSpawnStubs();
    scene._spawnKind = vi.fn(scene._spawnKind);
    scene._spawnMech = vi.fn(scene._spawnMech);
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [
        { q: 0, r: 0, kindId: 'tank', count: 1 },
        { q: 1, r: 0, kindId: 'sniper', count: 1 },
      ],
      turrets: [],
    }];
    scene._spawnDormantUnits();

    expect(scene._spawnKind).toHaveBeenCalledTimes(1);
    expect(scene._spawnMech).toHaveBeenCalledTimes(1);
    expect(scene.enemies.find((e) => e.typeId === 'tank').kind).not.toBe('mech');
    expect(scene.enemies.find((e) => e.typeId === 'sniper').kind).toBe('mech');
  });

  it('the mech gets the same DORMANT/baseId/dockKey tagging a vehicle-kind unit gets', () => {
    const scene = makeSceneWithSpawnStubs();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'raider', count: 1 }], turrets: [],
    }];
    scene._spawnDormantUnits();

    const e = scene.enemies[0];
    expect(e.awareness).toBe(DORMANT);
    expect(e.baseId).toBe('base0');
    expect(e.dockKey).toBeDefined();
  });

  it('a mech-kind dock defaults dockCountFor to 1 (mechs are not tank/helicopter)', () => {
    const scene = makeSceneWithSpawnStubs();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'artillery', count: 1 }], turrets: [],
    }];
    scene._spawnDormantUnits();
    expect(scene.enemies.length).toBe(1);
  });

  // #314: a drone/infantry dock hosts a DOCK_SWARM_COUNT burst, not a single body. These cover the
  // scene-side consequences of that: the right number of units actually spawn from ONE dock hex,
  // they all share the dock's identity (so `_wakeBase` still wakes them as one group), and no unit
  // is stacked on another or dumped onto impassable terrain.
  describe('#314 swarm docks (10 drones / 10 infantry from one dock hex)', () => {
    function swarmScene(kindId, { blocked = [] } = {}) {
      const scene = makeSceneWithSpawnStubs();
      scene.worldRadius = 8;
      scene.terrain = groundTerrain(8, blocked);
      scene.bases = [{
        id: 'base0', center: { q: 0, r: 0 },
        docks: [{ q: 0, r: 0, kindId, count: dockCountFor(kindId, () => 0.5) }], turrets: [],
      }];
      scene._spawnDormantUnits();
      return scene;
    }

    for (const kindId of ['drone', 'infantry']) {
      it(`a ${kindId} dock spawns DOCK_SWARM_COUNT dormant units from a single dock hex`, () => {
        const scene = swarmScene(kindId);
        expect(scene.enemies.length).toBe(DOCK_SWARM_COUNT);
        const dockKey = axialKey(0, 0);
        for (const e of scene.enemies) {
          expect(e.typeId).toBe(kindId);
          expect(e.awareness).toBe(DORMANT);
          expect(e.baseId).toBe('base0');
          // One shared dockKey, so `_wakeBase`/the dock open-closed state treat them as one group.
          expect(e.dockKey).toBe(dockKey);
        }
      });

      it(`a ${kindId} swarm huddles tightly around the dock without stacking bodies`, () => {
        const scene = swarmScene(kindId);
        const { x: cx, y: cy } = hexToPixel(0, 0);
        const seen = new Set();
        for (const e of scene.enemies) {
          // Concentric rings, not one overloaded ring: every body is a distinct point...
          const at = `${Math.round(e.x)},${Math.round(e.y)}`;
          expect(seen.has(at)).toBe(false);
          seen.add(at);
          // ...and the whole cluster stays a tight knot near the dock centre, so a swarm dock
          // can't leak units out past the base it's defending.
          expect(Math.hypot(e.x - cx, e.y - cy)).toBeLessThanOrEqual(48);
        }
      });
    }

    it('every swarm body lands on passable terrain even when the cluster overlaps a blocked hex', () => {
      // Block the ring of hexes around the dock; the naive ring offsets would put outer-ring
      // bodies onto them, so this only passes because each point is snapped (#115's fix).
      const blocked = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }];
      const scene = swarmScene('infantry', { blocked });
      expect(scene.enemies.length).toBe(DOCK_SWARM_COUNT);
      for (const e of scene.enemies) {
        const h = pixelToHex(e.x, e.y);
        expect(isPassable(scene.terrain.get(axialKey(h.q, h.r)))).toBe(true);
      }
    });
  });

  it('_wakeBase flips a docked mech to AWARE and unconditionally sets holdGround, for every archetype', () => {
    for (const typeId of ['raider', 'skirmisher', 'sniper', 'artillery']) {
      const scene = makeSceneWithSpawnStubs();
      scene.bases = [{
        id: 'base0', center: { q: 0, r: 0 },
        docks: [{ q: 0, r: 0, kindId: typeId, count: 1 }], turrets: [],
      }];
      scene._spawnDormantUnits();
      scene._wakeBase('base0');
      const e = scene.enemies[0];
      expect(e.awareness).toBe(AWARE);
      expect(e.holdGround).toBe(true);
    }
  });

  it('#269 Part 1 / #285: a held-ground mech still moves (runs the normal tactical brain) and, unleashed, keeps closing on the player', () => {
    const scene = makeSceneWithSpawnStubs();
    scene.enemyMove = true;
    scene.enemyFire = false;   // out of scope here: firing needs a full art/weapon-plumbing stub
    scene._blocked = () => false;
    // #282: not under test here — stub to "never blocks" like `_blocked` above. (Flyer-vs-flyer
    // is now soft separation in the behaviours, no scene-level gate to stub.)
    scene._blockedByOtherGroundUnit = () => false;
    scene._speedFactorAt = () => 1;
    scene._cachedLosToPlayer = () => true;
    scene._wallDistanceLos = () => Infinity;   // no cover in this stub world — always clear LOS
    scene._syncTilts = () => {};
    scene.px = 900; scene.py = 300; scene.vx = 0; scene.vy = 0; scene.turretAngle = 0;
    // `_decideEnemyState` reads the PLAYER's own mech (lethalHealth(this.mech)) for the
    // "is the player vulnerable" signal — a full-health stub is enough for this test.
    scene.mech = { partHealthFraction: () => 1 };
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'raider', count: 1 }], turrets: [],
    }];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const e = scene.enemies[0];
    e.view = { setPosition() {}, hull: { rotation: 0 }, turret: { rotation: 0 } };
    skipWakeStagger(e);   // #285: not under test here — react on the very next tick
    const spawnAngle = e.angle;
    const spawnX = e.x, spawnY = e.y;
    const distToPlayerStart = Math.hypot(scene.px - spawnX, scene.py - spawnY);

    for (let i = 0; i < 200; i++) scene._updateEnemy(e, 0.016, 16);

    // It's no longer pinned to a frozen 'hold' — it ran the real PRESS/KITE/FLANK/COVER/HOLD
    // brain, which (tooFar from the player, standoff 200 vs dist ~950) presses toward the
    // player just like a non-held mech would.
    expect(Math.hypot(e.vx, e.vy)).toBeGreaterThan(0);
    expect(e.x !== spawnX || e.y !== spawnY).toBe(true);
    // #285: the leash that used to cap this distance is gone — it fully commits and keeps
    // closing distance toward the player instead of settling at/near a fixed radius from spawn.
    const distToPlayerNow = Math.hypot(scene.px - e.x, scene.py - e.y);
    expect(distToPlayerNow).toBeLessThan(distToPlayerStart);
    // Root-cause parity with the non-mech holdGround bug-1 fix below: the hull turns to track
    // the player as it moves/holds, not stay frozen at its spawn facing.
    expect(e.angle).not.toBe(spawnAngle);
    // The turret independently tracks the player too (unchanged pre-existing behavior).
    expect(e.turret).not.toBe(Math.PI / 2);
  });
});

describe('#269 playtest follow-up: _spawnTowerPatrols — roaming units near each alert tower', () => {
  // Same lightweight `_spawnKind` stub as the dock-composition suite above — out of scope here
  // is Phaser texture/view building, in scope is spawnX/spawnY/awareness/baseId shape.
  function makeSceneWithSpawnStub(alertTowerHexes) {
    const scene = makeScene();
    scene.alertTowerHexes = alertTowerHexes;
    scene.terrain = new Map();   // empty terrain: nearestValidPixel's passableCheck treats every
                                  // hex as absent/impassable, exercising the "must snap to a
                                  // nearby hex" fallback path deterministically.
    scene._spawnKind = (x, y, kindId) => {
      const def = ENEMY_KINDS[kindId];
      const e = {
        key: `${kindId}Test`, mech: new HpBody(def), kind: def.kind, kindDef: def,
        x, y, spawnX: x, spawnY: y, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0,
        typeId: kindId, awareness: UNAWARE,
      };
      scene.enemies.push(e);
      return e;
    };
    // #357: a late tier includes a light MECH ('raider'), so the patrol spawner now goes through
    // `_spawnEnemy`'s kind-vs-mech dispatcher. Stub it the same lightweight way — a mech id just
    // gets a `kind: 'mech'` body stand-in; what's in scope here is still
    // spawnX/spawnY/awareness/baseId shape, not Phaser texture/view building.
    scene._spawnEnemy = (x, y, typeId) => {
      if (ENEMY_KINDS[typeId]) return scene._spawnKind(x, y, typeId);
      const e = {
        key: `${typeId}Test`, mech: null, kind: 'mech',
        x, y, spawnX: x, spawnY: y, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: {},
        typeId, awareness: UNAWARE,
      };
      scene.enemies.push(e);
      return e;
    };
    return scene;
  }

  // #357: patrol size is no longer a flat per-tower constant — it escalates by tower index, so
  // the expected headcount is the sum of each tower's own tier composition.
  it('spawns each tower its tier composition, starting UNAWARE with no baseId/dockKey', () => {
    const towers = [{ q: 0, r: 0 }, { q: 4, r: -2 }];
    const scene = makeSceneWithSpawnStub(towers);
    scene._spawnTowerPatrols();
    const expected = towers.reduce((n, _t, i) => n + towerPatrolComposition(i, towers.length).length, 0);
    expect(scene.enemies.length).toBe(expected);
    for (const e of scene.enemies) {
      expect(e.awareness).toBe(UNAWARE);
      expect(e.baseId).toBeUndefined();
      expect(e.dockKey).toBeUndefined();
    }
  });

  // #269 playtest follow-up round 2 (TOWER_PATROL_COUNT 1 -> 5): a real squad-sized patrol reads
  // as a genuine presence, not a lone trooper — assert the bumped headcount explicitly (rather
  // than only asserting via the derived `2 * TOWER_PATROL_COUNT` above) so a future accidental
  // drop back toward 1 fails loudly here too.
  it('TOWER_PATROL_COUNT is a real squad size (more than a lone trooper, short of a base-sized fight)', () => {
    expect(TOWER_PATROL_COUNT).toBeGreaterThanOrEqual(4);
    expect(TOWER_PATROL_COUNT).toBeLessThanOrEqual(6);
  });

  // #357: the escalation rules themselves. These are the merge gate for the composition change —
  // the exact per-tier roster is a playtest DIAL (expect Jackson to move the numbers), so these
  // pin the SHAPE that must survive any retune, not the specific counts.
  describe('#357: tower patrol composition escalates by alert-tower index', () => {
    it('tier 0 is still exactly the #269 five-infantry opener', () => {
      expect(TOWER_PATROL_TIERS[0]).toEqual(Array(TOWER_PATROL_COUNT).fill('infantry'));
      expect(towerPatrolComposition(0, 5)).toEqual(TOWER_PATROL_TIERS[0]);
    });

    it('the last tower of a run draws the heaviest tier, the first the lightest', () => {
      expect(towerPatrolComposition(0, 5)).toEqual(TOWER_PATROL_TIERS[0]);
      expect(towerPatrolComposition(4, 5)).toEqual(TOWER_PATROL_TIERS[TOWER_PATROL_TIERS.length - 1]);
    });

    it('SIZE grows monotonically across the tiers, not just the mix', () => {
      const sizes = TOWER_PATROL_TIERS.map((t) => t.length);
      for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    });

    it('composition is mixed beyond infantry from tier 1 on, and only tier 0 is infantry-only', () => {
      expect(new Set(TOWER_PATROL_TIERS[0]).size).toBe(1);
      for (let i = 1; i < TOWER_PATROL_TIERS.length; i++) {
        expect(new Set(TOWER_PATROL_TIERS[i]).size).toBeGreaterThan(1);
      }
    });

    it('every id in every tier is a real ENEMY_KINDS kind or a real ENEMIES mech loadout', () => {
      for (const tier of TOWER_PATROL_TIERS) {
        for (const id of tier) {
          expect(Boolean(ENEMY_KINDS[id]) || Boolean(ENEMIES[id])).toBe(true);
        }
      }
    });

    it('no tier fields a carrier — an unarmed, uncapped drone source would make a patrol an endless tap (#328), flagged for the owner rather than assumed', () => {
      for (const tier of TOWER_PATROL_TIERS) expect(tier).not.toContain('carrier');
    });

    it('a run with a single tower still gets the light opener, never the heaviest tier', () => {
      expect(towerPatrolComposition(0, 1)).toEqual(TOWER_PATROL_TIERS[0]);
    });

    it('every tower index of a real-length run resolves to a valid tier (no undefined off the end)', () => {
      for (const count of [1, 2, 3, 5, 8]) {
        for (let i = 0; i < count; i++) {
          expect(Array.isArray(towerPatrolComposition(i, count))).toBe(true);
          expect(towerPatrolComposition(i, count).length).toBeGreaterThan(0);
        }
      }
    });

    it('returns a fresh copy so a caller cannot mutate the shared tier table', () => {
      const a = towerPatrolComposition(0, 5);
      a.push('tank');
      expect(towerPatrolComposition(0, 5)).toEqual(TOWER_PATROL_TIERS[0]);
    });
  });

  // #269 playtest follow-up round 2: a multi-unit patrol must scatter around the tower's landing
  // point rather than stacking every unit on the exact same pixel (the same "huddle, don't stack"
  // idea `_spawnDormantUnits` already applies to a multi-unit dock cluster).
  it('scatters a multi-unit patrol\'s spawn points around the tower rather than stacking them on one pixel', () => {
    const scene = makeSceneWithSpawnStub([{ q: 6, r: 3 }]);
    scene._spawnTowerPatrols();
    expect(scene.enemies.length).toBe(TOWER_PATROL_COUNT);
    const points = scene.enemies.map((e) => `${e.spawnX},${e.spawnY}`);
    expect(new Set(points).size).toBe(TOWER_PATROL_COUNT);   // every unit gets its own distinct point
  });

  it('no alert towers means no patrol units spawned', () => {
    const scene = makeSceneWithSpawnStub([]);
    scene._spawnTowerPatrols();
    expect(scene.enemies.length).toBe(0);
  });

  it('every patrol unit\'s spawnX/spawnY (idle-wander anchor) sits near the tower position, not just at the origin', () => {
    const scene = makeSceneWithSpawnStub([{ q: 6, r: 3 }]);
    scene._spawnTowerPatrols();
    expect(scene.enemies.length).toBe(TOWER_PATROL_COUNT);
    const { x: tx, y: ty } = hexToPixel(6, 3);
    for (const e of scene.enemies) {
      // Empty terrain forces nearestValidPixel's ring-search fallback — the exact landing hex
      // isn't asserted (that's nearestValidPixel's own unit-tested behavior, spawnPlacement.test.js
      // if present, or covered by hexgrid's nearestHex tests), just that it's a real finite point
      // reasonably close to the tower, not left at (0,0)/NaN.
      expect(Number.isFinite(e.spawnX)).toBe(true);
      expect(Number.isFinite(e.spawnY)).toBe(true);
      expect(Math.hypot(e.spawnX - tx, e.spawnY - ty)).toBeLessThan(4000);
    }
  });

  it('_allBasesCleared ignores patrol units entirely — a base can be "cleared" while its nearby patrol is still alive, and vice versa', () => {
    const scene = makeSceneWithSpawnStub([{ q: 0, r: 0 }]);
    scene.bases = [{ id: 'base0', center: { q: 0, r: 0 }, docks: [], turrets: [] }];
    scene._spawnTowerPatrols();
    // No base-origin (baseId-tagged) enemy exists — cleared is true even though the patrol units
    // spawned near the tower are alive and sitting in `this.enemies`.
    expect(scene.enemies.length).toBe(TOWER_PATROL_COUNT);
    expect(scene._allBasesCleared()).toBe(true);

    // Conversely: a base-origin enemy alive with the patrol also alive still reads as NOT
    // cleared — the patrol's presence/absence has zero bearing on the win condition either way.
    scene.enemies.push(makeDockedUnit('turret', { baseId: 'base0' }));
    expect(scene._allBasesCleared()).toBe(false);
  });
});

// #284: a tower must wake its OWN linked base (`baseId`, threaded through from `placeGapTowers`)
// even when a DIFFERENT base sits geometrically closer to the tower's position — proving the fix
// actually changes behavior, not just that it still works on layouts where straight-line
// distance happened to agree with real gap ownership.
describe('#284: alert tower wake-trigger uses its own linked baseId, not geometric nearest-base', () => {
  it('_triggerAlert wakes exactly the base passed as baseId, ignoring this.bases entirely', () => {
    const scene = makeScene();
    scene.bases = [
      { id: 'base0', center: { q: 0, r: 0 }, docks: [], turrets: [] },
      { id: 'base1', center: { q: 1, r: 0 }, docks: [], turrets: [] },   // geometrically closer to (0,0)
    ];
    const dormant = makeDockedUnit('turret', { baseId: 'base0' });
    scene.enemies.push(dormant);
    scene._triggerAlert('base0');
    expect(dormant.awareness).toBe(AWARE);
    expect(scene._wokenBases.has('base1')).toBe(false);
  });

  it('a null baseId (tower somehow unlinked) wakes nothing rather than guessing a base', () => {
    const scene = makeScene();
    const dormant = makeDockedUnit('turret', { baseId: 'base0' });
    scene.enemies.push(dormant);
    scene._triggerAlert(null);
    expect(dormant.awareness).toBe(DORMANT);
    expect(scene._wokenBases.size).toBe(0);
  });

  it('a completed countdown wakes the tower\'s linked base even though a DIFFERENT base sits physically closer to the tower', () => {
    const scene = makeScene();
    // A deliberately "curvy corridor" layout: the tower is placed near base0's hex per its real
    // gap ownership (#275 — a tower sits within its own gap's progress bounds), but base1's centre
    // happens to land physically CLOSER to the tower's world position than base0's does — exactly
    // the scenario a curving spine can produce (progress-along-the-spine disagrees with straight-
    // line distance). The old `nearestBaseTo` would have woken base1; the fix must wake base0.
    const towerHex = { q: 0, r: 0 };
    scene.bases = [
      { id: 'base0', center: { q: 40, r: 0 }, docks: [], turrets: [] },   // base0: far by straight line...
      { id: 'base1', center: { q: 1, r: 0 }, docks: [], turrets: [] },    // ...base1: geometrically nearest
    ];
    scene.alertTowerHexes = [{ ...towerHex, baseId: 'base0' }];   // ...but the tower is base0's own
    scene.terrain = new Map([[axialKey(towerHex.q, towerHex.r), 'alertTower']]);
    scene._initAlertTowers();   // re-init now that alertTowerHexes/terrain are populated
    scene._updateSignaledPulse = () => {};   // #385: pure-graphics pulse, out of scope here (no `this.add`)

    const base0Unit = makeDockedUnit('turret', { baseId: 'base0' });
    const base1Unit = makeDockedUnit('turret', { baseId: 'base1' });
    scene.enemies.push(base0Unit, base1Unit);

    const { x, y } = hexToPixel(towerHex.q, towerHex.r);
    scene.px = x; scene.py = y;   // player standing right on the tower, well within detect radius
    // One big tick, well past the full countdown, completes it in a single call.
    scene._updateAlertTowers(30);

    expect(base0Unit.awareness).toBe(AWARE);     // the tower's OWN linked base woke...
    expect(base1Unit.awareness).toBe(DORMANT);   // ...NOT the geometrically-nearest one
    expect(scene._wokenBases.has('base0')).toBe(true);
    expect(scene._wokenBases.has('base1')).toBe(false);
  });
});

// #269 overhaul: an alert tower now activates on ANY of — player in its (larger) detection
// radius, a nearby player gunshot, or the tower itself being damaged — and once started the
// countdown is STICKY (leaving range no longer cancels it; only destroying the tower stops it).
describe('#269 overhaul: alert-tower activation triggers + sticky countdown (_updateAlertTowers)', () => {
  const TOWER = { q: 0, r: 0 };
  const KEY = axialKey(TOWER.q, TOWER.r);

  // A scene wired with one alert tower at the origin linked to base0, plus one dormant base0 unit
  // parked far away (so ONLY the tower's own completion can wake it — never proximity to the unit).
  function makeTowerScene() {
    const scene = makeScene();
    scene.bases = [{ id: 'base0', center: { q: 40, r: 0 }, docks: [], turrets: [] }];
    scene.alertTowerHexes = [{ ...TOWER, baseId: 'base0' }];
    scene.terrain = new Map([[KEY, 'alertTower']]);
    scene._initAlertTowers();
    // The live pulsing-ring FX (`_updateAlertFx`) needs real Phaser `this.add.graphics`/Audio —
    // it's purely visual and out of scope for these activation/countdown-logic tests, so stub it
    // to a no-op (the #284 completion test avoided it by finishing the countdown in a single tick).
    scene._updateAlertFx = () => {};
    // Likewise the #385 continuous post-signal pulse ring (`_updateSignaledPulse`) is pure Phaser
    // graphics, out of scope for these countdown/activation-logic tests — stub it to a no-op so a
    // completing countdown (which now records the tower as signaled) doesn't need `this.add`.
    scene._updateSignaledPulse = () => {};
    const unit = makeDockedUnit('turret', { baseId: 'base0' });
    unit.x = 99999; unit.y = 99999;   // nowhere near the tower or the player
    scene.enemies.push(unit);
    // Default: player and any gunshot far away — each test opts INTO exactly one trigger.
    scene.px = 88888; scene.py = 88888;
    scene._lastFireAt = null;
    return { scene, unit };
  }

  it('a nearby player GUNSHOT (no proximity) starts + completes the countdown, waking the base', () => {
    const { scene, unit } = makeTowerScene();
    const { x, y } = hexToPixel(TOWER.q, TOWER.r);
    // A live shot (time.now within NOISE_WINDOW_MS of _lastFireAt) landing right on the tower.
    scene.time.now = 0; scene._lastFireAt = 0;
    scene._lastFireX = x; scene._lastFireY = y;
    scene._updateAlertTowers(30);   // one big tick past the full countdown
    expect(unit.awareness).toBe(AWARE);
    expect(scene._wokenBases.has('base0')).toBe(true);
  });

  it('a gunshot OUTSIDE the tower\'s noise range does NOT start the countdown', () => {
    const { scene, unit } = makeTowerScene();
    const { x, y } = hexToPixel(TOWER.q, TOWER.r);
    scene.time.now = 0; scene._lastFireAt = 0;
    scene._lastFireX = x + 2000; scene._lastFireY = y;   // way past NOISE_AGGRO_RANGE
    scene._updateAlertTowers(30);
    expect(unit.awareness).toBe(DORMANT);
    expect(scene._alertTowerStates.get(KEY).countingDown).toBe(false);
  });

  it('DAMAGING the tower (via _onAlertTowerDamaged) starts + completes the countdown, waking the base', () => {
    const { scene, unit } = makeTowerScene();
    scene._onAlertTowerDamaged(KEY);   // world.js calls this when a standing alert tower is hit
    scene._updateAlertTowers(30);
    expect(unit.awareness).toBe(AWARE);
    expect(scene._wokenBases.has('base0')).toBe(true);
  });

  it('the damage flag is a one-frame signal — it is consumed on the tick it activates', () => {
    const { scene } = makeTowerScene();
    scene._onAlertTowerDamaged(KEY);
    expect(scene._alertTowerDamaged.has(KEY)).toBe(true);
    scene._updateAlertTowers(0.1);   // small tick: starts the countdown but doesn't complete it
    expect(scene._alertTowerDamaged.has(KEY)).toBe(false);   // consumed
    expect(scene._alertTowerStates.get(KEY).countingDown).toBe(true);   // ...but it's committed now
  });

  it('STICKY: a countdown started by proximity completes even after the player leaves range', () => {
    const { scene, unit } = makeTowerScene();
    const { x, y } = hexToPixel(TOWER.q, TOWER.r);
    scene.px = x; scene.py = y;                 // player on the tower — starts the countdown...
    scene._updateAlertTowers(0.1);              // ...partway (0.1s of a 3s countdown)
    expect(scene._alertTowerStates.get(KEY).countingDown).toBe(true);
    scene.px = 88888; scene.py = 88888;         // player flees far out of range
    scene._updateAlertTowers(30);               // old behavior: reset to idle; new: completes anyway
    expect(unit.awareness).toBe(AWARE);
    expect(scene._wokenBases.has('base0')).toBe(true);
  });

  it('a tower DESTROYED mid-countdown never fires — its state is dropped, base stays dormant', () => {
    const { scene, unit } = makeTowerScene();
    const { x, y } = hexToPixel(TOWER.q, TOWER.r);
    scene.px = x; scene.py = y;
    scene._updateAlertTowers(0.1);              // countdown started
    expect(scene._alertTowerStates.get(KEY).countingDown).toBe(true);
    scene.terrain.set(KEY, 'rubble');           // tower collapses to rubble (as _damageBuildingAt does)
    scene._updateAlertTowers(30);               // notices the hex is gone, drops the state
    expect(scene._alertTowerStates.has(KEY)).toBe(false);
    expect(unit.awareness).toBe(DORMANT);       // never woke — destroyed before completing
    expect(scene._wokenBases.has('base0')).toBe(false);
  });

  it('the larger detection radius: a player past the OLD 320px radius but inside the new one activates it', () => {
    const { scene } = makeTowerScene();
    const { x, y } = hexToPixel(TOWER.q, TOWER.r);
    scene.px = x + 400; scene.py = y;   // 400px: outside old 320 radius, inside new 480 radius
    scene._updateAlertTowers(0.1);
    expect(scene._alertTowerStates.get(KEY).countingDown).toBe(true);
  });

  // #385: once the countdown COMPLETES, the tower is recorded as SIGNALED — it keeps pulsing red
  // and is a siren candidate until destroyed, and its spool-up countdown state is gone.
  it('a completed countdown records the tower as SIGNALED (still standing) and clears its spool-up state', () => {
    const { scene } = makeTowerScene();
    const { x, y } = hexToPixel(TOWER.q, TOWER.r);
    scene.px = x; scene.py = y;
    scene._updateAlertTowers(30);                        // one big tick past the full countdown
    expect(scene._alertTowerStates.has(KEY)).toBe(false); // no longer spooling up
    expect(scene._signaledTowers.has(KEY)).toBe(true);    // now a live, signaled tower
    // Position stashed for the pulse + nearest-siren selection.
    expect(scene._signaledTowers.get(KEY)).toEqual({ x, y });
  });

  // #385: a SIGNALED tower keeps ticking as signaled-alive across frames until it is destroyed —
  // then it drops out (neither pulses nor sirens). This is the "stops on tower death" path.
  it('a SIGNALED tower is dropped the frame it is destroyed (stops pulsing + sirening)', () => {
    const { scene } = makeTowerScene();
    const { x, y } = hexToPixel(TOWER.q, TOWER.r);
    scene.px = x; scene.py = y;
    scene._updateAlertTowers(30);                        // signal it
    expect(scene._signaledTowers.has(KEY)).toBe(true);
    scene.px = 88888; scene.py = 88888;                  // player leaves — signaled tower stays live
    scene._updateAlertTowers(0.1);
    expect(scene._signaledTowers.has(KEY)).toBe(true);    // still lit + sirening after signaling
    scene.terrain.set(KEY, 'rubble');                    // tower destroyed
    scene._updateAlertTowers(0.1);
    expect(scene._signaledTowers.has(KEY)).toBe(false);   // gone — silent + unlit
  });

  // #385 (real abrupt-cut fix): the two prior fixes only lengthened the fade at the LAST-tower
  // `stopSiren` call — but that path almost never runs. Destroying the near, blaring tower usually
  // leaves ANOTHER signaled tower alive (this base's, or a far already-alerted base's), so the voice
  // REASSIGNS with no fade. When the survivor is far, that reads as an abrupt cut. These pin the fix:
  // the siren wails DOWN whenever the nearest signaled-alive tower is out of audible range, and only
  // GLIDES (no cut) when a survivor is still close enough to hear.
  describe('#385 siren wails down when the audible tower dies (single-voice reassignment)', () => {
    afterEach(() => vi.restoreAllMocks());

    // A far signaled tower well past MAX_AUDIBLE_DISTANCE, standing in for a cross-map alerted base.
    const FAR = { q: 50, r: 0 };
    const FAR_KEY = axialKey(FAR.q, FAR.r);

    function signalOriginTower() {
      const { scene } = makeTowerScene();
      const { x, y } = hexToPixel(TOWER.q, TOWER.r);
      scene.px = x; scene.py = y;          // player hugging the origin tower — it's the audible one
      scene._updateAlertTowers(30);        // signal it
      expect(scene._signaledTowers.has(KEY)).toBe(true);
      return { scene, x, y };
    }

    it('destroying the audible tower with only a FAR survivor left FADES the siren (not an instant cut)', () => {
      const { scene } = signalOriginTower();
      // A second, far-off signaled tower survives (out of audible range).
      const far = hexToPixel(FAR.q, FAR.r);
      expect(Math.hypot(far.x - scene.px, far.y - scene.py)).toBeGreaterThan(MAX_AUDIBLE_DISTANCE);
      scene.terrain.set(FAR_KEY, 'alertTower');
      scene._signaledTowers.set(FAR_KEY, { x: far.x, y: far.y });

      const stopSiren = vi.spyOn(Audio, 'stopSiren').mockImplementation(() => {});
      const updateSiren = vi.spyOn(Audio, 'updateSiren').mockImplementation(() => {});

      scene.terrain.set(KEY, 'rubble');    // player destroys the near, blaring tower
      scene._updateAlertTowers(0.1);

      // The voice must WAIL DOWN — stopSiren called WITH a real fade (~1s), not reassigned onto the
      // far survivor at its near-silent distance gain (the abrupt cut), and never a bare/instant stop.
      expect(stopSiren).toHaveBeenCalledTimes(1);
      const fade = stopSiren.mock.calls[0][0];
      expect(fade).toBeGreaterThanOrEqual(1);
      expect(updateSiren).not.toHaveBeenCalled();   // did NOT snap the voice onto the far tower
    });

    it('destroying the audible tower while a NEAR survivor remains GLIDES the voice (no fade/cut)', () => {
      const { scene } = signalOriginTower();
      // A survivor close enough to still be heard — reassignment should keep the siren going.
      const near = hexToPixel(2, 0);
      expect(Math.hypot(near.x - scene.px, near.y - scene.py)).toBeLessThan(MAX_AUDIBLE_DISTANCE);
      const NEAR_KEY = axialKey(2, 0);
      scene.terrain.set(NEAR_KEY, 'alertTower');
      scene._signaledTowers.set(NEAR_KEY, { x: near.x, y: near.y });

      const stopSiren = vi.spyOn(Audio, 'stopSiren').mockImplementation(() => {});
      const updateSiren = vi.spyOn(Audio, 'updateSiren').mockImplementation(() => {});

      scene.terrain.set(KEY, 'rubble');    // destroy the origin tower
      scene._updateAlertTowers(0.1);

      expect(updateSiren).toHaveBeenCalledTimes(1);   // reassigned to the near survivor, no cut
      expect(updateSiren.mock.calls[0][0]).toMatchObject({ x: near.x, y: near.y });
      expect(stopSiren).not.toHaveBeenCalled();
    });

    it('destroying the ONLY/last audible tower FADES the siren over ~1s', () => {
      const { scene } = signalOriginTower();
      const stopSiren = vi.spyOn(Audio, 'stopSiren').mockImplementation(() => {});
      const updateSiren = vi.spyOn(Audio, 'updateSiren').mockImplementation(() => {});

      scene.terrain.set(KEY, 'rubble');
      scene._updateAlertTowers(0.1);

      expect(stopSiren).toHaveBeenCalledTimes(1);
      expect(stopSiren.mock.calls[0][0]).toBeGreaterThanOrEqual(1);
      expect(updateSiren).not.toHaveBeenCalled();
    });
  });
});

// #269 playtest follow-up bug 1 — ROOT CAUSE regression: waking a base flipped DORMANT→AWARE and
// (correctly) set `holdGround` on slow/defensive kinds, but the holdGround branches in
// enemyBehaviors.js only ever zeroed velocity — they never touched `e.angle`, so a holdGround
// unit's HULL stayed frozen at whatever fixed angle it spawned with (`Math.PI/2`, straight down)
// FOREVER, regardless of where the player was. Only its turret (independently slewed) tracked the
// player, so from most approach angles a "woken" tank/carrier/infantry read as a completely
// static, lifeless prop — exactly the "ground units still don't move" playtest report. Fast
// (non-holdGround) kinds were never affected — they were already getting real velocity via their
// normal advance-to-standoff movement. Fixed by having each holdGround branch also rotate `e.angle`
// toward the player's bearing (mirrors the turret's own tracking), while still leaving velocity at
// zero (holdGround units still don't translate — that part of the design is intentional).
describe('#269 bug 1 regression: a woken unit actually reacts on its next tick', () => {
  it('a fast kind (drone, no holdGround) gets real non-zero velocity the tick after waking', () => {
    const scene = makeTickableScene();
    const e = makeTickableUnit('drone');
    scene.enemies.push(e);
    scene._wakeBase('base0');
    expect(e.holdGround).toBeUndefined();
    skipWakeStagger(e);   // #285: not under test here — react on the very next tick
    scene._updateEnemy(e, 0.016, 16);
    expect(Math.hypot(e.vx, e.vy)).toBeGreaterThan(0);
  });

  it('#269 Part 1 / #285: a slow/holdGround kind (tank) still moves toward the player, fully unleashed, and its hull turns to face it', () => {
    const scene = makeTickableScene();
    const e = makeTickableUnit('tank');
    scene.enemies.push(e);
    scene._wakeBase('base0');
    expect(e.holdGround).toBe(true);
    skipWakeStagger(e);   // #285: not under test here — react on the very next tick
    const spawnAngle = e.angle;
    for (let i = 0; i < 30; i++) scene._updateEnemy(e, 0.016, 16);
    // Root-cause assertion: BEFORE the #269 fix this stayed pinned at `spawnAngle` forever (the
    // actual bug), AND never translated at all. Holding ground is no longer a total freeze — it
    // gets real velocity, chasing/strafing exactly like a non-held tank.
    expect(e.angle).not.toBe(spawnAngle);
    expect(Math.hypot(e.vx, e.vy)).toBeGreaterThan(0);
    expect(e.x !== 0 || e.y !== 0).toBe(true);
  });

  it('#285: a holdGround unit is NOT leashed — it keeps closing on the player indefinitely, unlike the old leash-capped behavior', () => {
    const scene = makeTickableScene();
    scene.enemyFire = false;   // out of scope here: firing needs a full projectile-spawn stub
    const e = makeTickableUnit('tank');
    scene.enemies.push(e);
    scene._wakeBase('base0');
    skipWakeStagger(e);
    // Many ticks (~32s simulated). The old leash (HOLD_GROUND_LEASH_PX = 320px, now removed)
    // would have capped this well under 360px from spawn; #285 removes that cap entirely, so a
    // tank (52px/s) chasing a player 900px away keeps closing distance the whole time instead of
    // getting pulled back once it wanders "too far" from where it woke up.
    const spawnX = e.x, spawnY = e.y;
    const distToPlayerStart = Math.hypot(scene.px - spawnX, scene.py - spawnY);
    for (let i = 0; i < 2000; i++) scene._updateEnemy(e, 0.016, 16);
    const distTraveled = Math.hypot(e.x - spawnX, e.y - spawnY);
    const distToPlayerNow = Math.hypot(scene.px - e.x, scene.py - e.y);
    // Old leash radius (plus a small overshoot budget) — must now be comfortably exceeded.
    expect(distTraveled).toBeGreaterThan(400);
    // And it's genuinely closing the gap toward the player, not just wandering.
    expect(distToPlayerNow).toBeLessThan(distToPlayerStart);
  });

  it('a slow/holdGround kind (infantry) also turns its hull instead of staying frozen', () => {
    const scene = makeTickableScene();
    const e = makeTickableUnit('infantry');
    scene.enemies.push(e);
    scene._wakeBase('base0');
    skipWakeStagger(e);   // #285: not under test here — react on the very next tick
    const spawnAngle = e.angle;
    for (let i = 0; i < 30; i++) scene._updateEnemy(e, 0.016, 16);
    expect(e.angle).not.toBe(spawnAngle);
  });
});

// #285 ("units at a base shouldn't all snap into motion in the same instant"): coverage for the
// wake-response stagger (`e.reactDelayMs`, set by `_wakeBase`, consumed by enemies.js
// `_isReacting`). `awareness` still flips synchronously for the whole base at once (unchanged,
// covered above) — what's new is that each unit's actual engagement (movement/turret-tracking/
// firing) starts at a slightly different moment.
describe('#285: wake-response stagger — a base\'s units don\'t all start reacting on the identical tick', () => {
  it('a freshly-woken unit is AWARE but does not move/turn on the very first tick (still "noticing")', () => {
    const scene = makeTickableScene();
    const e = makeTickableUnit('tank');
    scene.enemies.push(e);
    scene._wakeBase('base0');
    // Real `_wakeBase` always stamps a non-zero-or-more stagger — sanity-check it's actually set
    // rather than accidentally always 0 (which would make this whole feature a no-op).
    expect(e.reactDelayMs).not.toBeNull();
    expect(e.reactDelayMs).toBeGreaterThanOrEqual(0);
    scene._updateEnemy(e, 0.016, 16);
    expect(e.turret).toBe(0);   // hasn't started tracking the player yet
  });

  it('two units woken together at the same base can differ in when they start reacting', () => {
    const scene = makeTickableScene();
    const a = makeTickableUnit('tank');
    const b = makeTickableUnit('tank');
    scene.enemies.push(a, b);
    scene._wakeBase('base0');
    // Force a deterministic split straddling a single tick: `a` reacts almost immediately, `b`
    // only after several ticks — mirrors the real spread `_wakeBase`'s randomization produces,
    // without depending on Math.random's actual output.
    a.reactDelayMs = 1;
    b.reactDelayMs = 100;
    scene._updateEnemy(a, 0.016, 16);
    scene._updateEnemy(b, 0.016, 16);
    // `a` has started reacting (turret tracking the player); `b` hasn't yet — NOT the identical
    // same-tick snap the old synchronous wake produced.
    expect(a.turret).not.toBe(0);
    expect(b.turret).toBe(0);
    // Enough further ticks for `b`'s longer delay to lapse too — it eventually reacts as well.
    for (let i = 0; i < 10; i++) scene._updateEnemy(b, 0.016, 16);
    expect(b.turret).not.toBe(0);
  });

  it('the stagger is short — every unit is reacting well within a second of waking', () => {
    const scene = makeTickableScene();
    const units = ['tank', 'tank', 'tank', 'infantry', 'infantry'].map(() => makeTickableUnit('tank'));
    scene.enemies.push(...units);
    scene._wakeBase('base0');
    // 60 ticks @16ms ≈ 1s — comfortably past even the maximum possible stagger window.
    for (let i = 0; i < 60; i++) for (const u of units) scene._updateEnemy(u, 0.016, 16);
    for (const u of units) expect(u.turret).not.toBe(0);
  });
});

// #269 playtest follow-up ask 2 — DORMANT units should also wake on player proximity, independent
// of any alert tower. Reuses `shouldBecomeAware`/`detectionRangeFor` (data/awareness.js), the same
// proximity mechanism an UNAWARE unit already uses to notice the player — the only difference is
// the RESPONSE: the whole base wakes together via `_wakeBase`, not just the one unit that noticed.
describe('#269 playtest follow-up: DORMANT units wake on player proximity, no alert tower needed', () => {
  it('a DORMANT unit\'s whole base wakes once the player enters its own detection range', () => {
    const scene = makeScene();
    const near = makeDockedUnit('tank', { baseId: 'base0' });
    const dockmate = makeDockedUnit('turret', { baseId: 'base0' });
    scene.enemies.push(near, dockmate);
    // Tank's detectRange is detectionRangeFor(fireRange=420) = 504 — put the player just inside it.
    scene.px = near.x + near.detectRange - 1;
    scene.py = near.y;
    scene._maybeProximityWake(near);
    expect(near.awareness).toBe(AWARE);
    expect(dockmate.awareness).toBe(AWARE);   // whole base, not just the unit that noticed
  });

  it('a base far from the player stays dormant — no proximity, no alert tower', () => {
    const scene = makeScene();
    const far = makeDockedUnit('tank', { baseId: 'base0' });
    scene.enemies.push(far);
    scene.px = far.x + far.detectRange * 10;   // way outside detection range
    scene.py = far.y;
    scene._maybeProximityWake(far);
    expect(far.awareness).toBe(DORMANT);
  });

  it('is a no-op once the base is already woken (idempotent, same as the tower path)', () => {
    const scene = makeScene();
    const e = makeDockedUnit('tank', { baseId: 'base0' });
    scene.enemies.push(e);
    scene._wakeBase('base0');
    e.awareness = UNAWARE;   // simulate some other transition after wake
    scene.px = e.x; scene.py = e.y;   // right on top of it
    scene._maybeProximityWake(e);
    expect(e.awareness).toBe(UNAWARE);   // must NOT get stomped back to AWARE
  });

  it('the DORMANT per-frame tick itself triggers proximity wake (not just direct calls)', () => {
    const scene = makeTickableScene({ px: 0, py: 0 });
    const e = makeTickableUnit('tank');
    scene.enemies.push(e);
    // Player sits right on top of the still-dormant unit — well within its detection range.
    scene._updateEnemy(e, 0.016, 16);
    expect(e.awareness).toBe(AWARE);
  });

  it('the DORMANT per-frame tick stays a cheap distance check — no movement/firing runs that tick', () => {
    const scene = makeTickableScene({ px: 0, py: 0 });
    const e = makeTickableUnit('tank');
    scene.enemies.push(e);
    scene._updateEnemy(e, 0.016, 16);
    // Woken THIS tick, but the early-return fires before any behavior dispatch runs — no movement/
    // turret slew/firing happens until the NEXT tick (matches DORMANT's "cheap check, not full AI"
    // contract; the bug-1 tests above cover what happens starting next tick).
    expect(e.vx).toBe(0);
    expect(e.vy).toBe(0);
    expect(e.turret).toBe(0);
  });

  it('a genuinely still-dormant unit (player far away) stays untouched by the tick', () => {
    const scene = makeTickableScene({ px: 5000, py: 5000 });
    const e = makeTickableUnit('tank');
    scene.enemies.push(e);
    scene._updateEnemy(e, 0.016, 16);
    expect(e.awareness).toBe(DORMANT);
    expect(e.x).toBe(0);
    expect(e.y).toBe(0);
  });
});

// #269 playtest follow-up ("wake upon being shot at or NEAR, not just when getting close"):
// gunfire NOISE near a DORMANT unit wakes its whole base, independent of player proximity —
// threading the same `noiseDist` check the UNAWARE path (enemies.js `_updateVehicle`) already
// uses (`_lastFireAt`/`_lastFireX`/`_lastFireY` + NOISE_WINDOW_MS) into `_maybeProximityWake`.
describe('#269 playtest follow-up: DORMANT units wake on nearby gunfire noise, no proximity needed', () => {
  it('a DORMANT unit within noise-aggro range of a recent player shot wakes its whole base', () => {
    const scene = makeScene();
    const near = makeDockedUnit('tank', { baseId: 'base0' });
    const dockmate = makeDockedUnit('turret', { baseId: 'base0' });
    scene.enemies.push(near, dockmate);
    // Player physically FAR away — the proximity branch must not be what wakes anyone here.
    scene.px = near.x + 100000; scene.py = near.y;
    // A live shot (fired at time.now, inside NOISE_WINDOW_MS) landing 200px away — inside
    // NOISE_AGGRO_RANGE (260).
    scene.time.now = 0;
    scene._lastFireAt = 0;
    scene._lastFireX = near.x + 200; scene._lastFireY = near.y;
    scene._maybeProximityWake(near);
    expect(near.awareness).toBe(AWARE);
    expect(dockmate.awareness).toBe(AWARE);   // whole base wakes, same as the proximity path
  });

  it('a DORMANT unit OUTSIDE noise-aggro range of the shot stays dormant', () => {
    const scene = makeScene();
    const e = makeDockedUnit('tank', { baseId: 'base0' });
    scene.enemies.push(e);
    scene.px = e.x + 100000; scene.py = e.y;   // no proximity wake either
    scene.time.now = 0;
    scene._lastFireAt = 0;
    scene._lastFireX = e.x + 400; scene._lastFireY = e.y;   // 400px > NOISE_AGGRO_RANGE (260)
    scene._maybeProximityWake(e);
    expect(e.awareness).toBe(DORMANT);
  });

  it('a stale shot (older than NOISE_WINDOW_MS) no longer wakes anyone', () => {
    const scene = makeScene();
    const e = makeDockedUnit('tank', { baseId: 'base0' });
    scene.enemies.push(e);
    scene.px = e.x + 100000; scene.py = e.y;
    // Shot was close (would-be in-range) but fired long ago — outside the noise window, so it's
    // no longer "live" and contributes no noiseDist.
    scene.time.now = 5000;
    scene._lastFireAt = 0;   // 5000ms ago, well past NOISE_WINDOW_MS (200)
    scene._lastFireX = e.x + 50; scene._lastFireY = e.y;
    scene._maybeProximityWake(e);
    expect(e.awareness).toBe(DORMANT);
  });

  it('no shot ever fired (_lastFireAt null) is a safe no-op — proximity path still works alone', () => {
    const scene = makeScene();
    const e = makeDockedUnit('tank', { baseId: 'base0' });
    scene.enemies.push(e);
    scene._lastFireAt = null;   // never fired
    scene.px = e.x + 100000; scene.py = e.y;   // and player is far — nothing should wake it
    expect(() => scene._maybeProximityWake(e)).not.toThrow();
    expect(e.awareness).toBe(DORMANT);
  });
});

// #269 playtest follow-up ("wake upon being SHOT"): a DORMANT unit taking damage via
// combat.js `_damageEnemyAt` wakes its whole base — being hit is the most unambiguous "you've
// been noticed" signal there is. Composes the real CombatMixin alongside BasesMixin (both are
// Object.assign'd onto the same ArenaScene in production) so `this._wakeBase` is directly
// reachable from `_damageEnemyAt`. The death-pipeline side effects (`_deathFx`/drops/removal)
// are stubbed — only the wake hook + damage application are under test.
describe('#269 playtest follow-up: DORMANT units wake when directly shot (_damageEnemyAt)', () => {
  function makeCombatScene() {
    const scene = { time: { now: 0 }, enemies: [], px: 0, py: 0, bases: [], alertTowerHexes: [] };
    Object.assign(scene, EnemiesMixin, BasesMixin, CombatMixin);
    scene._initAlertTowers();
    // Death-pipeline stubs (only fire when a hit destroys the unit) — irrelevant to the wake hook.
    scene._deathFx = () => {};
    scene._maybeDropPowerup = () => {};
    scene._maybeDropSalvage = () => {};
    scene._removeEnemy = (e) => { const i = scene.enemies.indexOf(e); if (i >= 0) scene.enemies.splice(i, 1); };
    return scene;
  }

  it('a non-lethal hit on a DORMANT unit wakes its whole base', () => {
    const scene = makeCombatScene();
    const hit = makeDockedUnit('tank', { baseId: 'base0' });
    const dockmate = makeDockedUnit('turret', { baseId: 'base0' });
    scene.enemies.push(hit, dockmate);
    // Small damage relative to the tank's hp pool — survives the hit, still gets its base woken.
    scene._damageEnemyAt(hit, hit.x, hit.y, 1, 0xffffff);
    expect(hit.mech.isDestroyed()).toBe(false);
    expect(hit.awareness).toBe(AWARE);
    expect(dockmate.awareness).toBe(AWARE);
  });

  it('a hit that DESTROYS the DORMANT unit still wakes its base (its dockmates notice)', () => {
    const scene = makeCombatScene();
    const hit = makeDockedUnit('infantry', { baseId: 'base0' });   // fragile — one big hit kills it
    const dockmate = makeDockedUnit('turret', { baseId: 'base0' });
    scene.enemies.push(hit, dockmate);
    scene._damageEnemyAt(hit, hit.x, hit.y, 100000, 0xffffff);   // overkill — destroys it outright
    expect(hit.mech.isDestroyed()).toBe(true);
    expect(scene.enemies.includes(hit)).toBe(false);   // removed from the roster this same tick
    // The wake fired BEFORE teardown, so the surviving dockmate still gets stirred by the kill.
    expect(dockmate.awareness).toBe(AWARE);
  });

  it('a hit on a unit with no baseId (e.g. a lone patrol unit) wakes nothing, no error', () => {
    const scene = makeCombatScene();
    const patrol = makeDockedUnit('tank');
    patrol.baseId = null;   // a lone patrol unit carries no base tag (makeDockedUnit's default forces one)
    patrol.awareness = DORMANT;
    scene.enemies.push(patrol);
    expect(() => scene._damageEnemyAt(patrol, patrol.x, patrol.y, 1, 0xffffff)).not.toThrow();
    // No baseId → nothing to group-wake; the unit itself is untouched by the wake hook.
    expect(patrol.awareness).toBe(DORMANT);
  });

  it('an already-AWARE unit taking a hit is a no-op for the wake hook (no re-wake)', () => {
    const scene = makeCombatScene();
    const e = makeDockedUnit('tank', { baseId: 'base0' });
    e.awareness = AWARE;
    scene.enemies.push(e);
    scene._wakeBase('base0');   // base already woken
    e.awareness = UNAWARE;      // simulate a later transition
    scene._damageEnemyAt(e, e.x, e.y, 1, 0xffffff);
    expect(e.awareness).toBe(UNAWARE);   // NOT stomped back to AWARE by a hit
  });
});

describe('#269 §8: _allBasesCleared — the run\'s simplified win condition', () => {
  it('false when no bases exist at all (nothing to clear yet)', () => {
    const scene = makeScene();
    scene.bases = [];
    expect(scene._allBasesCleared()).toBe(false);
  });

  it('false while any base-origin enemy (dormant or awake) is still alive', () => {
    const scene = makeScene();
    scene.bases = [{ id: 'base0', center: { q: 0, r: 0 }, docks: [{ q: 0, r: 0, kindId: 'turret' }] }];
    scene.enemies.push(makeDockedUnit('turret'));
    expect(scene._allBasesCleared()).toBe(false);
  });

  it('true once every base-origin enemy has been removed from this.enemies', () => {
    const scene = makeScene();
    scene.bases = [{ id: 'base0', center: { q: 0, r: 0 }, docks: [{ q: 0, r: 0, kindId: 'turret' }] }];
    // #87: a killed enemy is pruned out of `this.enemies` the same tick it dies — so "cleared"
    // is modeled here simply as an empty enemies array, matching that real invariant.
    expect(scene._allBasesCleared()).toBe(true);
  });
});

// #269 playtest report ("objectives aren't clearing until I kill all units at the base"): the
// run's REAL win condition, distinct from `_allBasesCleared` above — every base's own objective
// hex must be destroyed (or, for a base with no real objective hex, its enemy-count fallback),
// not just every enemy everywhere dead.
describe('#269 playtest follow-up: _allObjectivesDestroyed — objective-hex-based run win condition', () => {
  it('false when no bases exist at all', () => {
    const scene = makeScene();
    scene.bases = [];
    scene.buildingHp = new Map();
    expect(scene._allObjectivesDestroyed()).toBe(false);
  });

  it('false while a base\'s objective hex is still standing in buildingHp, even if every enemy is dead', () => {
    const scene = makeScene();
    scene.bases = [{ id: 'base0', center: { q: 0, r: 0 }, objectiveHex: { q: 0, r: 0 } }];
    scene.buildingHp = new Map([['0,0', 40]]);   // still standing
    scene.enemies = [];   // every enemy already dead — must NOT be enough on its own
    expect(scene._allObjectivesDestroyed()).toBe(false);
  });

  it('true once the objective hex has collapsed to rubble (removed from buildingHp), regardless of enemies', () => {
    const scene = makeScene();
    scene.bases = [{ id: 'base0', center: { q: 0, r: 0 }, objectiveHex: { q: 0, r: 0 } }];
    scene.buildingHp = new Map();   // key deleted — this is what `_damageBuildingAt` does on collapse
    scene.enemies = [makeDockedUnit('turret', { baseId: 'base0' })];   // defenders still alive
    expect(scene._allObjectivesDestroyed()).toBe(true);
  });

  it('falls back to the enemy-count rule for a base with no real objectiveHex', () => {
    const scene = makeScene();
    scene.bases = [{ id: 'base0', center: { q: 5, r: 5 } }];   // no objectiveHex field
    scene.buildingHp = new Map();
    scene.enemies = [makeDockedUnit('turret', { baseId: 'base0' })];
    expect(scene._allObjectivesDestroyed()).toBe(false);

    scene.enemies = [];
    expect(scene._allObjectivesDestroyed()).toBe(true);
  });

  it('requires every base\'s objective destroyed, not just one, when there are multiple bases', () => {
    const scene = makeScene();
    scene.bases = [
      { id: 'base0', center: { q: 0, r: 0 }, objectiveHex: { q: 0, r: 0 } },
      { id: 'base1', center: { q: 10, r: 0 }, objectiveHex: { q: 10, r: 0 } },
    ];
    scene.enemies = [];
    // Only base0's objective hex destroyed so far.
    scene.buildingHp = new Map([['10,0', 40]]);
    expect(scene._allObjectivesDestroyed()).toBe(false);

    // Both destroyed.
    scene.buildingHp = new Map();
    expect(scene._allObjectivesDestroyed()).toBe(true);
  });
});

// #350 — CO-OP ENEMY-COUNT SCALING, at the wiring level. The scaling RULE itself is unit-tested
// in data/playerScaling.test.js; what's checked here is that the two spawn paths actually consult
// the live player roster, and — the part that matters most — that solo is bit-identical to what
// every suite above already asserts. A two-player scene is just `scene.players` with two entries
// (`playersOf` synthesizes a one-player view for a scene double that has no collection, which is
// exactly why every other test in this file keeps passing untouched).
describe('#350: enemy counts scale with player count', () => {
  function makeDockScene(playerCount) {
    const scene = makeScene();
    if (playerCount != null) scene.players = Array.from({ length: playerCount }, (_, id) => ({ id }));
    scene._spawnKind = (x, y, kindId) => {
      const def = ENEMY_KINDS[kindId];
      const e = {
        key: `${kindId}Test`, mech: new HpBody(def), kind: def.kind, kindDef: def,
        x, y, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0, typeId: kindId,
      };
      scene.enemies.push(e);
      return e;
    };
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'tank', count: dockCountFor('tank', Math.random) }], turrets: [],
    }];
    return scene;
  }

  function makePatrolScene(playerCount, towers) {
    const scene = makeScene();
    if (playerCount != null) scene.players = Array.from({ length: playerCount }, (_, id) => ({ id }));
    scene.alertTowerHexes = towers;
    scene._spawnKind = (x, y, kindId) => {
      const e = { key: `${kindId}Test`, x, y, typeId: kindId, awareness: UNAWARE };
      scene.enemies.push(e);
      return e;
    };
    scene._spawnEnemy = (x, y, typeId) => {
      if (ENEMY_KINDS[typeId]) return scene._spawnKind(x, y, typeId);
      const e = { key: `${typeId}Test`, kind: 'mech', x, y, typeId, awareness: UNAWARE };
      scene.enemies.push(e);
      return e;
    };
    return scene;
  }

  const towers = [{ q: 0, r: 0 }, { q: 4, r: -2 }, { q: -5, r: 3 }];
  const soloPatrolTotal = towers.reduce((n, _t, i) => n + towerPatrolComposition(i, towers.length).length, 0);

  it('a GARRISON dock is unchanged solo', () => {
    const scene = makeDockScene(1);
    scene._spawnDormantUnits();
    expect(scene.enemies.length).toBe(dockCountFor('tank', Math.random));
  });

  it('a GARRISON dock doubles at two players', () => {
    const scene = makeDockScene(2);
    scene._spawnDormantUnits();
    expect(scene.enemies.length).toBe(dockCountFor('tank', Math.random) * 2);
    expect(scene.enemies.every((e) => e.awareness === DORMANT)).toBe(true);
  });

  it('a SWARM dock doubles at two players and is untouched solo', () => {
    for (const [players, expected] of [[1, DOCK_SWARM_COUNT], [2, DOCK_SWARM_COUNT * 2]]) {
      const scene = makeDockScene(players);
      scene.bases[0].docks = [{ q: 0, r: 0, kindId: 'drone', count: DOCK_SWARM_COUNT }];
      scene._spawnDormantUnits();
      expect(scene.enemies.length).toBe(expected);
    }
  });

  it('PATROLS are unchanged solo and doubled at two players', () => {
    const solo = makePatrolScene(1, towers);
    solo._spawnTowerPatrols();
    expect(solo.enemies.length).toBe(soloPatrolTotal);

    const coop = makePatrolScene(2, towers);
    coop._spawnTowerPatrols();
    expect(coop.enemies.length).toBe(soloPatrolTotal * 2);
  });

  it('a scene with no players collection at all behaves as one player', () => {
    const scene = makeDockScene(null);
    scene._spawnDormantUnits();
    expect(scene.enemies.length).toBe(dockCountFor('tank', Math.random));
  });

  it('scales per player rather than flipping a two-player switch', () => {
    const scene = makeDockScene(3);
    scene._spawnDormantUnits();
    expect(scene.enemies.length).toBe(dockCountFor('tank', Math.random) * 3);
  });
});
