// #306 + #460 — targeting respects line of sight: the convergence/lock system must not acquire an
// enemy the player has no sight of, so breaking a sightline genuinely protects a unit. Flying
// enemies (#338) and wall turrets (#426) stay targetable regardless.
//
// ── Why this file was rewired (#460) ──
// It used to build its scene doubles with a hand-made `visibleHexes` set and no `_enemyVisible`,
// which meant `_updateLock` fell through to the `enemyTargetable` branch — DEAD CODE in the live
// game (see the note at targeting.js:72, "`_enemyVisible` is ALWAYS the branch taken"). So the
// "REFUSES to acquire a ground enemy in an un-sighted hex" case below passed happily while the
// live path had no geometric check at all: since #337 v2 there is no open-world fog, so
// `enemyVisibleInFog` rule 3 was a bare `return true` for every ground enemy outside an unentered
// compound. Red lock on a tank behind a boulder; every shot splashing on the boulder.
//
// The whole file now drives the REAL wiring — WorldMixin (the `_wallDistanceLos` raycast) +
// VisibilityMixin (`_enemyVisible`) + TargetingMixin (`_updateLock`) — over real terrain, so
// "un-sighted" means actual hard cover between the player and the target rather than a set the
// test made up. If the bug comes back, these fail.
import { describe, it, expect, beforeEach } from 'vitest';
import { WorldMixin } from './world.js';
import { VisibilityMixin } from './visibility.js';
import { TargetingMixin } from './targeting.js';
import { makeWallEdgeSet } from '../../data/wallEdges.js';
import { axialKey, pixelToHex } from '../../data/hexgrid.js';

const HARD = 'objective';   // hard cover: blocks any ray that isn't endpoint-exempt

const enemy = (x, y, extra = {}) => ({
  x, y, vx: 0, vy: 0, mech: { isDestroyed: () => false }, ...extra,
});

// A flat grass field at the origin with hard cover stamped at the given world points. The scene is
// the real mixins over that field: nothing here re-implements the sight rule.
function makeScene({ cover = [] } = {}) {
  const terrain = new Map();
  for (let q = -12; q <= 12; q++) for (let r = -12; r <= 12; r++) terrain.set(axialKey(q, r), 'grass');
  for (const [x, y] of cover) {
    const h = pixelToHex(x, y);
    terrain.set(axialKey(h.q, h.r), HARD);
  }
  return Object.assign({}, WorldMixin, VisibilityMixin, TargetingMixin, {
    px: 0, py: 0, turretAngle: 0,
    terrain,
    wallEdges: makeWallEdgeSet([]),
    buildingHp: new Map(), coverHp: new Map(),
    enemies: [],
    foggedHexes: new Set(),      // no compound fog anywhere: rule 3's geometry is the only gate
    _peeked: new Set(),
    _reticlePos: null,
    _hexKeyAt(x, y) { const h = pixelToHex(x, y); return axialKey(h.q, h.r); },
    // Stubbed so the aim cone is scored over ENEMIES only — the cover hex itself is a legitimate
    // destructible target in the live game and would otherwise win on nearest-wins (#322).
    _destructibleTargetsNear() { return []; },
  });
}

describe('targeting LOS gate (#306, #460)', () => {
  let target;
  beforeEach(() => { target = enemy(400, 0); });   // straight ahead along the turret facing

  it('acquires a ground enemy the player can see', () => {
    const sc = makeScene();
    sc.enemies = [target];
    sc._updateLock(0.016);
    expect(sc._enemyVisible(target)).toBe(true);
    expect(sc.aimEnemy).toBe(target);
    expect(sc.convergeTarget).toBe(target);
  });

  // THE #460 CASE. Nothing fogged, nothing exempt — just a rock in the way. The shot was always
  // stopped here (`_shotIgnoresCover` is airborne-only); now the lock is too.
  it('REFUSES to acquire a ground enemy behind hard cover', () => {
    const sc = makeScene({ cover: [[200, 0]] });
    sc.enemies = [target];
    sc._updateLock(0.016);
    expect(sc._enemyVisible(target)).toBe(false);
    expect(sc.aimEnemy).toBe(null);
    expect(sc.convergeTarget).toBe(null);
    expect(sc._lockAimPoint()).toBe(null);
  });

  // #316 removed #306's flyer exception here ("let's let cover be actual cover"), and this test
  // asserted the flyer was REFUSED. #338 puts it back — but as the shared predicate
  // (`targetCoverExempt`), which the SHOT consults too. That is the whole difference: under #316
  // the lock said no; under #306 the lock said yes and the shot said no; now both say yes, so an
  // airborne enemy the player can lock over a base wall is one he can actually hit.
  it('#338: ACQUIRES an airborne enemy behind hard cover — and the shot follows', () => {
    const flyer = enemy(400, 0, { flying: true });
    const sc = makeScene({ cover: [[200, 0]] });
    sc.enemies = [flyer];
    sc._updateLock(0.016);
    expect(sc._enemyVisible(flyer)).toBe(true);
    expect(sc.aimEnemy).toBe(flyer);
    expect(sc.convergeTarget).toBe(flyer);
  });

  // A flying kind that has LANDED is a ground target again — the exemption is on `airborne`, not
  // on the kind. This is what proves #460 did not simply hand every flyer-shaped record a pass.
  it('REFUSES a flying enemy that has landed behind hard cover', () => {
    const landed = enemy(400, 0, { flying: true, airborne: false });
    const sc = makeScene({ cover: [[200, 0]] });
    sc.enemies = [landed];
    sc._updateLock(0.016);
    expect(sc._enemyVisible(landed)).toBe(false);
    expect(sc.aimEnemy).toBe(null);
  });

  // #426: a wall turret sits ON the boundary and stays hittable from either side, so it must stay
  // lockable through the very wall it is bolted to.
  it('#426: ACQUIRES a wall turret behind hard cover, from any side', () => {
    const turret = enemy(400, 0, { spanKey: 'a|0,0|1,0' });
    const sc = makeScene({ cover: [[200, 0]] });
    sc.enemies = [turret];
    sc._updateLock(0.016);
    expect(sc._enemyVisible(turret)).toBe(true);
    expect(sc.aimEnemy).toBe(turret);
  });

  // The complement: a flyer with a clear lane was always lockable and still is.
  it('still acquires a FLYING enemy in the clear', () => {
    const flyer = enemy(400, 0, { flying: true });
    const sc = makeScene();
    sc.enemies = [flyer];
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(flyer);
    expect(sc.convergeTarget).toBe(flyer);
  });

  it('prefers a SIGHTED enemy over a better-aimed hidden one', () => {
    // The hidden enemy is dead ahead AND nearer (it would win outright on #322's nearest-wins
    // rule); the sighted one is farther and off to one side but still inside the aim cone. The LOS
    // gate removes the hidden one from consideration entirely.
    const hidden = enemy(300, 0);
    const sighted = enemy(700, 150);
    // Cover tucked right up against the hidden enemy (its own hex is endpoint-exempt, the one in
    // front of it is not) so it blocks only the straight-ahead ray, not the off-axis one.
    const sc = makeScene({ cover: [[270, 0]] });
    sc.enemies = [hidden, sighted];
    sc._updateLock(0.016);
    expect(sc._enemyVisible(hidden)).toBe(false);
    expect(sc.aimEnemy).toBe(sighted);
  });

  // #460's symmetry escape hatch (fog rule 4): a unit that is awake and has a live firing lane on
  // the player is visible and lockable no matter what the player's own ray says — "if they can
  // shoot me, I can see them". Keeps a garrison firing out through a gate targetable.
  it('acquires an awake enemy with a live firing lane on the player', () => {
    const shooter = enemy(400, 0, { _losClear: true, awareness: 'alert' });
    const sc = makeScene({ cover: [[200, 0]] });
    sc.enemies = [shooter];
    sc._updateLock(0.016);
    expect(sc._enemyVisible(shooter)).toBe(true);
    expect(sc.aimEnemy).toBe(shooter);
  });

  it('an enemy that was hidden becomes acquirable once its cover collapses', () => {
    // Mirrors what happens live when a building is blown apart: the terrain entry changes and the
    // next sight refresh (staggered, ~LOS_REFRESH_MS) can lock on.
    const sc = makeScene({ cover: [[200, 0]] });
    sc.enemies = [target];
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(null);
    const h = pixelToHex(200, 0);
    sc.terrain.set(axialKey(h.q, h.r), 'grass');
    sc._refreshPlayerSight(1000);     // one refresh window later
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(target);
  });

  // The per-frame cost guard: the raycast is cached per enemy and only recomputed on the staggered
  // refresh, so `_updateLock` running every frame does NOT mean a raycast every frame.
  it('caches the sight answer between staggered refreshes', () => {
    const sc = makeScene();
    sc.enemies = [target];
    let casts = 0;
    const real = sc._wallDistanceLos;
    sc._wallDistanceLos = function (...args) { casts++; return real.apply(this, args); };
    sc._updateLock(0.016);
    sc._updateLock(0.016);
    sc._updateLock(0.016);
    expect(casts).toBe(1);            // seeded once on first touch, then reused
    sc._refreshPlayerSight(1000);     // past the refresh window ⇒ exactly one more
    expect(casts).toBe(2);
  });
});
