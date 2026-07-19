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
import {
  DOCK_RESUPPLY_COOLDOWN_MS, DOCK_RESUPPLY_MAX_PER_DOCK,
  DOCK_RESUPPLY_COOLDOWN_JITTER, DOCK_RESUPPLY_PHASE_MIN,
} from '../../data/dockResupply.js';

// #311 made each dock's interval and starting phase per-dock random, so these scene tests can no
// longer step by exactly "the cooldown ± 1s" and expect a deterministic answer. They step by
// bounds instead, derived from the jitter constants so they stay correct if those are re-tuned:
//   - PAST_COOLDOWN_S   — longer than the LONGEST interval any dock can roll, so a dock that is
//                         eligible at all is guaranteed to have fired.
//   - BEFORE_COOLDOWN_S — shorter than the SHORTEST first cycle any dock can roll (the low end
//                         of the interval band times the low end of the phase band), so no dock
//                         can possibly have fired yet.
const PAST_COOLDOWN_S = (DOCK_RESUPPLY_COOLDOWN_MS * (1 + DOCK_RESUPPLY_COOLDOWN_JITTER)) / 1000 + 1;
const BEFORE_COOLDOWN_S =
  (DOCK_RESUPPLY_COOLDOWN_MS * (1 - DOCK_RESUPPLY_COOLDOWN_JITTER) * DOCK_RESUPPLY_PHASE_MIN) / 1000 - 1;

// A minimal Phaser-shaped stand-in: `add.rectangle`/`add.circle` return a chainable fake game
// object (setDepth returns itself, destroy is a no-op spy); `tweens.add` and `time.delayedCall`
// just record what was scheduled rather than actually animating, so a test can assert the
// sequence fired without needing a real clock.
function fakeGameObject() {
  const obj = { destroyed: false };
  obj.setDepth = () => obj;
  // #269 Part 2: `_closeDockFx` (bases.js) also chains `setScale`/`setStrokeStyle`/`setRadius`
  // on an `add.circle(...)` result — same "chainable no-op fake" shape as `setDepth` above.
  obj.setScale = () => obj;
  obj.setStrokeStyle = () => obj;
  obj.setRadius = () => obj;
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
    // #311: docks now roll a jittered cooldown + starting phase off the run's world seed
    // (`_buildWorld`, world.js). This stub never builds a world, so pin a seed here — otherwise
    // every dock in these tests would draw fresh randomness on each run and the timing
    // assertions below would be flaky.
    _worldSeed: 424242,
    // #269 Part 2: `_resupplyDock`/`_updateDockOpenClose` read/write these world-state maps
    // (normally seeded by `_buildWorld`, world.js). Empty is fine for this file's coverage —
    // `this.terrain.get(dockKey)` reads as undefined (never `'dockClosed'`), so the reopen check
    // in `_resupplyDock` is a harmless no-op here, exactly like a dock that never actually
    // closed (see that method's own comment).
    terrain: new Map(), tileImages: new Map(), buildingHp: new Map(),
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
    scene._updateDockResupply(PAST_COOLDOWN_S);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(0);
    expect(scene._dockResupplyStates.get(dockKey).count).toBe(0);
  });

  it('does NOT resupply while the dock still has a live unit, even on an awake base, even once the cooldown has fully elapsed', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ count: 1 })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');   // base is awake, but the dormant unit is still alive

    scene._updateDockResupply(PAST_COOLDOWN_S);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(1);   // still just the original unit, no resupply
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    expect(scene._dockResupplyStates.get(dockKey).count).toBe(0);   // never spent
  });
});

// #269 playtest follow-up: "cooldown timer should start ticking as soon as the dock's unit is
// spawned, not wait for the dock to actually become vacated/close" — the countdown's PROGRESS is
// decoupled from `cleared`; only actually FIRING a resupply still requires the dock to be clear.
describe('#269 playtest follow-up: resupply cooldown progress is decoupled from cleared', () => {
  it('the cooldown ticks down while the base is awake even though the original unit is still alive', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ count: 1 })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');   // awake, original unit still alive/occupying the dock
    const dockKey = [...scene._dockResupplyMeta.keys()][0];

    scene._updateDockResupply(DOCK_RESUPPLY_COOLDOWN_MS / 1000 / 2);   // halfway through cooldown
    scene._runScheduled();

    expect(scene.enemies.length).toBe(1);   // still just the original unit
    const state = scene._dockResupplyStates.get(dockKey);
    expect(state.remainingMs).toBeLessThan(DOCK_RESUPPLY_COOLDOWN_MS);
    expect(state.remainingMs).toBeGreaterThan(0);
  });

  it('once the cooldown elapses while still occupied, resupply fires immediately (no extra wait) the instant the unit dies/leaves — does not restart a fresh cooldown', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ count: 1 })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];

    // Cooldown fully elapses while the original unit is still alive — must not fire yet.
    scene._updateDockResupply(PAST_COOLDOWN_S);
    scene._runScheduled();
    expect(scene.enemies.length).toBe(1);
    expect(scene._dockResupplyStates.get(dockKey).count).toBe(0);

    // The original unit now dies/leaves. A single, tiny subsequent tick (well short of another
    // full cooldown) should fire right away, proving progress wasn't reset while occupied.
    clearDock(scene, dockKey);
    scene._updateDockResupply(0.016);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(1);   // the resupplied unit
    expect(scene._dockResupplyStates.get(dockKey).count).toBe(1);
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

    scene._updateDockResupply(BEFORE_COOLDOWN_S);
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

    scene._updateDockResupply(PAST_COOLDOWN_S);
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

    scene._updateDockResupply(PAST_COOLDOWN_S);
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

    scene._updateDockResupply(PAST_COOLDOWN_S);
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
  it('a dock resupplies at most DOCK_RESUPPLY_MAX_PER_DOCK times over its lifetime, never more', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'tank' })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];

    // Drain the cap: clear the dock and wait past cooldown, `DOCK_RESUPPLY_MAX_PER_DOCK` times —
    // each one should produce exactly one fresh unit.
    for (let i = 0; i < DOCK_RESUPPLY_MAX_PER_DOCK; i++) {
      clearDock(scene, dockKey);
      scene._updateDockResupply(PAST_COOLDOWN_S);
      scene._runScheduled();
      expect(scene.enemies.length).toBe(1);
    }

    // Clear it once more and wait well past another full cooldown — the cap is spent, must NOT
    // resupply again.
    clearDock(scene, dockKey);
    scene._updateDockResupply(PAST_COOLDOWN_S);
    scene._runScheduled();
    expect(scene.enemies.length).toBe(0);
  });
});

// #269 Part 2 ("dock open/closed states") — the open ⇄ closed ⇄ reopened-for-resupply state
// machine layered on top of the resupply mechanic above. `_updateDockOpenClose` only acts on a
// hex whose CURRENT terrain is exactly `'dock'` (open) — these tests seed that explicitly since
// the lightweight scene stub above doesn't run the real `_buildWorld` terrain generator.
import { TERRAIN, isPassable, blocksLOS } from '../../data/terrain.js';

describe('#269 Part 2: dock open/closed states', () => {
  it('a dormant, still-occupied dock never closes (its cluster sits well within the vacate radius)', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'tank' })];
    scene._spawnDormantUnits();
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    scene.terrain.set(dockKey, 'dock');

    scene._updateDockOpenClose();

    expect(scene.terrain.get(dockKey)).toBe('dock');
    expect(scene.buildingHp.has(dockKey)).toBe(false);
  });

  it('closes the moment its unit(s) vacate the hex — terrain swaps to dockClosed and seeds buildingHp', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'tank' })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    scene.terrain.set(dockKey, 'dock');
    // The unit walked far off (fighting elsewhere) rather than dying — still counts as vacated.
    scene.enemies[0].x += 500;

    scene._updateDockOpenClose();

    expect(scene.terrain.get(dockKey)).toBe('dockClosed');
    expect(scene.buildingHp.get(dockKey)).toBe(TERRAIN.dockClosed.hp);
    // #286: a sealed dock stays passable-but-slow, not a full blockade — only blocksLOS.
    expect(isPassable('dockClosed')).toBe(true);
    expect(blocksLOS('dockClosed')).toBe(true);
  });

  it('closes just as readily when the dock\'s unit(s) died instead of walking away', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'tank' })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    scene.terrain.set(dockKey, 'dock');
    clearDock(scene, dockKey);   // dead + pruned, same as the real #87 convention

    scene._updateDockOpenClose();

    expect(scene.terrain.get(dockKey)).toBe('dockClosed');
    expect(scene.buildingHp.has(dockKey)).toBe(true);
  });

  it('reopens (closed → open) the moment resupply fires, and drops the hex back out of buildingHp', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'tank' })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    scene.terrain.set(dockKey, 'dock');
    clearDock(scene, dockKey);
    scene._updateDockOpenClose();
    expect(scene.terrain.get(dockKey)).toBe('dockClosed');   // sanity: actually closed first

    scene._updateDockResupply(PAST_COOLDOWN_S);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(1);   // the resupplied unit spawned
    expect(scene.terrain.get(dockKey)).toBe('dock');   // dome reopened
    expect(scene.buildingHp.has(dockKey)).toBe(false);
  });

  it('destroying a closed dock (_onTerrainCollapsed) permanently disables its resupply, even before it used its one shot', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'tank' })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    scene.terrain.set(dockKey, 'dock');
    clearDock(scene, dockKey);
    scene._updateDockOpenClose();
    expect(scene.terrain.get(dockKey)).toBe('dockClosed');

    // The closed dome gets destroyed (world.js `_damageBuildingAt` would call this hook the
    // instant it collapses to rubble — simulated directly here since this file's scene stub
    // doesn't wire the full generic-terrain-damage mixin).
    scene._onTerrainCollapsed(dockKey);

    // Tick well past the cooldown — must NEVER resupply now, even though eligibility (awake +
    // cleared) genuinely holds.
    scene._updateDockResupply(PAST_COOLDOWN_S);
    scene._runScheduled();

    expect(scene.enemies.length).toBe(0);
    expect(scene._dockResupplyStates.get(dockKey).count).toBeGreaterThanOrEqual(1);
  });

  it('_onTerrainCollapsed is a no-op for a hex this scene has no dock-resupply state for', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'tank' })];
    scene._spawnDormantUnits();
    // Some unrelated destructible hex (an ordinary outpost) collapsing must not throw or touch
    // dock bookkeeping at all.
    expect(() => scene._onTerrainCollapsed('99,99')).not.toThrow();
  });

  it('full cycle stays bookkeeping-consistent: open → closed → reopened → closed again', () => {
    const scene = makeScene();
    scene.bases = [oneDockBase({ kindId: 'tank' })];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    const dockKey = [...scene._dockResupplyMeta.keys()][0];
    scene.terrain.set(dockKey, 'dock');

    // 1) Vacate → closes.
    clearDock(scene, dockKey);
    scene._updateDockOpenClose();
    expect(scene.terrain.get(dockKey)).toBe('dockClosed');
    expect(scene.buildingHp.has(dockKey)).toBe(true);

    // 2) Resupply fires → reopens, spawns a fresh unit sitting right at the dock.
    scene._updateDockResupply(PAST_COOLDOWN_S);
    scene._runScheduled();
    expect(scene.terrain.get(dockKey)).toBe('dock');
    expect(scene.buildingHp.has(dockKey)).toBe(false);
    expect(scene.enemies.length).toBe(1);

    // 3) That fresh unit walks off / dies too → closes again. The OPEN/CLOSED visual cycle has
    // no cap of its own — it just tracks physical occupancy — independent of
    // `DOCK_RESUPPLY_MAX_PER_DOCK`, which only limits how many more times resupply can refill it.
    clearDock(scene, dockKey);
    scene._updateDockOpenClose();
    expect(scene.terrain.get(dockKey)).toBe('dockClosed');
    expect(scene.buildingHp.get(dockKey)).toBe(TERRAIN.dockClosed.hp);
  });
});

// #311 at the scene level: the reported symptom was a whole BASE's docks resupplying as one
// synchronized pulse, so the thing worth pinning here is that `_spawnDormantUnits` hands every
// dock in a run its own roll — and that the rolls are reproducible for a given world seed.
describe('#311: a base\'s docks are staggered, not synchronized', () => {
  function multiDockBase() {
    return {
      id: 'base0',
      center: { q: 0, r: 0 },
      docks: [
        { q: 0, r: 0, kindId: 'tank', count: 1 },
        { q: 1, r: 0, kindId: 'tank', count: 1 },
        { q: 2, r: 0, kindId: 'tank', count: 1 },
        { q: 3, r: 0, kindId: 'tank', count: 1 },
      ],
      turrets: [],
    };
  }

  it('gives each dock of one base a distinct cooldown AND a distinct starting phase', () => {
    const scene = makeScene();
    scene.bases = [multiDockBase()];
    scene._spawnDormantUnits();

    const states = [...scene._dockResupplyStates.values()];
    expect(states.length).toBe(4);
    expect(new Set(states.map((s) => s.cooldownMs)).size).toBe(4);
    expect(new Set(states.map((s) => s.remainingMs)).size).toBe(4);
    for (const s of states) {
      expect(s.cooldownMs).toBeGreaterThanOrEqual(DOCK_RESUPPLY_COOLDOWN_MS * (1 - DOCK_RESUPPLY_COOLDOWN_JITTER));
      expect(s.cooldownMs).toBeLessThanOrEqual(DOCK_RESUPPLY_COOLDOWN_MS * (1 + DOCK_RESUPPLY_COOLDOWN_JITTER));
      expect(s.remainingMs).toBeGreaterThanOrEqual(s.cooldownMs * DOCK_RESUPPLY_PHASE_MIN);
      expect(s.remainingMs).toBeLessThanOrEqual(s.cooldownMs);
    }
  });

  it('is deterministic for a given world seed (a seeded run reproduces the same staggering)', () => {
    const build = (seed) => {
      const scene = makeScene();
      scene._worldSeed = seed;
      scene.bases = [multiDockBase()];
      scene._spawnDormantUnits();
      return [...scene._dockResupplyStates.values()].map((s) => [s.cooldownMs, s.remainingMs]);
    };
    expect(build(777)).toEqual(build(777));
    expect(build(777)).not.toEqual(build(778));
  });

  it('those docks do not all fire their first resupply on the same tick', () => {
    const scene = makeScene();
    scene.bases = [multiDockBase()];
    scene._spawnDormantUnits();
    scene._wakeBase('base0');
    for (const dockKey of scene._dockResupplyMeta.keys()) clearDock(scene, dockKey);

    // Step in small slices and record, per dock, the tick its count first went from 0 to 1.
    const firstFire = new Map();
    for (let t = 0; t < 3000; t++) {
      scene._updateDockResupply(0.016);
      scene._runScheduled();
      for (const [dockKey, s] of scene._dockResupplyStates) {
        if (s.count >= 1 && !firstFire.has(dockKey)) firstFire.set(dockKey, t);
      }
      // Keep every dock permanently clear so `cleared` is never the limiting factor.
      for (const dockKey of scene._dockResupplyMeta.keys()) clearDock(scene, dockKey);
    }
    expect(firstFire.size).toBe(4);
    expect(new Set(firstFire.values()).size).toBe(4);
  });
});
