import { describe, it, expect } from 'vitest';
import { canFireWeapon, stepReticlePosition } from './targetlock.js';

const A = { mech: { isDestroyed: () => false }, id: 'a' };
const hexA = { x: 300, y: 0 };   // a static (destructible-hex, #250) convergence target — no `.mech`

// #341: the `lock` record that used to mirror the convergence pick every frame is gone, and with it
// makeLock/stepLock/hasLock and the tests that exercised the mirroring (they asserted that assigning
// a field assigns a field). There is ONE target now — the player's `convergeTarget` (targeting.js
// `_updateLock`) or an enemy's `lockTarget` (enemies.js) — and the instant acquire / instant switch /
// instant drop behaviour those tests described is asserted against that real pick in
// scenes/arena/targetingLos.test.js and coverTargeting.test.js. What is left pure here is the fire
// gate and the reticle easing.

// The no-target-no-fire gate (#252, #341) — "has a target" is the whole rule; passing the target
// straight in (no wrapper) is the #341 signature.
describe('targetlock — canFireWeapon (no-target-no-fire gate)', () => {
  const homing = { delivery: { guidance: 'homing', path: 'arcing' } };
  const dumbfireMissile = { delivery: { guidance: 'dumbfire', path: 'straight' } };
  const arcingLob = { delivery: { guidance: null, path: 'arcing' } };
  const directHitscan = { delivery: { guidance: null, path: 'straight', hit: 'hitscan' } };

  it('blocks a homing weapon with no target at all', () => {
    expect(canFireWeapon(homing, null)).toBe(false);
  });

  it('allows a homing weapon the instant a target is acquired — no charge-up wait', () => {
    expect(canFireWeapon(homing, A)).toBe(true);
  });

  it('a homing weapon can fire at a static hex/wall target too — only "is SOMETHING targeted" matters', () => {
    expect(canFireWeapon(homing, hexA)).toBe(true);
  });

  it('a homing weapon can fire with no LOS on its target — indirect fire has no LOS requirement', () => {
    expect(canFireWeapon(homing, A)).toBe(true);
  });

  it('never gates a dumbfire missile (clusterRocket) regardless of target state', () => {
    expect(canFireWeapon(dumbfireMissile, null)).toBe(true);
  });

  it('never gates an unguided arcing lob (plasma/napalm) regardless of target state', () => {
    expect(canFireWeapon(arcingLob, null)).toBe(true);
  });

  it('never gates direct-fire hitscan regardless of target state', () => {
    expect(canFireWeapon(directHitscan, null)).toBe(true);
  });
});

describe('targetlock (#252) — reticle slide (stepReticlePosition)', () => {
  it('snaps straight to the target when there is no previous position (fresh acquisition)', () => {
    const p = stepReticlePosition(null, { x: 100, y: 50 }, 1 / 60);
    expect(p).toEqual({ x: 100, y: 50 });
  });

  it('eases toward the target rather than snapping — partway there after one frame', () => {
    const p = stepReticlePosition({ x: 0, y: 0 }, { x: 100, y: 0 }, 1 / 60);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(100);
  });

  it('converges to (arbitrarily close to) the target after enough frames', () => {
    let p = { x: 0, y: 0 };
    const target = { x: 200, y: -80 };
    for (let i = 0; i < 300; i++) p = stepReticlePosition(p, target, 1 / 60);
    expect(p.x).toBeCloseTo(target.x, 1);
    expect(p.y).toBeCloseTo(target.y, 1);
  });

  it('a bigger dt eases further in one step than a smaller dt (monotonic in dt)', () => {
    const small = stepReticlePosition({ x: 0, y: 0 }, { x: 100, y: 0 }, 1 / 120);
    const big = stepReticlePosition({ x: 0, y: 0 }, { x: 100, y: 0 }, 1 / 30);
    expect(big.x).toBeGreaterThan(small.x);
  });

  it('never overshoots the target', () => {
    const p = stepReticlePosition({ x: 0, y: 0 }, { x: 100, y: 0 }, 5);   // a huge dt
    expect(p.x).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('does not mutate the previous position object', () => {
    const prev = { x: 0, y: 0 };
    stepReticlePosition(prev, { x: 100, y: 0 }, 1 / 60);
    expect(prev).toEqual({ x: 0, y: 0 });
  });
});
