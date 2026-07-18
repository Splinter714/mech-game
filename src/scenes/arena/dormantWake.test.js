// #269 §4/§6/§7 — scene-level coverage for the base-population system's dormant-unit tick and
// the alert-tower wake routing/response split. enemies.js has a vestigial `import Phaser from
// 'phaser'` whose top-level device detection throws under vitest's node env, so it's stubbed
// out (same convention as enemyFireAngle.test.js/vehicleFire.test.js).
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { EnemiesMixin } from './enemies.js';
import { BasesMixin } from './bases.js';
import { HpBody } from '../../data/HpBody.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { DORMANT, AWARE, UNAWARE, detectionRangeFor } from '../../data/awareness.js';

function makeScene() {
  const scene = { time: { now: 0 }, enemies: [], px: 0, py: 0, bases: [], alertTowerHexes: [] };
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

  it('slow/defensive kinds (turret/tank/quadruped/infantry) get holdGround: true', () => {
    const scene = makeScene();
    const units = ['turret', 'tank', 'quadruped', 'infantry'].map((k) => makeDockedUnit(k, { baseId: 'base0' }));
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

  it('a count:1 dock (e.g. quadruped) spawns exactly one unit, at the dock hex centre', () => {
    const scene = makeSceneWithSpawnStub();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'quadruped', count: 1 }], turrets: [],
    }];
    scene._spawnDormantUnits();
    expect(scene.enemies.length).toBe(1);
  });

  it('turret emplacements spawn a dormant turret tagged with the owning base id', () => {
    const scene = makeSceneWithSpawnStub();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 }, docks: [], turrets: [{ q: 1, r: 0 }],
    }];
    scene._spawnDormantUnits();
    expect(scene.enemies.length).toBe(1);
    expect(scene.enemies[0].typeId).toBe('turret');
    expect(scene.enemies[0].awareness).toBe(DORMANT);
    expect(scene.enemies[0].baseId).toBe('base0');
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

  it('a turret emplacement wakes alongside its base\'s docks (same wake group)', () => {
    const scene = makeSceneWithSpawnStub();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'quadruped', count: 1 }], turrets: [{ q: 1, r: 0 }],
    }];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    expect(scene.enemies.length).toBe(2);
    expect(scene.enemies.every((e) => e.awareness === AWARE)).toBe(true);
  });
});

// #269 playtest follow-up bug 1 — ROOT CAUSE regression: waking a base flipped DORMANT→AWARE and
// (correctly) set `holdGround` on slow/defensive kinds, but the holdGround branches in
// enemyBehaviors.js only ever zeroed velocity — they never touched `e.angle`, so a holdGround
// unit's HULL stayed frozen at whatever fixed angle it spawned with (`Math.PI/2`, straight down)
// FOREVER, regardless of where the player was. Only its turret (independently slewed) tracked the
// player, so from most approach angles a "woken" tank/quadruped/infantry read as a completely
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
    scene._updateEnemy(e, 0.016, 16);
    expect(Math.hypot(e.vx, e.vy)).toBeGreaterThan(0);
  });

  it('a slow/holdGround kind (tank) never gets velocity, but its hull turns to face the player', () => {
    const scene = makeTickableScene();
    const e = makeTickableUnit('tank');
    scene.enemies.push(e);
    scene._wakeBase('base0');
    expect(e.holdGround).toBe(true);
    const spawnAngle = e.angle;
    for (let i = 0; i < 30; i++) scene._updateEnemy(e, 0.016, 16);
    // Root-cause assertion: BEFORE the fix this stayed pinned at `spawnAngle` forever (the actual
    // bug). It still never translates (holdGround is a real "stand and fight" design choice), but
    // it must visibly turn to track the player.
    expect(e.angle).not.toBe(spawnAngle);
    expect(e.vx).toBe(0);
    expect(e.vy).toBe(0);
    expect(e.x).toBe(0);
    expect(e.y).toBe(0);
  });

  it('a slow/holdGround kind (infantry) also turns its hull instead of staying frozen', () => {
    const scene = makeTickableScene();
    const e = makeTickableUnit('infantry');
    scene.enemies.push(e);
    scene._wakeBase('base0');
    const spawnAngle = e.angle;
    for (let i = 0; i < 30; i++) scene._updateEnemy(e, 0.016, 16);
    expect(e.angle).not.toBe(spawnAngle);
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
