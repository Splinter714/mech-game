// #306: targeting respects line of sight — the convergence/lock system must not acquire an enemy
// the player has no sight of, so breaking a sightline genuinely protects a unit. Flying enemies
// stay targetable regardless (they're above ground-level cover, matching #245/#257's firing
// exception and the fact that they render ABOVE the dimming overlay).
//
// Drives the real `_updateLock` (targeting.js) against a stub scene, so this pins the actual wired
// behaviour, not a re-implementation of the rule.
import { describe, it, expect, beforeEach } from 'vitest';
import { TargetingMixin } from './targeting.js';
import { axialKey, pixelToHex } from '../../data/hexgrid.js';

const enemy = (x, y, extra = {}) => ({
  x, y, vx: 0, vy: 0, mech: { isDestroyed: () => false }, ...extra,
});

// Minimal ArenaScene stand-in: just the fields `_updateLock` actually reads.
function makeScene(visibleHexes) {
  const s = Object.assign(Object.create(TargetingMixin), {
    px: 0, py: 0, turretAngle: 0,
    enemies: [], focusMode: 'enemy',
    lock: { target: null }, _reticlePos: null,
    visibleHexes,
    _hexKeyAt(x, y) { const h = pixelToHex(x, y); return axialKey(h.q, h.r); },
    _destructibleHexesNear() { return []; },
  });
  return s;
}

// The hex key of a world point, for building visible sets in world coordinates.
const keyAt = (x, y) => { const h = pixelToHex(x, y); return axialKey(h.q, h.r); };

describe('targeting LOS gate (#306)', () => {
  let target;
  beforeEach(() => { target = enemy(400, 0); });   // straight ahead along the turret facing

  it('acquires a ground enemy the player can see', () => {
    const sc = makeScene(new Set([keyAt(0, 0), keyAt(400, 0)]));
    sc.enemies = [target];
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(target);
    expect(sc.convergeTarget).toBe(target);
    expect(sc.lock.target).toBe(target);
  });

  it('REFUSES to acquire a ground enemy in an un-sighted hex', () => {
    const sc = makeScene(new Set([keyAt(0, 0)]));   // the enemy's hex is NOT in the set
    sc.enemies = [target];
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(null);
    expect(sc.convergeTarget).toBe(null);
    expect(sc.lock.target).toBe(null);
    expect(sc._lockAimPoint()).toBe(null);
  });

  // #316 reverses #306's flyer exception (this test used to assert the flyer WAS acquired):
  // "let's stop being able to shoot them beyond cover also; let's let cover be actual cover."
  // The convergence pick now treats a flyer exactly like the ground enemy above it.
  it('#316: REFUSES to acquire a FLYING enemy in an un-sighted hex, same as a ground enemy', () => {
    const flyer = enemy(400, 0, { flying: true });
    const sc = makeScene(new Set([keyAt(0, 0)]));
    sc.enemies = [flyer];
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(null);
    expect(sc.convergeTarget).toBe(null);
    expect(sc.lock.target).toBe(null);
  });

  // The complement: flight is no longer special in EITHER direction — a SIGHTED flyer is still
  // perfectly lockable, so the change above isn't just "flyers became untargetable".
  it('#316: still acquires a FLYING enemy that IS in a sighted hex', () => {
    const flyer = enemy(400, 0, { flying: true });
    const sc = makeScene(new Set([keyAt(0, 0), keyAt(400, 0)]));
    sc.enemies = [flyer];
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(flyer);
    expect(sc.lock.target).toBe(flyer);
  });

  it('prefers a SIGHTED enemy over a better-aimed hidden one', () => {
    // The hidden enemy is dead ahead (perfect aim score); the sighted one is off to the side and
    // would lose on score alone. The LOS gate removes the hidden one from consideration entirely.
    const hidden = enemy(300, 0);
    const sighted = enemy(500, 400);
    const sc = makeScene(new Set([keyAt(0, 0), keyAt(500, 400)]));
    sc.enemies = [hidden, sighted];
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(sighted);
  });

  it('does not gate before a field of view exists (visibleHexes null)', () => {
    const sc = makeScene(null);
    sc.enemies = [target];
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(target);
  });

  it('an enemy that was hidden becomes acquirable once its hex enters the visible set', () => {
    // Mirrors what happens live when cover collapses: the scene recomputes `visibleHexes`, and the
    // very next `_updateLock` can lock on.
    const sc = makeScene(new Set([keyAt(0, 0)]));
    sc.enemies = [target];
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(null);
    sc.visibleHexes = new Set([keyAt(0, 0), keyAt(400, 0)]);
    sc._updateLock(0.016);
    expect(sc.aimEnemy).toBe(target);
  });
});
