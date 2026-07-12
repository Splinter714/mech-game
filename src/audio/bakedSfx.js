// Baked-in SFX assets (#173) — the FIRST real audio files shipped with the game. Until now
// every sound was synthesized (zero asset files, mirroring the procedural-art ethos); a
// "baked" SFX bundles an actual recorded file as a weapon+stage's shipped sound. This is the
// PRODUCTION counterpart to the dev-only runtime overrides (sfxOverrides.js): overrides are
// loaded live from IndexedDB by the Weapon Lab and never ship, whereas a baked entry is part
// of the build and plays for every player.
//
// Data-driven by design — a new bake is just "drop a file in src/assets/sfx/ + add one entry
// to BAKED_SFX." Each entry mirrors a runtime-override record's playback params
// (startMs/trimMs/processing), so a baked sound carries the same non-destructive start/end trim
// (#166) and pitch/filter/reverb chain (#172) as a dev override — and plays back through the
// EXACT same code path (sfx.js's playBuffer), just sourced from a bundled buffer instead of
// IndexedDB.
//
// Lifecycle mirrors sfxOverrides.js: AudioEngine.init(ctx) calls setAudioContext(ctx) so this
// module has a context to decode with; BootScene then fires loadAllBaked() once at boot to
// fetch + decode every asset into an in-memory buffer cache (`_cache`). It's fire-and-forget
// async and never blocks boot — a sound triggered before its buffer finishes decoding just
// finds nothing cached yet (getBaked → null) and plays procedurally for that one instance,
// never throwing. In a shipped build there are no IndexedDB overrides, so the effective
// precedence is baked-then-procedural.

// Vite asset import — bundled + content-hashed into the build (`.m4a` is a default Vite asset
// type, so this resolves to a hashed URL). The source WAV (96kHz/24-bit stereo, ~1.8MB) was
// converted with macOS `afconvert` to 48kHz stereo AAC at ~192kbps (~64KB) for web delivery.
import bitBombExplosion from '../assets/sfx/clusterRocket-fire-bitBomb.m4a';
// #175: plasmaLance's FIRE cue — "Bass wave.wav" from the same Helton Yan pack (mono 44.1kHz
// 16-bit, 1.199s). Converted with macOS `afconvert` to 44.1kHz mono AAC/.m4a at ~128kbps (~24KB).
// Played back with a 130ms trim (#166) and a 420ms fade-out (#174, clamped to the 130ms window).
import plasmaLanceFire from '../assets/sfx/plasmaLance-fire-bassWave.m4a';
// #176: pulseLaser's FIRE cue — "Bass Buzz_warning sound.wav" from the same Helton Yan pack (mono
// 44.1kHz 16-bit, 1.590s). Converted with macOS `afconvert` to 44.1kHz mono AAC/.m4a at ~128kbps
// (~30KB). Played back as a 60ms window starting 320ms into the file (#166 start+trim), pitched up
// +10 cents with a wet reverb (#172 processing), and a 450ms fade-out (#174, clamped to the window).
import pulseLaserFire from '../assets/sfx/pulseLaser-fire-bassBuzz.m4a';

const keyFor = (weaponId, stage) => `${weaponId}::${stage}`;

// The DATA table — the whole "add a bake = one entry" surface. Keyed by `weaponId::stage`
// (same key shape as sfxOverrides). Each entry:
//   asset       a Vite asset import of the file (bundled + content-hashed into the build)
//   startMs     skip-ahead offset into the buffer before playback (null/0 = start at the beginning)
//   trimMs      duration to play FROM that start point (null = play to the end of the file)
//   processing  sparse pitch/filter/reverb object (null = a clean passthrough) — see the
//               sfxOverrides.js header for the field list; played through the same #172 chain
//   fadeOutMs   optional fade-out duration in ms (#174) — fade to silence over the last N ms
//               before the scheduled stop (omit/null/0 = no fade, hard cut)
export const BAKED_SFX = {
  // Helton Yan's Pixel Combat pack — "DSGNImpt_EXPLOSION-Bit Bomb_HY_PC-001.wav". The full
  // file, no trim, no processing — just the raw explosion as clusterRocket's fire cue.
  'clusterRocket::fire': {
    asset: bitBombExplosion,
    startMs: 0,
    trimMs: null,
    processing: null,
  },
  // Helton Yan's Pixel Combat pack — "Bass wave.wav". Trimmed to the first 130ms (#166) with a
  // 420ms fade-out (#174) as plasmaLance's fire cue. The recipe's fadeOutMs (420) exceeds the
  // 130ms played window on purpose — playBuffer clamps the fade to the played duration, so it
  // fades across the whole 130ms; the literal owner recipe value is recorded here unclamped.
  'plasmaLance::fire': {
    asset: plasmaLanceFire,
    startMs: 0,
    trimMs: 130,
    fadeOutMs: 420,
    processing: null,
  },
  // Helton Yan's Pixel Combat pack — "Bass Buzz_warning sound.wav". A 60ms window starting 320ms
  // into the file (#166 start+trim: startMs 320, trimMs 60) as pulseLaser's fire cue, pitched up
  // +10 cents with a 0.25-mix / 2.3s reverb (#172 processing) and a 450ms fade-out (#174). The
  // recipe's fadeOutMs (450) exceeds the 60ms played window on purpose — playBuffer clamps the fade
  // to the played duration, so it fades across the whole 60ms; the literal owner recipe value is
  // recorded here unclamped. This is the first bake to carry a NON-null `processing` chain.
  'pulseLaser::fire': {
    asset: pulseLaserFire,
    startMs: 320,
    trimMs: 60,
    fadeOutMs: 450,
    processing: { detune: 10, reverbMix: 0.25, reverbSize: 2.3 },
  },
};

// Decoded AudioBuffer cache — the only thing playback (sfx.js) ever reads, synchronously.
// null (key absent) means "not decoded yet (or decode failed)" → fall back to procedural,
// exactly like an untouched override slot.
const _cache = new Map();

let _ctx = null;
// The audio context to decode with. AudioEngine.init() calls this once it has adopted Phaser's
// WebAudio context, same as it does for sfxOverrides.
export function setAudioContext(ctx) { _ctx = ctx; }

// Boot-time preload: fetch + decode every baked asset into `_cache`. Safe to call with no
// context yet (no-ops) and safe to call more than once (re-decodes; harmless). Each asset is
// decoded independently — one that fails to fetch/decode just leaves its slot empty (that
// weapon+stage plays procedurally), never throwing or blocking the others.
export async function loadAllBaked() {
  if (!_ctx) return;
  await Promise.all(Object.entries(BAKED_SFX).map(async ([key, entry]) => {
    if (!entry?.asset) return;
    try {
      const res = await fetch(entry.asset);
      const bytes = await res.arrayBuffer();
      const buffer = await _ctx.decodeAudioData(bytes);
      _cache.set(key, buffer);
    } catch {
      // fetch/decode failed (missing asset, codec unsupported) — leave the slot empty so this
      // weapon+stage plays procedurally, same as if no bake had ever been defined for it.
    }
  }));
}

// Synchronous lookup used at the sfx.js playback choke points: returns { buffer, startMs,
// trimMs, processing, fadeOutMs } for a decoded bake, or null (no bake for this slot, or not
// decoded yet) which callers treat as "fall back to procedural." The buffer comes from the
// decoded cache; the recipe (start/trim/processing/fadeOut) comes straight from the static
// BAKED_SFX entry.
export function getBaked(weaponId, stage) {
  const key = keyFor(weaponId, stage);
  const buffer = _cache.get(key);
  if (!buffer) return null;
  const entry = BAKED_SFX[key];
  return {
    buffer,
    startMs: entry.startMs ?? null,
    trimMs: entry.trimMs ?? null,
    processing: entry.processing ?? null,
    fadeOutMs: entry.fadeOutMs ?? null,
  };
}

export function hasBaked(weaponId, stage) { return _cache.has(keyFor(weaponId, stage)); }

// Test-only reset (no production caller) — clears the decoded cache and the context handle so
// each test starts clean, mirroring sfxOverrides._resetForTest.
export function _resetForTest() {
  _cache.clear();
  _ctx = null;
}

// Test-only injector — seed a decoded buffer for a key without going through fetch/decode, so
// unit tests (which can't fetch a bundled Vite URL in node) can exercise the playback path.
export function _setBakedBufferForTest(weaponId, stage, buffer) {
  _cache.set(keyFor(weaponId, stage), buffer);
}
