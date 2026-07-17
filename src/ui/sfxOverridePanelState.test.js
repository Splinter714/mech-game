import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  storeOverride, setAudioContext, _resetForTest, setStart, setTrim, setFadeOut, setProcessing, setVolume,
  clearOverride, hasOverride, seedOverrideFromBaked, getOverride, variantStage, removeOverrideVariant,
} from '../audio/sfxOverrides.js';
import { getOverrideRowState, getVariantSlotCount, getVariantRowStates } from './sfxOverridePanelState.js';
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

  it('reports "no override" for an untouched (id, stage) with NEITHER an override nor a bake — #186 unchanged path', () => {
    expect(getOverrideRowState('autocannon', 'fire')).toEqual({
      active: false, source: 'none', statusText: 'file override: none (procedural)', meta: null, proceduralControlsVisible: true,
    });
    expect(getOverrideRowState('ui_test', 'nav')).toEqual({
      active: false, source: 'none', statusText: 'file override: none (procedural)', meta: null, proceduralControlsVisible: true,
    });
    // #186: plasmaLance/impact has no bake and no override — same "none (procedural)" path,
    // proving a bake elsewhere (plasmaLance/fire, see below) doesn't leak onto a sibling stage.
    expect(getOverrideRowState('plasmaLance', 'impact')).toEqual({
      active: false, source: 'none', statusText: 'file override: none (procedural)', meta: null, proceduralControlsVisible: true,
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
    expect(getOverrideRowState('plasmaLance', 'impact').proceduralControlsVisible).toBe(true);
  });

  // #186: the core new behavior — a stage with a shipped bake but NO live override yet must show
  // as "loaded," populated from the bake's own recipe, not from "none (procedural)". Uses the REAL
  // plasmaLance/fire bake config from #268 (startMs 0, trimMs 170, fadeOutMs 1800, no processing).
  it('populates getOverrideRowState from the BAKE recipe when a bake exists but no live override yet', () => {
    _setBakedBufferForTest('plasmaLance', 'fire', { duration: 1.199, numberOfChannels: 1, sampleRate: 44100 });
    const state = getOverrideRowState('plasmaLance', 'fire');
    expect(state.active).toBe(true);
    expect(state.source).toBe('baked');
    expect(state.statusText).toMatch(/baked/i);
    expect(state.fullSec).toBeCloseTo(1.199);
    expect(state.startSec).toBe(0);           // bake's startMs: 0
    expect(state.endSec).toBeCloseTo(0.17);   // bake's trimMs: 170
    // The bake's own fadeOutMs (1800) exceeds its 170ms played window on purpose (see bakedSfx.js's
    // comment on this exact entry) — getOverrideRowState clamps it to the played window, same as
    // it already does for a live override's fadeMs.
    expect(state.fadeMax).toBe(170);
    expect(state.fadeMs).toBe(170);
    expect(state.volume).toBe(1);
    expect(state.proc).toEqual({});
    // No live runtime override exists yet — this is purely the bake's recipe on display.
    expect(hasOverride('plasmaLance', 'fire')).toBe(false);
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
    expect(state.volume).toBe(1);   // #182: defaults to unity gain
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

    // Edit volume (#182).
    await setVolume(id, stage, 1.4);
    state = getOverrideRowState(id, stage);
    expect(state.volume).toBe(1.4);

    // A DIFFERENT (id, stage) — including the weapon 'fire' stage of a totally unrelated id —
    // must stay untouched by any of the above (the storage/display layer keys purely on the
    // (id, stage) pair, never assumes "weapon" vs. "non-weapon").
    expect(getOverrideRowState(id, 'fire').active).toBe(false);
    expect(getOverrideRowState('autocannon', stage).active).toBe(false);
  });

  // #186: the seeding-on-first-edit flow — WeaponSfxPanel's _editOverride calls
  // seedOverrideFromBaked the moment the owner touches ANY control for a bake-only stage. Proves
  // the seeded override (a) actually exists afterward (hasOverride flips true), (b) starts with
  // the bake's own recipe values carried over (so the row reads identically right after seeding,
  // before any of the owner's own edit is applied), and (c) that a NEW edit on top of the seeded
  // override persists normally and is what a subsequent playback-precedence check would resolve
  // (override still beats baked — unchanged #173 precedence, not touched by this issue).
  it('seedOverrideFromBaked creates a real live override from the bake, seeded with its recipe, which then persists edits and beats the bake at resolution', async () => {
    const id = 'plasmaLance';
    const stage = 'fire';
    const length = Math.round(1.199 * 44100);
    const data = new Float32Array(length).fill(0.1);
    _setBakedBufferForTest(id, stage, {
      duration: 1.199, numberOfChannels: 1, sampleRate: 44100, length, getChannelData: () => data,
    });

    expect(hasOverride(id, stage)).toBe(false);
    expect(getOverrideRowState(id, stage).source).toBe('baked');

    const ok = await seedOverrideFromBaked(id, stage);
    expect(ok).toBe(true);
    expect(hasOverride(id, stage)).toBe(true);

    // Right after seeding (before any further edit), the row now shows a LIVE override — but
    // seeded with the bake's own recipe, so nothing audibly changes yet.
    let state = getOverrideRowState(id, stage);
    expect(state.source).toBe('override');
    expect(state.startSec).toBe(0);
    expect(state.endSec).toBeCloseTo(0.17);
    expect(state.fadeMs).toBe(170); // clamped to the played window, same as the bake-only reading

    // A second call is a no-op (already seeded) — doesn't stomp the override that's there.
    const bufferBeforeSecondSeed = getOverride(id, stage);
    const ok2 = await seedOverrideFromBaked(id, stage);
    expect(ok2).toBe(true);
    expect(getOverride(id, stage)).toBe(bufferBeforeSecondSeed);

    // Now apply the owner's OWN edit on top of the freshly-seeded override (mirrors what the
    // panel's start-slider onChange does after _editOverride's seeding step) — this must persist
    // through the ordinary setter path exactly like any hand-loaded override.
    await setStart(id, stage, 40);
    state = getOverrideRowState(id, stage);
    expect(state.startSec).toBeCloseTo(0.04);
    expect(state.source).toBe('override');

    // Precedence check (#173, unchanged): with a live override now present, sfx.js's playOverride
    // choke point resolves the OVERRIDE, not the bake — getOverride/hasOverride is exactly what
    // that choke point reads (see src/audio/sfx.js), so this proves the override wins.
    expect(hasOverride(id, stage)).toBe(true);
    expect(getOverride(id, stage)).toBeTruthy();
  });

  // #186: seeding is a no-op (returns false) when there's nothing to seed from — no bake and no
  // override for this (id, stage) — so a caller can safely call it unconditionally without first
  // checking hasBaked itself.
  it('seedOverrideFromBaked returns false and does nothing when there is no bake for this (id, stage)', async () => {
    const ok = await seedOverrideFromBaked('plasmaLance', 'impact');
    expect(ok).toBe(false);
    expect(hasOverride('plasmaLance', 'impact')).toBe(false);
  });

  it('exposes the #178 UI/pickup sound-domain registry that round-trips through the same helpers', () => {
    expect(Array.isArray(SFX_DOMAINS.ui)).toBe(true);
    const expectedIds = [
      'equip', 'deploy', 'menuNav', 'scrapPickup',
      'powerupPickupOvercharge', 'powerupPickupOverdrive', 'powerupPickupOverclock',
      'powerupPickupArmorPatch', 'powerupPickupShield',
    ];
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

  // #195: the tuner panel's variant-pool state helpers — how many slots to render, and each
  // slot's own display state (reusing getOverrideRowState per variant, unchanged per-slot shape).
  describe('variant pool state (#195)', () => {
    it('an untouched (id, stage) has exactly 1 slot (the empty base slot), same as every stage before #195', () => {
      expect(getVariantSlotCount('autocannon', 'fire')).toBe(1);
      const states = getVariantRowStates('autocannon', 'fire');
      expect(states).toHaveLength(1);
      expect(states[0]).toEqual(getOverrideRowState('autocannon', 'fire'));
    });

    it('a single loaded override still reports exactly 1 slot — byte-identical to pre-#195', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('only.wav', 'ONLY'));
      expect(getVariantSlotCount('autocannon', 'fire')).toBe(1);
      const states = getVariantRowStates('autocannon', 'fire');
      expect(states).toHaveLength(1);
      expect(states[0].active).toBe(true);
      expect(states[0].statusText).toBe('file override: only.wav');
    });

    it('loading a second/third variant grows the slot count, and each slot reads its OWN state', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await setStart('autocannon', 'fire', 10);
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      await setStart('autocannon', variantStage('fire', 1), 200);
      await storeOverride('autocannon', variantStage('fire', 2), fakeFile('v2.wav', 'V2'));

      expect(getVariantSlotCount('autocannon', 'fire')).toBe(3);
      const states = getVariantRowStates('autocannon', 'fire');
      expect(states).toHaveLength(3);
      expect(states[0].statusText).toBe('file override: v0.wav');
      expect(states[0].startSec).toBeCloseTo(0.01);
      expect(states[1].statusText).toBe('file override: v1.wav');
      expect(states[1].startSec).toBeCloseTo(0.2);
      expect(states[2].statusText).toBe('file override: v2.wav');
      expect(states[2].startSec).toBe(0);
    });

    it('removeOverrideVariant shrinks the slot count and compacts the remaining states', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      await storeOverride('autocannon', variantStage('fire', 2), fakeFile('v2.wav', 'V2'));
      await removeOverrideVariant('autocannon', 'fire', 1); // remove the middle one

      expect(getVariantSlotCount('autocannon', 'fire')).toBe(2);
      const states = getVariantRowStates('autocannon', 'fire');
      expect(states.map((s) => s.statusText)).toEqual([
        'file override: v0.wav',
        'file override: v2.wav', // shifted down into slot 1
      ]);
    });

    it('a different (id, stage) is unaffected by a sibling stage growing its own pool', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      expect(getVariantSlotCount('autocannon', 'impact')).toBe(1);
      expect(getVariantSlotCount('deploy', 'play')).toBe(1);
    });
  });
});
