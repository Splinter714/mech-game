// #317 + #318 — what the convergence/lock system can target, and what a shot aimed at it actually
// hits.
//
// #317: soft cover was a legitimate lock target that could never be hit. The cover rule correctly
// returned false for a LARGE unit (a mech shoots clean over foliage — the whole point of the soft
// tier, #279; #374 has since made that true for every unit), so the in-flight cover test never
// stopped a round in a forest hex, and the
// own-hex `transparent` exemption couldn't help: it only ever makes a hex MORE see-through. The fix
// asks "is this my target" as a SEPARATE question from "does this terrain block", so it can stop a
// shot the terrain rule would let sail past — but only for the one hex actually aimed at.
//
// #318: base wall spans are edge-keyed geometry (#288) and so were invisible to the hex-keyed
// convergence pool, despite being the most-destroyed thing in the game.
//
// Both are driven against the REAL mixins (WorldMixin + ProjectilesMixin + TargetingMixin) on a
// minimal fake ArenaScene, so this pins the wired behaviour rather than a re-implementation.
import { describe, it, expect, vi } from 'vitest';
import { WorldMixin } from './world.js';
import { ProjectilesMixin } from './projectiles.js';
import { TargetingMixin } from './targeting.js';
import { FiringMixin } from './firing.js';
import { targetHexKeyOf } from './shared.js';
import { targetCoverExempt } from '../../data/visibility.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile } from '../../data/delivery.js';
import { makeWallEdgeSet } from '../../data/wallEdges.js';
import { edgeMidpoint } from '../../data/hexEdges.js';
import { coverBlocksForRay, isSoftCover, buildingHp, TERRAIN } from '../../data/terrain.js';
import { hexToPixel, pixelToHex, axialKey, neighbors } from '../../data/hexgrid.js';

const SOFT = 'forest';        // soft cover: real HP, but never blocks a mech's ray
const HARD = 'objective';     // hard cover: blocks everything between two other points

// A flat grass field with `special` terrain stamped at the listed hexes, each seeded into the
// matching HP map exactly as worldgen does. Wall spans optional.
function makeScene({ hexes = [], wallDefs = [] } = {}) {
  const terrain = new Map();
  for (let q = -8; q <= 8; q++) for (let r = -8; r <= 8; r++) terrain.set(axialKey(q, r), 'grass');
  const buildings = new Map(), cover = new Map();
  for (const { h, id } of hexes) {
    const k = axialKey(h.q, h.r);
    terrain.set(k, id);
    // #351 made natural terrain indestructible, so `buildingHp('forest')` is 0 and worldgen no
    // longer seeds it at all. These tests exercise the #317 IMPACT RULE — "a round stops in the hex
    // it was aimed at, while that hex stands" — which is still fully live for base structures. So
    // the harness seeds from the RAW declared HP, forcing a hex into the map to drive the rule
    // directly. Whether natural terrain ever legitimately reaches these maps is a separate
    // question, pinned by the `#351` block at the bottom of this file.
    (isSoftCover(id) ? cover : buildings).set(k, TERRAIN[id].hp ?? buildingHp(id));
  }
  const scene = Object.assign(
    {}, WorldMixin, ProjectilesMixin, TargetingMixin,
    {
      terrain, buildingHp: buildings, coverHp: cover,
      wallEdges: makeWallEdgeSet(wallDefs),
      enemies: [], projectiles: [], firePatches: [],
      px: 0, py: 0, turretAngle: 0,
      _reticlePos: null,
      visibleHexes: null,
      mech: { isDestroyed: () => false },
      time: { now: 0 },
      tileImages: new Map(), canopyImages: new Map(),
      projFx: { clear: vi.fn() },
      _impactFx: vi.fn(),
      _damagePlayerAt: vi.fn(),
      _damageEnemyAt: vi.fn(),
      _rangeFactor: () => 1,
      _redrawWallEdges() {},
      _outpostCollapseFx() {},
    },
  );
  scene._drawProjectile = vi.fn();   // pure canvas art — irrelevant here, stub AFTER the mixin
  return scene;
}

const centre = (h) => hexToPixel(h.q, h.r);
const keyOf = (h) => axialKey(h.q, h.r);

// Fire one player round from the origin toward `to`, optionally stamped as aimed at `targetHexKey`,
// and step it until it dies or runs out of travel. Returns the round.
function fireAt(scene, to, targetHexKey = null, extra = {}) {
  const angle = Math.atan2(to.y, to.x);
  const round = makeProjectile(WEAPONS.autocannon, 0, 0, angle, { maxDist: 4000 });
  Object.assign(round, {
    owner: 'player', trail: [], seekTarget: null,
    originHexes: [scene._hexKeyAt(0, 0)], targetHexKey,
    ...extra,
  });
  scene.projectiles = [round];
  for (let i = 0; i < 200 && !round.dead; i++) scene._updateProjectiles(0.016);
  return round;
}

// #338 — lock and shot are ONE predicate. The bug: targeting exempts airborne enemies from the
// sight gate by rule, firing exempted nobody by geometry, so a helicopter over a base wall was
// lockable and unhittable simultaneously. `targetCoverExempt` is now the single rule both consult;
// `_shotIgnoresCover` is the firing-side call, and the round carries the answer as `ignoresCover`.
describe('#338 a locked AIRBORNE target is shootable through cover; nothing else is', () => {
  const firing = (convergeTarget) => Object.assign({}, FiringMixin, { convergeTarget });

  it('the shot half asks the same question target eligibility does', () => {
    const flyer = { x: 100, y: 0, flying: true, mech: {} };
    expect(firing(flyer)._shotIgnoresCover('player')).toBe(targetCoverExempt(flyer));
    expect(firing(flyer)._shotIgnoresCover('player')).toBe(true);
  });

  it('a GROUND target grants no exemption — cover is untouched for everything on the deck', () => {
    expect(firing({ x: 100, y: 0, mech: {} })._shotIgnoresCover('player')).toBe(false);
    expect(firing({ x: 100, y: 0, hexKey: '2,0' })._shotIgnoresCover('player')).toBe(false);
    expect(firing(null)._shotIgnoresCover('player')).toBe(false);
  });

  it('a grounded flying kind grants no exemption either', () => {
    expect(firing({ flying: true, airborne: false, mech: {} })._shotIgnoresCover('player')).toBe(false);
  });

  it('an ENEMY shot never takes the exemption — enemies do not lock, so there is no invariant to keep', () => {
    expect(firing({ x: 100, y: 0, flying: true, mech: {} })._shotIgnoresCover('enemy')).toBe(false);
  });

  it('a round stamped ignoresCover flies through a HARD-cover hex that would otherwise stop it', () => {
    const wall = { q: 3, r: 0 }, beyond = { q: 6, r: 0 };
    const blocked = fireAt(makeScene({ hexes: [{ h: wall, id: HARD }] }), centre(beyond));
    expect(blocked.dead).toBe(true);            // the control: cover stops an ordinary round

    const s = makeScene({ hexes: [{ h: wall, id: HARD }] });
    const k = keyOf(wall), before = s.buildingHp.get(k);
    const round = fireAt(s, centre(beyond), null, { ignoresCover: true });
    expect(round.dead).toBeFalsy();             // sailed past the building...
    expect(s.buildingHp.get(k)).toBe(before);   // ...without chipping it on the way
  });

  it('a round stamped ignoresCover crosses a base WALL SPAN too — that is the helicopter case', () => {
    const a = { q: 2, r: 0 }, b = { q: 2, r: -1 };
    const mk = () => makeScene({ wallDefs: [{ a, b }] });
    const mid = edgeMidpoint(a, b);
    const past = { x: mid.x * 3, y: mid.y * 3 };
    expect(fireAt(mk(), past).dead).toBe(true);                              // control: wall stops it
    expect(fireAt(mk(), past, null, { ignoresCover: true }).dead).toBeFalsy();
  });
});

describe('#317 target identity is asked separately from terrain blocking', () => {
  it('targetHexKeyOf reads a hex target, and is null for an enemy, a span, and nothing', () => {
    expect(targetHexKeyOf({ x: 0, y: 0, hexKey: '2,3' })).toBe('2,3');
    expect(targetHexKeyOf({ x: 0, y: 0, mech: {}, hexKey: '2,3' })).toBe(null);
    expect(targetHexKeyOf({ x: 0, y: 0, edgeKey: '0,0|1,0' })).toBe(null);
    expect(targetHexKeyOf(null)).toBe(null);
  });
});

describe('#317 a TARGETED soft-cover hex is finally hittable', () => {
  const far = { q: 4, r: 0 };

  it('the bug: soft cover does not block a mech ray, so nothing ever stopped a shot in it', () => {
    // This is the mechanism, pinned so the fix can never be mistaken for a transparency tweak:
    // for a LARGE unit the cover rule itself says "does not stop the ray", exemption or not.
    expect(isSoftCover(SOFT)).toBe(true);
    expect(coverBlocksForRay(SOFT, false)).toBe(false);
    expect(coverBlocksForRay(SOFT, true)).toBe(false);
  });

  it('a shot aimed AT a forest hex impacts it and drops its HP', () => {
    const s = makeScene({ hexes: [{ h: far, id: SOFT }] });
    const k = keyOf(far), before = s.coverHp.get(k);
    const round = fireAt(s, centre(far), k);
    expect(round.dead).toBe(true);
    expect(s.coverHp.get(k)).toBeLessThan(before);
  });

  it('the same shot NOT aimed at that hex still sails clean over it (#279 preserved)', () => {
    const s = makeScene({ hexes: [{ h: far, id: SOFT }] });
    const k = keyOf(far), before = s.coverHp.get(k);
    fireAt(s, centre(far), null);            // no target stamp — merely travelling past
    expect(s.coverHp.get(k)).toBe(before);
  });

  it('a shot aimed at a DISTANT hex passes over intervening foliage and only hits its own target', () => {
    // The regression that would matter most in play: shooting past a treeline at something beyond.
    const near = { q: 2, r: 0 }, target = { q: 5, r: 0 };
    const s = makeScene({ hexes: [{ h: near, id: SOFT }, { h: target, id: SOFT }] });
    const nk = keyOf(near), tk = keyOf(target);
    const nearBefore = s.coverHp.get(nk), targetBefore = s.coverHp.get(tk);
    fireAt(s, centre(target), tk);
    expect(s.coverHp.get(nk)).toBe(nearBefore);              // flew over the near trees
    expect(s.coverHp.get(tk)).toBeLessThan(targetBefore);    // stopped in the one it was aimed at
  });

  it('a collapsed target hex stops attracting impacts — the rule only fires while it stands', () => {
    const s = makeScene({ hexes: [{ h: far, id: SOFT }] });
    const k = keyOf(far);
    s.coverHp.delete(k);                    // stand-in for "already flattened to rubble"
    const round = fireAt(s, centre(far), k);
    expect(round.dead).toBeFalsy();         // no impact — it flew on through, as open ground should
  });
});

describe('#317 the tiers and units the fix must not disturb', () => {
  // #374 UPDATED. This used to read "a SMALL unit is still blocked by soft cover" — the #269 size
  // tier #317 had to avoid disturbing. That tier is gone: soft cover blocks no one's ray now, so
  // what #317's rule must not disturb is narrower, and this pins the narrower thing.
  it('#374: soft cover blocks NO unit geometrically — #317 targeting is the only way to stop in it', () => {
    expect(coverBlocksForRay(SOFT, false)).toBe(false);
    expect(coverBlocksForRay(SOFT, true)).toBe(false);
  });

  it('HARD cover still blocks unconditionally between two other points, and is still hittable', () => {
    expect(coverBlocksForRay(HARD, false)).toBe(true);
    expect(TERRAIN[HARD].destructible).toBe(true);
    const h = { q: 4, r: 0 };
    const s = makeScene({ hexes: [{ h, id: HARD }] });
    const k = keyOf(h), before = s.buildingHp.get(k);
    // Untargeted: hard cover stops the round on its own merits, exactly as before this change.
    fireAt(s, centre(h), null);
    expect(s.buildingHp.get(k)).toBeLessThan(before);
  });
});

describe('#318 wall spans are convergence/lock targets', () => {
  const A = { q: 0, r: 0 };
  const B = neighbors(A.q, A.r)[0];
  const spanDefs = [{ a: { q: 3, r: 0 }, b: neighbors(3, 0)[0] }];

  it('a standing span appears in the pool, keyed by EDGE and positioned at its midpoint', () => {
    const s = makeScene({ wallDefs: spanDefs });
    const pool = s._destructibleTargetsNear(0, 0, 2000);
    const span = pool.find((c) => c.edgeKey);
    expect(span).toBeTruthy();
    expect(span.hexKey).toBeUndefined();          // edge-keyed identity, NOT hex-keyed
    const m = edgeMidpoint(spanDefs[0].a, spanDefs[0].b);
    expect(span.x).toBeCloseTo(m.x, 3);
    expect(span.y).toBeCloseTo(m.y, 3);
  });

  it('a DESTROYED span drops out of the pool', () => {
    const s = makeScene({ wallDefs: spanDefs });
    for (const e of s._liveWallEdges()) s._damageWallEdge(e, 99999);
    expect(s._destructibleTargetsNear(0, 0, 2000).some((c) => c.edgeKey)).toBe(false);
  });

  it('destructible HEXES still carry a hex key alongside the spans', () => {
    const h = { q: 4, r: 0 };
    const s = makeScene({ hexes: [{ h, id: SOFT }], wallDefs: spanDefs });
    const pool = s._destructibleTargetsNear(0, 0, 2000);
    expect(pool.some((c) => c.hexKey === keyOf(h))).toBe(true);
    expect(pool.some((c) => c.edgeKey)).toBe(true);
  });

  it('the lock converges on a span when there is no enemy — reticle sits on the wall', () => {
    const s = makeScene({ wallDefs: spanDefs });
    s._updateLock(0.016);
    expect(s.convergeTarget?.edgeKey).toBeTruthy();
    // #341: one target concept — the aim point IS derived from `convergeTarget` (a static
    // wall-span target resolves to its plain {x, y} point; a live enemy returns the handle itself).
    const m = edgeMidpoint(spanDefs[0].a, spanDefs[0].b);
    expect(s._lockAimPoint().x).toBeCloseTo(m.x, 3);
  });

  it('an enemy at comparable range outranks a distant wall ring (#322 enemy edge)', () => {
    // A ring is 25-30 spans, and one of them is usually somewhere ahead of you. #322 dropped the
    // structural "enemy always wins", so this is now decided on distance: the enemy is nearer than
    // the ring here (and gets the enemy range edge on top), so it must still take the reticle.
    const ring = [];
    for (const n of neighbors(6, 0)) ring.push({ a: { q: 6, r: 0 }, b: n });
    const s = makeScene({ wallDefs: ring });
    const enemy = { x: 200, y: 0, vx: 0, vy: 0, mech: { isDestroyed: () => false } };
    s.enemies = [enemy];
    s.visibleHexes = new Set([s._hexKeyAt(0, 0), s._hexKeyAt(200, 0)]);
    s._updateLock(0.016);
    expect(s.convergeTarget).toBe(enemy);
  });

  it('but a span you are standing right next to DOES beat a distant enemy now (#322)', () => {
    // The #322 fix in one case: the old rule made this structurally impossible — any live enemy,
    // at any range, always took the reticle off the wall in front of your face.
    const ring = [];
    for (const n of neighbors(A.q, A.r)) ring.push({ a: A, b: n });
    const s = makeScene({ wallDefs: ring });
    const enemy = { x: 1200, y: 60, vx: 0, vy: 0, mech: { isDestroyed: () => false } };
    s.enemies = [enemy];
    s.visibleHexes = new Set([s._hexKeyAt(0, 0), s._hexKeyAt(1200, 60)]);
    s._updateLock(0.016);
    expect(s.convergeTarget?.edgeKey).toBeTruthy();
  });

  it('a round aimed at a span detonates on it and chips its HP (spans were always hittable)', () => {
    const s = makeScene({ wallDefs: spanDefs });
    const edge = s._liveWallEdges()[0];
    const before = edge.hp;
    const m = edgeMidpoint(spanDefs[0].a, spanDefs[0].b);
    const round = fireAt(s, m, null);
    expect(round.dead).toBe(true);
    expect(s._liveWallEdges()[0].hp).toBeLessThan(before);
  });
});

// #351 (owner-confirmed experiment, 2026-07-19): "nature is permanent, their stuff isn't."
// ALL natural terrain — forests/foliage AND boulders/rock — is indestructible AND untargetable.
// Both facts fall out of one place: `buildingHp()` returns 0 for `category: 'terrain'`, so worldgen
// never seeds it into `coverHp`/`buildingHp`, and those maps are exactly what convergence candidacy
// (#322), the targeted-hex impact rule (#317) and `_damageBuildingAt` all read.
//
// TO REVERSE: flip `NATURAL_TERRAIN_DESTRUCTIBLE` in data/terrain.js back to `true`.
describe('#351 natural terrain is permanent scenery — untargetable and undamageable', () => {
  // A scene built the way worldgen actually builds one: natural terrain stamped on the map, with
  // the HP maps seeded from the LIVE `buildingHp()` rule rather than force-fed.
  function realScene(hexes) {
    const s = makeScene({});
    const buildings = new Map(), cover = new Map();
    for (const { h, id } of hexes) {
      const k = keyOf(h);
      s.terrain.set(k, id);
      const hp = buildingHp(id);                       // the live rule — 0 for natural terrain
      if (hp > 0) (isSoftCover(id) ? cover : buildings).set(k, hp);
    }
    s.buildingHp = buildings; s.coverHp = cover;
    return s;
  }

  const far = { q: 4, r: 0 };

  it('worldgen-style seeding puts no natural hex into either HP map', () => {
    const s = realScene([{ h: far, id: SOFT }]);
    expect(s.coverHp.size).toBe(0);
    expect(s.buildingHp.size).toBe(0);
    expect(s._destructibleStandingAt(keyOf(far))).toBe(false);
  });

  it('a forest hex is not a convergence/lock candidate (#322 pool)', () => {
    const s = realScene([{ h: far, id: SOFT }]);
    const pts = s._destructibleTargetsNear(0, 0, 4000);
    expect(pts.some((p) => p.hexKey === keyOf(far))).toBe(false);
  });

  it('the #322 candidate pool copes with being EMPTY once natural terrain leaves it', () => {
    const s = realScene([{ h: far, id: SOFT }]);
    expect(s._destructibleTargetsNear(0, 0, 4000)).toEqual([]);
    // The reticle update must not throw and must simply find nothing to converge on.
    s.visibleHexes = new Set([s._hexKeyAt(0, 0)]);
    expect(() => s._updateLock(0.016)).not.toThrow();
    expect(s.convergeTarget ?? null).toBe(null);
  });

  it('no path damages it — not a stray round, not one aimed squarely AT it (#317)', () => {
    for (const stamp of [null, keyOf(far)]) {
      const s = realScene([{ h: far, id: SOFT }]);
      const round = fireAt(s, centre(far), stamp);
      expect(round.dead).toBeFalsy();                       // flew straight through
      expect(s.terrain.get(keyOf(far))).toBe(SOFT);         // still forest, never rubble
      expect(s.coverHp.size).toBe(0);
    }
  });

  it('a direct stomp/splash call on a natural hex is a no-op', () => {
    const s = realScene([{ h: far, id: SOFT }]);
    const p = centre(far);
    expect(s._damageBuildingAt(p.x, p.y, 100000)).toBe(false);
    expect(s._damageBuildingAt(p.x, p.y, 100000, { flame: true })).toBe(false);
    expect(s.terrain.get(keyOf(far))).toBe(SOFT);
  });

  it('their stuff is still fully destructible and targetable — base structures and wall spans', () => {
    const s = realScene([{ h: far, id: HARD }]);
    expect(s.buildingHp.get(keyOf(far))).toBe(TERRAIN[HARD].hp);
    expect(s._destructibleTargetsNear(0, 0, 4000).some((p) => p.hexKey === keyOf(far))).toBe(true);
    const p = centre(far);
    expect(s._damageBuildingAt(p.x, p.y, 100000)).toBe(true);
  });

  // #374 UPDATED: #351's scope claim was "destructibility/targetability only, cover untouched",
  // pinned via the size tier. #374 has since changed cover deliberately, so this now pins the
  // claim that still holds — the two axes are independent, and #351 did not itself move cover.
  it('cover and destructibility stay independent axes (#351 scope), with #374 cover behaviour', () => {
    expect(isSoftCover(SOFT)).toBe(true);
    expect(coverBlocksForRay(SOFT, false)).toBe(false);   // #374 — nobody is blocked geometrically
    // And a round travelling past intact foliage is unaffected in either direction.
    const s = realScene([{ h: { q: 2, r: 0 }, id: SOFT }]);
    expect(fireAt(s, centre({ q: 6, r: 0 })).dead).toBeFalsy();
  });
});
