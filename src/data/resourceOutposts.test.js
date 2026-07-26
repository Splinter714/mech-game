import { describe, it, expect } from 'vitest';
import { claimOutpost, outpostForBase } from './outposts.js';
import {
  RESOURCE_OUTPOST_COST, hasResourceOutpost, canBuildResourceOutpost, buildResourceOutpost,
  accrueResourceIncome, RESOURCE_INCOME_PER_SEC,
} from './resourceOutposts.js';

const SITE = {
  id: 'outpost-0-base0', type: 'resource', coord: { q: 3, r: -1 }, biomeId: 'grassland', baseId: 'base0',
};

describe('#511 resourceOutposts — lookup + build transition', () => {
  it('a freshly claimed outpost has resourceBuilt false and is buildable', () => {
    const outposts = claimOutpost([], SITE);
    expect(hasResourceOutpost(outposts, 'grassland', 'base0')).toBe(false);
    expect(canBuildResourceOutpost(outposts, 'grassland', 'base0')).toBe(true);
  });

  it('an unclaimed base is neither built nor buildable', () => {
    expect(hasResourceOutpost([], 'grassland', 'base0')).toBe(false);
    expect(canBuildResourceOutpost([], 'grassland', 'base0')).toBe(false);
  });

  it('buildResourceOutpost flags only the matching outpost, leaving others untouched', () => {
    const other = { ...SITE, id: 'outpost-0-base1', baseId: 'base1' };
    let outposts = claimOutpost([], SITE);
    outposts = claimOutpost(outposts, other);
    const next = buildResourceOutpost(outposts, 'grassland', 'base0');
    expect(next.find((o) => o.baseId === 'base0').resourceBuilt).toBe(true);
    expect(next.find((o) => o.baseId === 'base1').resourceBuilt).toBe(false);
    expect(hasResourceOutpost(next, 'grassland', 'base0')).toBe(true);
    expect(canBuildResourceOutpost(next, 'grassland', 'base0')).toBe(false);
  });

  it('buildResourceOutpost on an unheld base is a no-op (same array back)', () => {
    const outposts = claimOutpost([], SITE);
    expect(buildResourceOutpost(outposts, 'grassland', 'base9')).toBe(outposts);
  });

  it('buildResourceOutpost on an already-built base is a no-op', () => {
    const outposts = claimOutpost([], SITE);
    const built = buildResourceOutpost(outposts, 'grassland', 'base0');
    expect(buildResourceOutpost(built, 'grassland', 'base0')).toBe(built);
  });

  it('RESOURCE_OUTPOST_COST is a positive flat scrap price', () => {
    expect(RESOURCE_OUTPOST_COST).toBeGreaterThan(0);
  });

  it('repair and resource builds are independent flags on the same outpost record', () => {
    let outposts = claimOutpost([], SITE);
    outposts = buildResourceOutpost(outposts, 'grassland', 'base0');
    const record = outpostForBase(outposts, 'grassland', 'base0');
    expect(record.resourceBuilt).toBe(true);
    expect(record.repairBuilt).toBe(false);   // untouched by building the OTHER building
  });
});

describe('#511 accrueResourceIncome — fractional-to-whole scrap tick', () => {
  it('accrues nothing with zero built outposts', () => {
    expect(accrueResourceIncome(0, 0, 1)).toEqual({ amount: 0, carry: 0 });
  });

  it('accrues nothing with zero elapsed time', () => {
    expect(accrueResourceIncome(0, 1, 0)).toEqual({ amount: 0, carry: 0 });
  });

  it('carries a sub-whole fraction forward without banking anything yet', () => {
    // RESOURCE_INCOME_PER_SEC * 1 outpost * a fraction of a second stays under 1 whole scrap.
    const dt = 0.5 / RESOURCE_INCOME_PER_SEC / 4;   // a quarter of the time needed for 1 whole unit
    const { amount, carry } = accrueResourceIncome(0, 1, dt);
    expect(amount).toBe(0);
    expect(carry).toBeGreaterThan(0);
  });

  it('banks whole scrap once the running fraction crosses an integer, keeping the remainder', () => {
    const dt = 1 / RESOURCE_INCOME_PER_SEC;   // exactly enough time for 1 whole unit at rate 1x
    const { amount, carry } = accrueResourceIncome(0, 1, dt);
    expect(amount).toBe(1);
    expect(carry).toBeCloseTo(0);
  });

  it('scales linearly with the number of built outposts', () => {
    const dt = 1 / RESOURCE_INCOME_PER_SEC;
    const one = accrueResourceIncome(0, 1, dt);
    const three = accrueResourceIncome(0, 3, dt);
    expect(three.amount).toBe(one.amount * 3);
  });

  it('never goes negative and never drops accumulated fraction across repeated ticks', () => {
    let carry = 0;
    let totalBanked = 0;
    const smallDt = 0.1;
    for (let i = 0; i < 100; i++) {
      const { amount, carry: nextCarry } = accrueResourceIncome(carry, 1, smallDt);
      totalBanked += amount;
      carry = nextCarry;
      expect(carry).toBeGreaterThanOrEqual(0);
    }
    // Over 10 simulated seconds at RESOURCE_INCOME_PER_SEC, total banked should track the rate
    // (banked whole units can lag the ideal by less than 1, from truncation at each tick).
    const ideal = RESOURCE_INCOME_PER_SEC * 100 * smallDt;
    expect(totalBanked).toBeGreaterThanOrEqual(Math.floor(ideal) - 1);
    expect(totalBanked).toBeLessThanOrEqual(Math.ceil(ideal));
  });
});
