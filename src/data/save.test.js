import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllMechs, saveAllMechs, loadUnlocked, saveUnlocked } from './save.js';
import { STARTING_UNLOCKED } from './shop.js';

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
