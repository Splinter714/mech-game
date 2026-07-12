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

// Shared persistence for setTrim/setStart: writes a full IDB record combining whatever's
// currently in the in-memory maps for this key, so either setter alone keeps both fields intact.
async function _persistStartTrim(weaponId, stage) {
  const key = keyFor(weaponId, stage);
  const blob = _blobs.get(key);
  if (!blob) return; // no active override to attach this to
  const db = await openDB();
  if (!db) return;
  const meta = _meta.get(key) ?? {};
  const record = { key, weaponId, stage, blob, name: meta.name ?? '', type: meta.type ?? '' };
  const trimMs = _trim.get(key);
  const startMs = _start.get(key);
  if (trimMs != null) record.trimMs = trimMs;
  if (startMs != null) record.startMs = startMs;
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
  await _persistStartTrim(weaponId, stage);
}

// #166: set (or clear, with null/undefined) the non-destructive start offset for an active
// override. Same persistence/lifecycle contract as setTrim.
export async function setStart(weaponId, stage, startMs) {
  const key = keyFor(weaponId, stage);
  if (startMs == null) _start.delete(key); else _start.set(key, startMs);
  await _persistStartTrim(weaponId, stage);
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
  const db = await openDB();
  if (!db) return;
  try { await idbDelete(db, key); } catch { /* blocked — in-memory clear still took effect */ }
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
  _dbPromise = null;
  _ctx = null;
}
