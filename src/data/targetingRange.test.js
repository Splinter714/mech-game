// #322 — targeting range is DERIVED from the live WEAPONS table, not hand-set. The point of the
// module is that retuning a weapon retunes targeting, so the tests are about the derivation
// tracking the data, not about the literal 1750 it happens to produce today.
import { describe, it, expect } from 'vitest';
import { longestWeaponRange, TARGETING_RANGE } from './targetingRange.js';
import { WEAPONS } from './weapons.js';

describe('longestWeaponRange', () => {
  it('is the maximum range.max across a weapon table', () => {
    const fake = {
      a: { range: { min: 0, opt: 100, max: 300 } },
      b: { range: { min: 0, opt: 400, max: 1200 } },
      c: { range: { min: 0, opt: 200, max: 600 } },
    };
    expect(longestWeaponRange(fake)).toBe(1200);
  });

  it('tracks the data — lengthening the longest weapon moves the result', () => {
    const base = { a: { range: { max: 300 } }, b: { range: { max: 900 } } };
    const retuned = { a: { range: { max: 300 } }, b: { range: { max: 2400 } } };
    expect(longestWeaponRange(retuned)).toBeGreaterThan(longestWeaponRange(base));
    expect(longestWeaponRange(retuned)).toBe(2400);
  });

  it('skips malformed entries rather than poisoning the result', () => {
    const messy = {
      ok: { range: { max: 500 } },
      noRange: {},
      nullRange: { range: null },
      nan: { range: { max: NaN } },
      str: { range: { max: '9999' } },
      undef: undefined,
    };
    expect(longestWeaponRange(messy)).toBe(500);
  });

  it('returns 0 rather than -Infinity for an empty or missing table', () => {
    expect(longestWeaponRange({})).toBe(0);
    expect(longestWeaponRange(null)).toBe(0);
  });
});

describe('TARGETING_RANGE — the live value', () => {
  it('equals the longest range.max in the real WEAPONS table', () => {
    expect(TARGETING_RANGE).toBe(longestWeaponRange(WEAPONS));
  });

  it('is reachable by at least one real weapon and by no weapon beyond it', () => {
    const maxes = Object.values(WEAPONS).map((w) => w.range?.max).filter((r) => typeof r === 'number');
    expect(maxes).toContain(TARGETING_RANGE);
    for (const r of maxes) expect(r).toBeLessThanOrEqual(TARGETING_RANGE);
  });

  it('is a sane positive distance (guards a table that silently lost its ranges)', () => {
    expect(TARGETING_RANGE).toBeGreaterThan(500);
  });
});
