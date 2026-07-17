import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  storeOverride, getOverride, hasOverride, getOverrideMeta, clearOverride, loadAllOverrides,
  setAudioContext, _resetForTest, getTrimMs, setTrim, getStartMs, setStart,
  getProcessing, setProcessing, getFadeOutMs, setFadeOut, getVolume, setVolume,
  getLoopStartMs, setLoopStartMs,
  MAX_VARIANTS, variantStage, getOverrideVariantCount, pickOverrideStage, removeOverrideVariant,
  syncTuningToVariants, getSharedTuningSnapshot, applySharedTuningSnapshot,
} from './sfxOverrides.js';

// A minimal fake IndexedDB — just enough of the API surface sfxOverrides.js actually calls
// (open/onupgradeneeded/onsuccess, one object store, put/delete/getAll, tx.oncomplete) to
// exercise the real persistence code path in Vitest's node environment (which has no real
// indexedDB). Crucially, the underlying `databases` Map lives OUTSIDE the module under test,
// so calling `_resetForTest()` (which only clears sfxOverrides.js's in-memory cache/db-handle)
// while leaving this fake's storage alone simulates a page reload: the next loadAllOverrides()
// has to re-read+re-decode from "disk," exactly like a real IndexedDB would survive a reload.
function makeFakeIndexedDB() {
  const databases = new Map(); // dbName -> Map(storeName -> Map(key -> record))
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

// A fake File/Blob: just enough for storeOverride/loadAllOverrides (name/type + async
// arrayBuffer()). `tag` lets each fake file decode to a distinguishable fake AudioBuffer.
function fakeFile(name, tag) {
  return {
    name, type: 'audio/wav',
    arrayBuffer: async () => new TextEncoder().encode(tag).buffer,
  };
}

// A fake AudioContext: decodeAudioData "decodes" by reading the tag back out of the bytes,
// so a round-trip through storage can assert it got the SAME content back, and a bad/garbage
// file can be made to fail deterministically.
function fakeCtx() {
  return {
    decodeAudioData: async (bytes) => {
      const text = new TextDecoder().decode(bytes);
      if (text === 'CORRUPT') throw new Error('cannot decode');
      return { __decodedFrom: text };
    },
  };
}

describe('sfxOverrides (#150 real-file SFX overrides)', () => {
  beforeEach(() => {
    _resetForTest();
    globalThis.indexedDB = makeFakeIndexedDB();
    setAudioContext(fakeCtx());
  });
  afterEach(() => {
    delete globalThis.indexedDB;
  });

  it('has no override for an untouched weapon/stage (the strict no-op default)', () => {
    expect(getOverride('autocannon', 'fire')).toBeNull();
    expect(hasOverride('autocannon', 'fire')).toBe(false);
    expect(getOverrideMeta('autocannon', 'fire')).toBeNull();
  });

  it('stores + decodes a file, making it immediately available via getOverride', async () => {
    const buffer = await storeOverride('autocannon', 'fire', fakeFile('boom.wav', 'BOOM'));
    expect(buffer).toEqual({ __decodedFrom: 'BOOM' });
    expect(getOverride('autocannon', 'fire')).toEqual({ __decodedFrom: 'BOOM' });
    expect(hasOverride('autocannon', 'fire')).toBe(true);
    expect(getOverrideMeta('autocannon', 'fire')).toEqual({ name: 'boom.wav', type: 'audio/wav' });
  });

  it('keeps overrides independent per weaponId+stage', async () => {
    await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
    await storeOverride('autocannon', 'impact', fakeFile('b.wav', 'B'));
    await storeOverride('shotgun', 'fire', fakeFile('c.wav', 'C'));
    expect(getOverride('autocannon', 'fire')).toEqual({ __decodedFrom: 'A' });
    expect(getOverride('autocannon', 'impact')).toEqual({ __decodedFrom: 'B' });
    expect(getOverride('shotgun', 'fire')).toEqual({ __decodedFrom: 'C' });
    expect(getOverride('shotgun', 'impact')).toBeNull();
    expect(getOverride('autocannon', 'trajectory')).toBeNull();
  });

  it('persists across a simulated reload (module cache cleared, IndexedDB untouched)', async () => {
    await storeOverride('railLance', 'fire', fakeFile('zap.wav', 'ZAP'));
    expect(hasOverride('railLance', 'fire')).toBe(true);

    // Simulate a page reload: wipe the module's in-memory state (as a fresh module load
    // would start with) but leave the fake IndexedDB's persisted data alone.
    _resetForTest();
    setAudioContext(fakeCtx());
    expect(getOverride('railLance', 'fire')).toBeNull(); // not loaded yet — pre-boot state

    await loadAllOverrides();
    expect(getOverride('railLance', 'fire')).toEqual({ __decodedFrom: 'ZAP' });
    expect(getOverrideMeta('railLance', 'fire')).toEqual({ name: 'zap.wav', type: 'audio/wav' });
  });

  it('clearOverride reverts to no-override, including after a reload', async () => {
    await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
    expect(hasOverride('shotgun', 'impact')).toBe(true);

    await clearOverride('shotgun', 'impact');
    expect(getOverride('shotgun', 'impact')).toBeNull();
    expect(hasOverride('shotgun', 'impact')).toBe(false);

    // And the clear itself persisted — a reload doesn't resurrect it.
    _resetForTest();
    setAudioContext(fakeCtx());
    await loadAllOverrides();
    expect(getOverride('shotgun', 'impact')).toBeNull();
  });

  it('storeOverride resolves null (not throw) for a file that fails to decode, without caching it', async () => {
    const buffer = await storeOverride('napalm', 'fire', fakeFile('garbage.bin', 'CORRUPT'));
    expect(buffer).toBeNull();
    expect(getOverride('napalm', 'fire')).toBeNull();
    expect(hasOverride('napalm', 'fire')).toBe(false);
  });

  it('loadAllOverrides skips a stored file that no longer decodes, without throwing', async () => {
    await storeOverride('napalm', 'impact', fakeFile('ok.wav', 'OK'));
    // Force this one to look corrupt on the next decode by swapping in a context that always
    // fails — simulates a codec regression between sessions, not a real usage path but a
    // reasonable robustness check for the boot-time preload.
    _resetForTest();
    setAudioContext({ decodeAudioData: async () => { throw new Error('nope'); } });
    await expect(loadAllOverrides()).resolves.toBeUndefined();
    expect(getOverride('napalm', 'impact')).toBeNull();
  });

  it('loadAllOverrides is a safe no-op with no context set yet', async () => {
    _resetForTest();
    // no setAudioContext call
    await expect(loadAllOverrides()).resolves.toBeUndefined();
    expect(getOverride('anything', 'fire')).toBeNull();
  });

  it('never throws when IndexedDB is unavailable (e.g. a locked-down browser)', async () => {
    delete globalThis.indexedDB;
    const buffer = await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
    // Decoding still works in-memory for this session even though nothing persists.
    expect(buffer).toEqual({ __decodedFrom: 'A' });
    expect(getOverride('autocannon', 'fire')).toEqual({ __decodedFrom: 'A' });
    await expect(clearOverride('autocannon', 'fire')).resolves.toBeUndefined();
    await expect(loadAllOverrides()).resolves.toBeUndefined();
  });

  // #166: non-destructive trim (play only the first N ms of a loaded override file).
  describe('trim (#166)', () => {
    it('has no trim by default for a freshly-stored override', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      expect(getTrimMs('autocannon', 'fire')).toBeNull();
    });

    it('setTrim sets a trim visible immediately via getTrimMs', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setTrim('autocannon', 'fire', 400);
      expect(getTrimMs('autocannon', 'fire')).toBe(400);
    });

    it('setTrim(null) clears a previously-set trim', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setTrim('autocannon', 'fire', 400);
      await setTrim('autocannon', 'fire', null);
      expect(getTrimMs('autocannon', 'fire')).toBeNull();
    });

    it('persists the trim across a simulated reload, alongside the rest of the override', async () => {
      await storeOverride('railLance', 'fire', fakeFile('zap.wav', 'ZAP'));
      await setTrim('railLance', 'fire', 250);

      _resetForTest();
      setAudioContext(fakeCtx());
      expect(getTrimMs('railLance', 'fire')).toBeNull(); // pre-boot state, not loaded yet

      await loadAllOverrides();
      expect(getTrimMs('railLance', 'fire')).toBe(250);
      expect(getOverride('railLance', 'fire')).toEqual({ __decodedFrom: 'ZAP' }); // override itself unaffected
    });

    it('a reload with no trim ever set leaves getTrimMs null (backward-compatible with pre-#166 overrides)', async () => {
      // Simulates an override stored before trimMs existed: no setTrim call at all.
      await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getTrimMs('shotgun', 'impact')).toBeNull();
      expect(getOverride('shotgun', 'impact')).toEqual({ __decodedFrom: 'X' });
    });

    it('clearOverride also clears the trim, including across a reload', async () => {
      await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
      await setTrim('shotgun', 'impact', 300);
      await clearOverride('shotgun', 'impact');
      expect(getTrimMs('shotgun', 'impact')).toBeNull();

      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getTrimMs('shotgun', 'impact')).toBeNull();
      expect(getOverride('shotgun', 'impact')).toBeNull();
    });

    it('loading a new file into a previously-trimmed slot does not inherit the stale trim', async () => {
      await storeOverride('napalm', 'fire', fakeFile('old.wav', 'OLD'));
      await setTrim('napalm', 'fire', 500);
      expect(getTrimMs('napalm', 'fire')).toBe(500);

      // Load a different file into the SAME weapon+stage without an explicit clear first.
      await storeOverride('napalm', 'fire', fakeFile('new.wav', 'NEW'));
      expect(getTrimMs('napalm', 'fire')).toBeNull();
      expect(getOverride('napalm', 'fire')).toEqual({ __decodedFrom: 'NEW' });
    });

    it('setTrim is a safe no-op (in-memory only) when there is no active override for that slot', async () => {
      await expect(setTrim('nothingLoaded', 'fire', 300)).resolves.toBeUndefined();
      expect(getTrimMs('nothingLoaded', 'fire')).toBe(300); // still visible in-memory this session
    });

    it('never throws when IndexedDB is unavailable', async () => {
      delete globalThis.indexedDB;
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A')); // persists nowhere, decodes fine in-memory
      await expect(setTrim('autocannon', 'fire', 200)).resolves.toBeUndefined();
      expect(getTrimMs('autocannon', 'fire')).toBe(200);
    });
  });

  // #166 (scope expansion): a real START offset alongside the end trim, forming a genuine
  // start/end pair — startMs skips ahead into the buffer, trimMs is the duration to play from
  // THAT point (not from the original file start).
  describe('start offset (#166)', () => {
    it('has no start offset by default for a freshly-stored override', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      expect(getStartMs('autocannon', 'fire')).toBeNull();
    });

    it('setStart sets a start offset visible immediately via getStartMs', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setStart('autocannon', 'fire', 500);
      expect(getStartMs('autocannon', 'fire')).toBe(500);
    });

    it('setStart(null) clears a previously-set start offset', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setStart('autocannon', 'fire', 500);
      await setStart('autocannon', 'fire', null);
      expect(getStartMs('autocannon', 'fire')).toBeNull();
    });

    it('persists the start offset across a simulated reload, alongside the trim', async () => {
      await storeOverride('railLance', 'fire', fakeFile('zap.wav', 'ZAP'));
      await setStart('railLance', 'fire', 500);
      await setTrim('railLance', 'fire', 300);

      _resetForTest();
      setAudioContext(fakeCtx());
      expect(getStartMs('railLance', 'fire')).toBeNull(); // pre-boot state, not loaded yet

      await loadAllOverrides();
      expect(getStartMs('railLance', 'fire')).toBe(500);
      expect(getTrimMs('railLance', 'fire')).toBe(300);
      expect(getOverride('railLance', 'fire')).toEqual({ __decodedFrom: 'ZAP' });
    });

    it('a reload with no start ever set leaves getStartMs null (backward-compatible)', async () => {
      await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
      await setTrim('shotgun', 'impact', 300); // trim set, start never touched
      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getStartMs('shotgun', 'impact')).toBeNull();
      expect(getTrimMs('shotgun', 'impact')).toBe(300);
    });

    it('clearOverride also clears the start offset, including across a reload', async () => {
      await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
      await setStart('shotgun', 'impact', 500);
      await clearOverride('shotgun', 'impact');
      expect(getStartMs('shotgun', 'impact')).toBeNull();

      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getStartMs('shotgun', 'impact')).toBeNull();
      expect(getOverride('shotgun', 'impact')).toBeNull();
    });

    it('loading a new file into a previously-started slot does not inherit the stale start', async () => {
      await storeOverride('napalm', 'fire', fakeFile('old.wav', 'OLD'));
      await setStart('napalm', 'fire', 500);
      expect(getStartMs('napalm', 'fire')).toBe(500);

      await storeOverride('napalm', 'fire', fakeFile('new.wav', 'NEW'));
      expect(getStartMs('napalm', 'fire')).toBeNull();
      expect(getOverride('napalm', 'fire')).toEqual({ __decodedFrom: 'NEW' });
    });

    it('setStart is a safe no-op (in-memory only) when there is no active override for that slot', async () => {
      await expect(setStart('nothingLoaded', 'fire', 500)).resolves.toBeUndefined();
      expect(getStartMs('nothingLoaded', 'fire')).toBe(500);
    });

    it('never throws when IndexedDB is unavailable', async () => {
      delete globalThis.indexedDB;
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await expect(setStart('autocannon', 'fire', 200)).resolves.toBeUndefined();
      expect(getStartMs('autocannon', 'fire')).toBe(200);
    });

    it('setting start and trim independently persists both together', async () => {
      await storeOverride('railgun', 'fire', fakeFile('r.wav', 'R'));
      await setTrim('railgun', 'fire', 300);
      await setStart('railgun', 'fire', 500); // set after trim — must not clobber it

      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getStartMs('railgun', 'fire')).toBe(500);
      expect(getTrimMs('railgun', 'fire')).toBe(300);
    });
  });

  // #172: the non-destructive playback processing chain (pitch/filter/reverb), stored as a
  // single sparse `processing` object alongside startMs/trimMs. Same lifecycle contract as
  // #166: persists across reload, cleared on clearOverride / a fresh file, back-compatible.
  describe('processing (#172)', () => {
    it('has no processing by default for a freshly-stored override', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      expect(getProcessing('autocannon', 'fire')).toBeNull();
    });

    it('setProcessing merge-patches fields, visible immediately via getProcessing', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setProcessing('autocannon', 'fire', { detune: 300 });
      await setProcessing('autocannon', 'fire', { filterType: 'lowpass', filterFreq: 800, filterQ: 2 });
      expect(getProcessing('autocannon', 'fire')).toEqual({ detune: 300, filterType: 'lowpass', filterFreq: 800, filterQ: 2 });
    });

    it('a null field in the patch clears just that field; clearing all fields drops processing to null', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setProcessing('autocannon', 'fire', { detune: 300, reverbMix: 0.5, reverbSize: 1 });
      await setProcessing('autocannon', 'fire', { detune: null });
      expect(getProcessing('autocannon', 'fire')).toEqual({ reverbMix: 0.5, reverbSize: 1 });
      await setProcessing('autocannon', 'fire', { reverbMix: null, reverbSize: null });
      expect(getProcessing('autocannon', 'fire')).toBeNull();   // fully neutral again
    });

    it('persists the processing across a simulated reload, alongside start/trim', async () => {
      await storeOverride('railLance', 'fire', fakeFile('zap.wav', 'ZAP'));
      await setStart('railLance', 'fire', 500);
      await setTrim('railLance', 'fire', 300);
      await setProcessing('railLance', 'fire', { detune: -200, filterType: 'bandpass', filterFreq: 1500, filterQ: 4, reverbMix: 0.35, reverbSize: 1.2 });

      _resetForTest();
      setAudioContext(fakeCtx());
      expect(getProcessing('railLance', 'fire')).toBeNull(); // pre-boot state, not loaded yet

      await loadAllOverrides();
      expect(getProcessing('railLance', 'fire')).toEqual({ detune: -200, filterType: 'bandpass', filterFreq: 1500, filterQ: 4, reverbMix: 0.35, reverbSize: 1.2 });
      expect(getStartMs('railLance', 'fire')).toBe(500);
      expect(getTrimMs('railLance', 'fire')).toBe(300);
      expect(getOverride('railLance', 'fire')).toEqual({ __decodedFrom: 'ZAP' });
    });

    it('a reload with no processing ever set leaves getProcessing null (backward-compatible)', async () => {
      await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
      await setTrim('shotgun', 'impact', 300); // trim set, processing never touched
      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getProcessing('shotgun', 'impact')).toBeNull();
      expect(getTrimMs('shotgun', 'impact')).toBe(300);
    });

    it('clearOverride also clears the processing, including across a reload', async () => {
      await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
      await setProcessing('shotgun', 'impact', { detune: 400 });
      await clearOverride('shotgun', 'impact');
      expect(getProcessing('shotgun', 'impact')).toBeNull();

      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getProcessing('shotgun', 'impact')).toBeNull();
      expect(getOverride('shotgun', 'impact')).toBeNull();
    });

    it('loading a new file into a previously-processed slot does not inherit the stale processing', async () => {
      await storeOverride('napalm', 'fire', fakeFile('old.wav', 'OLD'));
      await setProcessing('napalm', 'fire', { detune: 400, reverbMix: 0.5, reverbSize: 1 });
      expect(getProcessing('napalm', 'fire')).not.toBeNull();

      await storeOverride('napalm', 'fire', fakeFile('new.wav', 'NEW'));
      expect(getProcessing('napalm', 'fire')).toBeNull();
      expect(getOverride('napalm', 'fire')).toEqual({ __decodedFrom: 'NEW' });
    });

    it('processing, start, and trim set independently all persist together', async () => {
      await storeOverride('railgun', 'fire', fakeFile('r.wav', 'R'));
      await setProcessing('railgun', 'fire', { filterType: 'highpass', filterFreq: 600, filterQ: 1 });
      await setTrim('railgun', 'fire', 300);   // set after processing — must not clobber it
      await setStart('railgun', 'fire', 500);

      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getProcessing('railgun', 'fire')).toEqual({ filterType: 'highpass', filterFreq: 600, filterQ: 1 });
      expect(getStartMs('railgun', 'fire')).toBe(500);
      expect(getTrimMs('railgun', 'fire')).toBe(300);
    });

    it('never throws when IndexedDB is unavailable', async () => {
      delete globalThis.indexedDB;
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await expect(setProcessing('autocannon', 'fire', { detune: 200 })).resolves.toBeUndefined();
      expect(getProcessing('autocannon', 'fire')).toEqual({ detune: 200 });
    });
  });

  // #174: non-destructive fade-out duration (fade the played buffer to silence over the last N
  // ms). Same storage/persistence/clear contract as trim/start/processing.
  describe('fade-out (#174)', () => {
    it('has no fade-out by default for a freshly-stored override', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      expect(getFadeOutMs('autocannon', 'fire')).toBeNull();
    });

    it('setFadeOut sets a fade visible immediately via getFadeOutMs', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setFadeOut('autocannon', 'fire', 120);
      expect(getFadeOutMs('autocannon', 'fire')).toBe(120);
    });

    it('setFadeOut(null) and setFadeOut(0) both clear a previously-set fade', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setFadeOut('autocannon', 'fire', 120);
      await setFadeOut('autocannon', 'fire', null);
      expect(getFadeOutMs('autocannon', 'fire')).toBeNull();
      await setFadeOut('autocannon', 'fire', 120);
      await setFadeOut('autocannon', 'fire', 0);   // 0 == "no fade" == cleared
      expect(getFadeOutMs('autocannon', 'fire')).toBeNull();
    });

    it('persists the fade-out across a simulated reload, alongside the trim', async () => {
      await storeOverride('railLance', 'fire', fakeFile('zap.wav', 'ZAP'));
      await setTrim('railLance', 'fire', 300);
      await setFadeOut('railLance', 'fire', 90);

      _resetForTest();
      setAudioContext(fakeCtx());
      expect(getFadeOutMs('railLance', 'fire')).toBeNull(); // pre-boot state, not loaded yet

      await loadAllOverrides();
      expect(getFadeOutMs('railLance', 'fire')).toBe(90);
      expect(getTrimMs('railLance', 'fire')).toBe(300);
      expect(getOverride('railLance', 'fire')).toEqual({ __decodedFrom: 'ZAP' });
    });

    it('a reload with no fade ever set leaves getFadeOutMs null (backward-compatible with pre-#174 overrides)', async () => {
      await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getFadeOutMs('shotgun', 'impact')).toBeNull();
      expect(getOverride('shotgun', 'impact')).toEqual({ __decodedFrom: 'X' });
    });

    it('clearOverride also clears the fade-out, including across a reload', async () => {
      await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
      await setFadeOut('shotgun', 'impact', 200);
      await clearOverride('shotgun', 'impact');
      expect(getFadeOutMs('shotgun', 'impact')).toBeNull();

      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getFadeOutMs('shotgun', 'impact')).toBeNull();
    });

    it('loading a new file into a previously-faded slot does not inherit the stale fade', async () => {
      await storeOverride('napalm', 'fire', fakeFile('old.wav', 'OLD'));
      await setFadeOut('napalm', 'fire', 250);
      expect(getFadeOutMs('napalm', 'fire')).toBe(250);
      await storeOverride('napalm', 'fire', fakeFile('new.wav', 'NEW'));
      expect(getFadeOutMs('napalm', 'fire')).toBeNull();
    });

    it('does not clobber a coexisting processing chain (both persist together)', async () => {
      await storeOverride('railgun', 'fire', fakeFile('r.wav', 'R'));
      await setProcessing('railgun', 'fire', { detune: 200 });
      await setFadeOut('railgun', 'fire', 75);

      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getProcessing('railgun', 'fire')).toEqual({ detune: 200 });
      expect(getFadeOutMs('railgun', 'fire')).toBe(75);
    });

    it('never throws when IndexedDB is unavailable', async () => {
      delete globalThis.indexedDB;
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await expect(setFadeOut('autocannon', 'fire', 150)).resolves.toBeUndefined();
      expect(getFadeOutMs('autocannon', 'fire')).toBe(150);
    });
  });

  // #182: non-destructive overall VOLUME multiplier — mirrors the fade-out (#174) test suite's
  // shape exactly, since it's the same kind of playback-time parameter with the same lifecycle.
  describe('volume (#182)', () => {
    it('defaults to unity gain (1) for a freshly-stored override', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      expect(getVolume('autocannon', 'fire')).toBe(1);
    });

    it('setVolume sets a gain visible immediately via getVolume', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setVolume('autocannon', 'fire', 1.5);
      expect(getVolume('autocannon', 'fire')).toBe(1.5);
    });

    it('setVolume(null) and setVolume(1) both clear a previously-set volume back to unity', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setVolume('autocannon', 'fire', 1.5);
      await setVolume('autocannon', 'fire', null);
      expect(getVolume('autocannon', 'fire')).toBe(1);
      await setVolume('autocannon', 'fire', 1.5);
      await setVolume('autocannon', 'fire', 1);   // 1 == unity == cleared
      expect(getVolume('autocannon', 'fire')).toBe(1);
    });

    it('clamps to the 0..2 range', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await setVolume('autocannon', 'fire', 5);
      expect(getVolume('autocannon', 'fire')).toBe(2);
      await setVolume('autocannon', 'fire', -3);
      expect(getVolume('autocannon', 'fire')).toBe(0);
    });

    it('persists the volume across a simulated reload, alongside the trim', async () => {
      await storeOverride('railLance', 'fire', fakeFile('zap.wav', 'ZAP'));
      await setTrim('railLance', 'fire', 300);
      await setVolume('railLance', 'fire', 1.3);

      _resetForTest();
      setAudioContext(fakeCtx());
      expect(getVolume('railLance', 'fire')).toBe(1); // pre-boot state, not loaded yet

      await loadAllOverrides();
      expect(getVolume('railLance', 'fire')).toBe(1.3);
      expect(getTrimMs('railLance', 'fire')).toBe(300);
      expect(getOverride('railLance', 'fire')).toEqual({ __decodedFrom: 'ZAP' });
    });

    it('a reload with no volume ever set leaves getVolume at unity (backward-compatible with pre-#182 overrides)', async () => {
      await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getVolume('shotgun', 'impact')).toBe(1);
      expect(getOverride('shotgun', 'impact')).toEqual({ __decodedFrom: 'X' });
    });

    it('clearOverride also clears the volume, including across a reload', async () => {
      await storeOverride('shotgun', 'impact', fakeFile('x.wav', 'X'));
      await setVolume('shotgun', 'impact', 1.7);
      await clearOverride('shotgun', 'impact');
      expect(getVolume('shotgun', 'impact')).toBe(1);

      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getVolume('shotgun', 'impact')).toBe(1);
    });

    it('loading a new file into a previously-volume-tuned slot does not inherit the stale gain', async () => {
      await storeOverride('napalm', 'fire', fakeFile('old.wav', 'OLD'));
      await setVolume('napalm', 'fire', 1.6);
      expect(getVolume('napalm', 'fire')).toBe(1.6);
      await storeOverride('napalm', 'fire', fakeFile('new.wav', 'NEW'));
      expect(getVolume('napalm', 'fire')).toBe(1);
    });

    it('does not clobber coexisting processing/fade-out (all three persist together)', async () => {
      await storeOverride('railgun', 'fire', fakeFile('r.wav', 'R'));
      await setProcessing('railgun', 'fire', { detune: 200 });
      await setFadeOut('railgun', 'fire', 75);
      await setVolume('railgun', 'fire', 1.4);

      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getProcessing('railgun', 'fire')).toEqual({ detune: 200 });
      expect(getFadeOutMs('railgun', 'fire')).toBe(75);
      expect(getVolume('railgun', 'fire')).toBe(1.4);
    });

    it('never throws when IndexedDB is unavailable', async () => {
      delete globalThis.indexedDB;
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await expect(setVolume('autocannon', 'fire', 1.5)).resolves.toBeUndefined();
      expect(getVolume('autocannon', 'fire')).toBe(1.5);
    });
  });

  // #195: RANDOMIZED VARIANTS — a stage can hold up to MAX_VARIANTS parallel override slots
  // instead of just one, addressed via a synthetic `#v${n}` pseudo-stage (variant 0 = the
  // stage's own original key). These tests exercise the pool machinery directly against the
  // pseudo-stage keys — the SAME storeOverride/getOverride/etc. every other test above already
  // exercises against a plain stage, proving zero special-casing was needed in this file.
  describe('variant pools (#195)', () => {
    it('a plain (untouched) stage has a variant count of 0, and pickOverrideStage returns null', () => {
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(0);
      expect(pickOverrideStage('autocannon', 'fire')).toBeNull();
    });

    it('(a) a single-variant override behaves EXACTLY as before — variantStage(stage, 0) is the plain stage', async () => {
      expect(variantStage('fire', 0)).toBe('fire');
      await storeOverride('autocannon', 'fire', fakeFile('boom.wav', 'BOOM'));
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(1);
      // A pool of exactly 1 always resolves to the plain stage itself, not a pseudo-stage —
      // byte-identical to how every pre-#195 (weaponId, stage) override behaves.
      expect(pickOverrideStage('autocannon', 'fire')).toBe('fire');
      expect(getOverride('autocannon', 'fire')).toEqual({ __decodedFrom: 'BOOM' });
    });

    it('loading files under variantStage(stage, n) grows the pool up to MAX_VARIANTS (#209: raised 4 -> 10)', async () => {
      expect(MAX_VARIANTS).toBe(10);
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      await storeOverride('autocannon', variantStage('fire', 2), fakeFile('v2.wav', 'V2'));
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(3);
      for (let i = 3; i < 10; i++) {
        await storeOverride('autocannon', variantStage('fire', i), fakeFile(`v${i}.wav`, `V${i}`));
      }
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(10);
      // Each variant slot is independently addressable through the ordinary getters.
      expect(getOverride('autocannon', 'fire')).toEqual({ __decodedFrom: 'V0' });
      for (let i = 1; i < 10; i++) {
        expect(getOverride('autocannon', variantStage('fire', i))).toEqual({ __decodedFrom: `V${i}` });
      }
      // The pool is capped at MAX_VARIANTS — an 11th slot is never counted even if something
      // were somehow stored there.
      await storeOverride('autocannon', variantStage('fire', 10), fakeFile('v10.wav', 'V10'));
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(10);
    });

    // (b) statistical test — mock Math.random to prove pickOverrideStage genuinely walks the
    // WHOLE pool (not just always variant 0), then a real-random pass over many trials to prove
    // every variant gets hit with none starved out, without being flaky (200 trials, uniform
    // over 3 outcomes — astronomically unlikely to miss one by chance).
    it('(b) pickOverrideStage resolves deterministically for a mocked Math.random across the whole pool', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      await storeOverride('autocannon', variantStage('fire', 2), fakeFile('v2.wav', 'V2'));
      const spy = vi.spyOn(Math, 'random');
      try {
        spy.mockReturnValue(0);
        expect(pickOverrideStage('autocannon', 'fire')).toBe('fire');
        spy.mockReturnValue(0.34); // floor(0.34*3) = 1
        expect(pickOverrideStage('autocannon', 'fire')).toBe(variantStage('fire', 1));
        spy.mockReturnValue(0.99); // floor(0.99*3) = 2
        expect(pickOverrideStage('autocannon', 'fire')).toBe(variantStage('fire', 2));
      } finally {
        spy.mockRestore();
      }
    });

    it('(b) pickOverrideStage picks among ALL loaded variants over many trials (uniform, no weighting)', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      await storeOverride('autocannon', variantStage('fire', 2), fakeFile('v2.wav', 'V2'));
      const seen = new Set();
      for (let i = 0; i < 200; i++) seen.add(pickOverrideStage('autocannon', 'fire'));
      expect(seen).toEqual(new Set(['fire', variantStage('fire', 1), variantStage('fire', 2)]));
    });

    it('(c) removeOverrideVariant on a single-variant pool behaves exactly like clearOverride', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('only.wav', 'ONLY'));
      await setVolume('autocannon', 'fire', 1.5);
      await removeOverrideVariant('autocannon', 'fire', 0);
      expect(hasOverride('autocannon', 'fire')).toBe(false);
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(0);
      expect(getVolume('autocannon', 'fire')).toBe(1); // volume reset too — same as clearOverride
    });

    it('removeOverrideVariant compacts a middle variant, shifting later ones down (persists across a reload)', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await setVolume('autocannon', 'fire', 1.1);
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      await setVolume('autocannon', variantStage('fire', 1), 1.2);
      await storeOverride('autocannon', variantStage('fire', 2), fakeFile('v2.wav', 'V2'));
      await setVolume('autocannon', variantStage('fire', 2), 1.3);

      await removeOverrideVariant('autocannon', 'fire', 1); // remove the MIDDLE variant

      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(2);
      // Variant 0 (untouched) still reads V0/1.1.
      expect(getOverride('autocannon', 'fire')).toEqual({ __decodedFrom: 'V0' });
      expect(getVolume('autocannon', 'fire')).toBe(1.1);
      // Old variant 2 (V2/1.3) shifted down into slot 1.
      expect(getOverride('autocannon', variantStage('fire', 1))).toEqual({ __decodedFrom: 'V2' });
      expect(getVolume('autocannon', variantStage('fire', 1))).toBe(1.3);
      // The vacated top slot is genuinely gone, not a stale duplicate.
      expect(hasOverride('autocannon', variantStage('fire', 2))).toBe(false);

      // Survives a reload — the compaction was actually persisted to IndexedDB, not just
      // reflected in the in-memory maps.
      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(2);
      expect(getOverride('autocannon', variantStage('fire', 1))).toEqual({ __decodedFrom: 'V2' });
      expect(getVolume('autocannon', variantStage('fire', 1))).toBe(1.3);
      expect(hasOverride('autocannon', variantStage('fire', 2))).toBe(false);
    });

    it('removeOverrideVariant out of range is a no-op', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await removeOverrideVariant('autocannon', 'fire', 5);
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(1);
      await removeOverrideVariant('autocannon', 'fire', -1);
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(1);
    });

    it('a totally different (id, stage) pool is unaffected by another one growing/shrinking', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('a2.wav', 'A2'));
      await storeOverride('railgun', 'fire', fakeFile('r.wav', 'R'));
      expect(getOverrideVariantCount('railgun', 'fire')).toBe(1);
      await removeOverrideVariant('autocannon', 'fire', 0);
      expect(getOverrideVariantCount('railgun', 'fire')).toBe(1);
      expect(getOverride('railgun', 'fire')).toEqual({ __decodedFrom: 'R' });
    });
  });

  // #209: the tuner panel shows exactly ONE set of tuning controls per stage (not one per
  // variant) — an edit writes straight to variant 0's record via the ordinary setters, then
  // syncTuningToVariants propagates that SAME tuning onto every other loaded variant, on every
  // edit (not a manual one-shot "copy" — that was the prior, rejected #209 attempt,
  // applyTuningToAllVariants, which this replaces).
  describe('syncTuningToVariants (#209)', () => {
    it('propagates trim/processing/fade-out/volume/loop-start from variant 0 onto every other variant, leaving the file untouched', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await setStart('autocannon', 'fire', 50);
      await setTrim('autocannon', 'fire', 900);
      await setFadeOut('autocannon', 'fire', 120);
      await setVolume('autocannon', 'fire', 1.4);
      await setLoopStartMs('autocannon', 'fire', 200);
      await setProcessing('autocannon', 'fire', { detune: -300, filterType: 'lowpass', filterFreq: 2000, filterQ: 2.5 });

      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      await storeOverride('autocannon', variantStage('fire', 2), fakeFile('v2.wav', 'V2'));
      // Give variant 2 its own distinct pre-existing tuning, including a processing field
      // variant 0 does NOT have — syncing must clear that stray field rather than merge it in
      // alongside variant 0's own fields.
      await setVolume('autocannon', variantStage('fire', 2), 0.5);
      await setProcessing('autocannon', variantStage('fire', 2), { reverbMix: 0.6, reverbSize: 1.2 });

      await syncTuningToVariants('autocannon', 'fire');

      for (const idx of [1, 2]) {
        const stage = variantStage('fire', idx);
        expect(getStartMs('autocannon', stage)).toBe(50);
        expect(getTrimMs('autocannon', stage)).toBe(900);
        expect(getFadeOutMs('autocannon', stage)).toBe(120);
        expect(getVolume('autocannon', stage)).toBe(1.4);
        expect(getLoopStartMs('autocannon', stage)).toBe(200);
        expect(getProcessing('autocannon', stage)).toEqual({
          detune: -300, filterType: 'lowpass', filterFreq: 2000, filterQ: 2.5,
        });
      }

      // The file/asset each variant points to is NEVER touched by the sync.
      expect(getOverride('autocannon', 'fire')).toEqual({ __decodedFrom: 'V0' });
      expect(getOverride('autocannon', variantStage('fire', 1))).toEqual({ __decodedFrom: 'V1' });
      expect(getOverride('autocannon', variantStage('fire', 2))).toEqual({ __decodedFrom: 'V2' });
      expect(getOverrideMeta('autocannon', variantStage('fire', 1))).toEqual({ name: 'v1.wav', type: 'audio/wav' });
      expect(getOverrideMeta('autocannon', variantStage('fire', 2))).toEqual({ name: 'v2.wav', type: 'audio/wav' });

      // The sync leaves variant 0 (the source) itself alone.
      expect(getStartMs('autocannon', 'fire')).toBe(50);
      expect(getVolume('autocannon', 'fire')).toBe(1.4);
    });

    it('persists the sync across a simulated reload', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await setVolume('autocannon', 'fire', 1.6);
      await setProcessing('autocannon', 'fire', { detune: 150 });
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));

      await syncTuningToVariants('autocannon', 'fire');

      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();

      expect(getVolume('autocannon', variantStage('fire', 1))).toBe(1.6);
      expect(getProcessing('autocannon', variantStage('fire', 1))).toEqual({ detune: 150 });
      expect(getOverride('autocannon', variantStage('fire', 1))).toEqual({ __decodedFrom: 'V1' });
    });

    it('is a no-op for a single-variant pool (nothing else to sync onto)', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await setVolume('autocannon', 'fire', 1.4);
      await syncTuningToVariants('autocannon', 'fire');
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(1);
      expect(getVolume('autocannon', 'fire')).toBe(1.4);
    });

    it('is a no-op for a stage with no override at all', async () => {
      await expect(syncTuningToVariants('autocannon', 'fire')).resolves.toBeUndefined();
      expect(getOverrideVariantCount('autocannon', 'fire')).toBe(0);
    });
  });

  // #209: a variant slot's file (re)load resets that key's own tuning to untuned defaults
  // (storeOverride's ordinary behavior) — getSharedTuningSnapshot/applySharedTuningSnapshot let
  // the panel capture the stage's current shared tuning before the load and reapply it after, so
  // a freshly added OR replaced variant comes back already matching the rest of the pool instead
  // of reverting to untrimmed/unprocessed.
  describe('shared tuning snapshot (#209)', () => {
    it('getSharedTuningSnapshot is null when the stage has no live override yet', () => {
      expect(getSharedTuningSnapshot('autocannon', 'fire')).toBeNull();
    });

    it('captures the current tuning and reapplies it onto a freshly (re)loaded key', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await setStart('autocannon', 'fire', 40);
      await setTrim('autocannon', 'fire', 800);
      await setFadeOut('autocannon', 'fire', 60);
      await setVolume('autocannon', 'fire', 1.3);
      await setProcessing('autocannon', 'fire', { detune: 80 });

      const snapshot = getSharedTuningSnapshot('autocannon', 'fire');

      // A brand-new variant slot loads in untuned by default (storeOverride's usual behavior)...
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      expect(getStartMs('autocannon', variantStage('fire', 1))).toBeNull();

      // ...until the captured snapshot is reapplied onto it.
      await applySharedTuningSnapshot('autocannon', variantStage('fire', 1), snapshot);
      expect(getStartMs('autocannon', variantStage('fire', 1))).toBe(40);
      expect(getTrimMs('autocannon', variantStage('fire', 1))).toBe(800);
      expect(getFadeOutMs('autocannon', variantStage('fire', 1))).toBe(60);
      expect(getVolume('autocannon', variantStage('fire', 1))).toBe(1.3);
      expect(getProcessing('autocannon', variantStage('fire', 1))).toEqual({ detune: 80 });
      // The file itself is unaffected.
      expect(getOverride('autocannon', variantStage('fire', 1))).toEqual({ __decodedFrom: 'V1' });
    });

    it('applySharedTuningSnapshot is a no-op with a null snapshot', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await expect(applySharedTuningSnapshot('autocannon', 'fire', null)).resolves.toBeUndefined();
      expect(getStartMs('autocannon', 'fire')).toBeNull();
    });
  });

  // Loop start (#185): this schema/storage was originally written for a held-loop scheme that
  // repeated a region of the buffer. #185 was later reworked (playtest feedback: the repeat
  // scheme "sounds so robotic"/has "oscillation") so a held weapon's buffer now plays once as an
  // intro and hands off to procedural synthesis instead — sfx.js no longer reads loopStartMs at
  // all (see its startHeld/startIntroThenSustain). The getter/setter/persistence contract here is
  // otherwise untouched (kept for the Weapon Lab panel's existing loop-region control), so it's
  // still exercised directly at the storage layer even though playback no longer consults it.
  describe('loop start (#185, schema kept though no longer read by playback)', () => {
    it('defaults to getStartMs when unset', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      expect(getLoopStartMs('beamLaser', 'fire')).toBeNull();   // no startMs either yet
      await setStart('beamLaser', 'fire', 200);
      expect(getLoopStartMs('beamLaser', 'fire')).toBe(200);    // falls back to startMs
    });

    it('setLoopStartMs sets a value visible immediately via getLoopStartMs', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      await setStart('beamLaser', 'fire', 200);
      await setLoopStartMs('beamLaser', 'fire', 450);
      expect(getLoopStartMs('beamLaser', 'fire')).toBe(450);
    });

    it('setLoopStartMs(null) clears back to "loop start = startMs"', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      await setStart('beamLaser', 'fire', 200);
      await setLoopStartMs('beamLaser', 'fire', 450);
      await setLoopStartMs('beamLaser', 'fire', null);
      expect(getLoopStartMs('beamLaser', 'fire')).toBe(200);
    });

    it('clearOverride also clears the loop start, so a fresh file never inherits a stale one', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      await setStart('beamLaser', 'fire', 200);
      await setLoopStartMs('beamLaser', 'fire', 450);
      await clearOverride('beamLaser', 'fire');
      expect(getLoopStartMs('beamLaser', 'fire')).toBeNull();
    });

    it('persists across a reload', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      await setStart('beamLaser', 'fire', 100);
      await setLoopStartMs('beamLaser', 'fire', 300);
      _resetForTest();
      setAudioContext(fakeCtx());
      await loadAllOverrides();
      expect(getLoopStartMs('beamLaser', 'fire')).toBe(300);
    });
  });
});
