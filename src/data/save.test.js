import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadAllMechs, saveAllMechs, loadUnlocked, saveUnlocked,
  loadClearedBiomes, saveClearedBiomes, markBiomeCleared, allBiomesCleared,
} from './save.js';
import { STARTING_UNLOCKED } from './shop.js';
import { BIOME_IDS } from './biomes.js';

// Minimal in-memory localStorage stub (vitest runs in node, which has none). save.js
// reads localStorage lazily inside its functions, so installing it per-test is enough.
beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
});

describe('garage persistence', () => {
  it('loads the default build, then persists and reloads edits + damage', () => {
    const all = loadAllMechs();
    expect(all.mech1).toBeDefined();
    expect(all.mech1.chassisId).toBe('medium');

    all.mech1.unmount('leftTorso', 0);
    all.mech1.mount('leftTorso', 'pulseLaser');
    all.mech1.applyDamage('rightTorso', 7);
    const woundedArmor = all.mech1.parts.rightTorso.armor;
    saveAllMechs(all);

    const reloaded = loadAllMechs();
    expect(reloaded.mech1.mounts.leftTorso).toContain('pulseLaser');
    expect(reloaded.mech1.parts.rightTorso.armor).toBe(woundedArmor);
  });

  // #248: light/heavy chassis are disabled for now — every mech, including one saved before
  // this change with a non-medium chassisId, is forced onto medium on load.
  it('force-migrates a pre-existing non-medium save onto medium', () => {
    globalThis.localStorage.setItem('mech-game-mechs-v1', JSON.stringify({
      mech1: { chassisId: 'heavy', name: 'Old Save', mounts: {} },
    }));
    const all = loadAllMechs();
    expect(all.mech1.chassisId).toBe('medium');
  });
});

describe('unlocked-catalog persistence (#65)', () => {
  it('a fresh save starts with exactly the starting kit unlocked', () => {
    const unlocked = loadUnlocked();
    for (const id of STARTING_UNLOCKED) expect(unlocked.has(id)).toBe(true);
  });

  it('persists a newly-unlocked item across a reload', () => {
    const unlocked = loadUnlocked();
    unlocked.add('shotgun');
    saveUnlocked(unlocked);

    const reloaded = loadUnlocked();
    expect(reloaded.has('shotgun')).toBe(true);
  });

  it('the starting kit can never be dropped, even from a corrupt/old save', () => {
    globalThis.localStorage.setItem('mech-game-unlocked-v1', JSON.stringify(['shotgun']));
    const unlocked = loadUnlocked();
    for (const id of STARTING_UNLOCKED) expect(unlocked.has(id)).toBe(true);
    expect(unlocked.has('shotgun')).toBe(true);
  });
});

// #240: the boss-arena unlock — one SUCCESSFUL run in each of the 5 biomes. The "a death does
// not count" half of the rule is enforced at the single call site (scenes/arena/run.js `_endRun`
// only marks on the 'won' branch), so the persistence-level guarantee tested here is the one
// that backs it: nothing is ever marked unless someone explicitly marks it, and the all-5
// condition is a real per-biome set, not a count of runs.
describe('per-biome run completion (#240 boss-arena unlock)', () => {
  it('a fresh save has cleared nothing and the boss arena is locked', () => {
    expect(loadClearedBiomes().size).toBe(0);
    expect(allBiomesCleared()).toBe(false);
  });

  it('marking a biome complete persists it across a reload', () => {
    markBiomeCleared('desert');
    const reloaded = loadClearedBiomes();
    expect(reloaded.has('desert')).toBe(true);
    expect(reloaded.size).toBe(1);
  });

  it('marking the same biome twice does not double-count', () => {
    markBiomeCleared('arctic');
    markBiomeCleared('arctic');
    expect(loadClearedBiomes().size).toBe(1);
    expect(allBiomesCleared()).toBe(false);
  });

  it('unlocks only once ALL five biomes are cleared, not after five wins', () => {
    for (const id of BIOME_IDS.slice(0, -1)) markBiomeCleared(id);
    expect(allBiomesCleared()).toBe(false);
    markBiomeCleared(BIOME_IDS[BIOME_IDS.length - 1]);
    expect(allBiomesCleared()).toBe(true);
  });

  it('a run that ends in DEATH marks nothing — completion is only ever recorded explicitly', () => {
    // Mirror the arena's terminal-run branch: a loss never calls markBiomeCleared at all.
    const endRun = (status, biomeId) => { if (status === 'won') markBiomeCleared(biomeId); };
    for (const id of BIOME_IDS) endRun('dead', id);
    expect(loadClearedBiomes().size).toBe(0);
    expect(allBiomesCleared()).toBe(false);
    endRun('won', BIOME_IDS[0]);
    expect(loadClearedBiomes().has(BIOME_IDS[0])).toBe(true);
  });

  it('ignores an unknown biome id, so a stale save can never fake the unlock', () => {
    markBiomeCleared('atlantis');
    expect(loadClearedBiomes().size).toBe(0);
    saveClearedBiomes(new Set([...BIOME_IDS, 'atlantis']));
    const reloaded = loadClearedBiomes();
    expect(reloaded.has('atlantis')).toBe(false);
    expect(allBiomesCleared(reloaded)).toBe(true);
  });

  it('survives a corrupt save without throwing', () => {
    globalThis.localStorage.setItem('mech-game-biome-clears-v1', 'not json');
    expect(loadClearedBiomes().size).toBe(0);
    expect(allBiomesCleared()).toBe(false);
  });
});
