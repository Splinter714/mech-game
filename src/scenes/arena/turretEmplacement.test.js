// #287 (playtest 2026-07-18: the turret emplacement "should BE a hex that fully gets destroyed
// into rubble") — scene-level coverage for the two spawn-path consequences of turning that hex
// from passable ground into a real impassable, HP-bearing bunker (data/terrain.js), plus the
// deliberate "the garrison dies with the structure" rule.
//
// enemies.js has a vestigial `import Phaser from 'phaser'` whose top-level device detection
// throws under vitest's node env, so it's stubbed out (same convention as dormantWake.test.js).
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
import { AWARE, DORMANT, detectionRangeFor } from '../../data/awareness.js';
import { hexToPixel, axialKey } from '../../data/hexgrid.js';
import { turretClusterHexes } from '../../data/spawnPlacement.js';
import { isPassable } from '../../data/terrain.js';

function makeScene() {
  const scene = {
    time: { now: 0 }, enemies: [], px: 0, py: 0, bases: [], alertTowerHexes: [],
    terrain: new Map(), worldRadius: 20,
    // Just enough real-ish stubs for a woken unit's FULL `_updateEnemy` -> `_updateVehicle` tick
    // to run end to end (mirrors dormantWake.test.js's `makeTickableScene`) — the #115 recovery
    // branch under test lives INSIDE `_updateVehicle`, so it can't be stubbed away here.
    enemyMove: true, enemyFire: true,
    _blocked: () => false,
    _blockedByOtherGroundUnit: () => false,
    _speedFactorAt: () => 1,
    _cachedLosToPlayer: () => true,
    _fireVehicleWeapon: () => {},
  };
  Object.assign(scene, EnemiesMixin, BasesMixin);
  scene._initAlertTowers();
  // `_spawnKind` normally builds real Phaser textures/views — out of scope here, so it's the
  // same lightweight plain-object stand-in dormantWake.test.js uses.
  scene._spawnKind = (x, y, kindId) => {
    const def = ENEMY_KINDS[kindId];
    const e = {
      key: `${kindId}Test`, mech: new HpBody(def), kind: def.kind, kindDef: def,
      x, y, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0, typeId: kindId, handed: 1,
      behavior: def.behavior,
      view: { setPosition() {}, hull: { setTexture() {}, rotation: 0 }, turret: { rotation: 0 }, shadow: null },
      detectRange: detectionRangeFor(def.fireRange),
    };
    scene.enemies.push(e);
    return e;
  };
  return scene;
}

const EMPLACEMENT = { q: 2, r: -1 };
const EMPLACEMENT_KEY = axialKey(EMPLACEMENT.q, EMPLACEMENT.r);

function withOneEmplacement(scene) {
  // Ordinary passable ground all around, so the #115 snap-back has somewhere real to snap TO —
  // otherwise `nearestValidPixel` finds no passable hex at all and returns the unit's own hex
  // centre unchanged, which would make the control test below vacuous.
  for (let q = -4; q <= 4; q++) for (let r = -4; r <= 4; r++) scene.terrain.set(axialKey(q, r), 'grass');
  scene.terrain.set(EMPLACEMENT_KEY, 'turretEmplacement');
  scene.bases = [{ id: 'base0', center: { q: 0, r: 0 }, docks: [], turrets: [EMPLACEMENT] }];
  return scene;
}

describe('#287 spawn path: a base turret garrisons its now-impassable bunker', () => {
  it('spawns the turret exactly on the emplacement hex centre and tags it `emplaced`', () => {
    const scene = withOneEmplacement(makeScene());
    scene._spawnDormantUnits();

    expect(scene.enemies.length).toBe(1);
    const [t] = scene.enemies;
    const { x, y } = hexToPixel(EMPLACEMENT.q, EMPLACEMENT.r);
    expect(t.x).toBe(x);
    expect(t.y).toBe(y);
    expect(t.emplaced).toBe(true);
    expect(t.dockKey).toBe(EMPLACEMENT_KEY);
    expect(t.baseId).toBe('base0');
    expect(t.awareness).toBe(DORMANT);
  });

  it('a DOCK unit is NOT tagged emplaced — the exemption is scoped to bunker garrisons only', () => {
    const scene = makeScene();
    scene.bases = [{
      id: 'base0', center: { q: 0, r: 0 },
      docks: [{ q: 0, r: 0, kindId: 'tank', count: 1 }], turrets: [],
    }];
    scene._spawnDormantUnits();
    expect(scene.enemies[0].emplaced).toBeUndefined();
  });

  it('the #115 stranded-unit snap-back leaves an emplaced turret standing on its own bunker', () => {
    // The heart of the conflict the old terrain.js comment warned about: the emplacement hex is
    // now impassable, so `_blocked` reports true underneath every base turret. Without the
    // `emplaced` exemption, `_updateEnemy`'s recovery would shove each one onto a neighbouring
    // hex on the very first tick, leaving the bunker visibly empty.
    const scene = withOneEmplacement(makeScene());
    scene._blocked = () => true;
    scene._spawnDormantUnits();
    const [t] = scene.enemies;
    t.awareness = AWARE;                     // DORMANT returns before the recovery branch
    t.reactDelayMs = 0;                      // #285 post-wake stagger — not what's under test
    const { x, y } = hexToPixel(EMPLACEMENT.q, EMPLACEMENT.r);

    scene._updateEnemy(t, 0.016, 16);

    expect(t.x).toBe(x);
    expect(t.y).toBe(y);
  });

  it('a NON-emplaced ground unit stranded on blocked terrain is still snapped back (#115 intact)', () => {
    const scene = withOneEmplacement(makeScene());
    scene._blocked = () => true;
    scene._spawnDormantUnits();
    const [t] = scene.enemies;
    delete t.emplaced;                       // the ONLY difference from the test above
    t.awareness = AWARE;
    t.reactDelayMs = 0;
    const { x, y } = hexToPixel(EMPLACEMENT.q, EMPLACEMENT.r);

    scene._updateEnemy(t, 0.016, 16);

    expect([t.x, t.y]).not.toEqual([x, y]);
    expect(t.vx).toBe(0);
    expect(t.vy).toBe(0);
  });

  it('turretClusterHexes (the free-roaming turretNest spawn) never lands a nest on a bunker', () => {
    // The other spawn path the old comment named. It snaps to the nearest PASSABLE hex, so an
    // emplacement hex is simply no longer an eligible site — the correct reading, since a
    // roaming nest shouldn't materialise on top of a base's fortification.
    expect(isPassable('turretEmplacement')).toBe(false);
    const terrain = new Map();
    for (let q = -4; q <= 4; q++) for (let r = -4; r <= 4; r++) terrain.set(axialKey(q, r), 'grass');
    terrain.set(EMPLACEMENT_KEY, 'turretEmplacement');
    const { x, y } = hexToPixel(EMPLACEMENT.q, EMPLACEMENT.r);

    const hexes = turretClusterHexes(terrain, 20, x, y, 4);

    expect(hexes.length).toBe(4);
    for (const h of hexes) {
      expect(axialKey(h.q, h.r)).not.toBe(EMPLACEMENT_KEY);
      expect(isPassable(terrain.get(axialKey(h.q, h.r)))).toBe(true);
    }
  });
});

describe('#287: destroying the bunker destroys its garrison', () => {
  it('_onTerrainCollapsed kills the turret standing on that emplacement hex', () => {
    const scene = withOneEmplacement(makeScene());
    scene._damageEnemyAt = vi.fn((e, x, y, dmg) => { e.mech.hp = Math.max(0, e.mech.hp - dmg); });
    scene._spawnDormantUnits();
    const [t] = scene.enemies;
    expect(t.mech.isDestroyed()).toBe(false);

    scene._onTerrainCollapsed(EMPLACEMENT_KEY);

    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
    expect(t.mech.isDestroyed()).toBe(true);
  });

  it('bites for more than the turret\'s full TOUGHNESS, so its armor pool cannot save it', () => {
    // Going through the normal damage path (rather than a bespoke teardown) is what keeps the
    // death FX, base-wake cascade, drop roll and win-condition bookkeeping identical to a turret
    // killed by direct fire — but that path spends ARMOR before structure. Since #299 the turret
    // has an armor pool (15) on top of its structure (35), so an `hp + 1` bite left it alive on
    // its own crater in live play. The damage must clear `toughness`, not `hp`.
    const scene = withOneEmplacement(makeScene());
    const calls = [];
    scene._damageEnemyAt = vi.fn((e, x, y, dmg) => { calls.push(dmg); e.mech.hp = 0; });
    scene._spawnDormantUnits();
    const [t] = scene.enemies;
    const toughness = t.mech.toughness;
    expect(toughness).toBeGreaterThan(t.mech.hp);   // guards the distinction itself

    scene._onTerrainCollapsed(EMPLACEMENT_KEY);

    expect(calls[0]).toBeGreaterThan(toughness);
  });

  it('leaves turrets on OTHER emplacements alone', () => {
    const scene = makeScene();
    const other = { q: -3, r: 4 };
    scene.terrain.set(EMPLACEMENT_KEY, 'turretEmplacement');
    scene.terrain.set(axialKey(other.q, other.r), 'turretEmplacement');
    scene.bases = [{ id: 'base0', center: { q: 0, r: 0 }, docks: [], turrets: [EMPLACEMENT, other] }];
    scene._damageEnemyAt = vi.fn((e, x, y, dmg) => { e.mech.hp = 0; });
    scene._spawnDormantUnits();

    scene._onTerrainCollapsed(EMPLACEMENT_KEY);

    const [a, b] = scene.enemies;
    expect(a.mech.isDestroyed()).toBe(true);
    expect(b.mech.isDestroyed()).toBe(false);
  });

  it('is a harmless no-op for a collapsing hex nobody garrisons (e.g. an alert tower)', () => {
    const scene = withOneEmplacement(makeScene());
    scene._damageEnemyAt = vi.fn();
    scene._spawnDormantUnits();

    expect(() => scene._onTerrainCollapsed(axialKey(7, 7))).not.toThrow();
    expect(scene._damageEnemyAt).not.toHaveBeenCalled();
    expect(scene.enemies[0].mech.isDestroyed()).toBe(false);
  });

  it('never double-kills an already-destroyed garrison', () => {
    const scene = withOneEmplacement(makeScene());
    scene._damageEnemyAt = vi.fn((e, x, y, dmg) => { e.mech.hp = 0; });
    scene._spawnDormantUnits();
    scene._onTerrainCollapsed(EMPLACEMENT_KEY);
    scene._onTerrainCollapsed(EMPLACEMENT_KEY);
    expect(scene._damageEnemyAt).toHaveBeenCalledTimes(1);
  });
});
