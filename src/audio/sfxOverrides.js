// Real-file SFX overrides (#150) — lets the Weapon Lab sound panel swap a weapon's
// procedural fire/trajectory/impact cue for a real loaded audio file, per weapon+stage,
// persisted across reloads. This is a DEV-TOOL feature (the panel isn't player-facing), so
// the storage/decoding here stays simple and functional rather than heavily abstracted.
//
// Storage: raw file bytes go in IndexedDB (not localStorage — audio files can be large and
// localStorage's quota/string-only storage isn't a good fit), keyed by `weaponId::stage`.
// A decoded AudioBuffer for each stored record is cached in memory (`_cache`) so playback
// (sfx.js) never has to decode/await on the hot path — it's a synchronous Map lookup that's
// null (=> fall back to procedural, exactly the pre-#150 behavior) until decoding finishes.
//
// Lifecycle: AudioEngine.init(ctx) calls setAudioContext(ctx) so this module has a context to
// decode with; BootScene then calls loadAllOverrides() once at boot to read everything out of
// IndexedDB and decode it before gameplay can trigger any sound. A sound triggered before that
// finishes just finds nothing in `_cache` yet and plays procedurally for that one instance —
// never throws, never blocks.
//
// Trim (#166): a non-destructive start/end pair per weapon+stage, stored as `startMs`/`trimMs`
// alongside the rest of the override record. `startMs` skips ahead into the buffer before
// playback begins; `trimMs` is the DURATION to play *from that new start point* (not from the
// original file start) — together they map directly onto
// `AudioBufferSourceNode.start(when, offset, duration)`'s `offset`/`duration` params, read via
// getStartMs()/getTrimMs() and applied purely as playback-time parameters (sfx.js) — the stored
// bytes/decoded buffer are never sliced or re-encoded, so both are instantly adjustable/
// reversible. undefined/null (including every override stored before this feature existed)
// means "start at 0" / "play to the end," respectively.
//
// Processing (#172): a non-destructive playback-time DSP chain per weapon+stage — pitch/rate,
// a biquad filter, and an algorithmic reverb — stored as a single `processing` object alongside
// `startMs`/`trimMs` in the same override record. Same philosophy as #166: nothing here touches
// the stored bytes or decoded buffer; every param is applied live as extra AudioNodes between
// the source and the sfx bus (see sfx.js's playOverride). The object is SPARSE — only
// non-neutral fields are stored, and an absent/empty `processing` means "no processing at all"
// (a strict clean passthrough, so an untouched file sounds byte-identical to pre-#172). Fields:
//   detune      cents on the AudioBufferSourceNode (pitch+speed coupled, like a record) — omit/0 = none
//   filterType  'lowpass' | 'highpass' | 'bandpass' — omit = no filter node inserted at all
//   filterFreq  Hz  · filterQ  (only meaningful when filterType is present)
//   reverbMix   0..1 wet/dry — omit/0 = no reverb nodes inserted at all
//   reverbSize  reverb tail length in seconds (only meaningful when reverbMix > 0)
// Read via getProcessing(); written (merge-patch, null clears a field) via setProcessing().
//
// Fade-out (#174): a non-destructive fade DURATION per weapon+stage, stored as `fadeOutMs`
// alongside `startMs`/`trimMs`/`processing` in the same override record. When set, playback
// (sfx.js) schedules a gain envelope on the played buffer: full gain held until
// `endTime - fadeOutMs`, then a linear ramp to 0 landing exactly on `endTime` (the scheduled
// stop = start-offset + trim duration), so an early-trimmed sound fades to silence instead of
// clicking on the abrupt cutoff. Same philosophy as #166/#172: nothing here touches the stored
// bytes or decoded buffer; it's a pure playback-time parameter, instantly adjustable/reversible.
// undefined/null/0 (including every override stored before this feature existed) means "no fade
// — hard cut," so unfaded playback is byte-for-byte unchanged. Read via getFadeOutMs(); written
// (null/0 clears) via setFadeOut().
//
// Volume (#182): a non-destructive overall GAIN multiplier per weapon+stage, stored as `volume`
// alongside `startMs`/`trimMs`/`processing`/`fadeOutMs` in the same override record. Same
// philosophy as the rest: purely a playback-time parameter (sfx.js applies it as a gain-node
// multiplier), never touches the stored bytes/decoded buffer. Unity gain (1.0 — today's implicit
// behavior) is the default and is never persisted as its own field, so an untouched/pre-#182
// override reads back exactly as unity. Range is clamped to 0..2 (0-200%) in the setter. It
// composes with the #174 fade-out envelope: the fade ramps FROM this volume level down to 0
// (not from 1.0), so a loud (volume > 1) override still fades out cleanly at its own level.
// Read via getVolume() (always returns a number, defaulting to 1); written (1.0 clears back to
// the default) via setVolume().
//
// Loop start (#185): a non-destructive SECOND start-offset, `loopStartMs`, used ONLY by the
// held-loop path (playBufferLoop/playOverrideLoop) — the ordinary #166 `startMs` still marks
// where playback begins the FIRST time (the intro/attack transient), while `loopStartMs` marks
// where the REPEATING loop region begins once the source wraps. Web Audio's
// AudioBufferSourceNode.start(when, offset) natively supports offset < loopStart: it plays
// offset→loopEnd once, then repeats loopStart→loopEnd forever, so this needs no custom
// scheduling — just a second offset fed to `loopStart` instead of reusing `startMs`. Unset/null
// (including every override stored before this feature existed) means "no separate loop start,"
// and getLoopStartMs() falls back to getStartMs() in that case — i.e. today's exact behavior
// (the whole intro-to-end clip re-loops every cycle) is the default, fully backward compatible.
// Same synchronous no-await in-memory lifecycle as `_start`/`_trim`, persisted alongside the rest
// of the override record, reset whenever a fresh file is loaded into the slot. Read via
// getLoopStartMs(); written (null clears back to "= startMs") via setLoopStartMs().

// #186: seeding a live override FROM a shipped bake (see seedOverrideFromBaked below) — the
// bake only has a decoded AudioBuffer (bakedSfx.js's `_cache`), never the original file bytes,
// so storeOverride (which persists raw bytes to IndexedDB) has nothing to write unless we
// re-encode the buffer back into real bytes first. Rather than teach storeOverride a second,
// bytes-less code path (which would also mean the seeded override can't survive a reload the
// same way every other override does), this just PCM16-encodes the decoded buffer into a
// standard WAV Blob — a well-understood, losslessly-round-trippable format for what's already
// a decoded float buffer — so the seeded override flows through the EXACT same storeOverride/
// IndexedDB/decode path as a file picked by hand, no special-casing anywhere else.
import { getBaked } from './bakedSfx.js';

function encodeWavBlob(buffer) {
  const numChannels = buffer.numberOfChannels ?? 1;
  const sampleRate = buffer.sampleRate ?? 44100;
  const length = buffer.length ?? Math.round((buffer.duration ?? 0) * sampleRate);
  const channels = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(buffer.getChannelData ? buffer.getChannelData(c) : new Float32Array(length));
  }
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const arr = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arr);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arr], { type: 'audio/wav' });
}

const DB_NAME = 'mech-game-sfx-overrides-v1';
const STORE = 'overrides';
const DB_VERSION = 1;

const keyFor = (weaponId, stage) => `${weaponId}::${stage}`;

// Decoded AudioBuffer cache — the only thing playback (sfx.js) ever reads, synchronously.
const _cache = new Map();
// Small bit of metadata (original filename/mime) purely for the panel's "loaded: foo.mp3" label.
const _meta = new Map();
// #166: non-destructive TRIM — play only the first `trimMs` milliseconds of the override
// buffer. undefined/absent (never stored in this map) means "play the full file," so every
// existing (pre-#166) override and every freshly-loaded file defaults to untrimmed. Kept as
// its own synchronous in-memory map (mirroring `_cache`) so sfx.js's hot playback path never
// awaits anything to read it.
const _trim = new Map();
// #166: non-destructive START offset — skip ahead `startMs` milliseconds into the buffer
// before playback begins. Same convention/lifecycle as `_trim` (undefined/absent means "start
// at 0," reset whenever a fresh file is loaded into the slot).
const _start = new Map();
// #172: non-destructive PROCESSING chain (pitch/filter/reverb) — a single sparse object per
// key (see the module header for its fields). undefined/absent means "no processing," same
// synchronous no-await in-memory lifecycle as `_trim`/`_start` so sfx.js's hot playback path
// reads it without awaiting, and reset whenever a fresh file is loaded into the slot.
const _proc = new Map();
// #174: non-destructive FADE-OUT duration (milliseconds) — fade the played buffer from full gain
// to silence over the last `fadeOutMs` before its scheduled stop. undefined/absent (never stored
// in this map) means "no fade (hard cut)," so every existing (pre-#174) override and every
// freshly-loaded file defaults to unfaded. Same synchronous no-await in-memory lifecycle as
// `_trim`/`_start`/`_proc` so sfx.js's hot playback path reads it without awaiting, and reset
// whenever a fresh file is loaded into the slot.
const _fadeOut = new Map();
// #182: non-destructive overall VOLUME multiplier — a linear gain applied on top of everything
// else in the playback chain. undefined/absent (never stored in this map) means "unity gain
// (1.0)," so every existing (pre-#182) override and every freshly-loaded file defaults to
// today's implicit behavior. Same synchronous no-await in-memory lifecycle as `_fadeOut`/`_proc`/
// `_trim`/`_start` so sfx.js's hot playback path reads it without awaiting, and reset whenever a
// fresh file is loaded into the slot.
const _volume = new Map();
// #185: non-destructive LOOP-START offset (milliseconds) — the held-loop path's own start
// offset, distinct from `_start`. undefined/absent (never stored in this map) means "no separate
// loop start," so getLoopStartMs() falls back to getStartMs() — same synchronous no-await
// in-memory lifecycle as the rest of these maps, reset whenever a fresh file is loaded.
const _loopStart = new Map();
// The raw Blob for each active override, cached purely so setTrim()/setStart() can persist a
// full IDB record (key/weaponId/stage/blob/name/type/startMs/trimMs) without a
// read-before-write round trip.
const _blobs = new Map();

let _ctx = null;
// The audio context to decode with. AudioEngine.init() calls this once it has adopted
// Phaser's WebAudio context; storeOverride() needs it to decode a freshly-picked file.
export function setAudioContext(ctx) {
  _ctx = ctx;
}

let _dbPromise = null;
// Opens (or creates) the overrides database. Resolves to `null` — never rejects — if
// IndexedDB isn't available (e.g. the Vitest node test environment, or a locked-down
// browser), so every caller below can treat "no db" as "feature quietly unavailable" the
// same way sfxParams.js treats a blocked localStorage.
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return _dbPromise;
}

function idbPut(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbGetAll(db) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

// Store `fileBlob` (a File/Blob from an <input type="file">) as weaponId+stage's override:
// persists the raw bytes to IndexedDB (survives reload) and decodes it into an AudioBuffer
// cached in memory (so playback is immediate this session too). Returns the decoded
// AudioBuffer, or null if decoding failed (e.g. not a real audio file) — the raw bytes are
// still saved in that case so a future reload/engine can retry, but nothing plays until a
// decodable file is loaded for that slot.
export async function storeOverride(weaponId, stage, fileBlob) {
  const key = keyFor(weaponId, stage);
  const record = { key, weaponId, stage, blob: fileBlob, name: fileBlob?.name ?? '', type: fileBlob?.type ?? '' };
  const db = await openDB();
  if (db) {
    try { await idbPut(db, record); } catch { /* storage full/blocked — decode still works this session */ }
  }
  let buffer = null;
  if (_ctx && fileBlob) {
    try {
      const bytes = await fileBlob.arrayBuffer();
      buffer = await _ctx.decodeAudioData(bytes);
    } catch {
      buffer = null; // corrupt/unsupported file — leave no override rather than throw
    }
  }
  if (buffer) {
    _cache.set(key, buffer);
    _meta.set(key, { name: record.name, type: record.type });
    _blobs.set(key, fileBlob);
    // #166: a freshly-loaded file always starts untrimmed and at start=0 — a start/trim tuned
    // against whatever was loaded before (if anything) has no meaningful relationship to this
    // file's own content/length, so never let it carry over silently.
    _trim.delete(key);
    _start.delete(key);
    // #172: same reasoning for the processing chain — a pitch/filter/reverb tuned against a
    // previous file must never carry over silently onto a fresh one.
    _proc.delete(key);
    // #174: same reasoning for the fade-out — a fade tuned against a previous file's length must
    // never carry over silently onto a fresh one.
    _fadeOut.delete(key);
    // #182: same reasoning for volume — a gain tuned against a previous file must never carry
    // over silently onto a fresh one; a new file always starts at unity gain.
    _volume.delete(key);
    // #185: same reasoning for loop start — a loop region tuned against a previous file's length
    // must never carry over silently onto a fresh one.
    _loopStart.delete(key);
  }
  return buffer;
}

// Synchronous lookup used at the sfx.js playback choke points — null means "no override
// loaded (or not decoded yet)," which callers treat as "fall back to procedural."
export function getOverride(weaponId, stage) {
  return _cache.get(keyFor(weaponId, stage)) ?? null;
}

export function hasOverride(weaponId, stage) {
  return _cache.has(keyFor(weaponId, stage));
}

// Original filename/mime for the panel's "loaded: foo.mp3" label; null if nothing loaded.
export function getOverrideMeta(weaponId, stage) {
  return _meta.get(keyFor(weaponId, stage)) ?? null;
}

// #166: synchronous lookup for the active trim (milliseconds) — the DURATION to play from the
// start offset (see getStartMs), used at the sfx.js playback choke point. null means "no trim
// set, play to the end of the file," same convention as getOverride.
export function getTrimMs(weaponId, stage) {
  return _trim.get(keyFor(weaponId, stage)) ?? null;
}

// #166: synchronous lookup for the active start offset (milliseconds into the buffer to skip
// ahead before playback begins), used at the sfx.js playback choke point. null means "start at
// the beginning of the file," same convention as getTrimMs.
export function getStartMs(weaponId, stage) {
  return _start.get(keyFor(weaponId, stage)) ?? null;
}

// #172: synchronous lookup for the active processing chain (pitch/filter/reverb) — the sparse
// object described in the module header, used at the sfx.js playback choke point. null means
// "no processing (clean passthrough)," same convention/lifecycle as getStartMs/getTrimMs.
export function getProcessing(weaponId, stage) {
  return _proc.get(keyFor(weaponId, stage)) ?? null;
}

// #174: synchronous lookup for the active fade-out duration (milliseconds) — the length of the
// gain ramp to silence ending at the scheduled stop, used at the sfx.js playback choke point.
// null means "no fade (hard cut)," same convention/lifecycle as getStartMs/getTrimMs.
export function getFadeOutMs(weaponId, stage) {
  return _fadeOut.get(keyFor(weaponId, stage)) ?? null;
}

// #182: synchronous lookup for the active overall volume multiplier, used at the sfx.js
// playback choke point. Unlike the other getters, this ALWAYS returns a real number (never
// null) — unity gain (1.0) is the meaningful default for "no volume override set," so callers
// never need their own `?? 1` fallback.
export function getVolume(weaponId, stage) {
  const v = _volume.get(keyFor(weaponId, stage));
  return v != null ? v : 1;
}

// #185: synchronous lookup for the held-loop path's own loop-start offset (milliseconds), used
// at sfx.js's playBufferLoop choke point. Falls back to getStartMs() when unset — i.e. no
// separate loop start means the loop region starts at the same place the intro does, which is
// today's exact pre-#185 behavior (the whole clip re-loops from its own start every cycle).
export function getLoopStartMs(weaponId, stage) {
  const key = keyFor(weaponId, stage);
  const v = _loopStart.get(key);
  return v != null ? v : getStartMs(weaponId, stage);
}

// Shared persistence for setTrim/setStart/setProcessing: writes a full IDB record combining
// whatever's currently in the in-memory maps for this key, so any one setter alone keeps the
// other fields intact.
async function _persistParams(weaponId, stage) {
  const key = keyFor(weaponId, stage);
  const blob = _blobs.get(key);
  if (!blob) return; // no active override to attach this to
  const db = await openDB();
  if (!db) return;
  const meta = _meta.get(key) ?? {};
  const record = { key, weaponId, stage, blob, name: meta.name ?? '', type: meta.type ?? '' };
  const trimMs = _trim.get(key);
  const startMs = _start.get(key);
  const processing = _proc.get(key);
  const fadeOutMs = _fadeOut.get(key);
  const volume = _volume.get(key);
  const loopStartMs = _loopStart.get(key);
  if (trimMs != null) record.trimMs = trimMs;
  if (startMs != null) record.startMs = startMs;
  if (processing != null) record.processing = processing;
  if (fadeOutMs != null) record.fadeOutMs = fadeOutMs;
  if (volume != null) record.volume = volume;
  if (loopStartMs != null) record.loopStartMs = loopStartMs;
  try { await idbPut(db, record); } catch { /* storage full/blocked — in-memory value still applies this session */ }
}

// #166: set (or clear, with null/undefined) the non-destructive trim (duration, from the start
// offset) for an active override. Purely a playback-time parameter — never touches the decoded
// buffer or the stored bytes. Persists alongside the existing override record in IndexedDB so
// it survives a reload; a no-op (still updates the in-memory map for this session) if there's
// no stored blob to attach it to yet, or if IndexedDB is unavailable/blocked.
export async function setTrim(weaponId, stage, trimMs) {
  const key = keyFor(weaponId, stage);
  if (trimMs == null) _trim.delete(key); else _trim.set(key, trimMs);
  await _persistParams(weaponId, stage);
}

// #166: set (or clear, with null/undefined) the non-destructive start offset for an active
// override. Same persistence/lifecycle contract as setTrim.
export async function setStart(weaponId, stage, startMs) {
  const key = keyFor(weaponId, stage);
  if (startMs == null) _start.delete(key); else _start.set(key, startMs);
  await _persistParams(weaponId, stage);
}

// #174: set (or clear, with null/undefined/0) the non-destructive fade-out duration for an active
// override. Purely a playback-time parameter — never touches the decoded buffer or the stored
// bytes. Same persistence/lifecycle contract as setTrim/setStart (0 is treated as "no fade" and
// stored as absent, so returning the slider to 0 restores the exact hard-cut behavior).
export async function setFadeOut(weaponId, stage, fadeOutMs) {
  const key = keyFor(weaponId, stage);
  if (fadeOutMs == null || fadeOutMs <= 0) _fadeOut.delete(key); else _fadeOut.set(key, fadeOutMs);
  await _persistParams(weaponId, stage);
}

// #182: set (or clear, with null/1.0) the non-destructive overall volume multiplier for an
// active override. Purely a playback-time parameter — never touches the decoded buffer or the
// stored bytes. Clamped to a 0..2 (0-200%) range; unity gain (1.0, including null/undefined) is
// treated as "no override" and stored as absent, so returning the slider to 100% restores the
// exact implicit pre-#182 behavior. Same persistence/lifecycle contract as setTrim/setStart/
// setFadeOut.
export async function setVolume(weaponId, stage, volume) {
  const key = keyFor(weaponId, stage);
  if (volume == null) {
    _volume.delete(key);
  } else {
    const clamped = Math.max(0, Math.min(2, volume));
    if (clamped === 1) _volume.delete(key); else _volume.set(key, clamped);
  }
  await _persistParams(weaponId, stage);
}

// #185: set (or clear, with null/undefined) the non-destructive loop-start offset for an active
// override's held-loop path. Purely a playback-time parameter — never touches the decoded buffer
// or the stored bytes. Same persistence/lifecycle contract as setStart (null restores "loop start
// = startMs," today's exact pre-#185 behavior).
export async function setLoopStartMs(weaponId, stage, loopStartMs) {
  const key = keyFor(weaponId, stage);
  if (loopStartMs == null) _loopStart.delete(key); else _loopStart.set(key, loopStartMs);
  await _persistParams(weaponId, stage);
}

// #172: merge-patch the non-destructive processing chain (pitch/filter/reverb) for an active
// override. `patch` is a partial of the processing object (see the module header) — each field
// set to a real value updates it, each field set to null/undefined CLEARS it. Once every field
// is cleared the whole processing object is dropped (getProcessing → null), so returning all
// controls to neutral restores an exact clean passthrough. Purely a playback-time parameter set
// (never touches the decoded buffer/stored bytes); persists alongside the rest of the override
// record. In-memory update is synchronous (getProcessing reflects it immediately) with the IDB
// write awaited, matching setTrim/setStart.
export async function setProcessing(weaponId, stage, patch) {
  const key = keyFor(weaponId, stage);
  const next = { ..._proc.get(key) };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete next[k]; else next[k] = v;
  }
  if (Object.keys(next).length === 0) _proc.delete(key); else _proc.set(key, next);
  await _persistParams(weaponId, stage);
}

// Remove an override, reverting that weapon+stage to procedural synthesis. Also clears any
// trim set for it (#166) — a trim with no override to apply to is meaningless, and a future
// file loaded into this same slot must never inherit a stale trim from a previous file.
export async function clearOverride(weaponId, stage) {
  const key = keyFor(weaponId, stage);
  _cache.delete(key);
  _meta.delete(key);
  _blobs.delete(key);
  _trim.delete(key);
  _start.delete(key);
  _proc.delete(key);   // #172: processing chain is meaningless without an override to apply to
  _fadeOut.delete(key); // #174: fade-out is meaningless without an override to apply to
  _volume.delete(key); // #182: volume is meaningless without an override to apply to
  _loopStart.delete(key); // #185: loop start is meaningless without an override to apply to
  const db = await openDB();
  if (!db) return;
  try { await idbDelete(db, key); } catch { /* blocked — in-memory clear still took effect */ }
}

// #186: pre-load a shipped bake's settings into the live override slot for editing. Called by
// the panel the moment the owner touches ANY slider for a stage that has a bake but no live
// override yet (see WeaponSfxPanel._editOverride) — a no-op (returns true immediately) if a
// live override already exists for this (id, stage), since there's nothing to seed. Otherwise:
// pulls the bake's decoded buffer + full recipe (getBaked), re-encodes the buffer as a WAV Blob
// (see encodeWavBlob above) and runs it through the ordinary storeOverride() path exactly as if
// the owner had picked that file by hand, then replays the bake's own start/trim/fadeOut/volume/
// processing/loopStart onto the new override via the normal setters — so the freshly-seeded
// override starts IDENTICAL to what was already playing (the bake), and the caller's own
// just-dragged value can then be applied on top of that by the normal setter path. Returns
// false (no-op beyond the no-op check) if there's no bake to seed from, or if decoding the
// re-encoded buffer failed.
export async function seedOverrideFromBaked(weaponId, stage) {
  if (hasOverride(weaponId, stage)) return true;
  const baked = getBaked(weaponId, stage);
  if (!baked?.buffer) return false;
  const wavBlob = encodeWavBlob(baked.buffer);
  const file = new File([wavBlob], `baked-${weaponId}-${stage}.wav`, { type: 'audio/wav' });
  const decoded = await storeOverride(weaponId, stage, file);
  if (!decoded) return false;
  if (baked.startMs != null) await setStart(weaponId, stage, baked.startMs);
  if (baked.trimMs != null) await setTrim(weaponId, stage, baked.trimMs);
  if (baked.fadeOutMs != null) await setFadeOut(weaponId, stage, baked.fadeOutMs);
  if (baked.volume != null && baked.volume !== 1) await setVolume(weaponId, stage, baked.volume);
  if (baked.processing) await setProcessing(weaponId, stage, baked.processing);
  if (baked.loopStartMs != null && baked.loopStartMs !== baked.startMs) {
    await setLoopStartMs(weaponId, stage, baked.loopStartMs);
  }
  return true;
}

// Boot-time preload (#150): read every stored override out of IndexedDB and decode it, so
// there's no race against the first time a weapon fires. Safe to call with no context yet
// (no-ops) and safe to call more than once (re-decodes everything; harmless, just redundant).
export async function loadAllOverrides() {
  const db = await openDB();
  if (!db || !_ctx) return;
  const records = await idbGetAll(db);
  await Promise.all(records.map(async (rec) => {
    if (!rec?.blob) return;
    try {
      const bytes = await rec.blob.arrayBuffer();
      const buffer = await _ctx.decodeAudioData(bytes);
      _cache.set(rec.key, buffer);
      _meta.set(rec.key, { name: rec.name, type: rec.type });
      _blobs.set(rec.key, rec.blob);
      // #166: restore a persisted trim, if this record has one — a record saved before this
      // feature existed simply has no `trimMs` field, which correctly leaves it untrimmed.
      if (rec.trimMs != null) _trim.set(rec.key, rec.trimMs);
      if (rec.startMs != null) _start.set(rec.key, rec.startMs);
      // #172: restore a persisted processing chain, if any — a record saved before this feature
      // existed simply has no `processing` field, which correctly leaves it clean/unprocessed.
      if (rec.processing != null) _proc.set(rec.key, rec.processing);
      // #174: restore a persisted fade-out, if any — a record saved before this feature existed
      // simply has no `fadeOutMs` field, which correctly leaves it unfaded (hard cut).
      if (rec.fadeOutMs != null) _fadeOut.set(rec.key, rec.fadeOutMs);
      // #182: restore a persisted volume, if any — a record saved before this feature existed
      // simply has no `volume` field, which correctly leaves it at unity gain (getVolume → 1).
      if (rec.volume != null) _volume.set(rec.key, rec.volume);
      // #185: restore a persisted loop start, if any — a record saved before this feature existed
      // simply has no `loopStartMs` field, which correctly leaves it "= startMs" (getLoopStartMs
      // falls back to getStartMs).
      if (rec.loopStartMs != null) _loopStart.set(rec.key, rec.loopStartMs);
    } catch {
      // A stored file that no longer decodes (corrupt, or the browser dropped codec support)
      // just stays a no-op override — that weapon+stage plays procedurally, same as if
      // nothing had ever been stored.
    }
  }));
}

// Test-only reset (no production caller) — clears in-memory state and forces the next
// openDB() to re-open, so each test starts from a clean slate.
export function _resetForTest() {
  _cache.clear();
  _meta.clear();
  _blobs.clear();
  _trim.clear();
  _start.clear();
  _proc.clear();
  _fadeOut.clear();
  _volume.clear();
  _loopStart.clear();
  _dbPromise = null;
  _ctx = null;
}
