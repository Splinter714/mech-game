// #511/#512: clearing a base's mission claims it as an outpost (run.js `_claimClearedBaseOutpost`,
// called from `_advanceObjective`). Same minimal fake-scene style as mission.test.js/
// baseClearRun.test.js — a plain `this`-based mixin bag, no real Phaser.
import { describe, it, expect } from 'vitest';
import { MissionMixin } from './mission.js';
import { RunMixin } from './run.js';
import { OUTPOSTS_KEY } from '../../data/events.js';

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
    registry: { get: (k) => registryStore.get(k), set: (k, v) => registryStore.set(k, v) },
    bases: [], enemies: [], biomeId: 'grassland',
  }, MissionMixin, RunMixin, overrides);
  return scene;
}

function makeBase(id, q, r) {
  return { id, center: { q, r }, docks: [], turrets: [] };
}

describe('#511/#512 clearing a base claims it as an outpost', () => {
  it('advancing the objective claims the just-cleared base', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 20, 0)];
    const scene = fakeScene({ bases, enemies: [] });
    scene._initMission();
    expect(scene._objectiveBaseIndex).toBe(0);

    scene._advanceObjective();

    const outposts = scene.registry.get(OUTPOSTS_KEY);
    expect(outposts).toHaveLength(1);
    expect(outposts[0]).toMatchObject({ type: 'resource', coord: { q: 0, r: 0 }, biomeId: 'grassland', upgradeLevel: 0 });
    expect(scene._objectiveBaseIndex).toBe(1);
  });

  it('alternates outpost type by base index (resource, repair, resource, ...)', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 10, 0), makeBase('base2', 20, 0)];
    const scene = fakeScene({ bases, enemies: [] });
    scene._initMission();

    scene._advanceObjective();   // clears base0 → resource
    scene._advanceObjective();   // clears base1 → repair

    const outposts = scene.registry.get(OUTPOSTS_KEY);
    expect(outposts.map((o) => o.type)).toEqual(['resource', 'repair']);
  });

  it('does not claim twice for the same deploy+base (no-op, not a duplicate)', () => {
    const bases = [makeBase('base0', 0, 0)];
    const scene = fakeScene({ bases, enemies: [] });
    scene._initMission();
    scene.registry.set('deployCount', 3);

    scene._claimClearedBaseOutpost();
    scene._claimClearedBaseOutpost();   // called again with the same index — must not duplicate

    expect(scene.registry.get(OUTPOSTS_KEY)).toHaveLength(1);
  });

  it('with no bases left, claiming is a safe no-op', () => {
    const scene = fakeScene({ bases: [] });
    scene._objectiveBaseIndex = 0;
    expect(() => scene._claimClearedBaseOutpost()).not.toThrow();
    expect(scene.registry.get(OUTPOSTS_KEY)).toBeUndefined();
  });
});
