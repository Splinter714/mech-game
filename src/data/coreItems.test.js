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
