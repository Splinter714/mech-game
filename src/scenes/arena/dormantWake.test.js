// #269 §4/§6/§7 — scene-level coverage for the base-population system's dormant-unit tick and
// the alert-tower wake routing/response split. enemies.js has a vestigial `import Phaser from
// 'phaser'` whose top-level device detection throws under vitest's node env, so it's stubbed
// out (same convention as enemyFireAngle.test.js/vehicleFire.test.js).
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));

import { EnemiesMixin } from './enemies.js';
import { BasesMixin } from './bases.js';
import { HpBody } from '../../data/HpBody.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { DORMANT, AWARE, UNAWARE } from '../../data/awareness.js';
import { hexToPixel } from '../../data/hexgrid.js';

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
    return scene;
  }

  it('spawns one patrol unit per alert tower, starting UNAWARE with no baseId/dockKey', () => {
    const scene = makeSceneWithSpawnStub([{ q: 0, r: 0 }, { q: 4, r: -2 }]);
    scene._spawnTowerPatrols();
    expect(scene.enemies.length).toBe(2);
    for (const e of scene.enemies) {
      expect(e.awareness).toBe(UNAWARE);
      expect(e.baseId).toBeUndefined();
      expect(e.dockKey).toBeUndefined();
    }
  });

  it('no alert towers means no patrol units spawned', () => {
    const scene = makeSceneWithSpawnStub([]);
    scene._spawnTowerPatrols();
    expect(scene.enemies.length).toBe(0);
  });

  it('a patrol unit\'s spawnX/spawnY (idle-wander anchor) sit near the tower position, not just at the origin', () => {
    const scene = makeSceneWithSpawnStub([{ q: 6, r: 3 }]);
    scene._spawnTowerPatrols();
    expect(scene.enemies.length).toBe(1);
    const e = scene.enemies[0];
    const { x: tx, y: ty } = hexToPixel(6, 3);
    // Empty terrain forces nearestValidPixel's ring-search fallback — the exact landing hex
    // isn't asserted (that's nearestValidPixel's own unit-tested behavior, spawnPlacement.test.js
    // if present, or covered by hexgrid's nearestHex tests), just that it's a real finite point
    // reasonably close to the tower, not left at (0,0)/NaN.
    expect(Number.isFinite(e.spawnX)).toBe(true);
    expect(Number.isFinite(e.spawnY)).toBe(true);
    expect(Math.hypot(e.spawnX - tx, e.spawnY - ty)).toBeLessThan(4000);
  });

  it('_allBasesCleared ignores patrol units entirely — a base can be "cleared" while its nearby patrol is still alive, and vice versa', () => {
    const scene = makeSceneWithSpawnStub([{ q: 0, r: 0 }]);
    scene.bases = [{ id: 'base0', center: { q: 0, r: 0 }, docks: [], turrets: [] }];
    scene._spawnTowerPatrols();
    // No base-origin (baseId-tagged) enemy exists — cleared is true even though the patrol unit
    // spawned near the tower is alive and sitting in `this.enemies`.
    expect(scene.enemies.length).toBe(1);
    expect(scene._allBasesCleared()).toBe(true);

    // Conversely: a base-origin enemy alive with the patrol also alive still reads as NOT
    // cleared — the patrol's presence/absence has zero bearing on the win condition either way.
    scene.enemies.push(makeDockedUnit('turret', { baseId: 'base0' }));
    expect(scene._allBasesCleared()).toBe(false);
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
