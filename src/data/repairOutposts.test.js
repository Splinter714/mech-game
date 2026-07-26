import { describe, it, expect } from 'vitest';
import { claimOutpost } from './outposts.js';
import {
  REPAIR_OUTPOST_COST, outpostForBase, hasRepairOutpost, canBuildRepairOutpost, buildRepairOutpost,
} from './repairOutposts.js';

const SITE = {
  id: 'outpost-0-base0', type: 'resource', coord: { q: 3, r: -1 }, biomeId: 'grassland', baseId: 'base0',
};

describe('#512 repairOutposts — lookup + build transition', () => {
  it('outpostForBase finds a claimed base by (biomeId, baseId), not by the outpost id', () => {
    const outposts = claimOutpost([], SITE);
    expect(outpostForBase(outposts, 'grassland', 'base0')).toMatchObject({ baseId: 'base0', biomeId: 'grassland' });
    expect(outpostForBase(outposts, 'desert', 'base0')).toBeNull();
    expect(outpostForBase(outposts, 'grassland', 'base1')).toBeNull();
  });

  it('a freshly claimed outpost has repairBuilt false and is buildable', () => {
    const outposts = claimOutpost([], SITE);
    expect(hasRepairOutpost(outposts, 'grassland', 'base0')).toBe(false);
    expect(canBuildRepairOutpost(outposts, 'grassland', 'base0')).toBe(true);
  });

  it('an unclaimed base is neither built nor buildable', () => {
    expect(hasRepairOutpost([], 'grassland', 'base0')).toBe(false);
    expect(canBuildRepairOutpost([], 'grassland', 'base0')).toBe(false);
  });

  it('buildRepairOutpost flags only the matching outpost, leaving others untouched', () => {
    const other = { ...SITE, id: 'outpost-0-base1', baseId: 'base1' };
    let outposts = claimOutpost([], SITE);
    outposts = claimOutpost(outposts, other);
    const next = buildRepairOutpost(outposts, 'grassland', 'base0');
    expect(next.find((o) => o.baseId === 'base0').repairBuilt).toBe(true);
    expect(next.find((o) => o.baseId === 'base1').repairBuilt).toBe(false);
    expect(hasRepairOutpost(next, 'grassland', 'base0')).toBe(true);
    expect(canBuildRepairOutpost(next, 'grassland', 'base0')).toBe(false);
  });

  it('buildRepairOutpost on an unheld base is a no-op (same array back)', () => {
    const outposts = claimOutpost([], SITE);
    expect(buildRepairOutpost(outposts, 'grassland', 'base9')).toBe(outposts);
  });

  it('buildRepairOutpost on an already-built base is a no-op', () => {
    const outposts = claimOutpost([], SITE);
    const built = buildRepairOutpost(outposts, 'grassland', 'base0');
    expect(buildRepairOutpost(built, 'grassland', 'base0')).toBe(built);
  });

  it('REPAIR_OUTPOST_COST is a positive flat scrap price', () => {
    expect(REPAIR_OUTPOST_COST).toBeGreaterThan(0);
  });
});
