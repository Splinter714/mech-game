import { describe, it, expect } from 'vitest';
import {
  claimOutpost, upgradeOutpost, loseOutpost, outpostsByType, MAX_UPGRADE_LEVEL,
  rollOutpostThreat, resolveUndefendedLoss, resolveAllUndefendedLosses,
  regarrisonChance, rollRegarrison, rollRegarrisonForBiome,
  REGARRISON_BASE_CHANCE, REGARRISON_STEP_CHANCE, REGARRISON_CAP_CHANCE,
} from './outposts.js';

const SITE = { id: 'base0-grassland', type: 'resource', coord: { q: 3, r: -1 }, biomeId: 'grassland' };

describe('#511/#512 outposts — claim/upgrade/lose transitions', () => {
  it('claimOutpost adds a fresh record at upgradeLevel 0 and threatState safe', () => {
    const outposts = claimOutpost([], SITE);
    expect(outposts).toHaveLength(1);
    expect(outposts[0]).toMatchObject({ id: SITE.id, type: 'resource', upgradeLevel: 0, threatState: 'safe' });
  });

  it('#517/#518/#519: claimOutpost carries an optional baseId (worldgen base index) and starts deploysHeld at 0', () => {
    const outposts = claimOutpost([], { ...SITE, baseId: 'base0' });
    expect(outposts[0]).toMatchObject({ baseId: 'base0', deploysHeld: 0 });
  });

  it('claimOutpost defaults baseId to null when the caller omits it', () => {
    const outposts = claimOutpost([], SITE);
    expect(outposts[0].baseId).toBeNull();
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

describe('#509 Stage 5 — outpost threat roll and undefended-loss resolution', () => {
  it('rollOutpostThreat flips a safe outpost to attacked when the roll beats the rate', () => {
    const outposts = claimOutpost([], SITE);
    const rolled = rollOutpostThreat(outposts, () => 0, 0.5);   // 0 < 0.5 → always flips
    expect(rolled[0].threatState).toBe('attacked');
  });

  it('rollOutpostThreat leaves a safe outpost alone when the roll misses the rate', () => {
    const outposts = claimOutpost([], SITE);
    const rolled = rollOutpostThreat(outposts, () => 0.99, 0.5);   // 0.99 >= 0.5 → never flips
    expect(rolled[0].threatState).toBe('safe');
  });

  it('rollOutpostThreat never re-rolls an already-attacked outpost', () => {
    let outposts = claimOutpost([], SITE);
    outposts = rollOutpostThreat(outposts, () => 0, 1);   // force attacked
    expect(outposts[0].threatState).toBe('attacked');
    const rolledAgain = rollOutpostThreat(outposts, () => 0, 1);
    expect(rolledAgain).toEqual(outposts);   // no change — not re-rolled
  });

  it('resolveUndefendedLoss on a safe outpost is a no-op', () => {
    const outposts = claimOutpost([], SITE);
    expect(resolveUndefendedLoss(outposts, SITE.id, () => 0)).toBe(outposts);
  });

  it('resolveUndefendedLoss: a losing roll reverts the outpost to unclaimed', () => {
    let outposts = claimOutpost([], SITE);
    outposts = rollOutpostThreat(outposts, () => 0, 1);
    const resolved = resolveUndefendedLoss(outposts, SITE.id, () => 0);   // 0 < any positive loss chance
    expect(resolved).toEqual([]);
  });

  it('resolveUndefendedLoss: a surviving roll reverts threatState to safe, keeps the outpost', () => {
    let outposts = claimOutpost([], SITE);
    outposts = rollOutpostThreat(outposts, () => 0, 1);
    const resolved = resolveUndefendedLoss(outposts, SITE.id, () => 0.999);   // beats any loss chance
    expect(resolved).toHaveLength(1);
    expect(resolved[0].threatState).toBe('safe');
  });

  it('a higher upgrade level lowers the loss chance', () => {
    let low = claimOutpost([], SITE);
    low = rollOutpostThreat(low, () => 0, 1);
    let high = upgradeOutpost(claimOutpost([], SITE), SITE.id, MAX_UPGRADE_LEVEL);
    high = upgradeOutpost(high, SITE.id, MAX_UPGRADE_LEVEL);
    high = rollOutpostThreat(high, () => 0, 1);
    // A roll that survives the max-upgraded outpost but loses the un-upgraded one demonstrates
    // the upgrade actually lowers the chance, rather than asserting an exact number.
    const midRoll = () => 0.4;
    expect(resolveUndefendedLoss(low, SITE.id, midRoll)).toEqual([]);
    expect(resolveUndefendedLoss(high, SITE.id, midRoll)[0]?.threatState).toBe('safe');
  });

  it('resolveAllUndefendedLosses resolves every attacked outpost, leaves safe ones untouched', () => {
    let outposts = claimOutpost([], SITE);
    outposts = claimOutpost(outposts, { id: 'base1-desert', type: 'repair', coord: { q: 5, r: 2 }, biomeId: 'desert' });
    outposts = rollOutpostThreat(outposts, () => 0, 1);   // both attacked
    // Resolve with a roll that always survives, so we can assert both got touched (safe again).
    const resolved = resolveAllUndefendedLosses(outposts, () => 0.999);
    expect(resolved).toHaveLength(2);
    expect(resolved.every((o) => o.threatState === 'safe')).toBe(true);
  });
});

describe('#519 regarrison — escalating percentage chance per deployment', () => {
  it('regarrisonChance starts at the locked base rate with no deployments held', () => {
    expect(regarrisonChance(0)).toBeCloseTo(REGARRISON_BASE_CHANCE);
  });

  it('regarrisonChance escalates by the locked step per deployment held', () => {
    expect(regarrisonChance(1)).toBeCloseTo(REGARRISON_BASE_CHANCE + REGARRISON_STEP_CHANCE);
    expect(regarrisonChance(2)).toBeCloseTo(REGARRISON_BASE_CHANCE + REGARRISON_STEP_CHANCE * 2);
  });

  it('regarrisonChance never exceeds the locked cap, however long the base is held', () => {
    expect(regarrisonChance(100)).toBeCloseTo(REGARRISON_CAP_CHANCE);
    expect(regarrisonChance(1000)).toBeCloseTo(REGARRISON_CAP_CHANCE);
  });

  it('the locked constants match the confirmed design: 15% base, 15%/deploy step, 90% cap', () => {
    expect(REGARRISON_BASE_CHANCE).toBe(0.15);
    expect(REGARRISON_STEP_CHANCE).toBe(0.15);
    expect(REGARRISON_CAP_CHANCE).toBe(0.90);
  });

  it('rollRegarrison on a failing roll increments deploysHeld and keeps the claim', () => {
    let outposts = claimOutpost([], { ...SITE, baseId: 'base0' });
    outposts = rollRegarrison(outposts, SITE.id, () => 0.99);   // 0.99 beats a 15% chance
    expect(outposts).toHaveLength(1);
    expect(outposts[0].deploysHeld).toBe(1);
  });

  it('rollRegarrison on a succeeding roll reverts the claim — same transition as loseOutpost', () => {
    let outposts = claimOutpost([], { ...SITE, baseId: 'base0' });
    outposts = rollRegarrison(outposts, SITE.id, () => 0);   // 0 always beats any positive chance
    expect(outposts).toEqual([]);
  });

  it('the odds actually escalate: a roll that survives a fresh claim can flip a long-held one', () => {
    let fresh = claimOutpost([], { ...SITE, baseId: 'base0' });
    let held = claimOutpost([], { ...SITE, baseId: 'base0' });
    for (let i = 0; i < 6; i++) held = rollRegarrison(held, SITE.id, () => 0.99);   // never flips, just racks up deploysHeld
    expect(held[0].deploysHeld).toBe(6);
    const midRoll = () => 0.2;   // beats the fresh 15% chance, loses to the escalated one
    expect(rollRegarrison(fresh, SITE.id, midRoll)).toHaveLength(1);   // survives
    expect(rollRegarrison(held, SITE.id, midRoll)).toEqual([]);       // flips
  });

  it('rollRegarrison on an unknown id is a no-op', () => {
    const outposts = claimOutpost([], { ...SITE, baseId: 'base0' });
    expect(rollRegarrison(outposts, 'nope', () => 0)).toBe(outposts);
  });

  it('rollRegarrisonForBiome only touches bases in the named biome', () => {
    let outposts = claimOutpost([], { id: 'a', type: 'resource', coord: { q: 0, r: 0 }, biomeId: 'grassland', baseId: 'base0' });
    outposts = claimOutpost(outposts, { id: 'b', type: 'resource', coord: { q: 1, r: 1 }, biomeId: 'desert', baseId: 'base1' });
    const rolled = rollRegarrisonForBiome(outposts, 'grassland', () => 0);   // always flips
    expect(rolled).toHaveLength(1);
    expect(rolled[0].biomeId).toBe('desert');   // the grassland claim is gone, desert untouched
  });

  it('rollRegarrisonForBiome resolves every claim in that biome, not just the first', () => {
    let outposts = claimOutpost([], { id: 'a', type: 'resource', coord: { q: 0, r: 0 }, biomeId: 'grassland', baseId: 'base0' });
    outposts = claimOutpost(outposts, { id: 'b', type: 'resource', coord: { q: 1, r: 1 }, biomeId: 'grassland', baseId: 'base1' });
    const rolled = rollRegarrisonForBiome(outposts, 'grassland', () => 0.99);   // never flips
    expect(rolled).toHaveLength(2);
    expect(rolled.every((o) => o.deploysHeld === 1)).toBe(true);
  });
});
