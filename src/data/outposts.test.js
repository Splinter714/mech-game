import { describe, it, expect } from 'vitest';
import { claimOutpost, upgradeOutpost, loseOutpost, outpostsByType, MAX_UPGRADE_LEVEL } from './outposts.js';

const SITE = { id: 'base0-grassland', type: 'resource', coord: { q: 3, r: -1 }, biomeId: 'grassland' };

describe('#511/#512 outposts — claim/upgrade/lose transitions', () => {
  it('claimOutpost adds a fresh record at upgradeLevel 0 and threatState safe', () => {
    const outposts = claimOutpost([], SITE);
    expect(outposts).toHaveLength(1);
    expect(outposts[0]).toMatchObject({ id: SITE.id, type: 'resource', upgradeLevel: 0, threatState: 'safe' });
  });

  it('claiming an already-held id is a no-op, not a re-claim', () => {
    const once = claimOutpost([], SITE);
    const twice = claimOutpost(once, SITE);
    expect(twice).toHaveLength(1);
    expect(twice).toBe(once);   // literally the same array reference — a true no-op
  });

  it('upgradeOutpost increments only the matching outpost, capped at maxLevel', () => {
    let outposts = claimOutpost([], SITE);
    outposts = upgradeOutpost(outposts, SITE.id);
    expect(outposts[0].upgradeLevel).toBe(1);
    outposts = upgradeOutpost(outposts, SITE.id);
    expect(outposts[0].upgradeLevel).toBe(MAX_UPGRADE_LEVEL);
    outposts = upgradeOutpost(outposts, SITE.id);   // already at cap
    expect(outposts[0].upgradeLevel).toBe(MAX_UPGRADE_LEVEL);
  });

  it('upgradeOutpost on an unknown id leaves the list untouched', () => {
    const outposts = claimOutpost([], SITE);
    expect(upgradeOutpost(outposts, 'nope')).toEqual(outposts);
  });

  it('loseOutpost reverts to unclaimed — the id simply leaves the list', () => {
    const outposts = claimOutpost([], SITE);
    expect(loseOutpost(outposts, SITE.id)).toEqual([]);
  });

  it('retaking a lost outpost starts fresh at upgradeLevel 0 (no memory of the old one)', () => {
    let outposts = claimOutpost([], SITE);
    outposts = upgradeOutpost(outposts, SITE.id);
    outposts = loseOutpost(outposts, SITE.id);
    outposts = claimOutpost(outposts, SITE);
    expect(outposts[0].upgradeLevel).toBe(0);
  });

  it('outpostsByType filters correctly', () => {
    let outposts = claimOutpost([], SITE);
    outposts = claimOutpost(outposts, { id: 'base1-desert', type: 'repair', coord: { q: 5, r: 2 }, biomeId: 'desert' });
    expect(outpostsByType(outposts, 'resource')).toHaveLength(1);
    expect(outpostsByType(outposts, 'repair')).toHaveLength(1);
    expect(outpostsByType(outposts, 'resource')[0].id).toBe(SITE.id);
  });
});
