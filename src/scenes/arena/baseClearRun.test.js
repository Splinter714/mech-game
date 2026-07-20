// #356: scene-level coverage for the two halves of Jackson's ask —
//   1. the run does not complete while enemies remain alive at the final objective, and
//   2. each base must be cleared of enemies AND docks before the objective moves to the next base.
// Exercised against a minimal fake ArenaScene composed of just the mission + run mixins plus the
// two clear-state helpers from bases.js, in the style of mission.test.js.
import { describe, it, expect } from 'vitest';
import { MissionMixin, isBaseFullyCleared } from './mission.js';
import { RunMixin } from './run.js';
import { BasesMixin } from './bases.js';
import { axialKey } from '../../data/hexgrid.js';
import { CLEAR_STRUCTURES, CLEAR_ENEMIES, CLEAR_DONE } from '../../data/bases.js';

function fakeGraphic() {
  const obj = {
    setStrokeStyle: () => obj, setOrigin: () => obj, setDepth: () => obj,
    setColor: () => obj, setText: () => obj, destroy: () => {},
    clear: () => obj, lineStyle: () => obj, strokePoints: () => obj,
  };
  return obj;
}

function fakeScene(overrides = {}) {
  const store = new Map();
  return Object.assign({
    add: {
      graphics: () => fakeGraphic(), text: () => fakeGraphic(),
      container: (x, y, list) => Object.assign({ x, y, list }, { setDepth() { return this; }, destroy() {}, setVisible() { return this; }, setPosition(x, y) { this.x = x; this.y = y; return this; } }),
    },
    tweens: { add: () => {}, killTweensOf: () => {} },
    time: { delayedCall: () => ({}) },
    registry: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
    bases: [], enemies: [],
    // #347: the run's loss check reads the players collection; one live player keeps it alive.
    players: [{ mech: { isDestroyed: () => false } }],
    // The run mixin's death check and garage exit — stubbed so `_updateRun` can run headless.
    toGarage: () => {},
  },
  {
    _allBasesFullyCleared: BasesMixin._allBasesFullyCleared,
    _allObjectivesDestroyed: BasesMixin._allObjectivesDestroyed,
  },
  MissionMixin, RunMixin, overrides);
}

// Two bases, each with a real objective hex and two dock hexes, all standing.
function twoBaseWorld() {
  const bases = [
    { id: 'base0', center: { q: 0, r: 0 }, objectiveHex: { q: 1, r: 0 }, docks: [{ q: 2, r: 0 }, { q: 3, r: 0 }] },
    { id: 'base1', center: { q: 10, r: 0 }, objectiveHex: { q: 11, r: 0 }, docks: [{ q: 12, r: 0 }] },
  ];
  const buildingHp = new Map();
  for (const b of bases) {
    buildingHp.set(axialKey(b.objectiveHex.q, b.objectiveHex.r), 100);
    for (const d of b.docks) buildingHp.set(axialKey(d.q, d.r), 100);
  }
  return { bases, buildingHp };
}

const raze = (scene, hex) => scene.buildingHp.delete(axialKey(hex.q, hex.r));

describe('#384 a base must be cleared of ALL structures AND enemies before the objective advances', () => {
  it('holds the objective on base 0 until its structures and garrison are both gone', () => {
    const { bases, buildingHp } = twoBaseWorld();
    const scene = fakeScene({ bases, buildingHp, enemies: [{ baseId: 'base0' }, { baseId: 'base1' }] });
    scene._initMission();
    scene._initRun();
    const step = () => { scene._updateMission(); scene._updateRun(); };

    step();
    expect(scene._objectiveBaseIndex).toBe(0);

    // Objective hex down — under the OLD (#356) rule this advanced to the docks step; under #384
    // it is still the ONE structures phase, because docks remain.
    raze(scene, bases[0].objectiveHex);
    step();
    expect(scene.registry.get('baseClear').step).toBe(CLEAR_STRUCTURES);
    expect(scene.registry.get('baseClear').objectiveStanding).toBe(false);
    expect(scene._objectiveBaseIndex).toBe(0);

    // One of two docks down: still structures.
    raze(scene, bases[0].docks[0]);
    step();
    expect(scene.registry.get('baseClear').step).toBe(CLEAR_STRUCTURES);
    expect(scene.registry.get('baseClear').docksLeft).toBe(1);
    expect(scene._objectiveBaseIndex).toBe(0);

    // Last dock down — every structure is gone, so ONLY NOW does the garrison become the ask.
    raze(scene, bases[0].docks[1]);
    step();
    expect(scene.registry.get('baseClear').step).toBe(CLEAR_ENEMIES);
    expect(scene._objectiveBaseIndex).toBe(0);

    // Kill base 0's last defender: cleared, objective moves to base 1.
    scene.enemies = scene.enemies.filter((e) => e.baseId !== 'base0');
    step();
    expect(scene._objectiveBaseIndex).toBe(1);
    expect(scene._objectiveBase.id).toBe('base1');
    expect(scene.run.status).toBe('active');
  });

  it('accepts the structures in ANY order — docks first, objective last, still one phase', () => {
    const { bases, buildingHp } = twoBaseWorld();
    const scene = fakeScene({ bases, buildingHp, enemies: [{ baseId: 'base0' }, { baseId: 'base1' }] });
    scene._initMission();
    scene._initRun();
    const step = () => { scene._updateMission(); scene._updateRun(); };

    // Both docks razed BEFORE the objective — the old ordered rule never allowed this.
    raze(scene, bases[0].docks[0]);
    raze(scene, bases[0].docks[1]);
    step();
    expect(scene.registry.get('baseClear').step).toBe(CLEAR_STRUCTURES);   // objective still up
    expect(scene.registry.get('baseClear').docksLeft).toBe(0);
    expect(scene.registry.get('baseClear').objectiveStanding).toBe(true);
    expect(scene._objectiveBaseIndex).toBe(0);

    // Objective last — structures done, garrison now.
    raze(scene, bases[0].objectiveHex);
    step();
    expect(scene.registry.get('baseClear').step).toBe(CLEAR_ENEMIES);
  });
});

describe('#356 the run does not complete while enemies live at the final objective', () => {
  it('stays active after the last objective hex falls, and wins only on the full clear', () => {
    const { bases, buildingHp } = twoBaseWorld();
    const scene = fakeScene({ bases, buildingHp, enemies: [{ baseId: 'base1' }] });
    scene._initMission();
    scene._initRun();
    const step = () => { scene._updateMission(); scene._updateRun(); };

    // Base 0 fully cleared (no enemies tagged to it from the start).
    raze(scene, bases[0].objectiveHex);
    for (const d of bases[0].docks) raze(scene, d);
    step();
    expect(scene._objectiveBase.id).toBe('base1');

    // Every objective hex in the world is now rubble — the OLD win condition.
    raze(scene, bases[1].objectiveHex);
    step();
    expect(scene._allObjectivesDestroyed()).toBe(true);   // old rule would have won here
    expect(scene.run.status).toBe('active');              // #356: not any more

    raze(scene, bases[1].docks[0]);
    step();
    expect(scene.registry.get('baseClear').step).toBe(CLEAR_ENEMIES);
    expect(scene.run.status).toBe('active');

    scene.enemies = [];
    step();
    expect(scene.run.status).toBe('won');
  });
});

describe('#384 keeps the #355 gate latch keyed on the OBJECTIVE alone — the split must not merge', () => {
  // The gate latch (`_failedOpenBases` -> `isBaseObjectiveDestroyed`) and the phase-1-complete
  // predicate (`isBaseFullyCleared` -> also needs the docks) are DIFFERENT predicates. #384's whole
  // subtlety: killing the objective opens the gates even mid-phase-1; killing a dock does not.
  it('objective dead, docks ALIVE -> gates open, base NOT yet cleared', () => {
    const { bases, buildingHp } = twoBaseWorld();
    const scene = fakeScene({ bases, buildingHp, enemies: [] });
    raze(scene, bases[0].objectiveHex);   // docks[0] and docks[1] still standing
    // #355's gate rule sees the base as beaten (gates fail open) …
    const failedOpen = BasesMixin._failedOpenBases.call(scene);
    expect(failedOpen.has('base0')).toBe(true);
    // … while #384's progression rule still has work left (the docks), which is the intended
    // composition: the player can drive in and out freely while sweeping them.
    expect(isBaseFullyCleared(bases[0], scene.buildingHp, scene.enemies)).toBe(false);
  });

  it('dock dead, objective ALIVE -> gates do NOT open (killing a dock does not latch them)', () => {
    const { bases, buildingHp } = twoBaseWorld();
    const scene = fakeScene({ bases, buildingHp, enemies: [] });
    raze(scene, bases[0].docks[0]);       // objective still standing
    raze(scene, bases[0].docks[1]);       // both docks gone, objective alive
    // The gate latch keys on the objective ALONE, so razing every dock leaves the gates shut …
    const failedOpen = BasesMixin._failedOpenBases.call(scene);
    expect(failedOpen.has('base0')).toBe(false);
    // … and the base is of course not cleared either (objective still up).
    expect(isBaseFullyCleared(bases[0], scene.buildingHp, scene.enemies)).toBe(false);
  });

  it('a base with no objective hex at all falls back to the enemy-count rule and can still clear', () => {
    const bases = [{ id: 'base0', center: { q: 0, r: 0 }, objectiveHex: null, docks: [] }];
    const scene = fakeScene({ bases, buildingHp: new Map(), enemies: [{ baseId: 'base0' }] });
    expect(isBaseFullyCleared(bases[0], scene.buildingHp, scene.enemies)).toBe(false);
    scene.enemies = [];
    expect(isBaseFullyCleared(bases[0], scene.buildingHp, scene.enemies)).toBe(true);
    expect(BasesMixin._allBasesFullyCleared.call(scene)).toBe(true);
  });
});

describe('#356 clear-state bookkeeping', () => {
  it('clears the published step once no base is left to target', () => {
    const { bases, buildingHp } = twoBaseWorld();
    const scene = fakeScene({ bases, buildingHp, enemies: [] });
    scene._initMission();
    scene._objectiveBaseIndex = 5;
    scene._targetCurrentBase();
    expect(scene.registry.get('baseClear')).toBe(null);
    expect(scene.mission).toBe(null);
  });

  it('reports DONE for a base whose objective, docks and garrison are all gone', () => {
    const { bases, buildingHp } = twoBaseWorld();
    const scene = fakeScene({ bases, buildingHp, enemies: [] });
    scene._initMission();
    raze(scene, bases[0].objectiveHex);
    for (const d of bases[0].docks) raze(scene, d);
    scene._updateMission();
    expect(scene.registry.get('baseClear').step).toBe(CLEAR_DONE);
  });
});
