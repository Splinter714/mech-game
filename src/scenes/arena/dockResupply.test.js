// #269 §3 "rare multi-spawn exception" (playtest follow-up) — scene-level coverage for the
// dock-resupply mechanic (`_updateDockResupply`/`_resupplyDock`, scenes/arena/bases.js). Mirrors
// dormantWake.test.js's hand-rolled scene harness: a plain object with the mixins assigned, a
// stubbed `_spawnKind` (real texture/view building is out of scope here), and a minimal
// Phaser-shaped `tweens`/`time`/`add` stand-in since `_resupplyDock` drives real tween/timer
// calls. Tweens/delayed-calls are captured and can be driven synchronously in tests rather than
// relying on a real Phaser clock.
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({ default: {} }));

import { EnemiesMixin } from './enemies.js';
import { BasesMixin } from './bases.js';
import { HpBody } from '../../data/HpBody.js';
import { Mech } from '../../data/Mech.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { ENEMIES } from '../../data/enemies.js';
import { DORMANT, AWARE } from '../../data/awareness.js';
import { DOCK_RESUPPLY_COOLDOWN_MS } from '../../data/dockResupply.js';

// A minimal Phaser-shaped stand-in: `add.rectangle`/`add.circle` return a chainable fake game
// object (setDepth returns itself, destroy is a no-op spy); `tweens.add` and `time.delayedCall`
// just record what was scheduled rather than actually animating, so a test can assert the
// sequence fired without needing a real clock.
function fakeGameObject() {
  const obj = { destroyed: false };
  obj.setDepth = () => obj;
  obj.destroy = () => { obj.destroyed = true; };
  return obj;
}

function makeScene() {
  const scheduled = [];
  const scene = {
    time: { now: 0, delayedCall: (ms, fn) => { scheduled.push({ ms, fn }); } },
    tweens: { add: (cfg) => { if (cfg.onComplete) cfg.onComplete(); return {}; } },
    add: {
      rectangle: () => fakeGameObject(),
      circle: () => fakeGameObject(),
    },
    enemies: [], px: 0, py: 0, bases: [], alertTowerHexes: [],
  };
  Object.assign(scene, EnemiesMixin, BasesMixin);
  scene._spawnKind = (x, y, kindId) => {
    const def = ENEMY_KINDS[kindId];
    const e = {
      key: `${kindId}Test`, mech: new HpBody(def), kind: def.kind, kindDef: def,
      x, y, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0, typeId: kindId,
    };
    scene.enemies.push(e);
    return e;
  };
  // #269 playtest follow-up ("fold mechs into the dock system"): a mech-kind dock's resupply
  // dispatches to `_spawnMech`, not `_spawnKind` — see scenes/arena/bases.js `_resupplyDock`.
  scene._spawnMech = (x, y, typeId) => {
    const def = ENEMIES[typeId];
    const mech = new Mech(def);
    mech.repairAll();
    const e = {
      key: `${typeId}Test`, mech, kind: 'mech', x, y, vx: 0, vy: 0,
      angle: 0, turret: 0, fireCd: {}, typeId,
    };
    scene.enemies.push(e);
    return e;
  };
  scene._initAlertTowers();
  scene._runScheduled = () => { while (scheduled.length) scheduled.shift().fn(); };
  return scene;
}

function oneDockBase({ kindId = 'tank', count = 1 } = {}) {
  return { id: 'base0', center: { q: 0, r: 0 }, docks: [{ q: 0, r: 0, kindId, count }], turrets: [] };
}

// Removes every enemy tagged with a given dockKey — stands in for "the player killed them all"
// (matches #87's real "dead enemies are pruned from `this.enemies` immediately" invariant, also
// relied on by `_allBasesCleared`/dormantWake.test.js above).
function clearDock(scene, dockKey) {
  scene.enemies = scene.enemies.filter((e) => e.dockKey !== dockKey);
}

describe('#269 §3 dock resupply: trigger gating', () => {
  it('does NOT resupply a cleared dock whose base was never woken (still fully dormant)', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase()];
    scene._spawnDormantUnits();
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    clearDock(scene, dockKey);   // dock cleared, but base never woken

    // Tick well past the cooldown — should never become eligible without a wake.
    scene._updateDockResupply(DOCK_RESUPPLY_COOLDOWN_MS / 1000 + 5);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(0);
    expect(scene._dockResupplyStates.get(dockKey).count).toBe(0);
  });

  it('does NOT resupply while the dock still has a live unit, even on an awake base', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ count: 1 })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');   // base is awake, but the dormant unit is still alive

    scene._updateDockResupply(DOCK_RESUPPLY_COOLDOWN_MS / 1000 + 5);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(1);   // still just the original unit, no resupply
  });
});

describe('#269 §3 dock resupply: cooldown + spawn', () => {
  it('does not trigger before the cooldown elapses, even once eligible', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase()];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    clearDock(scene, dockKey);

    scene._updateDockResupply(DOCK_RESUPPLY_COOLDOWN_MS / 1000 - 1);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(0);
  });

  it('triggers a resupply once eligible AND the cooldown has elapsed', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'tank' })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    clearDock(scene, dockKey);

    scene._updateDockResupply(DOCK_RESUPPLY_COOLDOWN_MS / 1000 + 1);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(1);
    expect(scene.enemies[0].typeId).toBe('tank');
  });

  it('the resupplied unit is spawned DIRECTLY ACTIVE (AWARE), not dormant', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'helicopter' })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    clearDock(scene, dockKey);

    scene._updateDockResupply(DOCK_RESUPPLY_COOLDOWN_MS / 1000 + 1);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(1);
    expect(scene.enemies[0].awareness).toBe(AWARE);
    expect(scene.enemies[0].awareness).not.toBe(DORMANT);
    expect(scene.enemies[0].baseId).toBe('base0');
    expect(scene.enemies[0].dockKey).toBe(dockKey);
  });
});

describe('#269 playtest follow-up: dock resupply for a mech-kind dock', () => {
  it('a mech-kind dock (e.g. sniper) resupplies via _spawnMech, spawned directly AWARE', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'sniper' })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    clearDock(scene, dockKey);

    scene._updateDockResupply(DOCK_RESUPPLY_COOLDOWN_MS / 1000 + 1);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(1);
    const e = scene.enemies[0];
    expect(e.kind).toBe('mech');
    expect(e.typeId).toBe('sniper');
    expect(e.awareness).toBe(AWARE);
    expect(e.baseId).toBe('base0');
    expect(e.dockKey).toBe(dockKey);
  });
});

describe('#269 §3 dock resupply: per-dock cap', () => {
  it('a dock resupplies at most once over its lifetime (DOCK_RESUPPLY_MAX_PER_DOCK)', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'tank' })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    clearDock(scene, dockKey);

    // First resupply.
    scene._updateDockResupply(DOCK_RESUPPLY_COOLDOWN_MS / 1000 + 1);
    scene._runScheduled();
    expect(scene.enemies.length).toBe(1);

    // Clear it again and wait well past another full cooldown — must NOT resupply a second time.
    clearDock(scene, dockKey);
    scene._updateDockResupply(DOCK_RESUPPLY_COOLDOWN_MS / 1000 + 5);
    scene._runScheduled();
    expect(scene.enemies.length).toBe(0);
  });
});
