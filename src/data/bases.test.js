import { describe, it, expect } from 'vitest';
import { isFastWakeKind, FAST_WAKE_SPEED_THRESHOLD, isBaseCleared } from './bases.js';
import { ENEMY_KINDS } from './enemyKinds.js';

// #284: `nearestBaseTo` (pure straight-line-distance wake routing) is gone — a tower now wakes
// its own linked `baseId`, threaded through from `placeGapTowers` (data/worldgen.js). Coverage
// for that lives in worldgen.test.js (`placeGapTowers` tagging its towers with the right
// `baseId`) and scenes/arena/dormantWake.test.js (the scene-side trigger waking that exact base).

describe('isFastWakeKind (#269 §7: wake-response split by speed)', () => {
  it('drone/helicopter (light, fast flyers) are fast-wake kinds', () => {
    expect(isFastWakeKind(ENEMY_KINDS.drone)).toBe(true);
    expect(isFastWakeKind(ENEMY_KINDS.helicopter)).toBe(true);
  });

  it('wallTurret/tank/carrier/infantry (heavy/rooted) are NOT fast-wake kinds', () => {
    expect(isFastWakeKind(ENEMY_KINDS.wallTurret)).toBe(false);
    expect(isFastWakeKind(ENEMY_KINDS.tank)).toBe(false);
    expect(isFastWakeKind(ENEMY_KINDS.carrier)).toBe(false);
    expect(isFastWakeKind(ENEMY_KINDS.infantry)).toBe(false);
  });

  it('a missing/undefined kindDef is treated as slow (maxSpeed 0)', () => {
    expect(isFastWakeKind(undefined)).toBe(false);
    expect(isFastWakeKind({})).toBe(false);
  });

  it('the threshold sits strictly between the fastest slow kind and slowest fast kind', () => {
    const slowMax = Math.max(
      ENEMY_KINDS.wallTurret.move.maxSpeed, ENEMY_KINDS.tank.move.maxSpeed,
      ENEMY_KINDS.carrier.move.maxSpeed, ENEMY_KINDS.infantry.move.maxSpeed,
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
