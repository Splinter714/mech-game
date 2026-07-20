// #374 — soft cover's shot block, as WIRED into the arena (the pure rule itself lives in
// data/terrain.js and is pinned in terrain.test.js).
//
// The change in one sentence: soft cover (forest/scrub/drift/wreck/fumarole) no longer blocks
// anyone's ray geometrically — instead a shot that has already RESOLVED onto a unit standing in
// soft cover is eaten by the foliage with a chance graded by that unit's tier (Jackson: "non-mech
// ground units a 75% block chance and mech ground units 25% block chance and air units NO block
// chance"). Three things have to hold for that to be real in play, and this file pins each:
//   1. the tier is read off the TARGET (`softCoverUnitTier`), from classifications that already
//      existed — the flying/airborne test and the mech-vs-vehicle `kind` split;
//   2. the roll runs on a SEEDED rng (`scene._coverRng`), never bare `Math.random`, so a run is
//      reproducible and this file can be deterministic;
//   3. it is applied at the real damage-resolution sites — the hitscan beam (firing.js) and a
//      projectile impact (projectiles.js) — so a blocked shot deals nothing but still splashes.
import { describe, it, expect, vi } from 'vitest';
import { CombatMixin } from './combat.js';
import { FiringMixin } from './firing.js';
import { ProjectilesMixin } from './projectiles.js';
import { WorldMixin } from './world.js';
import { softCoverUnitTier } from './shared.js';
import { SOFT_COVER_BLOCK_CHANCE } from '../../data/terrain.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile } from '../../data/delivery.js';
import { makeWallEdgeSet } from '../../data/wallEdges.js';
import { hexToPixel, axialKey } from '../../data/hexgrid.js';

// ── 1. the tier classifier ────────────────────────────────────────────────────────────────
describe('#374 softCoverUnitTier — which block chance a TARGET gets', () => {
  it('the player (no kind, always a mech) is the mech tier', () => {
    expect(softCoverUnitTier({ x: 0, y: 0, mech: {} })).toBe('mech');
  });

  it('a mech-kind enemy is the mech tier', () => {
    expect(softCoverUnitTier({ kind: 'mech', mech: {} })).toBe('mech');
  });

  it('every non-mech GROUND vehicle kind is the vehicle tier — from the real registry', () => {
    const ground = Object.values(ENEMY_KINDS).filter((k) => !k.flying);
    expect(ground.length).toBeGreaterThan(0);
    for (const def of ground) {
      expect(softCoverUnitTier({ kind: def.kind, kindDef: def })).toBe('vehicle');
    }
    // ...which is the tank/infantry/carrier/turret set, spelled out so a re-tag is loud.
    for (const kind of ['tank', 'infantry', 'carrier', 'turret']) {
      expect(softCoverUnitTier({ kind })).toBe('vehicle');
    }
  });

  it('every FLYING kind is the air tier — from the real registry', () => {
    const flyers = Object.values(ENEMY_KINDS).filter((k) => k.flying);
    expect(flyers.length).toBeGreaterThan(0);
    for (const def of flyers) {
      expect(softCoverUnitTier({ kind: def.kind, kindDef: def, flying: true })).toBe('air');
    }
  });

  // Same reading #338's `targetCoverExempt` already applies: a flyer sitting on the deck is a
  // ground target while it's down there, so it does not keep its 0% immunity.
  it('a GROUNDED flyer drops to the ground treatment, not air', () => {
    expect(softCoverUnitTier({ kind: 'drone', flying: true, airborne: false })).toBe('vehicle');
    expect(softCoverUnitTier({ kind: 'drone', flying: true, airborne: true })).toBe('air');
    expect(softCoverUnitTier({ kind: 'drone', flying: true })).toBe('air');
  });

  it('a wall turret needs no special case — it classifies plainly, and never stands in foliage', () => {
    // A gun emplaced on a wall span is a `turret` kind like any other; the rule never reaches its
    // tier because its hex is a wall, not soft cover (pinned by the terrain gate in terrain.test.js).
    expect(softCoverUnitTier({ kind: 'turret', spanKey: '1,0:2,0' })).toBe('vehicle');
  });
});

// ── 2 + 3. the scene wiring ───────────────────────────────────────────────────────────────
// A flat grass field with a forest hex at `FOREST`, and the real mixins under test.
const FOREST_HEX = { q: 4, r: 0 };
const OPEN_HEX = { q: 6, r: 0 };
const centre = (h) => hexToPixel(h.q, h.r);

function makeScene({ roll = 0 } = {}) {
  const terrain = new Map();
  for (let q = -8; q <= 8; q++) for (let r = -8; r <= 8; r++) terrain.set(axialKey(q, r), 'grass');
  terrain.set(axialKey(FOREST_HEX.q, FOREST_HEX.r), 'forest');
  const scene = Object.assign({}, WorldMixin, CombatMixin, {
    terrain,
    buildingHp: new Map(), coverHp: new Map(),
    wallEdges: makeWallEdgeSet([]),
    enemies: [], projectiles: [], firePatches: [],
    // A scripted rng in place of the seeded one, so every assertion below is exact rather than
    // statistical. Production builds this lazily from `runSeed` (see `_softCoverStopsShot`).
    _coverRng: () => roll,
  });
  return scene;
}

describe('#374 _softCoverStopsShot — the scene-level roll', () => {
  const at = (h, extra = {}) => ({ ...centre(h), mech: {}, ...extra });

  it('a target in the OPEN is never blocked, however the dice fall', () => {
    const s = makeScene({ roll: 0 });
    expect(s._softCoverStopsShot(at(OPEN_HEX))).toBe(false);
  });

  it('a MECH target in forest is blocked below 25% and not at or above it', () => {
    expect(makeScene({ roll: 0.24 })._softCoverStopsShot(at(FOREST_HEX))).toBe(true);
    expect(makeScene({ roll: 0.25 })._softCoverStopsShot(at(FOREST_HEX))).toBe(false);
    expect(makeScene({ roll: 0.5 })._softCoverStopsShot(at(FOREST_HEX))).toBe(false);
  });

  it('a VEHICLE target in the same forest is blocked far more often — 75%', () => {
    const tank = { kind: 'tank' };
    expect(makeScene({ roll: 0.5 })._softCoverStopsShot(at(FOREST_HEX, tank))).toBe(true);
    expect(makeScene({ roll: 0.74 })._softCoverStopsShot(at(FOREST_HEX, tank))).toBe(true);
    expect(makeScene({ roll: 0.75 })._softCoverStopsShot(at(FOREST_HEX, tank))).toBe(false);
  });

  it('an AIRBORNE target in forest is never blocked — it is above the treeline', () => {
    const heli = { kind: 'helicopter', flying: true };
    expect(makeScene({ roll: 0 })._softCoverStopsShot(at(FOREST_HEX, heli))).toBe(false);
  });

  // #72/#279's own-hex exemption, decided for the new rule: it APPLIES. A shooter standing in the
  // same thicket as its target has no foliage in between.
  it('the own-hex exemption holds — a shooter in the SAME forest hex is never blocked', () => {
    const s = makeScene({ roll: 0 });
    const sameHex = [s._hexKeyAt(centre(FOREST_HEX).x, centre(FOREST_HEX).y)];
    expect(s._softCoverStopsShot(at(FOREST_HEX), sameHex)).toBe(false);
    // ...but a shooter standing anywhere else rolls normally.
    const elsewhere = [s._hexKeyAt(centre(OPEN_HEX).x, centre(OPEN_HEX).y)];
    expect(s._softCoverStopsShot(at(FOREST_HEX), elsewhere)).toBe(true);
    expect(s._softCoverStopsShot(at(FOREST_HEX), null)).toBe(true);
  });

  it('a target with no position cannot be rolled for, and is never blocked', () => {
    const s = makeScene({ roll: 0 });
    expect(s._softCoverStopsShot(null)).toBe(false);
    expect(s._softCoverStopsShot({ mech: {} })).toBe(false);
  });

  // The seeding requirement, stated as a test: no bare Math.random, and the same run seed must
  // reproduce the same sequence of blocks.
  it('rolls on a SEEDED rng derived from runSeed — not Math.random — and repeats for a seed', () => {
    const spy = vi.spyOn(Math, 'random');
    const run = (runSeed) => {
      const s = makeScene();
      delete s._coverRng;                      // force the lazy production construction
      s.runSeed = runSeed;
      const tank = at(FOREST_HEX, { kind: 'tank' });
      return Array.from({ length: 24 }, () => s._softCoverStopsShot(tank));
    };
    const a = run(1234), b = run(1234), c = run(9999);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(a).toEqual(b);                      // same seed ⇒ same outcomes
    expect(a).not.toEqual(c);                  // a different seed genuinely differs
    // ...and it is a real 75% roll, not a stuck constant.
    expect(a).toContain(true);
    expect(a).toContain(false);
  });
});

// ── the two real damage-resolution sites ──────────────────────────────────────────────────
describe('#374 a blocked shot deals no damage but still splashes', () => {
  function makeFiringScene({ roll, target }) {
    const s = makeScene({ roll });
    Object.assign(s, FiringMixin, ProjectilesMixin, {
      beams: [], enemies: [target],
      players: [{ id: 'p1', x: 0, y: 0, convergeTarget: null, mech: { isDestroyed: () => false } }],
      time: { now: 0, delayedCall: () => {} },
      projFx: { clear: vi.fn() },
      _drawProjectile: vi.fn(),
      _impactFx: vi.fn(),
      _damageEnemyAt: vi.fn(),
      _damagePlayerAt: vi.fn(),
      _damageBuildingAt: vi.fn(),
      _rangeFactor: () => 1,
      _liveTargetsForTrace: () => [{ ref: target, x: target.x, y: target.y }],
      _shotIgnoresCover: () => false,
      _isHeldBeam: () => false,
      _buildEnemyIndex: () => ({ nearest: () => target }),
    });
    return s;
  }

  const tankIn = (h) => ({ ...centre(h), kind: 'tank', mech: { isDestroyed: () => false } });

  it('HITSCAN: a beam eaten by the foliage damages nothing, but still draws its impact', () => {
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ roll: 0, target });   // 0 < 0.75 ⇒ the trees eat it
    const w = { weapon: WEAPONS.beamLaser, location: 'rightArm', index: 0 };
    s._fireHitscan(w, 0, 0, 0, 'player', 'player');
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
    expect(s._impactFx).toHaveBeenCalled();           // it visibly hit the branches
  });

  it('HITSCAN: the same beam on a roll the target survives deals its damage normally', () => {
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ roll: 0.9, target });  // 0.9 >= 0.75 ⇒ through the gap
    const w = { weapon: WEAPONS.beamLaser, location: 'rightArm', index: 0 };
    s._fireHitscan(w, 0, 0, 0, 'player', 'player');
    expect(s._damageEnemyAt).toHaveBeenCalled();
  });

  it('HITSCAN: a target standing in the OPEN is never affected by the rule', () => {
    const target = tankIn(OPEN_HEX);
    const s = makeFiringScene({ roll: 0, target });
    const w = { weapon: WEAPONS.beamLaser, location: 'rightArm', index: 0 };
    s._fireHitscan(w, 0, 0, 0, 'player', 'player');
    expect(s._damageEnemyAt).toHaveBeenCalled();
  });

  function fireRound(s, target) {
    const to = { x: target.x, y: target.y };
    const round = makeProjectile(WEAPONS.autocannon, 0, 0, Math.atan2(to.y, to.x), { maxDist: 4000 });
    Object.assign(round, {
      owner: 'player', trail: [], seekTarget: null,
      originHexes: [s._hexKeyAt(0, 0)], targetHexKey: null,
    });
    s.projectiles = [round];
    for (let i = 0; i < 200 && !round.dead; i++) s._updateProjectiles(0.016);
    return round;
  }

  it('PROJECTILE: a round eaten by the foliage dies and splashes, but deals no damage', () => {
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ roll: 0, target });
    const round = fireRound(s, target);
    expect(round.dead).toBe(true);
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
    expect(s._impactFx).toHaveBeenCalled();
  });

  it('PROJECTILE: the same round on a surviving roll deals its damage', () => {
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ roll: 0.9, target });
    fireRound(s, target);
    expect(s._damageEnemyAt).toHaveBeenCalled();
  });

  // The consequence Jackson accepted, pinned as a fact rather than left implicit: an AIRBORNE
  // unit gets nothing from foliage at all, where the old size-tier rule (drones are `size:
  // 'large'`) also gave them nothing — but a grounded one now takes the vehicle treatment.
  it('PROJECTILE: an airborne drone in forest is hit regardless of the roll', () => {
    const target = { ...centre(FOREST_HEX), kind: 'drone', flying: true, mech: { isDestroyed: () => false } };
    const s = makeFiringScene({ roll: 0, target });
    fireRound(s, target);
    expect(s._damageEnemyAt).toHaveBeenCalled();
  });
});

describe('#374 the tuning dial is one table', () => {
  it('the three chances are exported together so a retune is a single edit', () => {
    expect(SOFT_COVER_BLOCK_CHANCE).toEqual({ vehicle: 0.75, mech: 0.25, air: 0 });
  });
});
