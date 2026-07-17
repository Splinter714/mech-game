import { describe, it, expect } from 'vitest';
import {
  makeLock, stepLock, hasLock, canFireWeapon, stepReticlePosition,
} from './targetlock.js';

const A = { mech: { isDestroyed: () => false }, id: 'a' };
const B = { mech: { isDestroyed: () => false }, id: 'b' };
const hexA = { x: 300, y: 0 };   // a static (destructible-hex, #250) convergence target — no `.mech`

describe('targetlock (#252) — the lock mirrors the live target instantly', () => {
  it('has no target and cannot fire a homing weapon on a fresh lock', () => {
    const lock = makeLock();
    expect(hasLock(lock)).toBe(false);
    expect(lock.target).toBe(null);
  });

  it('acquires a target the SAME frame it appears — no charge delay', () => {
    const lock = makeLock();
    stepLock(lock, { target: A });
    expect(lock.target).toBe(A);
    expect(hasLock(lock)).toBe(true);
  });

  it('switches targets immediately (no dwell/hand-over delay) when the live pick changes', () => {
    const lock = makeLock();
    stepLock(lock, { target: A });
    stepLock(lock, { target: B });
    expect(lock.target).toBe(B);
  });

  it('drops to no-target the instant the live pick goes null (no maintain grace period)', () => {
    const lock = makeLock();
    stepLock(lock, { target: A });
    stepLock(lock, { target: null });
    expect(lock.target).toBe(null);
    expect(hasLock(lock)).toBe(false);
  });

  it('re-acquiring the same target after a drop is instant too (no re-charge)', () => {
    const lock = makeLock();
    stepLock(lock, { target: A });
    stepLock(lock, { target: null });
    stepLock(lock, { target: A });
    expect(hasLock(lock)).toBe(true);
  });
});

// Playtest follow-up (#252): the old "blind fire" state (dead-reckoned last-known position while
// the picked target had no LOS) is gone entirely — the lock has no LOS concept at all any more,
// it purely mirrors whatever target convergence handed it, live, always. There is no `lock.blind`
// and no last-known/prediction bookkeeping left to test.
describe('targetlock (#252) — no LOS gate, no blind-fire state (playtest follow-up)', () => {
  it('keeps tracking the same enemy target with no LOS concept involved at all', () => {
    const lock = makeLock();
    stepLock(lock, { target: A });
    stepLock(lock, { target: A });
    stepLock(lock, { target: A });
    expect(lock.target).toBe(A);
    expect(hasLock(lock)).toBe(true);
    expect(lock.blind).toBeUndefined();
  });

  it('a static (hex) target behaves identically to an enemy target — just mirrored', () => {
    const lock = makeLock();
    stepLock(lock, { target: hexA });
    expect(lock.target).toBe(hexA);
    expect(hasLock(lock)).toBe(true);
  });

  it('a homing weapon can fire at a hex target — hasLock only cares whether SOMETHING is targeted', () => {
    const lock = makeLock();
    stepLock(lock, { target: hexA });
    const homing = { delivery: { guidance: 'homing' } };
    expect(canFireWeapon(homing, lock)).toBe(true);
  });
});

// #252 no-lock-no-fire gate — unchanged semantics, just "has a target" instead of "fully charged".
describe('targetlock — canFireWeapon (no-lock-no-fire gate)', () => {
  const homing = { delivery: { guidance: 'homing', path: 'arcing' } };
  const dumbfireMissile = { delivery: { guidance: 'dumbfire', path: 'straight' } };
  const arcingLob = { delivery: { guidance: null, path: 'arcing' } };
  const directHitscan = { delivery: { guidance: null, path: 'straight', hit: 'hitscan' } };

  it('blocks a homing weapon with no target at all', () => {
    const lock = makeLock();
    expect(canFireWeapon(homing, lock)).toBe(false);
  });

  it('allows a homing weapon the instant a target is acquired — no charge-up wait', () => {
    const lock = makeLock();
    stepLock(lock, { target: A });
    expect(canFireWeapon(homing, lock)).toBe(true);
  });

  it('blocks again once the target is gone', () => {
    const lock = makeLock();
    stepLock(lock, { target: A });
    stepLock(lock, { target: null });
    expect(canFireWeapon(homing, lock)).toBe(false);
  });

  it('a homing weapon can fire with no LOS on its target — indirect fire has no LOS requirement', () => {
    const lock = makeLock();
    stepLock(lock, { target: A });
    expect(canFireWeapon(homing, lock)).toBe(true);
  });

  it('never gates a dumbfire missile (clusterRocket) regardless of lock state', () => {
    const lock = makeLock();
    expect(canFireWeapon(dumbfireMissile, lock)).toBe(true);
  });

  it('never gates an unguided arcing lob (plasma/napalm) regardless of lock state', () => {
    const lock = makeLock();
    expect(canFireWeapon(arcingLob, lock)).toBe(true);
  });

  it('never gates direct-fire hitscan regardless of lock state', () => {
    const lock = makeLock();
    expect(canFireWeapon(directHitscan, lock)).toBe(true);
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
