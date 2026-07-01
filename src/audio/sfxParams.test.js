import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SFX, loadSfxParams, saveSfxParams, HELD_SFX, hasHeldSfx } from './sfxParams.js';

// A minimal in-memory localStorage mock — vitest's default (node) environment has no
// real one, and this only needs get/set for these tests.
function mockLocalStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

describe('SFX param persistence (Weapon Lab sound panel)', () => {
  beforeEach(() => { globalThis.localStorage = mockLocalStorage(); });

  it('falls back to the shipped defaults with nothing saved', () => {
    const params = loadSfxParams();
    expect(params.autocannon.fire[0].gain).toBe(DEFAULT_SFX.autocannon.fire[0].gain);
  });

  it('round-trips a tuned value through save/load', () => {
    const params = loadSfxParams();
    params.autocannon.fire[0].gain = 0.99;
    saveSfxParams(params);
    const reloaded = loadSfxParams();
    expect(reloaded.autocannon.fire[0].gain).toBe(0.99);
  });

  it('merges a saved value UNDER current defaults, field by field', () => {
    // Only one field of one weapon was ever tuned; everything else — other fields, other
    // weapons, and any weapon/field added to the defaults since — must still come through.
    localStorage.setItem('mech-game-sfx-params-v1', JSON.stringify({
      autocannon: { fire: [{ gain: 0.5 }] },
    }));
    const params = loadSfxParams();
    expect(params.autocannon.fire[0].gain).toBe(0.5);                              // saved
    expect(params.autocannon.fire[0].freq).toBe(DEFAULT_SFX.autocannon.fire[0].freq); // untouched field
    expect(params.autocannon.impact).toEqual(DEFAULT_SFX.autocannon.impact);          // untouched stage
    expect(params.shotgun).toEqual(DEFAULT_SFX.shotgun);                              // untouched weapon
  });

  it('never throws if localStorage is unavailable or holds garbage', () => {
    globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(() => loadSfxParams()).not.toThrow();
    expect(() => saveSfxParams(DEFAULT_SFX)).not.toThrow();

    globalThis.localStorage = { getItem: () => 'not json{{', setItem: () => {} };
    expect(() => loadSfxParams()).not.toThrow();
  });
});

describe('gunCrackLayers (#54 — 4-layer ballistic crack)', () => {
  it('gives autocannon/shotgun 2 tone + 2 noise layers', () => {
    for (const id of ['autocannon', 'shotgun']) {
      const layers = DEFAULT_SFX[id].fire;
      expect(layers.length).toBe(4);
      expect(layers.filter((l) => l.kind === 'noise').length).toBe(2);
      expect(layers.filter((l) => l.kind === 'tone').length).toBe(2);
    }
  });

  it('leaves machineGun on its own bespoke layers, untouched', () => {
    expect(DEFAULT_SFX.machineGun.fire.length).toBe(2);
  });
});

describe('HELD_SFX (#53 — held/looping fire sound data)', () => {
  it('has an entry for flamethrower and beamLaser', () => {
    expect(HELD_SFX.flamethrower).toBeTruthy();
    expect(HELD_SFX.beamLaser).toBeTruthy();
  });

  it('hasHeldSfx reports true only for weapons with an entry', () => {
    expect(hasHeldSfx('flamethrower')).toBe(true);
    expect(hasHeldSfx('beamLaser')).toBe(true);
    expect(hasHeldSfx('autocannon')).toBe(false);
    expect(hasHeldSfx('made-up-weapon')).toBe(false);
  });
});
