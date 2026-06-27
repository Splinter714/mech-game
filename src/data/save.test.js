import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllMechs, saveAllMechs } from './save.js';

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

    all.mech1.mount('head', 'mediumLaser');
    all.mech1.applyDamage('leftLeg', 7);
    const woundedArmor = all.mech1.parts.leftLeg.armor;
    saveAllMechs(all);

    const reloaded = loadAllMechs();
    expect(reloaded.mech1.mounts.head).toContain('mediumLaser');
    expect(reloaded.mech1.parts.leftLeg.armor).toBe(woundedArmor);
  });
});
