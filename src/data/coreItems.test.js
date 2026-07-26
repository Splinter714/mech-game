import { describe, it, expect } from 'vitest';
import { CORE_ITEMS, getCoreItem, isCoreItem, shieldConfigFor } from './coreItems.js';

describe('core items registry', () => {
  it('shield is a 100-point pool (#299/#382 baseline, unchanged by becoming optional)', () => {
    expect(CORE_ITEMS.shield.max).toBe(100);
  });

  it('getCoreItem/isCoreItem resolve known and reject unknown ids', () => {
    expect(isCoreItem('shield')).toBe(true);
    expect(getCoreItem('shield').max).toBe(100);
    expect(isCoreItem('not-a-real-core-item')).toBe(false);
  });
});

// #526-followup: each item's own `meterFrac(mech)` — the generic reading fed into the fused HUD's
// shield-line bracket (healthReadout.js `coreMeter`) so that visual isn't hardcoded to literal
// shield HP.
describe('meterFrac', () => {
  it('shield reads its own HP fraction, including a grown temp pool', () => {
    const mech = {
      hasShield: () => true,
      shieldTotalHp: () => 60, shieldTotalMax: () => 120,
    };
    expect(CORE_ITEMS.shield.meterFrac(mech)).toBeCloseTo(0.5, 5);
  });

  it('shield reads null (no meter) when the mech has none', () => {
    expect(CORE_ITEMS.shield.meterFrac({ hasShield: () => false })).toBeNull();
  });

  it('antiMissile reads RECHARGE progress — 0 the instant it fires, 1 once ready', () => {
    const justFired = { _interceptorCooldown: CORE_ITEMS.antiMissile.cooldown };
    const ready = { _interceptorCooldown: 0 };
    const halfway = { _interceptorCooldown: CORE_ITEMS.antiMissile.cooldown / 2 };
    expect(CORE_ITEMS.antiMissile.meterFrac(justFired)).toBeCloseTo(0, 5);
    expect(CORE_ITEMS.antiMissile.meterFrac(ready)).toBeCloseTo(1, 5);
    expect(CORE_ITEMS.antiMissile.meterFrac(halfway)).toBeCloseTo(0.5, 5);
  });

  it('antiMissile treats a missing cooldown counter as fully recharged', () => {
    expect(CORE_ITEMS.antiMissile.meterFrac({})).toBeCloseTo(1, 5);
  });
});

describe('shieldConfigFor', () => {
  it('resolves the mounted item\'s shield config', () => {
    expect(shieldConfigFor({ core: 'shield' })).toEqual({ max: 100 });
  });

  it('resolves to no shield when the core slot is empty', () => {
    expect(shieldConfigFor({ core: null })).toEqual({ max: 0 });
  });

  it('resolves to no shield for an unknown/stale id rather than throwing', () => {
    expect(shieldConfigFor({ core: 'not-a-real-core-item' })).toEqual({ max: 0 });
  });

  it('survives a missing coreMounts entirely', () => {
    expect(shieldConfigFor(undefined)).toEqual({ max: 0 });
  });
});
