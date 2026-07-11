import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_SFX, loadSfxParams, saveSfxParams, hasHeldSfx,
  EXPLOSION_CATEGORIES, EXPLOSION_CATEGORY_LABEL, explosionSfxId, scaleExplosionLayer,
} from './sfxParams.js';

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
    // A real save always round-trips COMPLETE layer objects (incl. `kind`) — only one field
    // was ever actually tuned, but everything else on that layer, other layers, other
    // stages, and any weapon added to the defaults since must still come through.
    localStorage.setItem('mech-game-sfx-params-v1', JSON.stringify({
      autocannon: { fire: [{ ...DEFAULT_SFX.autocannon.fire[0], gain: 0.5 }] },
    }));
    const params = loadSfxParams();
    expect(params.autocannon.fire[0].gain).toBe(0.5);                              // saved
    expect(params.autocannon.fire[0].freq).toBe(DEFAULT_SFX.autocannon.fire[0].freq); // untouched field
    expect(params.autocannon.impact).toEqual(DEFAULT_SFX.autocannon.impact);          // untouched stage
    expect(params.shotgun).toEqual(DEFAULT_SFX.shotgun);                              // untouched weapon
  });

  it('ignores a saved layer whose kind no longer matches the default at that index (shape drift)', () => {
    // Simulates the exact bug this guards against: a layer count/order change (e.g. #54's
    // ballistic expansion) shifts what USED to be a tone layer into a noise layer's slot.
    // A naive index-based merge would splice the stale tone fields (incl. `type`) onto it,
    // silently turning a noise layer into a tone. The mismatched save must be ignored.
    localStorage.setItem('mech-game-sfx-params-v1', JSON.stringify({
      autocannon: { fire: [{ kind: 'tone', type: 'triangle', freq: 999, gain: 0.99 }] },
    }));
    const params = loadSfxParams();
    expect(params.autocannon.fire[0]).toEqual(DEFAULT_SFX.autocannon.fire[0]); // pure default, save ignored
  });

  it('never throws if localStorage is unavailable or holds garbage', () => {
    globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(() => loadSfxParams()).not.toThrow();
    expect(() => saveSfxParams(DEFAULT_SFX)).not.toThrow();

    globalThis.localStorage = { getItem: () => 'not json{{', setItem: () => {} };
    expect(() => loadSfxParams()).not.toThrow();
  });
});

describe('every weapon fire stage has 2 tone + 2 noise layers (#54, extended to all weapons)', () => {
  it('gives every weapon in DEFAULT_SFX exactly 2 tone + 2 noise fire layers', () => {
    for (const [id, entry] of Object.entries(DEFAULT_SFX)) {
      const layers = entry.fire;
      expect(layers.length, `${id}.fire should have 4 layers`).toBe(4);
      expect(layers.filter((l) => l.kind === 'noise').length, `${id}.fire noise count`).toBe(2);
      expect(layers.filter((l) => l.kind === 'tone').length, `${id}.fire tone count`).toBe(2);
    }
  });

  it('gives machineGun its own bespoke layers (not gunCrackLayers)', () => {
    // Bespoke, not the shared archetype: the tuned first noise layer's filter type differs
    // from gunCrackLayers' first layer ('highpass').
    expect(DEFAULT_SFX.machineGun.fire[0].type).toBe('bandpass');
  });
});

describe('destruction-explosion size categories (#107)', () => {
  it('gives every category its own DEFAULT_SFX entry, tunable through the identical plumbing', () => {
    for (const category of EXPLOSION_CATEGORIES) {
      const id = explosionSfxId(category);
      expect(DEFAULT_SFX[id], `${id} should exist in DEFAULT_SFX`).toBeTruthy();
      expect(DEFAULT_SFX[id].fire.length).toBeGreaterThan(0);
      expect(EXPLOSION_CATEGORY_LABEL[category]).toBeTruthy();
    }
  });

  it('falls back to medium for an unrecognized category', () => {
    expect(explosionSfxId('bogus')).toBe(explosionSfxId('medium'));
  });

  it('graduates louder/longer/lower-pitched small → massive (bigger boom for a tougher kill)', () => {
    const small = DEFAULT_SFX[explosionSfxId('small')].fire[0];   // sub-bass tone layer
    const massive = DEFAULT_SFX[explosionSfxId('massive')].fire[0];
    expect(massive.dur).toBeGreaterThan(small.dur);      // more sustain
    expect(massive.gain).toBeGreaterThan(small.gain);    // louder
    expect(massive.freq).toBeLessThan(small.freq);       // lower pitch = more bass
  });

  it('deathExplosion (continuous, used elsewhere) is untouched by the category split', () => {
    expect(DEFAULT_SFX.deathExplosion.fire.length).toBe(4);
  });

  it('scaleExplosionLayer scales dur/gain up and freq down for a bigger factor, and is pure', () => {
    const layer = { kind: 'tone', freq: 100, freqEnd: 20, dur: 0.5, gain: 0.3 };
    const out = scaleExplosionLayer(layer, 1.5);
    expect(out.dur).toBeCloseTo(0.75, 5);
    expect(out.gain).toBeCloseTo(0.3 * (0.7 + 0.3 * 1.5), 5);
    expect(out.freq).toBeCloseTo(100 / 1.5, 5);
    expect(out.freqEnd).toBeCloseTo(20 / 1.5, 5);
    expect(layer.dur).toBe(0.5); // input untouched
  });

  it('leaves a zero-gain (silent) layer silent regardless of scale', () => {
    const out = scaleExplosionLayer({ kind: 'tone', freq: 90, gain: 0 }, 1.55);
    expect(out.gain).toBe(0);
  });
});

describe('held/looping fire sound (#53) reuses `fire`, not a separate table', () => {
  it('hasHeldSfx reports true only for flamethrower/beamLaser', () => {
    expect(hasHeldSfx('flamethrower')).toBe(true);
    expect(hasHeldSfx('beamLaser')).toBe(true);
    expect(hasHeldSfx('autocannon')).toBe(false);
    expect(hasHeldSfx('made-up-weapon')).toBe(false);
  });

  it('flamethrower/beamLaser have at least one audible (non-zero gain) fire layer', () => {
    // Exact values are expected to drift as they're hand-tuned via the panel — just confirm
    // the held loop actually has something to play, of the kind its comment claims.
    expect(DEFAULT_SFX.flamethrower.fire.some((l) => l.gain > 0)).toBe(true);
    expect(DEFAULT_SFX.beamLaser.fire.some((l) => l.gain > 0)).toBe(true);
  });
});
