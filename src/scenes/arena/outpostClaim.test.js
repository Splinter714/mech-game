// #511/#512/#517: clearing a base now presents a CHOICE (run.js `_presentBaseCaptureChoice`,
// called from `_advanceObjective`) — establish it as an outpost, or leave it uncaptured and move
// on. Accepting (`_onInteractPressed`/`_resolveBaseCaptureChoice(true)`) runs the same claim-and-
// persist pipeline #511/#512 built (`_establishBase`); declining/timing out
// (`_resolveBaseCaptureChoice(false)`) still advances the mission but claims nothing. Same minimal
// fake-scene style as mission.test.js/baseClearRun.test.js — a plain `this`-based mixin bag, no
// real Phaser.
import { describe, it, expect } from 'vitest';
import { MissionMixin } from './mission.js';
import { RunMixin } from './run.js';
import { makeRun } from '../../data/run.js';
import { OUTPOSTS_KEY, REGIONAL_BASES_KEY } from '../../data/events.js';

function fakeGraphic() {
  const obj = {
    setStrokeStyle: () => obj, setOrigin: () => obj, setDepth: () => obj,
    setColor: () => obj, setText: () => obj, destroy: () => {},
    clear: () => obj, lineStyle: () => obj, strokePoints: () => obj,
    fillStyle: () => obj, fillPoints: () => obj,
  };
  return obj;
}

function fakeScene(overrides = {}) {
  const registryStore = new Map();
  const scene = Object.assign({
    add: {
      circle: () => fakeGraphic(), polygon: () => fakeGraphic(),
      graphics: () => fakeGraphic(), text: () => fakeGraphic(),
      container: (x, y, list) => Object.assign({ x, y, list, visible: true }, {
        setDepth() { return this; }, destroy() {}, setVisible(v) { this.visible = v; return this; }, setPosition(x, y) { this.x = x; this.y = y; return this; },
      }),
    },
    tweens: { add: () => ({}), killTweensOf: () => {} },
    // Fires nothing on its own — tests resolve the choice directly via `_resolveBaseCaptureChoice`/
    // `_onInteractPressed` rather than actually waiting out the real timer.
    time: { delayedCall: () => ({ remove: () => {} }) },
    registry: { get: (k) => registryStore.get(k), set: (k, v) => registryStore.set(k, v) },
    // `_advanceObjective`/`_finishObjectiveAdvance` feed the pure Run model — a real scene sets
    // this up via `_initRun()` (ArenaScene.create()); these tests only exercise MissionMixin +
    // RunMixin, so it's seeded directly, same shape `makeRun()` produces.
    run: makeRun(),
    bases: [], enemies: [], biomeId: 'grassland',
  }, MissionMixin, RunMixin, overrides);
  return scene;
}

function makeBase(id, q, r) {
  return { id, center: { q, r }, docks: [], turrets: [], captured: false };
}

describe('#517 post-clear base-capture choice', () => {
  it('advancing the objective presents a choice instead of auto-claiming', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 20, 0)];
    const scene = fakeScene({ bases, enemies: [] });
    scene._initMission();
    expect(scene._objectiveBaseIndex).toBe(0);

    scene._advanceObjective();

    expect(scene.registry.get('baseCaptureChoice')).toMatchObject({ baseId: 'base0' });
    expect(scene.registry.get(OUTPOSTS_KEY)).toBeUndefined();   // nothing claimed yet
    expect(scene._objectiveBaseIndex).toBe(0);                  // mission hasn't advanced yet either
  });

  it('accepting the choice (interact press) claims the base and advances the mission', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 20, 0)];
    const scene = fakeScene({ bases, enemies: [] });
    scene._initMission();
    scene._advanceObjective();

    scene._onInteractPressed();

    const outposts = scene.registry.get(OUTPOSTS_KEY);
    expect(outposts).toHaveLength(1);
    expect(outposts[0]).toMatchObject({
      type: 'resource', coord: { q: 0, r: 0 }, biomeId: 'grassland', baseId: 'base0', upgradeLevel: 0,
    });
    expect(scene.registry.get('baseCaptureChoice')).toBeNull();
    expect(scene._objectiveBaseIndex).toBe(1);
  });

  it('declining the choice moves the mission on without claiming anything', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 20, 0)];
    const scene = fakeScene({ bases, enemies: [] });
    scene._initMission();
    scene._advanceObjective();

    scene._resolveBaseCaptureChoice(false);

    expect(scene.registry.get(OUTPOSTS_KEY)).toBeUndefined();
    expect(scene.registry.get('baseCaptureChoice')).toBeNull();
    expect(scene._objectiveBaseIndex).toBe(1);   // still moves on to the next base
  });

  it('a second interact press after the choice already resolved is a no-op', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 20, 0)];
    const scene = fakeScene({ bases, enemies: [] });
    scene._initMission();
    scene._advanceObjective();
    scene._resolveBaseCaptureChoice(false);   // declined
    scene._onInteractPressed();               // late press — nothing pending any more

    expect(scene.registry.get(OUTPOSTS_KEY)).toBeUndefined();
    expect(scene._objectiveBaseIndex).toBe(1);
  });

  it('interact press outside a pending choice does nothing', () => {
    const scene = fakeScene({ bases: [makeBase('base0', 0, 0)] });
    expect(() => scene._onInteractPressed()).not.toThrow();
    expect(scene.registry.get(OUTPOSTS_KEY)).toBeUndefined();
  });

  it('alternates outpost type by base index (resource, repair, resource, ...) across accepted bases', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 10, 0), makeBase('base2', 20, 0)];
    const scene = fakeScene({ bases, enemies: [] });
    scene._initMission();

    scene._advanceObjective(); scene._onInteractPressed();   // clears+establishes base0 → resource
    scene._advanceObjective(); scene._onInteractPressed();   // clears+establishes base1 → repair

    const outposts = scene.registry.get(OUTPOSTS_KEY);
    expect(outposts.map((o) => o.type)).toEqual(['resource', 'repair']);
  });

  it('the FIRST established base in a biome becomes its regional base; a later one does not', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 10, 0)];
    const scene = fakeScene({ bases, enemies: [] });
    scene._initMission();

    scene._advanceObjective(); scene._onInteractPressed();   // establishes base0
    scene._advanceObjective(); scene._onInteractPressed();   // establishes base1 too

    const regional = scene.registry.get(REGIONAL_BASES_KEY);
    expect(regional).toHaveLength(1);
    expect(regional[0]).toMatchObject({ biomeId: 'grassland', baseId: 'base0' });
  });

  it('an already-captured base skips the choice and auto-advances without re-claiming', () => {
    const capturedBase = { ...makeBase('base0', 0, 0), captured: true };
    const bases = [capturedBase, makeBase('base1', 10, 0)];
    const scene = fakeScene({ bases, enemies: [] });
    scene._initMission();

    scene._advanceObjective();

    expect(scene.registry.get('baseCaptureChoice')).toBeUndefined();   // never presented
    expect(scene.registry.get(OUTPOSTS_KEY)).toBeUndefined();
    expect(scene._objectiveBaseIndex).toBe(1);
  });

  it('with no bases left, advancing is a safe no-op', () => {
    const scene = fakeScene({ bases: [] });
    scene._objectiveBaseIndex = 0;
    expect(() => scene._advanceObjective()).not.toThrow();
    expect(scene.registry.get(OUTPOSTS_KEY)).toBeUndefined();
  });
});
