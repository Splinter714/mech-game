// #269 playtest follow-up (objective sequencing) — MissionMixin/RunMixin no longer pick an
// arbitrary "farthest destructible outpost hex" as the objective; they walk `this.bases` in
// index order instead (base 0 first, then base 1 once base 0's docked units are all dead, etc).
// Both mixins are plain `this`-based method bags (no Phaser dependency beyond a handful of
// `this.add`/`this.tweens` calls for the world-space marker), so they're exercised here against
// a minimal fake ArenaScene, same style as world.test.js.
import { describe, it, expect } from 'vitest';
import { MissionMixin } from './mission.js';
import { RunMixin } from './run.js';
import { axialKey } from '../../data/hexgrid.js';
import { makeRun } from '../../data/run.js';

// A fake Phaser game-object: every method chains (returns itself) except `destroy`, which is a
// no-op spy-free stub — none of these tests assert on visuals, just that the sequencing logic
// (objectiveHex / _objectiveBase / mission status / registry publishes) is correct.
function fakeGraphic() {
  const obj = {
    setStrokeStyle: () => obj, setOrigin: () => obj, setDepth: () => obj,
    setColor: () => obj, setText: () => obj, destroy: () => {},
    // #280: the objective marker's rings are now drawn via `Graphics` (`strokeHexRing`,
    // shared.js), not `Polygon` — chain the calls it makes (`clear`/`lineStyle`/`strokePoints`)
    // the same no-op way as the rest of this fake.
    clear: () => obj, lineStyle: () => obj, strokePoints: () => obj,
  };
  return obj;
}

function fakeScene(overrides = {}) {
  const registryStore = new Map();
  const scene = Object.assign({
    add: {
      circle: () => fakeGraphic(),
      polygon: () => fakeGraphic(),
      graphics: () => fakeGraphic(),
      text: () => fakeGraphic(),
      container: (x, y, list) => Object.assign({ x, y, list, visible: true }, {
        setDepth() { return this; }, destroy() {}, setVisible(v) { this.visible = v; return this; }, setPosition(x, y) { this.x = x; this.y = y; return this; },
      }),
    },
    tweens: { add: () => {}, killTweensOf: () => {} },
    registry: {
      get: (k) => registryStore.get(k),
      set: (k, v) => registryStore.set(k, v),
    },
    bases: [],
    enemies: [],
  }, MissionMixin, RunMixin, overrides);
  return scene;
}

function makeBase(id, q, r) {
  return { id, center: { q, r }, docks: [], turrets: [] };
}

// #269 playtest follow-up ("objectives are picking an arbitrary hex, not a real target"): a base
// with a real `objectiveHex` distinct from its (arbitrary-centroid) `center`.
function makeBaseWithObjective(id, centerQ, centerR, objQ, objR) {
  return { id, center: { q: centerQ, r: centerR }, docks: [], turrets: [], objectiveHex: { q: objQ, r: objR } };
}

describe('objective sequencing walks through bases in index order (#269 playtest follow-up)', () => {
  it('the first objective targets base 0, not an arbitrary hex', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 20, 0), makeBase('base2', 0, 20)];
    const scene = fakeScene({ bases });
    scene._initMission();
    expect(scene._objectiveBase).toBe(bases[0]);
    expect(scene.objectiveHex).toBe(axialKey(0, 0));
    expect(scene.mission.status).toBe('active');
    expect(scene.registry.get('mission')).toBe(scene.mission);
    expect(scene.registry.get('objectiveWorld')).not.toBeNull();
  });

  it('clearing the current base\'s units completes the mission and advances to the next base by index', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 20, 0), makeBase('base2', 0, 20)];
    const scene = fakeScene({
      bases,
      enemies: [{ baseId: 'base0' }, { baseId: 'base1' }],
      run: makeRun(),
    });
    scene._initMission();
    expect(scene._objectiveBase.id).toBe('base0');

    // Not yet cleared — base0 still has a live enemy.
    scene._updateMission();
    expect(scene.mission.status).toBe('active');

    // Kill base0's last enemy, then re-evaluate — mission should complete.
    scene.enemies = scene.enemies.filter((e) => e.baseId !== 'base0');
    scene._updateMission();
    expect(scene.mission.status).toBe('complete');

    // The run mixin reacts to a completed mission by advancing to the next base.
    scene._advanceObjective();
    expect(scene._objectiveBaseIndex).toBe(1);
    expect(scene._objectiveBase).toBe(bases[1]);
    expect(scene.objectiveHex).toBe(axialKey(20, 0));
    expect(scene.mission.status).toBe('active');
    expect(scene.run.objectivesCleared).toBe(1);   // #269: currency banking is unaffected —
    // it only cares that a mission completed, not what kind of objective it was.
  });

  it('keeps advancing base-to-base as each is cleared, in order', () => {
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 20, 0), makeBase('base2', 0, 20)];
    const scene = fakeScene({ bases, enemies: [], run: makeRun() });
    scene._initMission();
    for (let i = 0; i < bases.length; i++) {
      expect(scene._objectiveBase).toBe(bases[i]);
      scene._updateMission();   // no enemies left anywhere ⇒ immediately cleared
      expect(scene.mission.status).toBe('complete');
      scene._advanceObjective();
    }
    // Ran off the end — no more bases to target.
    expect(scene._objectiveBaseIndex).toBe(bases.length);
    expect(scene._objectiveBase).toBeNull();
    expect(scene.objectiveHex).toBeNull();
    expect(scene.mission).toBeNull();
  });

  it('after the last base is cleared, the objective/marker is cleared (no dangling target)', () => {
    const bases = [makeBase('base0', 0, 0)];
    const scene = fakeScene({ bases, enemies: [], run: makeRun() });
    scene._initMission();
    expect(scene._objectiveMarker).toBeTruthy();

    scene._updateMission();
    expect(scene.mission.status).toBe('complete');
    scene._advanceObjective();

    expect(scene._objectiveBase).toBeNull();
    expect(scene.objectiveHex).toBeNull();
    expect(scene.mission).toBeNull();
    expect(scene._objectiveMarker).toBeNull();
    expect(scene.registry.get('mission')).toBeNull();
    expect(scene.registry.get('objectiveWorld')).toBeNull();
  });

  it('a base with no docked/turret units at all is skipped over immediately (reads as pre-cleared)', () => {
    // Regression guard: isBaseCleared(baseId, enemies) with no enemies tagged to that id must
    // read true, so an edge-case empty base doesn't stall the sequence forever.
    const bases = [makeBase('base0', 0, 0), makeBase('base1', 20, 0)];
    const scene = fakeScene({ bases, enemies: [{ baseId: 'base1' }], run: makeRun() });
    scene._initMission();
    scene._updateMission();   // base0 has zero enemies tagged to it ⇒ immediately complete
    expect(scene.mission.status).toBe('complete');
    scene._advanceObjective();
    expect(scene._objectiveBase.id).toBe('base1');
  });
});

// #269 playtest follow-up ("objectives are picking an arbitrary hex, not a real target"): the
// marker now targets a base's dedicated destructible `objectiveHex`, not the geometric-centroid
// `center` (which isn't necessarily even a real placed hex).
describe('the mission marker targets the base objective hex, not the arbitrary centroid (#269 playtest follow-up)', () => {
  it('points at objectiveHex when the base has one, not at center', () => {
    const bases = [makeBaseWithObjective('base0', 0, 0, 3, -1)];
    const scene = fakeScene({ bases });
    scene._initMission();
    expect(scene.objectiveHex).toBe(axialKey(3, -1));
    expect(scene.objectiveHex).not.toBe(axialKey(0, 0));
  });

  it('falls back to center when a base has no objectiveHex (e.g. invalidated by the safe-zone clear)', () => {
    const bases = [makeBase('base0', 5, 5)];   // no objectiveHex field at all
    const scene = fakeScene({ bases });
    scene._initMission();
    expect(scene.objectiveHex).toBe(axialKey(5, 5));
  });
});

// #269 playtest report ("objectives aren't clearing until I kill all units at the base"): the
// win condition must key off the objective hex's own destroyed state (removed from
// `this.buildingHp` — the same "collapsed to rubble" signal `_damageBuildingAt`, world.js, uses),
// not off `isBaseCleared`'s enemy count.
describe('mission completion is driven by the objective hex\'s destroyed state, not enemy death alone (#269 playtest follow-up)', () => {
  it('killing every enemy at the base does NOT complete the mission while the objective hex still stands', () => {
    const bases = [makeBaseWithObjective('base0', 0, 0, 3, -1)];
    const scene = fakeScene({
      bases,
      enemies: [{ baseId: 'base0' }],
      buildingHp: new Map([[axialKey(3, -1), 40]]),   // objective hex still standing
    });
    scene._initMission();

    // Kill the only enemy tagged to this base.
    scene.enemies = [];
    scene._updateMission();
    expect(scene.mission.status).toBe('active');   // still active — the hex, not the enemies, gates this
  });

  // #356 REVERSED the "even with live defenders" half of this: destroying the objective hex is now
  // the FIRST of three steps, not the whole mission. The hex still has to fall before anything
  // else counts, which is what this now pins.
  it('destroying the objective hex (removed from buildingHp) completes the mission once nothing is left defending', () => {
    const bases = [makeBaseWithObjective('base0', 0, 0, 3, -1)];
    const scene = fakeScene({
      bases,
      enemies: [{ baseId: 'base0' }],   // a defender is still alive
      buildingHp: new Map([[axialKey(3, -1), 40]]),
    });
    scene._initMission();

    scene._updateMission();
    expect(scene.mission.status).toBe('active');

    // Simulate `_damageBuildingAt` collapsing the objective hex to rubble: its key is deleted
    // from `buildingHp`, enemies untouched.
    scene.buildingHp.delete(axialKey(3, -1));
    scene._updateMission();
    expect(scene.mission.status).toBe('active');   // #356: the defender still has to die

    scene.enemies = [];
    scene._updateMission();
    expect(scene.mission.status).toBe('complete');
  });

  it('a base with no real objectiveHex still falls back to the enemy-count rule', () => {
    const bases = [makeBase('base0', 5, 5)];   // no objectiveHex field
    const scene = fakeScene({ bases, enemies: [{ baseId: 'base0' }], buildingHp: new Map() });
    scene._initMission();
    scene._updateMission();
    expect(scene.mission.status).toBe('active');

    scene.enemies = [];
    scene._updateMission();
    expect(scene.mission.status).toBe('complete');
  });
});

// ── #371: the objective indicator spreads to everything still required ─────────────────────────
// The pure rule (which targets, at which step) is pinned in data/baseMarkTargets.test.js. These
// pin the SCENE wiring on top of it: one marker per live target, pooled and re-derived each tick
// (so late spawns get marked and dead targets lose theirs), and fog suppression.
describe('#371 spreading objective markers', () => {
  const dockBase = (id, docks) => ({
    id, center: { q: 0, r: 0 }, docks, turrets: [], objectiveHex: { q: 0, r: 0 },
  });
  const hpFor = (hexes) => new Map(hexes.map((h) => [axialKey(h.q, h.r), 10]));
  const dockCount = (s) => s._dockMarkers?.size ?? 0;
  const enemyCount = (s) => s._enemyMarkers?.size ?? 0;

  function sceneAt({ objectiveUp = false, docksUp = [], enemies = [], ...rest } = {}) {
    const docks = [{ q: 1, r: 0 }, { q: 2, r: 0 }];
    const standing = [...docksUp, ...(objectiveUp ? [{ q: 0, r: 0 }] : [])];
    const scene = fakeScene({
      bases: [dockBase('base0', docks)],
      enemies,
      buildingHp: hpFor(standing),
      run: makeRun(),
      ...rest,
    });
    scene._initMission();
    scene._updateMission();
    return scene;
  }

  it('step 1 — objective alive: only the single marker, no spread markers', () => {
    const s = sceneAt({
      objectiveUp: true,
      docksUp: [{ q: 1, r: 0 }, { q: 2, r: 0 }],
      enemies: [{ baseId: 'base0', x: 0, y: 0 }],
    });
    expect(dockCount(s)).toBe(0);
    expect(enemyCount(s)).toBe(0);
  });

  it('step 2 — objective down: one marker per STANDING dock, and none on enemies', () => {
    const s = sceneAt({
      docksUp: [{ q: 1, r: 0 }, { q: 2, r: 0 }],
      enemies: Array.from({ length: 7 }, () => ({ baseId: 'base0', x: 0, y: 0 })),
    });
    expect(dockCount(s)).toBe(2);
    expect(enemyCount(s)).toBe(0);

    // Blow up one dock: its marker is pruned, the other stays.
    s.buildingHp.delete(axialKey(1, 0));
    s._updateMission();
    expect(dockCount(s)).toBe(1);
    expect(enemyCount(s)).toBe(0);
  });

  it('step 3 — docks cleared: a little marker per remaining enemy, pinned above it', () => {
    const enemies = [{ baseId: 'base0', x: 100, y: 200 }, { baseId: 'other', x: 0, y: 0 }];
    const s = sceneAt({ enemies });
    expect(dockCount(s)).toBe(0);
    expect(enemyCount(s)).toBe(1);
    const m = s._enemyMarkers.get(enemies[0]);
    expect(m.x).toBe(100);
    expect(m.y).toBeLessThan(200);   // lifted clear of the sprite/shield bubble

    // It tracks the enemy as it moves.
    enemies[0].x = 140;
    s._updateMission();
    expect(s._enemyMarkers.get(enemies[0]).x).toBe(140);
  });

  it('LATE SPAWNS get marked — a carrier drone born mid-step grows the marker set, uncapped', () => {
    const enemies = [{ baseId: 'base0', x: 0, y: 0 }];
    const s = sceneAt({ enemies });
    expect(enemyCount(s)).toBe(1);
    for (let i = 0; i < 12; i++) s.enemies.push({ baseId: 'base0', x: i, y: 0 });
    s._updateMission();
    expect(enemyCount(s)).toBe(13);
    // Dead enemies (pruned from `enemies`) drop their markers.
    s.enemies = s.enemies.slice(0, 3);
    s._updateMission();
    expect(enemyCount(s)).toBe(3);
  });

  it('markers do NOT show through an unentered compound (fog #337)', () => {
    const enemies = [{ baseId: 'base0', x: 0, y: 0 }];
    const s = sceneAt({
      enemies,
      _enemyVisible: () => false,
      _pointVisible: () => false,
    });
    expect(s._enemyMarkers.get(enemies[0]).visible).toBe(false);

    // Same gate for docks.
    const d = sceneAt({ docksUp: [{ q: 1, r: 0 }], _pointVisible: () => false });
    expect([...d._dockMarkers.values()][0].visible).toBe(false);
  });

  it('base clear drops every spread marker, and advancing bases does not leak them', () => {
    const enemies = [{ baseId: 'base0', x: 0, y: 0 }];
    const s = sceneAt({ enemies });
    expect(enemyCount(s)).toBe(1);
    s.enemies = [];
    s._updateMission();
    expect(s.mission.status).toBe('complete');
    expect(enemyCount(s)).toBe(0);
    s._advanceObjective();
    expect(enemyCount(s)).toBe(0);
    expect(dockCount(s)).toBe(0);
  });
});
