import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  storeOverride, getOverride, hasOverride, getOverrideMeta, clearOverride, loadAllOverrides,
  setAudioContext, _resetForTest, getTrimMs, setTrim, getStartMs, setStart,
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
});
