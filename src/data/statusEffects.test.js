import { describe, it, expect } from 'vitest';
import { applyStatusEffect, tickStatusEffects } from './statusEffects.js';

describe('applyStatusEffect', () => {
  it('adds a fresh effect', () => {
    const effects = applyStatusEffect([], 'burn', { duration: 3, tickDamage: 2, location: 'leftArm' });
    expect(effects).toEqual([{ kind: 'burn', remaining: 3, tickDamage: 2, tickInterval: 1, location: 'leftArm', sinceTick: 0 }]);
  });

  it('re-applying the same kind REFRESHES duration/damage instead of stacking a second entry', () => {
    let effects = applyStatusEffect([], 'burn', { duration: 3, tickDamage: 2, location: 'leftArm' });
    effects = tickStatusEffects(effects, 2).effects;   // 1s remaining
    effects = applyStatusEffect(effects, 'burn', { duration: 5, tickDamage: 9, location: 'rightArm' });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ remaining: 5, tickDamage: 9, location: 'rightArm' });
  });

  it('does not disturb an unrelated effect kind', () => {
    let effects = applyStatusEffect([], 'burn', { duration: 3, tickDamage: 2, location: 'leftArm' });
    effects = applyStatusEffect(effects, 'poison', { duration: 4, tickDamage: 1, location: 'rightArm' });
    expect(effects).toHaveLength(2);
  });
});

describe('tickStatusEffects', () => {
  it('fires a tick once tickInterval has elapsed, then resets its own clock', () => {
    let effects = applyStatusEffect([], 'burn', { duration: 10, tickDamage: 3, tickInterval: 1, location: 'leftArm' });
    let r = tickStatusEffects(effects, 0.6);
    expect(r.ticks).toEqual([]);
    r = tickStatusEffects(r.effects, 0.6);   // 1.2s total this effect has lived — one tick due
    expect(r.ticks).toEqual([{ kind: 'burn', tickDamage: 3, location: 'leftArm' }]);
  });

  it('drops an effect once its duration runs out', () => {
    let effects = applyStatusEffect([], 'burn', { duration: 1, tickDamage: 3, location: 'leftArm' });
    const r = tickStatusEffects(effects, 1.5);
    expect(r.effects).toEqual([]);
  });

  it('a large dt can still fire the tick before the effect expires in the same call', () => {
    let effects = applyStatusEffect([], 'burn', { duration: 1, tickDamage: 3, tickInterval: 0.5, location: 'leftArm' });
    const r = tickStatusEffects(effects, 0.5);
    expect(r.ticks).toEqual([{ kind: 'burn', tickDamage: 3, location: 'leftArm' }]);
    expect(r.effects).toHaveLength(1);   // 0.5s remaining, still alive
  });

  it('never mutates the input array', () => {
    const effects = applyStatusEffect([], 'burn', { duration: 5, tickDamage: 3, location: 'leftArm' });
    const snapshot = JSON.parse(JSON.stringify(effects));
    tickStatusEffects(effects, 1);
    expect(effects).toEqual(snapshot);
  });
});
