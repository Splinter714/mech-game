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

describe('#374 REWORK (in-flight): _softCoverStopsShot — the RESOLUTION roll, TARGET OWN HEX only', () => {
  // Since the rework the intervening lane hexes are rolled IN FLIGHT (a projectile per step, a
  // hitscan trace along its whole path — see the wiring blocks below), so this resolution roll is
  // scoped down to just the TARGET'S OWN hex, with the tier bump (vehicle 25% / mech 10% / air 0).
  // It never re-walks the lane, so a hex is never rolled twice.
  const at = (h, extra = {}) => ({ ...centre(h), mech: {}, ...extra });
  const roll = (s, target, originHexes = null) => s._softCoverStopsShot(target, originHexes);
  // Returns the CENTRE `{x, y}` of the target's own hex (where the leaf puff detonates) when eaten.
  const blockAt = (h) => ({ x: centre(h).x, y: centre(h).y });

  it('a target whose OWN hex is not soft cover is never blocked, however the dice fall', () => {
    expect(roll(makeScene({ roll: 0 }), at(CLEAR_HEX))).toBeNull();
    // even standing BEHIND woods: the intervening forest is the in-flight roll's job, not this one.
    expect(roll(makeScene({ roll: 0 }), at(OPEN_HEX))).toBeNull();
  });

  // The own-hex chances: this is the "no mech bonus" half of Jackson's instruction.
  it('a MECH target in forest gets NO own-hex bonus — its own hex is a plain 10%', () => {
    expect(roll(makeScene({ roll: 0.09 }), at(FOREST_HEX))).toEqual(blockAt(FOREST_HEX));
    expect(roll(makeScene({ roll: 0.10 }), at(FOREST_HEX))).toBeNull();
    expect(roll(makeScene({ roll: 0.2 }), at(FOREST_HEX))).toBeNull();
  });

  it('a non-mech GROUND target bumps its OWN hex to 25%', () => {
    const tank = { kind: 'tank' };
    expect(roll(makeScene({ roll: 0.24 }), at(FOREST_HEX, tank))).toEqual(blockAt(FOREST_HEX));
    expect(roll(makeScene({ roll: 0.25 }), at(FOREST_HEX, tank))).toBeNull();
  });

  it('rolls the target OWN hex ONCE — a single draw, never the whole lane', () => {
    // FOREST_MID is also planted, so the OLD lane-walk would have taken two draws; the reworked
    // resolution roll takes exactly one — the own hex — leaving the intervening woods to in-flight.
    const rng = vi.fn(() => 0.5);
    const s = makeScene({ extraForest: true });
    s._coverRng = rng;
    roll(s, at(FOREST_HEX));
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it('an AIRBORNE target is exempt from its own-hex roll too', () => {
    const heli = { kind: 'helicopter', flying: true };
    const rng = vi.fn(() => 0);
    const s = makeScene({});
    s._coverRng = rng;
    expect(roll(s, at(FOREST_HEX, heli))).toBeNull();
    expect(rng).not.toHaveBeenCalled();
  });

  // #72/#279's own-hex exemption: the shooter standing in the target's own thicket never rolls.
  it('the brawling exemption holds — muzzle hex IS the target hex ⇒ no roll', () => {
    const s = makeScene({ roll: 0 });
    const forestPt = centre(FOREST_HEX);
    const sameHex = [s._hexKeyAt(forestPt.x, forestPt.y)];
    expect(s._softCoverStopsShot(at(FOREST_HEX), sameHex)).toBeNull();
    // ...but a shooter standing anywhere else rolls the own hex normally.
    expect(roll(s, at(FOREST_HEX), null)).toEqual(blockAt(FOREST_HEX));
  });

  it('a target with no position cannot be rolled for, and is never blocked', () => {
    const s = makeScene({ roll: 0 });
    expect(s._softCoverStopsShot(null)).toBeNull();
    expect(s._softCoverStopsShot({ mech: {} })).toBeNull();
  });

  // The seeding requirement: no bare Math.random, and the same run seed reproduces the outcomes.
  it('rolls on a SEEDED rng derived from runSeed — not Math.random — and repeats for a seed', () => {
    const spy = vi.spyOn(Math, 'random');
    const run = (runSeed) => {
      const s = makeScene({});
      delete s._coverRng;                      // force the lazy production construction
      s.runSeed = runSeed;
      const tank = at(FOREST_HEX, { kind: 'tank' });
      return Array.from({ length: 60 }, () => !!roll(s, tank));
    };
    const a = run(1234), b = run(1234), c = run(9999);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(a).toEqual(b);                      // same seed ⇒ same outcomes
    expect(a).not.toEqual(c);                  // a different seed genuinely differs
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

// ── the real damage-resolution sites, plus the NEW in-flight pass-through ──────────────────
describe('#374 REWORK: a shot is eaten IN FLIGHT / at resolution — no damage, normal impact FX at the stop point', () => {
  function makeFiringScene({ roll, rolls, target, extraForest = false }) {
    const s = makeScene({ roll, rolls, extraForest });
    Object.assign(s, FiringMixin, ProjectilesMixin, {
      beams: [], enemies: target ? [target] : [],
      players: [{ id: 'p1', x: 0, y: 0, convergeTarget: null, mech: { isDestroyed: () => false } }],
      time: { now: 0, delayedCall: () => {} },
      projFx: { clear: vi.fn() },
      _drawProjectile: vi.fn(),
      _impactFx: vi.fn(),
      _damageEnemyAt: vi.fn(),
      _damagePlayerAt: vi.fn(),
      _damageBuildingAt: vi.fn(),
      _rangeFactor: () => 1,
      _liveTargetsForTrace: () => (target ? [{ ref: target, x: target.x, y: target.y }] : []),
      _shotIgnoresCover: () => false,
      _isHeldBeam: () => false,
      _buildEnemyIndex: () => ({ nearest: () => target ?? null }),
    });
    return s;
  }

  const tankIn = (h) => ({ ...centre(h), kind: 'tank', mech: { isDestroyed: () => false } });
  const W = { weapon: WEAPONS.beamLaser, location: 'rightArm', index: 0 };
  const lastBeam = (s) => s.beams[s.beams.length - 1];

  // fire a projectile from (0,0) toward `to`, stepping until it resolves. `airTarget` stamps the
  // flyer-exempt flag firing.js derives from a locked airborne target.
  function fireRound(s, to, { airTarget = false, maxDist = 4000 } = {}) {
    const round = makeProjectile(WEAPONS.autocannon, 0, 0, Math.atan2(to.y, to.x), { maxDist });
    Object.assign(round, {
      owner: 'player', trail: [], seekTarget: null,
      originHexes: [s._hexKeyAt(0, 0)], targetHexKey: null,
      originX: 0, originY: 0, _lastHexKey: s._hexKeyAt(0, 0), airTarget,
    });
    s.projectiles = [round];
    for (let i = 0; i < 400 && !round.dead; i++) s._updateProjectiles(0.016);
    return round;
  }

  // ── HITSCAN (whole-trace walk) ──
  it('HITSCAN: a beam eaten by the foliage deals nothing but plays its normal beam impact at the stop point', () => {
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ roll: 0, target });   // 0 < 0.25 ⇒ the trees eat it
    s._fireHitscan(W, 0, 0, 0, 'player', 'player');
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
    // #374: the block now plays the round's OWN normal beam impact FX at the clamp point (the beam's
    // stopped endpoint, projected into the blocking hex), not a distinct puff at the hex centre.
    expect(s._impactFx).toHaveBeenCalledTimes(1);
    const [ix, , , kind] = s._impactFx.mock.calls[0];
    expect(kind).toBe('beam');
    expect(ix).toBeCloseTo(centre(FOREST_HEX).x, 3);
  });

  it('HITSCAN: the same beam on a roll the target survives deals its damage normally', () => {
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ roll: 0.9, target });  // 0.9 >= 0.25 ⇒ through the gap
    s._fireHitscan(W, 0, 0, 0, 'player', 'player');
    expect(s._damageEnemyAt).toHaveBeenCalled();
  });

  it('HITSCAN: a target whose trace crosses no soft cover is never affected by the rule', () => {
    const target = tankIn(CLEAR_HEX);
    const s = makeFiringScene({ roll: 0, target });
    s._fireHitscan(W, 0, 0, Math.atan2(target.y, target.x), 'player', 'player');
    expect(s._damageEnemyAt).toHaveBeenCalled();
  });

  // The rework's headline: a beam at a target in the CLEAR is eaten by woods it merely crosses,
  // and visibly STOPS at that hex rather than drawing through to the target.
  it('HITSCAN: woods CROSSED on the way to a clear target eat the beam, which stops there', () => {
    const target = tankIn(OPEN_HEX);                  // sits behind FOREST_HEX
    const s = makeFiringScene({ roll: 0.05, target }); // 0.05 < 0.10, the crossed-hex chance
    s._fireHitscan(W, 0, 0, 0, 'player', 'player');
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
    expect(s._impactFx).toHaveBeenCalledTimes(1);
    expect(s._impactFx.mock.calls[0][0]).toBeCloseTo(centre(FOREST_HEX).x, 3);   // impact at the stop point
    expect(lastBeam(s).x1).toBeCloseTo(centre(FOREST_HEX).x, 3);   // stopped mid-trace, not drawn through
  });

  it('HITSCAN (no target): a beam lanced into EMPTY woods still rolls, impacts, and stops there', () => {
    const s = makeFiringScene({ roll: 0.05, extraForest: true });   // no target at all
    s._fireHitscan(W, 0, 0, 0, 'player', 'player');
    expect(s._impactFx).toHaveBeenCalledTimes(1);
    expect(s._impactFx.mock.calls[0][0]).toBeCloseTo(centre(FOREST_MID).x, 3);
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
    expect(lastBeam(s).x1).toBeCloseTo(centre(FOREST_MID).x, 3);
  });

  // ── PROJECTILE (per-step in flight + own-hex at resolution) ──
  it('PROJECTILE: a round eaten resolving on a target in forest impacts at the stop point, no damage', () => {
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ roll: 0, target });   // own-hex 25%, 0 < 0.25
    const round = fireRound(s, target);
    expect(round.dead).toBe(true);
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
    // #374: the eaten round plays its OWN normal impact FX where it was caught (near the target),
    // not a puff at the hex centre — but deals nothing.
    expect(s._impactFx).toHaveBeenCalledTimes(1);
  });

  it('PROJECTILE: the same round on a surviving roll deals its damage', () => {
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ roll: 0.9, target });
    fireRound(s, target);
    expect(s._damageEnemyAt).toHaveBeenCalled();
  });

  it('PROJECTILE (no target): a round fired into EMPTY woods impacts and dies in the trees', () => {
    const s = makeFiringScene({ roll: 0.05, extraForest: true });   // 0.05 < 0.10
    const round = fireRound(s, centre(OPEN_HEX), { maxDist: 900 });
    expect(round.dead).toBe(true);
    // eaten at the FIRST forest hex it enters (FOREST_MID) — its normal impact FX plays where it
    // was caught, so the impact x lands inside that hex (a hex spans ±HEX_SIZE of its centre).
    expect(s._impactFx).toHaveBeenCalledTimes(1);
    expect(s._impactFx.mock.calls[0][0]).toBeCloseTo(centre(FOREST_MID).x, -2);
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
  });

  it('PROJECTILE (no target): survives the open dice and lands normally — no early block', () => {
    const s = makeFiringScene({ roll: 0.5, extraForest: true });
    const round = fireRound(s, centre(OPEN_HEX), { maxDist: 900 });
    expect(round.dead).toBe(true);
    // it flew clean through the woods and ran out its range: the ONLY impact is the normal landing
    // one out at max range (x well past the two forest hexes), never an in-flight block inside them.
    expect(s._impactFx).toHaveBeenCalledTimes(1);
    expect(s._impactFx.mock.calls[0][0]).toBeGreaterThan(centre(FOREST_HEX).x + 100);
  });

  it('PROJECTILE: each crossed forest hex rolls INDEPENDENTLY — the impact is at the FIRST that eats it', () => {
    // FOREST_MID is entered before FOREST_HEX, so rolls[0] is MID's draw, rolls[1] is HEX's.
    const midEats = makeFiringScene({ rolls: [0.05, 0.5], extraForest: true });
    fireRound(midEats, centre(OPEN_HEX), { maxDist: 900 });
    expect(midEats._impactFx).toHaveBeenCalledTimes(1);
    expect(midEats._impactFx.mock.calls[0][0]).toBeCloseTo(centre(FOREST_MID).x, -2);

    const hexEats = makeFiringScene({ rolls: [0.5, 0.05], extraForest: true });
    fireRound(hexEats, centre(OPEN_HEX), { maxDist: 900 });
    expect(hexEats._impactFx).toHaveBeenCalledTimes(1);
    expect(hexEats._impactFx.mock.calls[0][0]).toBeCloseTo(centre(FOREST_HEX).x, -2);
  });

  it('PROJECTILE: an intervening forest is NOT double-rolled with the target own hex', () => {
    // A tank sits in FOREST_HEX behind FOREST_MID (extraForest). rolls: MID (in flight) then the
    // own hex (resolution). MID survives (0.5), own-hex vehicle 25% eats it (0.2) — exactly TWO
    // draws total, one per hex, never MID twice.
    const rng = vi.fn(() => 0.5);
    let seq = [0.5, 0.2], i = 0;
    rng.mockImplementation(() => seq[i++] ?? 0.5);
    const target = tankIn(FOREST_HEX);
    const s = makeFiringScene({ target, extraForest: true });
    s._coverRng = rng;
    fireRound(s, target);
    expect(rng).toHaveBeenCalledTimes(2);
    expect(s._impactFx).toHaveBeenCalledTimes(1);   // eaten on the own-hex roll → impact at the stop point
    expect(s._damageEnemyAt).not.toHaveBeenCalled();
  });

  // The flyer exemption, the part Jackson chose over physical consistency: an AIRBORNE target is
  // exempt from the WHOLE lane, in flight and at resolution — the `airTarget` flag firing.js stamps.
  it('PROJECTILE: an air-aimed round crossing forest is NEVER eaten, even on a guaranteed roll', () => {
    const target = { ...centre(OPEN_HEX), kind: 'drone', flying: true, mech: { isDestroyed: () => false } };
    const s = makeFiringScene({ roll: 0, target, extraForest: true });   // would eat everything...
    fireRound(s, target, { airTarget: true });                            // ...but it's air-aimed
    expect(s._damageEnemyAt).toHaveBeenCalled();                          // never eaten → damages normally
  });

  // The statistical shape Jackson asked for: crossing k=2 forest hexes with no target is eaten at
  // ~1 − 0.9² ≈ 0.19 over many SEEDED rolls (the real mulberry32, not the scripted stub).
  it('PROJECTILE (no target): ~1 − 0.9^k eaten crossing k=2 forest hexes over many rolls', () => {
    const s = makeFiringScene({ extraForest: true });
    delete s._coverRng;                       // force the lazy production mulberry32
    s.runSeed = 20260720;
    const N = 2000; let eaten = 0;
    const woodsEdge = centre(FOREST_HEX).x + 100;   // past both forest hexes but short of max range
    for (let n = 0; n < N; n++) {
      s._impactFx.mockClear();
      // no target/wall: an un-eaten round still impacts once when it LANDS out at max range, so
      // "eaten" is an impact that fired INSIDE the woods (before the landing point), not any impact.
      fireRound(s, centre(OPEN_HEX), { maxDist: 900 });
      if (s._impactFx.mock.calls.some((c) => c[0] < woodsEdge)) eaten++;
    }
    const rate = eaten / N;
    expect(rate).toBeGreaterThan(0.15);
    expect(rate).toBeLessThan(0.24);          // centred on ≈ 0.19
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
      _lastHexKey: s._hexKeyAt(0, 0), airTarget: false,
    });
    s.projectiles = [round];
    for (let i = 0; i < 300 && !round.dead; i++) s._updateProjectiles(0.016);
    return round;
  }

  it('an enemy round at a player standing in forest is eaten on the own-hex roll', () => {
    const { s, player } = makeEnemyFiringScene({ roll: 0.05, playerHex: FOREST_HEX });
    const round = fireEnemyRound(s, player);
    expect(round.dead).toBe(true);
    expect(s._damagePlayerAt).not.toHaveBeenCalled();
    // #374 block-visual: symmetric — an eaten ENEMY round plays its normal impact at the stop point too.
    expect(s._impactFx).toHaveBeenCalledTimes(1);
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
    void player;
    const w = { weapon: WEAPONS.beamLaser, location: 'rightArm', index: 0 };
    s._fireHitscan(w, 0, 0, 0, 'enemy', 'e1');
    expect(s._damagePlayerAt).not.toHaveBeenCalled();
    expect(s._impactFx).toHaveBeenCalledTimes(1);
    expect(s._impactFx.mock.calls[0][0]).toBeCloseTo(centre(FOREST_HEX).x, 3);
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
