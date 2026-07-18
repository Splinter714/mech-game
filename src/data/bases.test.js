import { describe, it, expect } from 'vitest';
import { nearestBaseTo, isFastWakeKind, FAST_WAKE_SPEED_THRESHOLD, isBaseCleared } from './bases.js';
import { ENEMY_KINDS } from './enemyKinds.js';
import { hexToPixel } from './hexgrid.js';

describe('nearestBaseTo (#269 §6: wake routing — only the nearest base wakes)', () => {
  const bases = [
    { id: 'base0', center: { q: 0, r: 0 }, docks: [] },
    { id: 'base1', center: { q: 20, r: 0 }, docks: [] },
    { id: 'base2', center: { q: 0, r: 20 }, docks: [] },
  ];

  it('returns null for an empty base list', () => {
    expect(nearestBaseTo({ x: 0, y: 0 }, [])).toBeNull();
    expect(nearestBaseTo({ x: 0, y: 0 }, null)).toBeNull();
  });

  it('picks the base whose centre is closest to the point, not any other', () => {
    const p = hexToPixel(1, 0);   // very close to base0's centre
    const nearest = nearestBaseTo(p, bases);
    expect(nearest.id).toBe('base0');
  });

  it('picks a different base when the point sits near it instead', () => {
    const p = hexToPixel(19, 0);   // very close to base1's centre
    const nearest = nearestBaseTo(p, bases);
    expect(nearest.id).toBe('base1');
  });

  it('never returns two bases at once — always exactly one winner', () => {
    const p = hexToPixel(10, 10);   // roughly equidistant-ish, but still one strict winner
    const nearest = nearestBaseTo(p, bases);
    expect(bases.map((b) => b.id)).toContain(nearest.id);
  });
});

describe('isFastWakeKind (#269 §7: wake-response split by speed)', () => {
  it('drone/helicopter (light, fast flyers) are fast-wake kinds', () => {
    expect(isFastWakeKind(ENEMY_KINDS.drone)).toBe(true);
    expect(isFastWakeKind(ENEMY_KINDS.helicopter)).toBe(true);
  });

  it('turret/tank/quadruped/infantry (heavy/rooted) are NOT fast-wake kinds', () => {
    expect(isFastWakeKind(ENEMY_KINDS.turret)).toBe(false);
    expect(isFastWakeKind(ENEMY_KINDS.tank)).toBe(false);
    expect(isFastWakeKind(ENEMY_KINDS.quadruped)).toBe(false);
    expect(isFastWakeKind(ENEMY_KINDS.infantry)).toBe(false);
  });

  it('a missing/undefined kindDef is treated as slow (maxSpeed 0)', () => {
    expect(isFastWakeKind(undefined)).toBe(false);
    expect(isFastWakeKind({})).toBe(false);
  });

  it('the threshold sits strictly between the fastest slow kind and slowest fast kind', () => {
    const slowMax = Math.max(
      ENEMY_KINDS.turret.move.maxSpeed, ENEMY_KINDS.tank.move.maxSpeed,
      ENEMY_KINDS.quadruped.move.maxSpeed, ENEMY_KINDS.infantry.move.maxSpeed,
    );
    const fastMin = Math.min(ENEMY_KINDS.drone.move.maxSpeed, ENEMY_KINDS.helicopter.move.maxSpeed);
    expect(FAST_WAKE_SPEED_THRESHOLD).toBeGreaterThan(slowMax);
    expect(FAST_WAKE_SPEED_THRESHOLD).toBeLessThanOrEqual(fastMin);
  });
});

describe('isBaseCleared (#269 playtest follow-up: objective sequencing)', () => {
  it('a base with live enemies still tagged to it is NOT cleared', () => {
    const enemies = [{ baseId: 'base0' }, { baseId: 'base1' }];
    expect(isBaseCleared('base0', enemies)).toBe(false);
  });

  it('a base with no remaining enemies tagged to it IS cleared', () => {
    const enemies = [{ baseId: 'base1' }];
    expect(isBaseCleared('base0', enemies)).toBe(true);
  });

  it('an empty/missing enemies list reads as cleared', () => {
    expect(isBaseCleared('base0', [])).toBe(true);
    expect(isBaseCleared('base0', null)).toBe(true);
    expect(isBaseCleared('base0', undefined)).toBe(true);
  });

  it('a null/undefined baseId (no target base) reads as cleared', () => {
    expect(isBaseCleared(null, [{ baseId: 'base0' }])).toBe(true);
    expect(isBaseCleared(undefined, [{ baseId: 'base0' }])).toBe(true);
  });

  it('only counts enemies tagged with the exact baseId — other bases don\'t interfere', () => {
    const enemies = [{ baseId: 'base0' }, { baseId: 'base0' }, { baseId: 'base1' }];
    expect(isBaseCleared('base1', enemies)).toBe(false);
    expect(isBaseCleared('base2', enemies)).toBe(true);
  });
});
