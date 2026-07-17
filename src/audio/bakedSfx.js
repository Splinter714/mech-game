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
// #180: deathExplosionMassive's FIRE cue — "Mecha DAMAGED 2.wav" from the same Helton Yan pack
// (STEREO 44.1kHz 16-bit, 3.429s). Converted with macOS `afconvert` to 44.1kHz STEREO AAC/.m4a
// at ~224kbps (~99KB) — kept stereo (unlike the prior mono weapon-fire bakes) and encoded at a
// higher bitrate to preserve the explosion's low end. Played back as the first 1490ms of the
// file (#166 start+trim: startMs 0, trimMs 1490) with a 550ms fade-out (#174).
import deathExplosionFire from '../assets/sfx/deathExplosionMassive-fire-mechaDamaged2.m4a';
// #194: the UI domain's `deploy` cue (Garage → Arena launch) — "Mecha TURN ON - OFF 8.wav" from
// the same Helton Yan pack (STEREO 44.1kHz 16-bit, 3.429s). Converted with macOS `afconvert` to
// 44.1kHz STEREO AAC/.m4a (~191kbps, ~85KB) — kept stereo like the #180 explosion bake. Played
// back as the first 1620ms of the file (#166 start+trim: startMs 0, trimMs 1620) with a 930ms
// fade-out (#174). No pitch/volume processing. Key is `deploy::play` (UI domain entries use the
// (id, stage) pair from sfxDomains.js/sfx.js's uiCue, not a weaponId — same `weaponId::stage` key
// shape either way).
import deployPlay from '../assets/sfx/deploy-play-mechaTurnOn8.m4a';
// #192: the UI domain's `equip` cue (Garage mount/swap click) — "Ting_Pitched_Up.wav" from the
// same Helton Yan pack (STEREO 48kHz 24-bit, 0.689s). Converted with macOS `afconvert` to
// 44.1kHz STEREO AAC/.m4a (~192kbps, ~9.5KB) — kept stereo like the #180/#194 stereo bakes.
// Played back as the full file (startMs 0, trimMs 689 — the whole 689ms length, not an actual
// trim), pitched up +80 cents (#172 processing) and boosted to 1.6x volume (#182).
import equipPlay from '../assets/sfx/equip-play-tingPitchedUp.m4a';
// #198: the UI domain's `powerupPickupOverclock` cue (one of the 5 #196 per-powerup pickup ids)
// — "DSGNSynth_CAST-Mecha Speeding_HY_PC-003.wav" from the same Helton Yan pack (STEREO 96kHz
// 24-bit, 3.488s). Converted with macOS `afconvert` to 44.1kHz STEREO AAC/.m4a (~93kbps, ~45KB;
// VBR-encoded so bitrate follows content, unlike the flat ~191-224kbps of the earlier stereo
// bakes) — kept stereo like the #180/#194/#192 stereo bakes. Played back as the first 2590ms of
// the file (#166 start+trim: startMs 0, trimMs 2590) with a 660ms fade-out (#174). No pitch/
// volume processing.
import powerupPickupOverclockPlay from '../assets/sfx/powerupPickupOverclock-play-mechaSpeeding.m4a';
// #199: the UI domain's `powerupPickupOverdrive` cue (#196 split of the powerup-pickup sfx) —
// "DSGNSynth_BUFF-Plus Damage_HY_PC-001.wav" from the same Helton Yan pack (STEREO 96kHz 24-bit,
// 2.602s). Converted with macOS `afconvert` to 44.1kHz STEREO AAC/.m4a (target ~192kbps, ~28KB) —
// kept stereo like the other UI-domain stereo bakes (#180/#194/#192). Played back as the full file
// (startMs 0, trimMs 2602 — the whole 2602ms length, not an actual trim). No fade-out, no pitch
// shift, no volume change — all defaults, per Jackson's copy-recipe.
import powerupPickupOverdrivePlay from '../assets/sfx/powerupPickupOverdrive-play-plusDamage.m4a';
// #206: the UI domain's `menuNav` cue — "UIClick_INTERFACE-Strong Click 1_HY_PC-001.wav" from
// the same Helton Yan pack (STEREO 96kHz 24-bit, 2.5s). Converted with macOS `afconvert` to
// 44.1kHz STEREO AAC/.m4a (~192kbps target) — kept stereo like the other UI-domain stereo bakes
// (#180/#194/#192/#198/#199). Played back as the first 190ms of the file (#166 start+trim:
// startMs 0, trimMs 190) with a lowpass filter at 1700Hz/Q9 (#172 processing) and a 1070ms
// fade-out (#174) — the fade duration exceeds the 190ms played window, so it's clamped down to
// the window at playback time (same precedent as #175's plasmaLance bake). Silenced entirely at
// 0.00x (0%) volume (#182) — recorded literally per Jackson's copy-recipe, not "fixed" to
// audible; this bakes the cue as authored-silent.
import menuNavPlay from '../assets/sfx/menuNav-play-strongClick1.m4a';
// #208: the UI domain's `mechDestroyed` cue (added #201) — the FIRST real 4-VARIANT bake using
// the #195 randomized-pool feature (every earlier bake above is a single-object entry). Four
// distinct files from the same Helton Yan pack, each "Mecha DAMAGED N.wav" (STEREO 44.1kHz
// 16-bit, 3.429s) — variant 2 is a DIFFERENT source file than the one already baked as
// deathExplosionMassive::fire (#180 trimmed "Mecha DAMAGED 2.wav" to 1490ms+550ms fade for a
// different cue); this bake uses the FULL untrimmed file for all 4 variants, no fade/processing.
// Converted with macOS `afconvert` to 44.1kHz STEREO AAC/.m4a (~154-194kbps, ~71-89KB each) —
// kept stereo like the other Helton Yan stereo bakes (#180/#194/#192/#198/#199/#206).
import mechDestroyed1 from '../assets/sfx/mechDestroyed-play-mechaDamaged1.m4a';
import mechDestroyed2 from '../assets/sfx/mechDestroyed-play-mechaDamaged2.m4a';
import mechDestroyed3 from '../assets/sfx/mechDestroyed-play-mechaDamaged3.m4a';
import mechDestroyed4 from '../assets/sfx/mechDestroyed-play-mechaDamaged4.m4a';

const keyFor = (weaponId, stage) => `${weaponId}::${stage}`;

// #195: RANDOMIZED VARIANTS — same pool concept as sfxOverrides.js's live-override pool, for a
// SHIPPED bake. A BAKED_SFX entry may be either a single recipe object (today's shape, unchanged)
// or an ARRAY of up to MAX_VARIANTS recipe objects — each with its own `asset`/start/trim/etc —
// and playback picks uniformly at random among however many are decoded. `normalizeEntries`
// treats a bare object as an implicit 1-entry array so every existing single-object bake needs
// ZERO changes. Variant `i`'s decoded buffer is cached under the SAME `#v${i}` pseudo-stage
// suffix sfxOverrides.js's live-override pool uses (index 0 = the plain key, unchanged) — so a
// (weaponId, stage) pair passed through getBaked/hasBaked with a pseudo-stage suffix resolves
// consistently whether it's actually a live-override pseudo-stage or a baked one.
// #209: raised from 4 to 10, matching sfxOverrides.js's MAX_VARIANTS (must stay in sync — see
// its own header for why).
const MAX_VARIANTS = 10;
function normalizeEntries(entry) {
  if (Array.isArray(entry)) return entry;
  return entry ? [entry] : [];
}
// Parses an incoming `stage` argument for a trailing `#v<n>` pseudo-stage suffix (added by the
// variant pool machinery below, or forwarded straight through from sfxOverrides.js's
// variantStage()) — returns the REAL stage name and the variant index (0 if no suffix).
const VARIANT_STAGE_RE = /^(.*)#v(\d+)$/;
function parseStage(stage) {
  const m = VARIANT_STAGE_RE.exec(stage);
  return m ? { realStage: m[1], index: Number(m[2]) } : { realStage: stage, index: 0 };
}
function variantCacheKey(baseKey, index) {
  return index === 0 ? baseKey : `${baseKey}#v${index}`;
}

// The DATA table — the whole "add a bake = one entry" surface. Keyed by `weaponId::stage`
// (same key shape as sfxOverrides). Each entry:
//   asset       a Vite asset import of the file (bundled + content-hashed into the build)
//   startMs     skip-ahead offset into the buffer before playback (null/0 = start at the beginning)
//   trimMs      duration to play FROM that start point (null = play to the end of the file)
//   processing  sparse pitch/filter/reverb object (null = a clean passthrough) — see the
//               sfxOverrides.js header for the field list; played through the same #172 chain
//   fadeOutMs   optional fade-out duration in ms (#174) — fade to silence over the last N ms
//               before the scheduled stop (omit/null/0 = no fade, hard cut)
//   volume      optional overall gain multiplier (#182) — 1.0 = unity (omit = unity, unchanged
//               implicit gain); composes with fadeOutMs (the fade ramps FROM this level to 0)
//   loopStartMs VESTIGIAL (#185 rework) — used by an earlier held-loop scheme that repeated a
//               region of the buffer. A held weapon's bake now plays ONCE as the intro and hands
//               off to procedural sustain synthesis (sfx.js's startHeld/startIntroThenSustain),
//               so the buffer is never repeated and this field is not read by playback anymore.
//               Left in the schema so an entry authored before the rework still round-trips
//               (getBaked still returns it, defaulting to the entry's own `startMs`), but adding
//               it to a new bake has no audible effect.
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
  // Helton Yan's Pixel Combat pack — "Mecha DAMAGED 2.wav" (stereo). The first 1490ms of the
  // file (#166 start+trim: startMs 0, trimMs 1490) as deathExplosionMassive's fire cue, with a
  // 550ms fade-out (#174). No pitch/filter/reverb processing.
  'deathExplosionMassive::fire': {
    asset: deathExplosionFire,
    startMs: 0,
    trimMs: 1490,
    fadeOutMs: 550,
    processing: null,
  },
  // Helton Yan's Pixel Combat pack — "Mecha TURN ON - OFF 8.wav" (stereo). The first 1620ms of
  // the file (#166 start+trim: startMs 0, trimMs 1620) as the UI domain's deploy cue, with a
  // 930ms fade-out (#174). No pitch/filter/reverb processing (#194).
  'deploy::play': {
    asset: deployPlay,
    startMs: 0,
    trimMs: 1620,
    fadeOutMs: 930,
    processing: null,
  },
  // Helton Yan's Pixel Combat pack — "Ting_Pitched_Up.wav" (stereo). The full 689ms file (#166
  // start+trim: startMs 0, trimMs 689 — no actual trim, just the recorded played window) as the
  // UI domain's equip cue, pitched up +80 cents (#172 processing) and boosted to 1.6x volume
  // (#182). No fade-out.
  'equip::play': {
    asset: equipPlay,
    startMs: 0,
    trimMs: 689,
    processing: { detune: 80 },
    volume: 1.6,
  },
  // Helton Yan's Pixel Combat pack — "DSGNSynth_CAST-Mecha Speeding_HY_PC-003.wav" (stereo).
  // The first 2590ms of the file (#166 start+trim: startMs 0, trimMs 2590) as the UI domain's
  // powerupPickupOverclock cue, with a 660ms fade-out (#174). No pitch/filter/reverb/volume
  // processing (#198).
  'powerupPickupOverclock::play': {
    asset: powerupPickupOverclockPlay,
    startMs: 0,
    trimMs: 2590,
    fadeOutMs: 660,
    processing: null,
  },
  // Helton Yan's Pixel Combat pack — "DSGNSynth_BUFF-Plus Damage_HY_PC-001.wav" (stereo). The full
  // 2602ms file (#166 start+trim: startMs 0, trimMs 2602 — no actual trim, just the recorded played
  // window) as the UI domain's powerupPickupOverdrive cue (#196 split). No fade-out, no
  // pitch/filter/reverb processing (#199). Reduced to 0.5x (50%) volume (#204).
  'powerupPickupOverdrive::play': {
    asset: powerupPickupOverdrivePlay,
    startMs: 0,
    trimMs: 2602,
    processing: null,
    volume: 0.5,
  },
  // Helton Yan's Pixel Combat pack — "UIClick_INTERFACE-Strong Click 1_HY_PC-001.wav" (stereo).
  // The first 190ms of the file (#166 start+trim: startMs 0, trimMs 190 — full file is 2500ms)
  // as the UI domain's menuNav cue, with a lowpass filter at 1700Hz/Q9 (#172 processing) and a
  // 1070ms fade-out (#174 — exceeds the 190ms played window; clamped to it at playback time,
  // same as #175). Silenced at 0.00x volume (#182) — authored silent, per Jackson's literal
  // copy-recipe (#206).
  'menuNav::play': {
    asset: menuNavPlay,
    startMs: 0,
    trimMs: 190,
    processing: { filterType: 'lowpass', filterFreq: 1700, filterQ: 9 },
    fadeOutMs: 1070,
    volume: 0,
  },
  // #208: the UI domain's mechDestroyed cue — a 4-VARIANT pool (#195), one entry per
  // "Mecha DAMAGED N.wav" (N=1..4) from the Helton Yan pack. Each variant plays the FULL
  // 3429ms file, no trim, no fade, no pitch/filter/reverb processing — literal copy-recipe.
  // Playback (pickBakedVariant) picks uniformly at random among the 4 decoded variants.
  'mechDestroyed::play': [
    { asset: mechDestroyed1, startMs: 0, trimMs: 3429, processing: null },
    { asset: mechDestroyed2, startMs: 0, trimMs: 3429, processing: null },
    { asset: mechDestroyed3, startMs: 0, trimMs: 3429, processing: null },
    { asset: mechDestroyed4, startMs: 0, trimMs: 3429, processing: null },
  ],
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
  await Promise.all(Object.entries(BAKED_SFX).map(async ([key, rawEntry]) => {
    const entries = normalizeEntries(rawEntry);
    // #195: decode every variant independently (same fire-and-forget-per-asset contract as
    // before) — a single-entry bake decodes exactly one buffer at the plain key, unchanged.
    await Promise.all(entries.map(async (entry, i) => {
      if (!entry?.asset) return;
      try {
        const res = await fetch(entry.asset);
        const bytes = await res.arrayBuffer();
        const buffer = await _ctx.decodeAudioData(bytes);
        _cache.set(variantCacheKey(key, i), buffer);
      } catch {
        // fetch/decode failed (missing asset, codec unsupported) — leave the slot empty so this
        // weapon+stage/variant plays procedurally (or falls back to a lower-index variant, if any
        // decoded), same as if no bake had ever been defined for it.
      }
    }));
  }));
}

// Synchronous lookup used at the sfx.js playback choke points: returns { buffer, startMs,
// trimMs, processing, fadeOutMs, volume, loopStartMs } for a decoded bake, or null (no bake for
// this slot, or not decoded yet) which callers treat as "fall back to procedural." The buffer
// comes from the decoded cache; the recipe (start/trim/processing/fadeOut/volume/loopStartMs)
// comes straight from the static BAKED_SFX entry. `volume` defaults to 1 (unity) when the entry
// omits it (#182), same convention sfxOverrides.getVolume() uses. `loopStartMs` defaults to the
// entry's own `startMs` when omitted (#185) — same "no separate loop region" fallback convention
// as sfxOverrides.getLoopStartMs().
// #195: `stage` may carry a `#v<n>` pseudo-stage suffix (see the header above) addressing one
// variant of a multi-variant bake — a plain stage (no suffix) is variant 0, byte-identical to
// every pre-#195 call site (including every existing single-object BAKED_SFX entry, which has
// exactly one variant living at index 0).
export function getBaked(weaponId, stage) {
  const { realStage, index } = parseStage(stage);
  const baseKey = keyFor(weaponId, realStage);
  const entry = normalizeEntries(BAKED_SFX[baseKey])[index];
  if (!entry) return null;
  const buffer = _cache.get(variantCacheKey(baseKey, index));
  if (!buffer) return null;
  return {
    buffer,
    startMs: entry.startMs ?? null,
    trimMs: entry.trimMs ?? null,
    processing: entry.processing ?? null,
    fadeOutMs: entry.fadeOutMs ?? null,
    volume: entry.volume ?? 1,
    loopStartMs: entry.loopStartMs ?? entry.startMs ?? null,
  };
}

export function hasBaked(weaponId, stage) {
  const { realStage, index } = parseStage(stage);
  return _cache.has(variantCacheKey(keyFor(weaponId, realStage), index));
}

// #195: how many contiguous decoded variants exist for this (weaponId, REAL stage — no `#v`
// suffix) bake. 0 = no bake at all (or not decoded yet); 1 = today's ordinary single-bake case.
export function getBakedVariantCount(weaponId, stage) {
  const baseKey = keyFor(weaponId, stage);
  const entries = normalizeEntries(BAKED_SFX[baseKey]);
  let n = 0;
  while (n < MAX_VARIANTS && n < entries.length && _cache.has(variantCacheKey(baseKey, n))) n++;
  return n;
}

// #195: the sole playback-time entry point for a BAKED pool — picks uniformly at random among
// however many variants are decoded (Math.random(), no weighting), mirroring
// sfxOverrides.js's pickOverrideStage. Returns the same shape as getBaked, or null if nothing is
// decoded for this (weaponId, stage) at all. A pool of exactly 1 always resolves to variant 0 —
// byte-identical to plain getBaked(weaponId, stage) for every existing single-bake entry.
export function pickBakedVariant(weaponId, stage) {
  const n = getBakedVariantCount(weaponId, stage);
  if (n === 0) return null;
  const idx = n === 1 ? 0 : Math.floor(Math.random() * n);
  return getBaked(weaponId, idx === 0 ? stage : `${stage}#v${idx}`);
}

// Test-only reset (no production caller) — clears the decoded cache and the context handle so
// each test starts clean, mirroring sfxOverrides._resetForTest.
export function _resetForTest() {
  _cache.clear();
  _ctx = null;
}

// Test-only injector — seed a decoded buffer for a key without going through fetch/decode, so
// unit tests (which can't fetch a bundled Vite URL in node) can exercise the playback path.
// #195: optional `variantIndex` (default 0, unchanged for every existing call site) seeds a
// specific variant slot of a multi-variant bake.
export function _setBakedBufferForTest(weaponId, stage, buffer, variantIndex = 0) {
  _cache.set(variantCacheKey(keyFor(weaponId, stage), variantIndex), buffer);
}
