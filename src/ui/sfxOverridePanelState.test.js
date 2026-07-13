import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  storeOverride, setAudioContext, _resetForTest, setStart, setTrim, setFadeOut, setProcessing,
  clearOverride,
} from '../audio/sfxOverrides.js';
import { getOverrideRowState } from './sfxOverridePanelState.js';
import { SFX_DOMAINS, ALL_SFX_DOMAIN_ENTRIES, findSfxDomainEntry } from '../audio/sfxDomains.js';
import { WEAPON_STAGES } from './weaponSfxStages.js';
import { _resetForTest as _resetBakedForTest, _setBakedBufferForTest } from '../audio/bakedSfx.js';

// Same minimal fake IndexedDB as sfxOverrides.test.js — just enough surface for storeOverride/
// setStart/setTrim/setFadeOut/setProcessing to exercise the real persistence code path.
function makeFakeIndexedDB() {
  const databases = new Map();
  function fakeDB(name) {
    if (!databases.has(name)) databases.set(name, new Map());
    const storeMap = databases.get(name);
    return {
      objectStoreNames: { contains: (n) => storeMap.has(n) },
      createObjectStore(n) { storeMap.set(n, new Map()); },
      transaction(names) {
        const nameList = Array.isArray(names) ? names : [names];
        const tx = { oncomplete: null, onerror: null };
        tx.objectStore = (n) => {
          const data = storeMap.get(n);
          return {
            put(record) {
              const req = {};
              queueMicrotask(() => { data.set(record.key, record); req.onsuccess?.(); tx.oncomplete?.(); });
              return req;
            },
            delete(key) {
              const req = {};
              queueMicrotask(() => { data.delete(key); req.onsuccess?.(); tx.oncomplete?.(); });
              return req;
            },
            getAll() {
              const req = {};
              queueMicrotask(() => { req.result = Array.from(data.values()); req.onsuccess?.(); });
              return req;
            },
          };
        };
        return tx;
      },
    };
  }
  return {
    open(name) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
      queueMicrotask(() => {
        const isNew = !databases.has(name);
        req.result = fakeDB(name);
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

function fakeFile(name, tag) {
  return { name, type: 'audio/wav', arrayBuffer: async () => new TextEncoder().encode(tag).buffer };
}

// Decodes to a fake AudioBuffer WITH a real `.duration`, so getOverrideRowState's fullSec/
// startSec/endSec math has something meaningful to clamp against (unlike sfxOverrides.test.js's
// bare `{ __decodedFrom }` fakes, which don't need a duration for what they assert).
function fakeCtx(duration = 2) {
  return { decodeAudioData: async () => ({ duration }) };
}

describe('sfxOverridePanelState (#177 generalized id/stage panel display state)', () => {
  beforeEach(() => {
    _resetForTest();
    _resetBakedForTest();
    globalThis.indexedDB = makeFakeIndexedDB();
    setAudioContext(fakeCtx());
  });
  afterEach(() => {
    delete globalThis.indexedDB;
  });

  it('reports "no override" for an untouched (id, stage), weapon or otherwise', () => {
    expect(getOverrideRowState('autocannon', 'fire')).toEqual({
      active: false, statusText: 'file override: none (procedural)', meta: null, proceduralControlsVisible: true,
    });
    expect(getOverrideRowState('ui_test', 'nav')).toEqual({
      active: false, statusText: 'file override: none (procedural)', meta: null, proceduralControlsVisible: true,
    });
  });

  // #181: the procedural layer-editing controls (tone/noise sliders authoring the ORIGINAL
  // synthesis def) should hide once a real file has taken over — whether that's a live dev
  // override OR a shipped bake. `plasmaLance`/`fire` carries a real bake (#175); `plasmaLance`/
  // `impact` has neither, so it proves the "stays visible" branch on the SAME weapon (only the
  // overridden/baked stage hides, other stages of the same weapon are unaffected).
  it('reports proceduralControlsVisible: false for a stage with an active BAKE, true for a sibling stage with none', () => {
    _setBakedBufferForTest('plasmaLance', 'fire', { duration: 1.2 });
    expect(getOverrideRowState('plasmaLance', 'fire').proceduralControlsVisible).toBe(false);
    // The baked stage still reports no runtime override — `active` (file-override-loaded) and
    // `proceduralControlsVisible` are deliberately independent booleans.
    expect(getOverrideRowState('plasmaLance', 'fire').active).toBe(false);
    expect(getOverrideRowState('plasmaLance', 'impact').proceduralControlsVisible).toBe(true);
  });

  // #181: a live dev-tool override (no bake involved) also hides the procedural controls, and
  // they reappear once the override is cleared (with no bake present to keep them hidden).
  it('flips proceduralControlsVisible false->true across storeOverride -> clearOverride when no bake exists', async () => {
    const id = 'autocannon';
    const stage = 'fire';
    expect(getOverrideRowState(id, stage).proceduralControlsVisible).toBe(true);

    await storeOverride(id, stage, fakeFile('boom.wav', 'BOOM'));
    expect(getOverrideRowState(id, stage).proceduralControlsVisible).toBe(false);

    await clearOverride(id, stage);
    expect(getOverrideRowState(id, stage).proceduralControlsVisible).toBe(true);
  });

  // The core proof requested by #177: a synthetic NON-weapon id ('ui_test') with an arbitrary
  // stage name ('nav', not fire/trajectory/impact) round-trips a loaded file + every tunable
  // (start/trim, fade-out, processing) through sfxOverrides.js AND displays/edits correctly via
  // getOverrideRowState — the exact function WeaponSfxPanel's _buildOverrideRow renders from.
  // Nothing here is weapon-specific; the same assertions would hold verbatim for a real weapon.
  it('round-trips a non-weapon (id, stage) target end-to-end through the panel display state', async () => {
    const id = 'ui_test';
    const stage = 'nav';

    // Not a weapon id, not one of the three weapon stage names — proves the plumbing carries
    // no hidden assumption about either.
    expect(WEAPON_STAGES.some(([key]) => key === stage)).toBe(false);

    await storeOverride(id, stage, fakeFile('click.wav', 'CLICK'));
    let state = getOverrideRowState(id, stage);
    expect(state.active).toBe(true);
    expect(state.statusText).toBe('file override: click.wav');
    expect(state.fullSec).toBe(2);
    expect(state.startSec).toBe(0);
    expect(state.endSec).toBe(2);
    expect(state.fadeMs).toBe(0);
    expect(state.proc).toEqual({});

    // Edit start/trim (#166) — mirrors the start/end slider onChange handlers in
    // _buildOverrideRow: start at 0.5s, end at 1.5s (stored as startMs=500, trimMs=1000).
    await setStart(id, stage, 500);
    await setTrim(id, stage, 1000);
    state = getOverrideRowState(id, stage);
    expect(state.startSec).toBeCloseTo(0.5);
    expect(state.endSec).toBeCloseTo(1.5);

    // Edit fade-out (#174).
    await setFadeOut(id, stage, 200);
    state = getOverrideRowState(id, stage);
    expect(state.fadeMs).toBe(200);
    expect(state.fadeMax).toBe(1000); // capped at the played window (endSec - startSec)

    // Edit processing (#172) — pitch/filter/reverb merge-patch.
    await setProcessing(id, stage, { detune: 150, filterType: 'lowpass', filterFreq: 900 });
    state = getOverrideRowState(id, stage);
    expect(state.proc).toEqual({ detune: 150, filterType: 'lowpass', filterFreq: 900 });

    // A DIFFERENT (id, stage) — including the weapon 'fire' stage of a totally unrelated id —
    // must stay untouched by any of the above (the storage/display layer keys purely on the
    // (id, stage) pair, never assumes "weapon" vs. "non-weapon").
    expect(getOverrideRowState(id, 'fire').active).toBe(false);
    expect(getOverrideRowState('autocannon', stage).active).toBe(false);
  });

  it('exposes the #178 UI/pickup sound-domain registry that round-trips through the same helpers', () => {
    expect(Array.isArray(SFX_DOMAINS.ui)).toBe(true);
    const expectedIds = ['equip', 'unequip', 'deploy', 'menuNav', 'scrapPickup', 'powerupPickup'];
    for (const id of expectedIds) {
      const entry = SFX_DOMAINS.ui.find((e) => e.id === id);
      expect(entry).toBeTruthy();
      expect(entry.stages).toEqual([['play', 'PLAY']]);
      expect(ALL_SFX_DOMAIN_ENTRIES).toContain(entry);
      expect(findSfxDomainEntry(id)).toBe(entry);
    }
    expect(findSfxDomainEntry('does_not_exist')).toBeNull();
  });

  it('resolves a real UI domain (id, stage) pair through the override/bake lookup path exactly like a weapon stage', async () => {
    const entry = findSfxDomainEntry('equip');
    const [stage] = entry.stages[0];
    expect(getOverrideRowState(entry.id, stage).active).toBe(false);
    await storeOverride(entry.id, stage, fakeFile('clunk.wav', 'CLUNK'));
    const state = getOverrideRowState(entry.id, stage);
    expect(state.active).toBe(true);
    expect(state.statusText).toContain('clunk.wav');
    // A different domain entry's same stage name stays untouched — proves the lookup keys on
    // the full (id, stage) pair, not just the stage.
    expect(getOverrideRowState('deploy', stage).active).toBe(false);
  });
});
