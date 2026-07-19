import { describe, it, expect } from 'vitest';
import {
  explosionCategoryFor, deathScaleFor, DEATH_SCALE_MAX, nearestLocation, resolveHitLocation,
  pickLiveWeighted,
} from './shared.js';
import { rosterToughnessBounds, liveToughnessBounds } from '../../data/rosterBounds.js';
import { Mech } from '../../data/Mech.js';

// #107 (+ #301): which discrete destruction-explosion-SOUND category a dying enemy falls into,
// bucketed off `.toughness` (structure + armor + shield — uniform across Mech/HpBody per #106)
// against bounds DERIVED from the live roster (data/rosterBounds.js). Today's roster:
// infantry 6, drone 14, turret 90, helicopter 100, light mech 184, tank 200, medium mech 290,
// quadruped 370, heavy/artillery mech 430 (the ceiling).
function enemyWithToughness(toughness) {
  return { mech: { toughness } };
}

describe('explosionCategoryFor (#107 buckets, #301 roster-derived bounds)', () => {
  it('buckets infantry (6) and a drone (14) as small', () => {
    expect(explosionCategoryFor(enemyWithToughness(6))).toBe('small');
    expect(explosionCategoryFor(enemyWithToughness(14))).toBe('small');
  });

  it('buckets turret (90), helicopter (100), light mech (184), and tank (200) as medium', () => {
    for (const t of [90, 100, 184, 200]) {
      expect(explosionCategoryFor(enemyWithToughness(t))).toBe('medium');
    }
  });

  it('buckets a medium mech (290) and the quadruped (370) as large', () => {
    expect(explosionCategoryFor(enemyWithToughness(290))).toBe('large');
    expect(explosionCategoryFor(enemyWithToughness(370))).toBe('large');
  });

  // The #301 regression itself: under the old hardcoded 616 ceiling the toughest unit in the
  // game (430) landed in 'large', leaving 'massive' unreachable.
  it('gives the TOUGHEST unit in the live roster the top tier', () => {
    const { ceil } = liveToughnessBounds();
    expect(explosionCategoryFor(enemyWithToughness(ceil))).toBe('massive');
  });

  it('is monotonic across the small/medium/large/massive boundaries', () => {
    const order = ['small', 'medium', 'large', 'massive'];
    let lastIdx = -1;
    for (const t of [0, 6, 14, 60, 90, 200, 290, 370, 420, 430, 5000]) {
      const idx = order.indexOf(explosionCategoryFor(enemyWithToughness(t)));
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx;
    }
  });
});

describe('deathScaleFor (#301 — roster-derived, not hardcoded)', () => {
  it('puts the weakest live unit at the min scale and the toughest at the max', () => {
    const { floor, ceil } = liveToughnessBounds();
    expect(deathScaleFor(enemyWithToughness(floor))).toBeCloseTo(0.5, 5);
    expect(deathScaleFor(enemyWithToughness(ceil))).toBeCloseTo(DEATH_SCALE_MAX, 5);
  });

  it('is monotonically increasing with toughness', () => {
    expect(deathScaleFor(enemyWithToughness(90))).toBeGreaterThan(deathScaleFor(enemyWithToughness(14)));
    expect(deathScaleFor(enemyWithToughness(370))).toBeGreaterThan(deathScaleFor(enemyWithToughness(200)));
  });
});

// The point of #301: the endpoints are COMPUTED from the roster, so they move when the roster
// does instead of drifting stale (as the hardcoded 616 ceiling did after #128, and as any
// hardcoded 430 would after #299's HP retune).
describe('explosion bounds track the roster (#301)', () => {
  const stubKinds = {
    weakling: { hp: 10 },
    bruiser: { hp: 1000 },
  };

  it('derives different endpoints under a stubbed roster', () => {
    const stubbed = rosterToughnessBounds({}, stubKinds);
    expect(stubbed.floor).toBe(10);
    expect(stubbed.ceil).toBe(1000);
    const live = liveToughnessBounds();
    expect(stubbed.ceil).not.toBe(live.ceil);
  });

  it('re-tiers the same enemy when the roster bounds change', () => {
    const stubbed = rosterToughnessBounds({}, stubKinds);
    const e = enemyWithToughness(500);   // #299: the artillery mech, top of the live roster
    // Top of today's live roster ⇒ the biggest boom…
    expect(explosionCategoryFor(e)).toBe('massive');
    expect(deathScaleFor(e)).toBeCloseTo(DEATH_SCALE_MAX, 5);
    // …but middling in a roster whose toughest unit is 1000 (500 of a 10..1000 span sits just
    // under halfway, so it drops out of the top tier — which is the point being asserted).
    expect(explosionCategoryFor(e, stubbed)).not.toBe('massive');
    expect(explosionCategoryFor(e, stubbed)).toBe('large');
    expect(deathScaleFor(e, stubbed)).toBeLessThan(DEATH_SCALE_MAX);
    // …and the stub roster's own toughest unit takes the top tier there.
    expect(explosionCategoryFor(enemyWithToughness(1000), stubbed)).toBe('massive');
    expect(deathScaleFor(enemyWithToughness(1000), stubbed)).toBeCloseTo(DEATH_SCALE_MAX, 5);
  });
});

// #231 — "enemy mechs take damage strangely, like it feels easy to destroy one side torso,
// and then waaaaaay harder to destroy the second side." Root cause: a hit maps to the part
// nearest the world hit point, with no check that the nearest part isn't already destroyed
// (armor+structure zeroed, either hit down directly or cascaded — a side torso takes its arm
// with it, DESTROY_CASCADE in anatomy.js). Since a kill needs BOTH side torsos destroyed
// (LETHAL_GROUPS), every hit that geometrically lands on the already-dead side was silently
// wasted instead of redirecting, making the second side (the actual kill) feel far tankier.
describe('nearestLocation (#231 — pure nearest-part geometry, factored out of combat.js)', () => {
  const lay = {
    leftTorso: { x: -10, y: 0 },
    rightTorso: { x: 10, y: 0 },
    leftArm: { x: -20, y: 0 },
    rightArm: { x: 20, y: 0 },
  };

  it('picks the part whose layout position is closest to the local hit point', () => {
    expect(nearestLocation(lay, Object.keys(lay), -10, 0, 1)).toBe('leftTorso');
    expect(nearestLocation(lay, Object.keys(lay), 19, 1, 1)).toBe('rightArm');
  });

  it('only considers locations passed in `locs`, even if something closer exists in `lay`', () => {
    // Hit point is right on top of leftTorso, but leftTorso is excluded from the candidate list.
    expect(nearestLocation(lay, ['rightTorso', 'leftArm', 'rightArm'], -10, 0, 1)).toBe('leftArm');
  });
});

describe('resolveHitLocation (#231 — redirect a hit off an already-destroyed part)', () => {
  const lay = {
    leftTorso: { x: -10, y: 0 },
    rightTorso: { x: 10, y: 0 },
    leftArm: { x: -20, y: 0 },
    rightArm: { x: 20, y: 0 },
  };
  const locs = ['leftTorso', 'rightTorso', 'leftArm', 'rightArm'];

  it('leaves a hit on a live part unchanged (normal-case behavior is unaffected)', () => {
    const isPartDestroyed = () => false;
    expect(resolveHitLocation(lay, locs, -10, 0, 1, isPartDestroyed)).toBe('leftTorso');
    expect(resolveHitLocation(lay, locs, 19, 1, 1, isPartDestroyed)).toBe('rightArm');
  });

  it('redirects to the nearest LIVE part when the geometrically-nearest one is destroyed', () => {
    // Hit lands nearest leftTorso, but leftTorso (and its cascaded leftArm) are already dead —
    // the real #231 scenario. Must redirect to a live part (rightTorso/rightArm), never
    // silently return the dead leftTorso.
    const destroyed = new Set(['leftTorso', 'leftArm']);
    const isPartDestroyed = (loc) => destroyed.has(loc);
    const got = resolveHitLocation(lay, locs, -10, 0, 1, isPartDestroyed);
    expect(destroyed.has(got)).toBe(false);
    expect(got).toBe('rightTorso'); // nearest of the remaining live parts to (-10, 0)
  });

  it('exercises the real Mech model end to end: killing one side torso then hitting that '
    + 'side again applies real damage to the surviving side instead of wasting the hit', () => {
    const m = new Mech({ chassisId: 'light' });
    // Overkill the left torso (cascades the left arm too, per DESTROY_CASCADE).
    m.applyDamage('leftTorso', m.parts.leftTorso.maxArmor + m.parts.leftTorso.maxHp + 999);
    expect(m.isPartDestroyed('leftTorso')).toBe(true);
    expect(m.isPartDestroyed('leftArm')).toBe(true);
    expect(m.isDestroyed()).toBe(false); // needs BOTH side torsos, not just one

    // Hit point is right on top of the now-dead leftTorso.
    const loc = resolveHitLocation(lay, locs, -10, 0, 1, (l) => m.isPartDestroyed(l));
    expect(m.isPartDestroyed(loc)).toBe(false);
    expect(loc === 'rightTorso' || loc === 'rightArm').toBe(true);
    const before = m.parts[loc].hp + m.parts[loc].armor;
    const res = m.applyDamage(loc, 15);
    expect(res.applied).toBe(15); // damage actually applied, not wasted on the dead leftTorso
    const after = m.parts[loc].hp + m.parts[loc].armor;
    expect(after).toBe(before - 15);
  });

  it('falls back to the originally-nearest part if every candidate is already destroyed '
    + '(defensive — should be unreachable while the unit is alive)', () => {
    const isPartDestroyed = () => true;
    expect(resolveHitLocation(lay, locs, -10, 0, 1, isPartDestroyed)).toBe('leftTorso');
  });
});

describe('pickLiveWeighted (#231 — player weighted-random hit-location redirect)', () => {
  const pool = ['leftTorso', 'leftTorso', 'rightTorso', 'rightTorso', 'leftArm', 'rightArm'];

  it('returns the rolled location unchanged when it is still live', () => {
    // rng() = 0 -> index 0 -> 'leftTorso'
    expect(pickLiveWeighted(pool, () => false, () => 0)).toBe('leftTorso');
  });

  it('rerolls among only the LIVE entries when the roll lands on an already-destroyed part', () => {
    const destroyed = new Set(['leftTorso', 'leftArm']);
    const isPartDestroyed = (loc) => destroyed.has(loc);
    // First rng() call (the initial roll) picks index 0 -> 'leftTorso', which is destroyed.
    // Second rng() call (the reroll) picks index 0 of the live-filtered pool
    // (['rightTorso','rightTorso','rightArm']) -> 'rightTorso'.
    let call = 0;
    const rng = () => (call++ === 0 ? 0 : 0);
    expect(pickLiveWeighted(pool, isPartDestroyed, rng)).toBe('rightTorso');
  });

  it('never returns an already-destroyed location when at least one live entry exists', () => {
    const destroyed = new Set(['leftTorso']);
    const isPartDestroyed = (loc) => destroyed.has(loc);
    // Sweep the rng space broadly to make sure no reachable path returns the dead location.
    for (let i = 0; i < 20; i++) {
      const rng = () => i / 20;
      expect(pickLiveWeighted(pool, isPartDestroyed, rng)).not.toBe('leftTorso');
    }
  });

  it('falls back to the rolled (destroyed) location if the entire pool is destroyed '
    + '(defensive fallback, mirrors resolveHitLocation)', () => {
    expect(pickLiveWeighted(pool, () => true, () => 0)).toBe('leftTorso');
  });
});

// #285: the hold-ground leash (`leashIntent`/`HOLD_GROUND_LEASH_PX`, previously tested here) was
// removed outright — a woken hold-ground unit now runs its normal unconstrained movement, no
// distance clamp. Coverage for that lives in dormantWake.test.js (scene-level, since the
// unconstrained behavior is now just "the same movement any non-hold-ground unit already runs,"
// nothing left to unit-test as a standalone pure function).
