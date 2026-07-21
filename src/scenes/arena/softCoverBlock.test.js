// #374 — soft cover's shot block, as WIRED into the arena (the pure rule itself lives in
// data/terrain.js and is pinned in terrain.test.js).
//
// The change in one sentence (the #374 REWORK — this file previously pinned that issue's first
// landing, a single 75/25/0 roll against the TARGET's own hex only): soft cover
// (forest/scrub/drift/wreck/fumarole) no longer blocks anyone's ray geometrically — instead EVERY
// soft-cover hex a shot's lane crosses gets its own independent 10% chance of eating it, with the
// target's own hex worth 25% for a non-mech ground unit / 10% for a mech / 0 for air, and an air
// target exempt from the WHOLE lane. Jackson: "have non-mech own hex bump to 25%, and don't give
// mech own-hex additional bonus; this all will apply to enemy shots as well, right?"
// Four things have to hold for that to be real in play, and this file pins each:
//   1. the tier is read off the TARGET (`softCoverUnitTier`), from classifications that already
//      existed — the flying/airborne test and the mech-vs-vehicle `kind` split;
//   2. the LANE is walked muzzle→target (`_softCoverLane`, world.js), so intervening woods roll
//      too and the shooter's own hex drops out (the #72/#279 brawling exemption);
//   3. the roll runs on a SEEDED rng (`scene._coverRng`), never bare `Math.random`, so a run is
//      reproducible and this file can be deterministic;
//   4. it is applied at the real damage-resolution sites — the hitscan beam (firing.js) and a
//      projectile impact (projectiles.js), for ENEMY fire as much as the player's — so a blocked
//      shot deals nothing but still splashes.
import { describe, it, expect, vi } from 'vitest';
import { CombatMixin } from './combat.js';
import { FiringMixin } from './firing.js';
import { ProjectilesMixin } from './projectiles.js';
import { WorldMixin } from './world.js';
import { softCoverUnitTier } from './shared.js';
import { SOFT_COVER_HEX_BLOCK_CHANCE, SOFT_COVER_OWN_HEX_BLOCK_CHANCE } from '../../data/terrain.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile } from '../../data/delivery.js';
import { makeWallEdgeSet } from '../../data/wallEdges.js';
import { hexToPixel, axialKey } from '../../data/hexgrid.js';

// ── 1. the tier classifier ────────────────────────────────────────────────────────────────
describe('#374 softCoverUnitTier — which own-hex block chance a TARGET gets', () => {
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
// The shooter always stands at hex (0,0) / pixel (0,0). FOREST_HEX is the target hex under test;
// OPEN_HEX sits BEHIND it on the same q axis, so a lane to it crosses the forest (which is exactly
// what the rework is about); CLEAR_HEX is off that axis, so its lane crosses nothing at all.
// FOREST_MID + FOREST_HEX give a two-soft-hex lane for the compounding tests.
const FOREST_HEX = { q: 4, r: 0 };
const FOREST_MID = { q: 2, r: 0 };
const OPEN_HEX = { q: 6, r: 0 };
const CLEAR_HEX = { q: 0, r: 5 };
const centre = (h) => hexToPixel(h.q, h.r);

// `extraForest`: also plant FOREST_MID, for the multi-hex-lane assertions.
function makeScene({ roll = 0, rolls = null, extraForest = false } = {}) {
  const terrain = new Map();
  for (let q = -8; q <= 8; q++) for (let r = -8; r <= 8; r++) terrain.set(axialKey(q, r), 'grass');
  terrain.set(axialKey(FOREST_HEX.q, FOREST_HEX.r), 'forest');
  if (extraForest) terrain.set(axialKey(FOREST_MID.q, FOREST_MID.r), 'forest');
  const scene = Object.assign({}, WorldMixin, CombatMixin, {
    terrain,
    buildingHp: new Map(), coverHp: new Map(),
    wallEdges: makeWallEdgeSet([]),
    enemies: [], projectiles: [], firePatches: [],
    // A scripted rng in place of the seeded one, so every assertion below is exact rather than
    // statistical. Production builds this lazily from `runSeed` (see `_softCoverStopsShot`).
    // `rolls` scripts a SEQUENCE, for lanes that take more than one draw.
    _coverRng: rolls ? (() => { let i = 0; return () => rolls[i++ % rolls.length]; })() : () => roll,
  });
  return scene;
}

describe('#374 REWORK: _softCoverStopsShot — the scene-level per-hex lane roll', () => {
  const at = (h, extra = {}) => ({ ...centre(h), mech: {}, ...extra });
  // Every scene-level call now names WHERE the shot came from — the shooter at pixel (0,0).
  const MUZZLE = { x: 0, y: 0 };
  const roll = (s, target, originHexes = null, origin = MUZZLE) =>
    s._softCoverStopsShot(target, originHexes, origin);

  // #374 block-visual: `_softCoverStopsShot` now returns the CENTRE `{x, y}` of the blocking hex
  // (where the leaf puff detonates) when eaten, or `null` when the shot gets through. `blockAt`
  // pins that the returned point is a specific hex's centre.
  const blockAt = (h) => ({ x: centre(h).x, y: centre(h).y });

  it('a target with a lane crossing NO soft cover is never blocked, however the dice fall', () => {
    const s = makeScene({ roll: 0 });
    expect(roll(s, at(CLEAR_HEX))).toBeNull();
  });

  // The own-hex chances: this is the "no mech bonus" half of Jackson's instruction.
  it('a MECH target in forest gets NO own-hex bonus — its own hex is a plain 10%', () => {
    // ...and when eaten, the puff detonates at that own (forest) hex's centre.
    expect(roll(makeScene({ roll: 0.09 }), at(FOREST_HEX))).toEqual(blockAt(FOREST_HEX));
    expect(roll(makeScene({ roll: 0.10 }), at(FOREST_HEX))).toBeNull();
    expect(roll(makeScene({ roll: 0.2 }), at(FOREST_HEX))).toBeNull();
  });

  it('a non-mech GROUND target bumps its OWN hex to 25% — and only its own hex', () => {
    const tank = { kind: 'tank' };
    expect(roll(makeScene({ roll: 0.24 }), at(FOREST_HEX, tank))).toEqual(blockAt(FOREST_HEX));
    expect(roll(makeScene({ roll: 0.25 }), at(FOREST_HEX, tank))).toBeNull();
    // an INTERVENING forest hex is still only 10% for that same tank: standing at OPEN_HEX
    // (behind the woods) its lane crosses the forest as a plain hex — and the puff detonates
    // mid-lane AT that crossed forest hex, not at the tank.
    expect(roll(makeScene({ roll: 0.15 }), at(OPEN_HEX, tank))).toBeNull();
    expect(roll(makeScene({ roll: 0.05 }), at(OPEN_HEX, tank))).toEqual(blockAt(FOREST_HEX));
  });

  // THE HEADLINE BEHAVIOUR: foliage between you and the target now matters at all.
  it('a shot at a target in the CLEAR is blocked by woods it merely CROSSES', () => {
    const s = makeScene({ roll: 0.05 });          // 0.05 < 0.10
    // ...and the block reports the crossed forest hex's centre, not the clear target's.
    expect(roll(s, at(OPEN_HEX))).toEqual(blockAt(FOREST_HEX));
    expect(roll(makeScene({ roll: 0.5 }), at(OPEN_HEX))).toBeNull();
  });

  it('two soft hexes in one lane are rolled INDEPENDENTLY — either can eat the shot', () => {
    // rolls: [first hex, second hex]. Only the SECOND (FOREST_HEX) is under 10%, and it blocks there.
    expect(roll(makeScene({ rolls: [0.5, 0.05], extraForest: true }), at(OPEN_HEX))).toEqual(blockAt(FOREST_HEX));
    // only the first (FOREST_MID) under 10% ⇒ the puff detonates at that nearer hex
    expect(roll(makeScene({ rolls: [0.05, 0.5], extraForest: true }), at(OPEN_HEX))).toEqual(blockAt(FOREST_MID));
    // neither ⇒ through, where a single-hex lane on the same dice also gets through
    expect(roll(makeScene({ rolls: [0.5, 0.5], extraForest: true }), at(OPEN_HEX))).toBeNull();
  });

  it('the lane really is walked: an intervening forest takes its own draw', () => {
    const rng = vi.fn(() => 0.5);
    const s = makeScene({ extraForest: true });
    s._coverRng = rng;
    // FOREST_MID + FOREST_HEX crossed, then OPEN_HEX (grass) as the own hex ⇒ two draws.
    roll(s, at(OPEN_HEX));
    expect(rng).toHaveBeenCalledTimes(2);
  });

  // Air's exemption is now LANE-WIDE, which is the part Jackson chose over physical consistency.
  it('an AIRBORNE target ignores the ENTIRE lane, not just its own hex', () => {
    const heli = { kind: 'helicopter', flying: true };
    const rng = vi.fn(() => 0);
    const s = makeScene({ extraForest: true });
    s._coverRng = rng;
    // in the trees itself...
    expect(roll(s, at(FOREST_HEX, heli))).toBeNull();
    // ...and behind two forest hexes, where a ground target would almost certainly be stopped
    expect(roll(s, at(OPEN_HEX, heli))).toBeNull();
    expect(rng).not.toHaveBeenCalled();
    expect(roll(makeScene({ roll: 0, extraForest: true }), at(OPEN_HEX))).toEqual(blockAt(FOREST_MID));
  });

  // #72/#279's own-hex exemption, carried into the lane rule: it survives, expressed as the
  // shooter's muzzle hex being OMITTED from the lane.
  it('the own-hex exemption holds — a shooter in the SAME forest hex is never blocked', () => {
    const s = makeScene({ roll: 0 });
    const forestPt = centre(FOREST_HEX);
    const sameHex = [s._hexKeyAt(forestPt.x, forestPt.y)];
    // shooter standing in the target's own thicket: empty lane, no roll
    expect(s._softCoverStopsShot(at(FOREST_HEX), sameHex, forestPt)).toBeNull();
    // ...but a shooter standing anywhere else rolls normally.
    expect(roll(s, at(FOREST_HEX), sameHex.slice(0, 0))).toEqual(blockAt(FOREST_HEX));
    expect(roll(s, at(FOREST_HEX), null)).toEqual(blockAt(FOREST_HEX));
  });

  it('with no origin the rule degrades to the target own-hex lane — never to an exception', () => {
    const s = makeScene({ roll: 0 });
    // the fallback still reports a real block point — the target's own hex centre.
    expect(s._softCoverStopsShot(at(FOREST_HEX))).toEqual(blockAt(FOREST_HEX));
    expect(s._softCoverStopsShot(at(CLEAR_HEX))).toBeNull();
    // the own-hex exemption still applies without an origin
    const forestPt = centre(FOREST_HEX);
    expect(s._softCoverStopsShot(at(FOREST_HEX), [s._hexKeyAt(forestPt.x, forestPt.y)])).toBeNull();
  });

  it('a target with no position cannot be rolled for, and is never blocked', () => {
    const s = makeScene({ roll: 0 });
    expect(s._softCoverStopsShot(null)).toBeNull();
    expect(s._softCoverStopsShot({ mech: {} })).toBeNull();
  });

  // The seeding requirement, stated as a test: no bare Math.random, and the same run seed must
  // reproduce the same sequence of blocks — now with MORE draws per shot than before.
  it('rolls on a SEEDED rng derived from runSeed — not Math.random — and repeats for a seed', () => {
    const spy = vi.spyOn(Math, 'random');
    const run = (runSeed) => {
      const s = makeScene({ extraForest: true });
      delete s._coverRng;                      // force the lazy production construction
      s.runSeed = runSeed;
      const tank = at(OPEN_HEX, { kind: 'tank' });
      // map the point-or-null return to a plain blocked? boolean for the sequence comparison
      return Array.from({ length: 40 }, () => !!roll(s, tank));
    };
    const a = run(1234), b = run(1234), c = run(9999);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(a).toEqual(b);                      // same seed ⇒ same outcomes
    expect(a).not.toEqual(c);                  // a different seed genuinely differs
    // ...and it is a real roll, not a stuck constant.
    expect(a).toContain(true);
    expect(a).toContain(false);
  });
});

// ── _softCoverLane — the traversal itself ─────────────────────────────────────────────────
describe('#374 REWORK: _softCoverLane — the soft-cover hexes a shot crosses', () => {
  it('lists the crossed soft hexes, with the target hex last and marked ownHex — each stamped with its centre', () => {
    const s = makeScene({ extraForest: true });
    const to = centre(FOREST_HEX);
    const lane = s._softCoverLane(0, 0, to.x, to.y);
    // #374 block-visual: every lane entry carries its hex CENTRE, so a block can detonate there.
    expect(lane).toEqual([
      { id: 'forest', ownHex: false, x: centre(FOREST_MID).x, y: centre(FOREST_MID).y },   // FOREST_MID, crossed
      { id: 'forest', ownHex: true, x: centre(FOREST_HEX).x, y: centre(FOREST_HEX).y },     // FOREST_HEX, the destination
    ]);
  });

  it('ignores non-soft terrain entirely — a lane over open ground is empty', () => {
    const s = makeScene();
    const to = centre(CLEAR_HEX);
    expect(s._softCoverLane(0, 0, to.x, to.y)).toEqual([]);
  });

  it('omits the shooter\'s own hex and its stamped originHexes — the brawling exemption', () => {
    const s = makeScene();
    const f = centre(FOREST_HEX);
    // muzzle and target in the SAME forest hex ⇒ nothing to roll
    expect(s._softCoverLane(f.x, f.y, f.x, f.y)).toEqual([]);
    // and an originHexes stamp naming that hex does the same from a nearby muzzle point
    expect(s._softCoverLane(f.x + 1, f.y + 1, f.x, f.y, [s._hexKeyAt(f.x, f.y)])).toEqual([]);
  });

  it('never rolls one hex twice for a single shot', () => {
    const s = makeScene({ extraForest: true });
    const to = centre(OPEN_HEX);
    const lane = s._softCoverLane(0, 0, to.x, to.y);
    expect(lane).toHaveLength(2);                       // FOREST_MID + FOREST_HEX, once each
    expect(lane.every((h) => h.ownHex === false)).toBe(true);   // OPEN_HEX itself is grass
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
      _foliageBlockFx: vi.fn(),
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
    const s = makeFiringScene({ roll: 0, target });   // 0 < 0.25 ⇒ the trees eat it
    const w = { weapon: WEAPONS.beamLaser, location: 'rightArm', index: 0 };
    s._fireHitscan(w, 0, 0, 0, 'player', 'player');
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
    expect(s._impactFx).toHaveBeenCalled();           // it visibly hit the branches
  });

  it('HITSCAN: the same beam on a roll the target survives deals its damage normally', () => {
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ roll: 0.9, target });  // 0.9 >= 0.25 ⇒ through the gap
    const w = { weapon: WEAPONS.beamLaser, location: 'rightArm', index: 0 };
    s._fireHitscan(w, 0, 0, 0, 'player', 'player');
    expect(s._damageEnemyAt).toHaveBeenCalled();
  });

  it('HITSCAN: a target whose lane crosses no soft cover is never affected by the rule', () => {
    const target = tankIn(CLEAR_HEX);
    const s = makeFiringScene({ roll: 0, target });
    const w = { weapon: WEAPONS.beamLaser, location: 'rightArm', index: 0 };
    s._fireHitscan(w, 0, 0, Math.atan2(target.y, target.x), 'player', 'player');
    expect(s._damageEnemyAt).toHaveBeenCalled();
  });

  // The rework's other headline at the wiring level: a beam at a target in the CLEAR can now be
  // eaten by woods it merely passes over.
  it('HITSCAN: woods CROSSED on the way to a clear target can eat the beam', () => {
    const target = tankIn(OPEN_HEX);                  // sits behind FOREST_HEX
    const s = makeFiringScene({ roll: 0.05, target }); // 0.05 < 0.10, the crossed-hex chance
    const w = { weapon: WEAPONS.beamLaser, location: 'rightArm', index: 0 };
    s._fireHitscan(w, 0, 0, 0, 'player', 'player');
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
    expect(s._impactFx).toHaveBeenCalled();
  });

  function fireRound(s, target) {
    const to = { x: target.x, y: target.y };
    const round = makeProjectile(WEAPONS.autocannon, 0, 0, Math.atan2(to.y, to.x), { maxDist: 4000 });
    Object.assign(round, {
      owner: 'player', trail: [], seekTarget: null,
      originHexes: [s._hexKeyAt(0, 0)], targetHexKey: null,
      // #374 REWORK: the spawn point the soft-cover lane is walked from (firing.js stamps this).
      originX: 0, originY: 0,
    });
    s.projectiles = [round];
    for (let i = 0; i < 200 && !round.dead; i++) s._updateProjectiles(0.016);
    return round;
  }

  it('PROJECTILE: a round eaten by the foliage dies and puffs in the trees, but deals no damage', () => {
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ roll: 0, target });
    const round = fireRound(s, target);
    expect(round.dead).toBe(true);
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
    // #374 block-visual: a blocked PROJECTILE plays the distinct foliage puff, NOT a weapon splash.
    expect(s._foliageBlockFx).toHaveBeenCalled();
    expect(s._impactFx).not.toHaveBeenCalled();
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

// ── SYMMETRY: enemy fire obeys the identical rule ─────────────────────────────────────────
// Jackson asked directly: "this all will apply to enemy shots as well, right?" It does, and it
// does so structurally rather than by a parallel code path — `_softCoverStopsShot` reads the
// TARGET's tier and the lane geometry, and never looks at who fired.
describe('#374 REWORK: ENEMY shots obey the same lane rule', () => {
  // A player standing in the forest, shot at by an enemy standing at the origin.
  function makeEnemyFiringScene({ roll, playerHex, extraForest = false }) {
    const pt = centre(playerHex);
    const player = {
      id: 'p1', x: pt.x, y: pt.y, convergeTarget: null,
      mech: { isDestroyed: () => false },
    };
    const s = makeScene({ roll, extraForest });
    Object.assign(s, FiringMixin, ProjectilesMixin, {
      beams: [], enemies: [], players: [player],
      time: { now: 0, delayedCall: () => {} },
      projFx: { clear: vi.fn() },
      _drawProjectile: vi.fn(),
      _impactFx: vi.fn(),
      _foliageBlockFx: vi.fn(),
      _damageEnemyAt: vi.fn(),
      _damagePlayerAt: vi.fn(),
      _damageBuildingAt: vi.fn(),
      _rangeFactor: () => 1,
      _liveTargetsForTrace: () => [{ ref: player, x: player.x, y: player.y }],
      _shotIgnoresCover: () => false,
      _isHeldBeam: () => false,
      _buildEnemyIndex: () => ({ nearest: () => null }),
    });
    return { s, player };
  }

  function fireEnemyRound(s, player) {
    const round = makeProjectile(WEAPONS.autocannon, 0, 0,
      Math.atan2(player.y, player.x), { maxDist: 4000 });
    Object.assign(round, {
      owner: 'enemy', trail: [], seekTarget: null,
      originHexes: [s._hexKeyAt(0, 0)], targetHexKey: null, originX: 0, originY: 0,
    });
    s.projectiles = [round];
    for (let i = 0; i < 200 && !round.dead; i++) s._updateProjectiles(0.016);
    return round;
  }

  it('an enemy round at a player standing in forest is eaten on the own-hex roll', () => {
    const { s, player } = makeEnemyFiringScene({ roll: 0.05, playerHex: FOREST_HEX });
    const round = fireEnemyRound(s, player);
    expect(round.dead).toBe(true);
    expect(s._damagePlayerAt).not.toHaveBeenCalled();
    // #374 block-visual: symmetric — an eaten ENEMY round puffs in the foliage too.
    expect(s._foliageBlockFx).toHaveBeenCalled();
    expect(s._impactFx).not.toHaveBeenCalled();
  });

  it('the same enemy round on a surviving roll damages the player normally', () => {
    const { s, player } = makeEnemyFiringScene({ roll: 0.9, playerHex: FOREST_HEX });
    fireEnemyRound(s, player);
    expect(s._damagePlayerAt).toHaveBeenCalled();
  });

  it('a player is a MECH to enemy fire too — its own hex gets no 25% bump', () => {
    // 0.15 is under the vehicle own-hex 25% but over the mech 10%: the player takes the hit.
    const { s, player } = makeEnemyFiringScene({ roll: 0.15, playerHex: FOREST_HEX });
    fireEnemyRound(s, player);
    expect(s._damagePlayerAt).toHaveBeenCalled();
  });

  it('woods the enemy shot merely CROSSES eat it, exactly as for player fire', () => {
    // The player stands in the clear at OPEN_HEX, behind the forest.
    const { s, player } = makeEnemyFiringScene({ roll: 0.05, playerHex: OPEN_HEX });
    fireEnemyRound(s, player);
    expect(s._damagePlayerAt).not.toHaveBeenCalled();
  });

  it('an enemy BEAM obeys it as well — the hitscan path is shared', () => {
    const { s, player } = makeEnemyFiringScene({ roll: 0.05, playerHex: FOREST_HEX });
    const w = { weapon: WEAPONS.beamLaser, location: 'rightArm', index: 0 };
    s._fireHitscan(w, 0, 0, 0, 'enemy', 'e1');
    expect(s._damagePlayerAt).not.toHaveBeenCalled();
    expect(s._impactFx).toHaveBeenCalled();
    // ...and lands when the dice allow
    const clear = makeEnemyFiringScene({ roll: 0.9, playerHex: FOREST_HEX });
    clear.s._fireHitscan(w, 0, 0, 0, 'enemy', 'e1');
    expect(clear.s._damagePlayerAt).toHaveBeenCalled();
  });
});

describe('#374 REWORK: the tuning dials', () => {
  it('the per-hex chance and the own-hex table are exported so a retune is a two-line edit', () => {
    expect(SOFT_COVER_HEX_BLOCK_CHANCE).toBe(0.10);
    expect(SOFT_COVER_OWN_HEX_BLOCK_CHANCE).toEqual({ vehicle: 0.25, mech: 0.10, air: 0 });
  });
});
