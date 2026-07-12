import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  storeOverride, getOverride, hasOverride, getOverrideMeta, clearOverride, loadAllOverrides,
  setAudioContext, _resetForTest,
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
});
