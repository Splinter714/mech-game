import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSfxCopyText } from './sfxCopyText.js';
import {
  storeOverride, setTrim, setStart, setProcessing, setFadeOut, _resetForTest, setAudioContext,
} from '../audio/sfxOverrides.js';

// Same minimal fake IndexedDB + File + AudioContext used by sfxOverrides.test.js — just enough
// of each surface for storeOverride/setStart/setTrim to run in Vitest's node env, so this test
// drives the REAL #150/#166 override state (not a mock) through buildSfxCopyText.
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
        void nameList;
        const tx = { oncomplete: null, onerror: null };
        tx.objectStore = (n) => {
          const data = storeMap.get(n);
          return {
            put(record) { const req = {}; queueMicrotask(() => { data.set(record.key, record); req.onsuccess?.(); tx.oncomplete?.(); }); return req; },
            delete(key) { const req = {}; queueMicrotask(() => { data.delete(key); req.onsuccess?.(); tx.oncomplete?.(); }); return req; },
            getAll() { const req = {}; queueMicrotask(() => { req.result = Array.from(data.values()); req.onsuccess?.(); }); return req; },
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

const fakeFile = (name, tag) => ({ name, type: 'audio/wav', arrayBuffer: async () => new TextEncoder().encode(tag).buffer });

// Decodes to a buffer carrying a `duration` (seconds) so the "full file length" / end-of-file
// branches of the FILE block can be exercised deterministically.
const fakeCtx = (durationSec = 2) => ({
  decodeAudioData: async (bytes) => {
    const text = new TextDecoder().decode(bytes);
    if (text === 'CORRUPT') throw new Error('cannot decode');
    return { __decodedFrom: text, duration: durationSec };
  },
});

// A representative three-stage procedural params object (shape mirrors audio/sfxParams.js:
// each stage is an array of layer objects). Used as the `params` arg to buildSfxCopyText.
const PARAMS = () => ({
  fire: [{ kind: 'tone', type: 'square', freq: 200, dur: 0.1, gain: 0.8 }],
  trajectory: [{ kind: 'noise', type: 'bandpass', freq: 800, dur: 0.3, gain: 0.5 }],
  impact: [{ kind: 'tone', type: 'sine', freq: 120, dur: 0.2, gain: 0.7 }],
});

describe('buildSfxCopyText (#170 per-stage copy)', () => {
  beforeEach(() => {
    _resetForTest();
    globalThis.indexedDB = makeFakeIndexedDB();
    setAudioContext(fakeCtx());
  });
  afterEach(() => { delete globalThis.indexedDB; });

  it('fully-procedural weapon: byte-for-byte identical to the pre-#170 whole-params output', () => {
    const params = PARAMS();
    const out = buildSfxCopyText('autocannon', params);
    // The exact historical format _copy() produced before this change.
    const expected = `  autocannon: ${JSON.stringify(params, null, 2).replace(/\n/g, '\n  ')},`;
    expect(out).toBe(expected);
  });

  it('overridden stage: emits weapon id, stage, verbatim filename, and start/end in ms', async () => {
    await storeOverride('autocannon', 'fire', fakeFile('boom_final.wav', 'BOOM'));
    await setStart('autocannon', 'fire', 500);
    await setTrim('autocannon', 'fire', 700); // duration from start → end = 1200ms

    const out = buildSfxCopyText('autocannon', PARAMS());

    expect(out).toContain('FILE OVERRIDE');
    expect(out).toContain('autocannon');
    expect(out).toContain('[fire]');
    expect(out).toContain('boom_final.wav');   // exact filename, verbatim
    expect(out).toContain('start:           500 ms');
    expect(out).toContain('end:             1200 ms');
    expect(out).toContain('full file length: 2000 ms');
    expect(out).toContain('bake "boom_final.wav" into the repo as autocannon\'s fire sound, trimmed 500ms → 1200ms');
  });

  it('overridden stage with no trim set: end falls back to the real file length, labeled end-of-file', async () => {
    await storeOverride('shotgun', 'fire', fakeFile('blast.wav', 'BLAST'));
    // no setStart/setTrim → start 0, plays whole 2s file
    const out = buildSfxCopyText('shotgun', PARAMS());
    expect(out).toContain('start:           0 ms');
    expect(out).toContain('end:             2000 ms   (end of file)');
  });

  it('mixed weapon: FILE block for the overridden stage, procedural JSON for the rest, distinguishable', async () => {
    await storeOverride('autocannon', 'fire', fakeFile('kick.wav', 'KICK'));
    await setStart('autocannon', 'fire', 100);
    await setTrim('autocannon', 'fire', 250);

    const params = PARAMS();
    const out = buildSfxCopyText('autocannon', params);

    // fire → FILE block
    expect(out).toContain('[fire] FILE OVERRIDE');
    expect(out).toContain('kick.wav');
    expect(out).toContain('start:           100 ms');
    expect(out).toContain('end:             350 ms');

    // trajectory + impact → still procedural, emitted as their synthesis JSON
    expect(out).toContain('[trajectory] PROCEDURAL synthesis');
    expect(out).toContain('[impact] PROCEDURAL synthesis');
    expect(out).toContain('"trajectory":');
    expect(out).toContain('"impact":');
    expect(out).toContain('"bandpass"');   // a trajectory layer field survived into the JSON
    // the two kinds are unambiguously distinguished
    expect(out).toContain('FILE OVERRIDE');
    expect(out).toContain('PROCEDURAL synthesis');
    // fire's procedural JSON is NOT dumped (it's a file now)
    expect(out).not.toContain('"fire":');
  });

  it('#107 destruction-explosion category (single fire stage) with an override copies consistently', async () => {
    await storeOverride('deathExplosionLarge', 'fire', fakeFile('kaboom.wav', 'KA'));
    await setStart('deathExplosionLarge', 'fire', 0);
    await setTrim('deathExplosionLarge', 'fire', 900);

    const params = { fire: [{ kind: 'noise', type: 'lowpass', freq: 300, dur: 0.5, gain: 1 }] };
    const out = buildSfxCopyText('deathExplosionLarge', params);

    expect(out).toContain('[fire] FILE OVERRIDE');
    expect(out).toContain('deathExplosionLarge');
    expect(out).toContain('kaboom.wav');
    expect(out).toContain('end:             900 ms');
    // only a fire stage exists — no trajectory/impact blocks
    expect(out).not.toContain('[trajectory]');
    expect(out).not.toContain('[impact]');
  });

  it('a fully-procedural single-stage category still uses the exact whole-params fallback', () => {
    const params = { fire: [{ kind: 'noise', type: 'lowpass', freq: 300, dur: 0.5, gain: 1 }] };
    const out = buildSfxCopyText('deathExplosionSmall', params);
    const expected = `  deathExplosionSmall: ${JSON.stringify(params, null, 2).replace(/\n/g, '\n  ')},`;
    expect(out).toBe(expected);
  });

  // #172: the copy payload carries the full processing recipe (pitch/filter/reverb) so a pasted
  // FILE block bakes the processing too, not just the trim.
  it('overridden stage with processing: emits the pitch, filter, and reverb params', async () => {
    await storeOverride('autocannon', 'fire', fakeFile('boom.wav', 'BOOM'));
    await setStart('autocannon', 'fire', 100);
    await setTrim('autocannon', 'fire', 400);
    await setProcessing('autocannon', 'fire', { detune: -300, filterType: 'lowpass', filterFreq: 1200, filterQ: 2.5, reverbMix: 0.4, reverbSize: 1.5 });

    const out = buildSfxCopyText('autocannon', PARAMS());

    expect(out).toContain('pitch:           -300 cents');
    expect(out).toContain('filter:          lowpass @ 1200 Hz, Q 2.5');
    expect(out).toContain('reverb:          mix 0.4, size 1.5s');
    // the bake instruction summarises the processing too
    expect(out).toContain('apply pitch -300 cents');
    expect(out).toContain('lowpass filter @ 1200 Hz, Q 2.5');
    expect(out).toContain('reverb mix 0.4 / size 1.5s');
  });

  it('overridden stage with NO processing: emits no pitch/filter/reverb lines (clean)', async () => {
    await storeOverride('shotgun', 'fire', fakeFile('blast.wav', 'BLAST'));
    const out = buildSfxCopyText('shotgun', PARAMS());
    expect(out).not.toContain('pitch:');
    expect(out).not.toContain('filter:');
    expect(out).not.toContain('reverb:');
  });

  // #174: the copy payload carries the fade-out duration so a pasted FILE block bakes the fade too.
  it('overridden stage with a fade-out: emits the fade-out line and folds it into the bake', async () => {
    await storeOverride('autocannon', 'fire', fakeFile('boom.wav', 'BOOM'));
    await setTrim('autocannon', 'fire', 400);
    await setFadeOut('autocannon', 'fire', 120);
    const out = buildSfxCopyText('autocannon', PARAMS());
    expect(out).toContain('fade-out:        120 ms');
    expect(out).toContain('fade-out 120 ms');   // summarised in the bake instruction
  });

  it('overridden stage with NO fade-out: emits no fade-out line (clean)', async () => {
    await storeOverride('shotgun', 'fire', fakeFile('blast.wav', 'BLAST'));
    const out = buildSfxCopyText('shotgun', PARAMS());
    expect(out).not.toContain('fade-out:');
  });
});
