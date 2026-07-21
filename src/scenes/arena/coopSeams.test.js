// #347 — the migrated call sites, exercised with TWO players.
//
// The seam tests next door prove the queries answer correctly. These prove the arena code that
// now calls them actually behaves per-player: a powerup goes to whoever touched it, burning
// ground burns everyone standing in it, a wall detector trips for either player, both players
// are solid obstacles, the run survives one death, and an enemy fights its nearest.
//
// Every case is paired with its N=1 twin, because "identical with one player" is the actual
// requirement of this phase — a co-op behaviour that came at the cost of the single-player
// reading would be a regression, not a feature.
import { describe, it, expect, vi } from 'vitest';

// Same stub the other arena mixin tests use — these mixins import Phaser at module load but
// none of the methods under test touch it.
vi.mock('phaser', () => ({ default: {} }));

import { makePlayer } from '../../data/players.js';
import { PowerupsMixin } from './powerups.js';
import { SalvageMixin } from './salvage.js';
import { ProjectilesMixin } from './projectiles.js';
import { RunMixin } from './run.js';
import { WorldMixin } from './world.js';

const mech = (over = {}) => ({
  isDestroyed: () => false,
  isPartDestroyed: () => false,
  repairArmor: vi.fn(() => 10),
  exposedArmorLocations: () => [],
  grantTempShield: vi.fn(),
  tempShieldRemainingMs: 0,
  applyDamage: vi.fn(() => ({})),
  ...over,
});

const deadMech = () => mech({ isDestroyed: () => true });

// Same chainable no-op Graphics stub firePatchDamage.test.js uses.
function fakeGraphics() {
  const g = new Proxy({}, { get: () => (() => g) });
  return g;
}

function player(id, x, y, m = mech()) {
  const p = makePlayer({ id, mech: m, x, y });
  p.view = { setVisible: vi.fn() };
  return p;
}

// ── Powerups: who collected it? (#335 open question 6) ──────────────────────────────────
function powerupScene(players) {
  const scene = {
    players,
    activePowerups: {},
    powerups: [],
    registry: { set: vi.fn() },
    time: { now: 0 },
    _floatText: vi.fn(),
    _updateShieldVisual: vi.fn(),
    _shieldVisual: null,
  };
  return Object.assign(scene, PowerupsMixin);
}

function dropAt(scene, x, y, type = 'armorPatch') {
  const view = {
    y: 0, destroy: vi.fn(),
    _halo: { setScale: () => ({ setAlpha: () => {} }) },
    _core: { setScale: vi.fn() },
    _ring: { setScale: vi.fn(), rotation: 0 },
    _spark: { rotation: 0 },
    _beam: { setScale: () => ({ setAlpha: () => {} }) },
    _glow: [{ y: 0, setScale: vi.fn() }],
  };
  scene.powerups.push({ x, y, type, age: 0, view });
}

describe('powerups apply to the COLLECTOR, not to "the player" (#347; team-wide for shield/armor #390)', () => {
  // #390: Armor Patch (and Shield) now grant their FULL effect to EVERY live player from one
  // pickup — the collector is still the one who TRIGGERS it (proximity), but the repair is
  // team-wide. What #347 still guarantees is that a global "the player" singleton is not used:
  // the pickup is detected on whoever stands on it, and it is consumed exactly once.
  it('two players: standing on it triggers a team-wide repair (BOTH mechs, #390)', () => {
    const a = player(0, 0, 0);
    const b = player(1, 800, 0);
    const scene = powerupScene([a, b]);
    dropAt(scene, 805, 0);            // right on top of player B

    scene._updatePowerups(16);

    expect(b.mech.repairArmor).toHaveBeenCalled();
    expect(a.mech.repairArmor).toHaveBeenCalled();   // #390: the far player is repaired too
    expect(scene.powerups).toHaveLength(0);
  });

  it('one player: unchanged — the drop under him is his', () => {
    const only = player(0, 0, 0);
    const scene = powerupScene([only]);
    dropAt(scene, 4, 0);
    scene._updatePowerups(16);
    expect(only.mech.repairArmor).toHaveBeenCalled();
  });

  it('a drop nobody is touching is left on the ground', () => {
    const a = player(0, 0, 0);
    const b = player(1, 800, 0);
    const scene = powerupScene([a, b]);
    dropAt(scene, 400, 0);            // squarely between them
    scene._updatePowerups(16);
    expect(scene.powerups).toHaveLength(1);
    expect(a.mech.repairArmor).not.toHaveBeenCalled();
    expect(b.mech.repairArmor).not.toHaveBeenCalled();
  });

  it('a downed player cannot collect', () => {
    const dead = player(0, 0, 0, deadMech());
    const scene = powerupScene([dead]);
    dropAt(scene, 2, 0);
    scene._updatePowerups(16);
    expect(scene.powerups).toHaveLength(1);
  });

  it('the shield powerup grants EVERY live player their own full temp pool (#390)', () => {
    const a = player(0, 0, 0);
    const b = player(1, 800, 0);
    const scene = powerupScene([a, b]);
    dropAt(scene, 800, 0, 'shield');
    scene._updatePowerups(16);
    expect(b.mech.grantTempShield).toHaveBeenCalled();
    expect(a.mech.grantTempShield).toHaveBeenCalled();   // #390: the far player is shielded too
  });
});

// ── Salvage: magnet + pickup follow the nearest/collecting player ───────────────────────
function salvageScene(players) {
  return Object.assign({
    players, salvage: [], run: { currency: 0 },
    registry: { set: vi.fn() },
    _floatText: vi.fn(),
  }, SalvageMixin);
}

function scrapAt(scene, x, y, amount = 5) {
  scene.salvage.push({
    x, y, amount, age: 0,
    view: { x: 0, y: 0, _gem: { rotation: 0 }, _ring: { rotation: 0 }, destroy: vi.fn() },
  });
}

describe('salvage drifts toward and is collected by the nearest player (#347)', () => {
  it('two players: SCRAP drifts toward the nearer one', () => {
    const a = player(0, 0, 0);
    const b = player(1, 1000, 0);
    const scene = salvageScene([a, b]);
    scrapAt(scene, 900, 0);           // inside B's magnet range, far from A
    const before = scene.salvage[0].x;
    scene._updateSalvage(16);
    expect(scene.salvage[0]?.x ?? Infinity).toBeGreaterThan(before);  // pulled toward B (+x)
  });

  it('the player who touches it banks it, and the run currency is shared', () => {
    const a = player(0, 0, 0);
    const b = player(1, 1000, 0);
    const scene = salvageScene([a, b]);
    scrapAt(scene, 1000, 0, 7);
    scene._updateSalvage(16);
    expect(scene.salvage).toHaveLength(0);
    expect(scene.run.currency).toBe(7);
  });

  it('one player: unchanged', () => {
    const only = player(0, 0, 0);
    const scene = salvageScene([only]);
    scrapAt(scene, 0, 0, 3);
    scene._updateSalvage(16);
    expect(scene.run.currency).toBe(3);
  });
});

// ── Burning ground burns EVERY player standing in it ────────────────────────────────────
function firePatchScene(players, patch) {
  return Object.assign({
    players,
    firePatches: [patch],
    enemies: [],
    time: { now: 10_000 },
    _damagePlayerAt: vi.fn(),
    _damageEnemyAt: vi.fn(),
    groundFx: fakeGraphics(),
    coverHp: new Map(),
    _damageBuildingAt: vi.fn(),
  }, { _updateFirePatches: ProjectilesMixin._updateFirePatches });
}

describe('burning ground is indiscriminate across players (#319 rule, #347 scope)', () => {
  const patch = () => ({ x: 0, y: 0, r: 100, dps: 20, nextTick: 0, until: 99_999 });

  it('two players inside: both take their own tick', () => {
    const a = player(0, 10, 0);
    const b = player(1, -10, 0);
    const scene = firePatchScene([a, b], patch());
    scene._updateFirePatches();
    expect(scene._damagePlayerAt).toHaveBeenCalledTimes(2);
    const hit = scene._damagePlayerAt.mock.calls.map((c) => c[1]);
    expect(hit).toContain(a);
    expect(hit).toContain(b);
  });

  it('only the player actually standing in it burns', () => {
    const inside = player(0, 10, 0);
    const outside = player(1, 5000, 0);
    const scene = firePatchScene([inside, outside], patch());
    scene._updateFirePatches();
    expect(scene._damagePlayerAt).toHaveBeenCalledTimes(1);
    expect(scene._damagePlayerAt.mock.calls[0][1]).toBe(inside);
  });

  it('one player: unchanged — one tick, on him', () => {
    const only = player(0, 0, 0);
    const scene = firePatchScene([only], patch());
    scene._updateFirePatches();
    expect(scene._damagePlayerAt).toHaveBeenCalledTimes(1);
    expect(scene._damagePlayerAt.mock.calls[0][1]).toBe(only);
  });
});

// ── Both players are solid obstacles to ground units ────────────────────────────────────
describe('every player blocks a ground unit, not just the primary (#347)', () => {
  const scene = (players) => Object.assign(
    { players, enemies: [] },
    { _blockedByOtherGroundUnit: WorldMixin._blockedByOtherGroundUnit },
  );
  const self = { kind: 'tank', flying: false };

  it('two players: standing on either one is blocked', () => {
    const s = scene([player(0, 0, 0), player(1, 1000, 0)]);
    expect(s._blockedByOtherGroundUnit(self, 0, 0)).toBe(true);
    expect(s._blockedByOtherGroundUnit(self, 1000, 0)).toBe(true);
    expect(s._blockedByOtherGroundUnit(self, 500, 0)).toBe(false);
  });

  it('one player: unchanged', () => {
    const s = scene([player(0, 0, 0)]);
    expect(s._blockedByOtherGroundUnit(self, 0, 0)).toBe(true);
    expect(s._blockedByOtherGroundUnit(self, 900, 0)).toBe(false);
  });

  it('a downed player stops being an obstacle', () => {
    const s = scene([player(0, 0, 0, deadMech())]);
    expect(s._blockedByOtherGroundUnit(self, 0, 0)).toBe(false);
  });
});

// ── The run ends only when EVERY player is down ─────────────────────────────────────────
describe('run/death flow across players (#347)', () => {
  const runScene = (players) => Object.assign({
    players,
    run: { status: 'active', currency: 0 },
    mission: null,
    _runAdvancing: false,
    _allObjectivesDestroyed: () => false,
    _allBasesFullyCleared: () => false,   // #356: the run's win check moved to the full per-base clear
    registry: { get: () => 0, set: vi.fn() },
    time: { delayedCall: vi.fn() },
  }, RunMixin);

  it('two players, one down: the run continues', () => {
    const scene = runScene([player(0, 0, 0, deadMech()), player(1, 10, 0)]);
    scene._updateRun();
    expect(scene.run.status).toBe('active');
    expect(scene._runAdvancing).toBe(false);
  });

  it('two players, both down: the run ends', () => {
    const scene = runScene([
      player(0, 0, 0, deadMech()), player(1, 10, 0, deadMech()),
    ]);
    scene._updateRun();
    expect(scene._runAdvancing).toBe(true);
  });

  it('one player down: the run ends, exactly as before', () => {
    const scene = runScene([player(0, 0, 0, deadMech())]);
    scene._updateRun();
    expect(scene._runAdvancing).toBe(true);
  });

  it('one player alive: the run continues, exactly as before', () => {
    const scene = runScene([player(0, 0, 0)]);
    scene._updateRun();
    expect(scene._runAdvancing).toBe(false);
  });
});
