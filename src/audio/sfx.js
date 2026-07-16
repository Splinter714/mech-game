// Gameplay SFX — the procedural cues for firing, impacts, abilities, footfalls, and
// explosions, factored out of AudioEngine. Weapon fire/trajectory/impact cues are DATA (a
// per-weapon table of tunable layers in sfxParams.js, edited live by the Weapon Lab sound
// panel) played back by the generic playLayers() — **add/retune a weapon's sound = edit its
// entry in sfxParams.js, not a new function.** Ability/footstep/explosion cues are still
// small dedicated functions; they're not weapon-specific. The engine keeps the public
// facade (guards + `_resume`) and delegates here.
import { playLayers, startLoopLayers } from './sfxLayers.js';
import { hasHeldSfx, scaleExplosionLayer, explosionSfxId } from './sfxParams.js';
import {
  getOverride, getTrimMs, getStartMs, getProcessing, getFadeOutMs, getVolume, getLoopStartMs,
  pickOverrideStage,
} from './sfxOverrides.js';
import { pickBakedVariant } from './bakedSfx.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Dial the one-shot trajectory cue's gain down for the sustained loop — up to 6 can play at
// once (Swarm Rack); tune here.
const TRAJECTORY_LOOP_GAIN_SCALE = 0.6;

// At each one-shot choke point, a decoded buffer can take priority over the procedural layers
// for that weapon+stage. Two buffer sources feed this, in precedence order (#173): a dev-loaded
// IndexedDB override (#150, Weapon Lab sound panel) FIRST, then a shipped BAKED asset
// (bakedSfx.js). Both are synchronous in-memory lookups (null until decoded), so whenever
// neither exists this is a strict no-op — same node graph, same behavior as pure procedural.
// See playOverride (precedence) + playBuffer (the shared scheduling/DSP chain both sources use).
//
// #172: a runtime-synthesized reverb impulse response — decaying stereo white noise, so the
// ConvolverNode needs NO asset file (keeps the zero-asset philosophy). `seconds` sets the tail
// length; `decay` shapes how fast it fades (higher = tighter). Regenerated per shot, which is
// cheap for the short IRs a UI reverb uses and keeps the dev-tool path dead simple.
function makeImpulse(ctx, seconds, decay = 3) {
  const rate = ctx.sampleRate || 48000;
  const len = Math.max(1, Math.floor(seconds * rate));
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

// #172: splice a wet/dry reverb into the chain between `input` and `bus`. The dry path carries
// (1 - mix) straight through; the wet path runs `input` through a convolver (fed the generated
// IR) at `mix`. Only ever called when mix > 0 — a mix of 0 skips this entirely upstream, so a
// reverb-off override is a true clean passthrough (no extra nodes at all).
function connectReverb(ctx, input, bus, mix, sizeSec) {
  const dry = ctx.createGain(); dry.gain.value = 1 - mix;
  const wet = ctx.createGain(); wet.gain.value = mix;
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(ctx, Math.max(0.05, sizeSec ?? 1.5));
  input.connect(dry); dry.connect(bus);
  input.connect(conv); conv.connect(wet); wet.connect(bus);
}

// #166: non-destructive start/end pair — `startMs`/`trimMs`. `startMs` becomes the `offset` arg
// (skip ahead into the buffer before playback begins) and `trimMs` becomes the `duration` arg
// (how long to play FROM that new start point, not from the original file start) to
// AudioBufferSourceNode.start(when, offset, duration); the buffer itself is never sliced/copied,
// so both stay purely scheduling parameters, instantly adjustable/reversible.
//
// #172: non-destructive PROCESSING chain layered on top — pitch/rate (a `detune` on the source
// node, pitch+speed coupled), a BiquadFilter, and a wet/dry reverb (the sparse `proc` object).
// Chain order: source (with #166 offset/duration + detune) → [filter] → [reverb wet/dry] → bus
// (the existing sfx gain) → output. Each stage is inserted ONLY when its param is non-neutral,
// so a buffer with no processing builds the exact same `source → bus` graph as before — a
// strict clean passthrough, no regression.
//
// #173: this is the SHARED scheduling/DSP chain — both a dev IndexedDB override (#150) and a
// shipped BAKED asset (bakedSfx.js) play a decoded buffer through this exact code, differing
// only in where `buffer` and its (startMs/trimMs/proc/fadeOutMs) recipe come from. Returns true
// if it scheduled the buffer, false if there was nothing to play.
//
// #174: an optional FADE-OUT — when `fadeOutMs > 0` and the played duration is known, a gain
// node is spliced at the END of the chain (after processing, before the bus/reverb split) with a
// scheduled envelope: full gain held until `endTime - fadeOutMs`, then a linear ramp to 0 landing
// exactly on `endTime` (the scheduled stop = start-offset + played duration). This smooths the
// click/pop from an early-trimmed cutoff. `fadeOutMs` is clamped so it can never exceed the played
// duration; `fadeOutMs`=0/absent inserts NO gain node at all — a strict clean passthrough, so
// unfaded playback builds the exact same graph as before.
//
// #182: an optional overall VOLUME multiplier — a plain linear gain applied at the same point in
// the chain as the fade-out node. `volume` unset/1.0 (unity gain, today's implicit default)
// inserts NO extra gain node when there's also no fade-out — a strict clean passthrough, same
// graph as before #182. When a fade-out IS also active, the two compose into the SAME gain node:
// it holds at `volume` (not always 1) until the fade point, then ramps to 0 — so a loud
// (volume > 1) or quiet (volume < 1) override still fades out from its own level, not from unity.
function playBuffer(e, bus, buffer, startMs, trimMs, proc, fadeOutMs, volume) {
  if (!buffer || !e.ctx) return false;
  const ctx = e.ctx;
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  // #172: assemble the processing chain from src outward; `tail` is whatever the next node
  // should connect FROM. Neutral/absent params add nothing, leaving src → bus untouched.
  if (proc?.detune && src.detune) src.detune.value = proc.detune;   // cents (pitch+speed coupled)
  let tail = src;
  if (proc?.filterType) {
    const filter = ctx.createBiquadFilter();
    filter.type = proc.filterType;
    if (proc.filterFreq != null) filter.frequency.value = proc.filterFreq;
    if (proc.filterQ != null) filter.Q.value = proc.filterQ;
    tail.connect(filter);
    tail = filter;
  }

  const startAt = e._now();
  const offsetSec = (startMs ?? 0) / 1000;
  // The played duration (seconds) — the scheduled window length. trimMs wins when set; otherwise
  // it's whatever remains of the buffer after the start offset (null if the buffer length is
  // unknown, e.g. a fake decode in tests, which just means "can't compute a fade").
  const playedSec = trimMs != null
    ? trimMs / 1000
    : (buffer.duration != null ? Math.max(0, buffer.duration - offsetSec) : null);

  // #182: the volume multiplier — unset/null defaults to unity gain (1.0), same convention as
  // getVolume(). Neutral (exactly 1) with no fade-out active means no extra node is needed at
  // all (see below).
  const vol = volume != null ? volume : 1;

  // #174: splice the fade-out gain node only when there's a real fade to apply (positive
  // fadeOutMs AND a known, positive played duration). Clamp the fade so it can't exceed the
  // played window, then anchor gain at #182's `vol` (not always 1) at the fade-start and ramp
  // linearly to 0 at endTime — so the fade rides FROM the volume level, not from unity.
  if (fadeOutMs > 0 && playedSec != null && playedSec > 0) {
    const fadeSec = Math.min(fadeOutMs / 1000, playedSec);
    const endTime = startAt + playedSec;
    const fadeGain = ctx.createGain();
    fadeGain.gain.setValueAtTime(vol, endTime - fadeSec);
    fadeGain.gain.linearRampToValueAtTime(0, endTime);
    tail.connect(fadeGain);
    tail = fadeGain;
  } else if (vol !== 1) {
    // #182: no fade-out active, but a non-unity volume is set — a plain constant-gain node
    // carries the multiplier. Omitted entirely when vol is unity, so an untouched/pre-#182
    // override builds the exact same graph as before.
    const volGain = ctx.createGain();
    volGain.gain.value = vol;
    tail.connect(volGain);
    tail = volGain;
  }

  if (proc?.reverbMix > 0) connectReverb(ctx, tail, bus, proc.reverbMix, proc.reverbSize);
  else tail.connect(bus);

  if (startMs == null && trimMs == null) src.start(startAt);
  else if (trimMs != null) src.start(startAt, offsetSec, trimMs / 1000);
  else src.start(startAt, offsetSec);
  return true;
}

// Buffer-source precedence at each choke point (#173): a dev-loaded IndexedDB override (#150)
// wins FIRST — so a dev auditioning a live-loaded file in the Weapon Lab still beats a shipped
// bake — then a BAKED asset (bakedSfx.js), then (by returning false here) the caller's
// procedural fallback. Both buffer sources schedule through the shared playBuffer above, so the
// #166 trim + #172 processing recipe applies identically to either. In a shipped build there
// are no IndexedDB overrides, so this is effectively baked-then-procedural.
// #195: RANDOMIZED VARIANTS — a stage's override/bake can hold up to 4 parallel variant slots
// instead of just one (see sfxOverrides.js's/bakedSfx.js's module headers); every play resolves
// WHICH one via pickOverrideStage/pickBakedVariant, uniform random among however many are
// currently loaded. `pickOverrideStage` returns null when there's no live override at all for
// this stage (any variant) — same "fall through to bake" behavior as before this feature. A
// pool of exactly 1 (every stage that predates #195) always resolves to `stage` itself, so this
// is byte-identical to the pre-#195 single-variant precedence/behavior in that case.
function playOverride(e, bus, weaponId, stage) {
  const pickedStage = pickOverrideStage(weaponId, stage);
  if (pickedStage != null) {
    const override = getOverride(weaponId, pickedStage);
    if (override) {
      return playBuffer(e, bus, override, getStartMs(weaponId, pickedStage), getTrimMs(weaponId, pickedStage), getProcessing(weaponId, pickedStage), getFadeOutMs(weaponId, pickedStage), getVolume(weaponId, pickedStage));
    }
  }
  const baked = pickBakedVariant(weaponId, stage);
  if (baked) return playBuffer(e, bus, baked.buffer, baked.startMs, baked.trimMs, baked.processing, baked.fadeOutMs, baked.volume);
  return false;
}

// #179: a small attack ramp for a looping buffer's start, mirroring startLoopLayers' click-safety
// floor (sfxLayers.js's MIN_ATTACK) — an instant 0->gain jump on a continuous source pops.
const LOOP_ATTACK_SEC = 0.01;
// #179: fallback release length (ms) when a looping override/bake has no fadeOutMs set — same
// window sfxLayers.js's HELD_RELEASE uses for the procedural held path, so a loop with no tuned
// fade still ramps down cleanly on release instead of clicking.
const LOOP_RELEASE_DEFAULT_MS = 80;

// #179: genuinely LOOPING counterpart to playBuffer — for the held-sustain path (beamLaser/
// flamethrower), a one-shot buffer isn't enough; the source has to keep playing for as long as
// the trigger is held. Sets `AudioBufferSourceNode.loop = true` with `loopStart`/`loopEnd` derived
// from the #166 startMs/trimMs fields playBuffer already reads — `loopEnd` stays anchored to the
// overall trim end (startMs/1000 + trimMs/1000): trimMs's meaning (the duration of the trimmed
// region measured FROM startMs) never changes, so the played window's end doesn't move just
// because the loop's repeat point does. Applies the same #172 pitch/filter/reverb chain as the
// one-shot path. Fade-out (#174) semantics differ for a loop: there's no fixed "end" to fade into
// mid-loop, so fadeOutMs (or the release fallback above) is instead applied as the RELEASE ramp
// when the returned stop() is called — the gain node doubles as both the tiny start-attack ramp
// and the release fade, exactly analogous to how startLoopLayers' per-voice gain ramps up on
// start and down on stop.
// #182: the same overall VOLUME multiplier as the one-shot path, applied to the held loop's
// attack target — the gain node ramps up to `volume` (not always 1) on start and back down from
// wherever it's currently held on release, so a non-unity volume carries through the whole held
// sustain, not just the attack instant.
// #185: an optional SEPARATE loop-start offset, `loopStartMs` — playback still STARTS at
// `offsetSec` (from `startMs`, unchanged: the intro/attack transient plays once), but
// `src.loopStart` is now `loopStartMs/1000` when it differs from `startMs`, so the source wraps
// to a LATER point than where it began and never replays the intro. `loopStartMs` unset/absent
// (or equal to `startMs`) defaults to `offsetSec` — byte-for-byte the same node graph/behavior as
// before #185, so every existing held-loop override/bake (beamLaser/flamethrower) is unaffected.
//
// Returns a stop() closure (same shape/contract as startLoopLayers'), or null if there's no
// buffer/context to play through.
function playBufferLoop(e, bus, buffer, startMs, trimMs, proc, fadeOutMs, volume, loopStartMs) {
  if (!buffer || !e.ctx) return null;
  const ctx = e.ctx;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;

  const offsetSec = (startMs ?? 0) / 1000;
  // #185: the loop's repeat point — defaults to the same position as the intro's start offset
  // (today's behavior) when loopStartMs is unset/null, so an untouched held-loop sound builds the
  // exact same graph as before this change.
  const loopStartSec = loopStartMs != null ? loopStartMs / 1000 : offsetSec;
  src.loopStart = loopStartSec;
  if (trimMs != null) src.loopEnd = offsetSec + trimMs / 1000;
  // else: leave loopEnd unset — Web Audio treats 0/absent as "the end of the buffer."

  if (proc?.detune && src.detune) src.detune.value = proc.detune;
  let tail = src;
  let filter = null;
  if (proc?.filterType) {
    filter = ctx.createBiquadFilter();
    filter.type = proc.filterType;
    if (proc.filterFreq != null) filter.frequency.value = proc.filterFreq;
    if (proc.filterQ != null) filter.Q.value = proc.filterQ;
    tail.connect(filter);
    tail = filter;
  }

  // Gain node carries both the start attack and the eventual release fade — same role
  // startLoopLayers' per-voice gain plays for the procedural held path. #182: the attack ramps
  // to `volume` (default unity) instead of a hardcoded 1, so a non-unity volume applies to the
  // whole held sustain. exponentialRampToValueAtTime can't target exactly 0 (Web Audio requires
  // a nonzero value), so a volume of 0 floors at the same tiny epsilon the attack starts from.
  const vol = volume != null ? volume : 1;
  const g = ctx.createGain();
  const startAt = e._now();
  g.gain.setValueAtTime(0.0001, startAt);
  g.gain.exponentialRampToValueAtTime(vol > 0 ? vol : 0.0001, startAt + LOOP_ATTACK_SEC);
  tail.connect(g);
  tail = g;

  if (proc?.reverbMix > 0) connectReverb(ctx, tail, bus, proc.reverbMix, proc.reverbSize);
  else tail.connect(bus);

  src.start(startAt, offsetSec);

  let stopped = false;
  return function stop() {
    if (stopped) return;
    stopped = true;
    const now = e.ctx ? e._now() : startAt;
    const releaseSec = (fadeOutMs > 0 ? fadeOutMs : LOOP_RELEASE_DEFAULT_MS) / 1000;
    // Linear ramp to exact 0 (same envelope shape #174's one-shot fade-out uses) rather than an
    // exponential approach to a near-zero floor — a loop's release IS a #174-style fade, just
    // triggered on stop() instead of scheduled against a known end time.
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
    g.gain.linearRampToValueAtTime(0, now + releaseSec);
    try { src.stop(now + releaseSec + 0.02); } catch { /* already stopped */ }
    setTimeout(() => {
      try { src.disconnect(); filter?.disconnect(); g.disconnect(); } catch { /* already gone */ }
    }, (releaseSec + 0.05) * 1000);
  };
}

// #179: override/baked lookup for the held-sustain path, mirroring playOverride's precedence
// (dev IndexedDB override first, then a shipped bake) but scheduling a genuine LOOP via
// playBufferLoop instead of a fixed-duration one-shot. Returns the stop() closure, or null if
// there's no override/bake for this weapon+stage (caller falls back to procedural loop layers).
// #195: same variant-pool resolution as playOverride above, for the held-loop path.
function playOverrideLoop(e, bus, weaponId, stage) {
  const pickedStage = pickOverrideStage(weaponId, stage);
  if (pickedStage != null) {
    const override = getOverride(weaponId, pickedStage);
    if (override) {
      return playBufferLoop(e, bus, override, getStartMs(weaponId, pickedStage), getTrimMs(weaponId, pickedStage), getProcessing(weaponId, pickedStage), getFadeOutMs(weaponId, pickedStage), getVolume(weaponId, pickedStage), getLoopStartMs(weaponId, pickedStage));
    }
  }
  const baked = pickBakedVariant(weaponId, stage);
  if (baked) return playBufferLoop(e, bus, baked.buffer, baked.startMs, baked.trimMs, baked.processing, baked.fadeOutMs, baked.volume, baked.loopStartMs);
  return null;
}

export function fire(e, weapon) {
  if (playOverride(e, e.sfx, weapon.id, 'fire')) return;
  playLayers(e, e.sfx, e.getSfxParams(weapon.id).fire);
}

export function trajectory(e, weaponId) {
  if (playOverride(e, e.sfx, weaponId, 'trajectory')) return;
  const p = e.getSfxParams(weaponId);
  if (p.trajectory) playLayers(e, e.sfx, p.trajectory);
}

export function impact(e, weaponId) {
  if (playOverride(e, e.sfx, weaponId, 'impact')) return;
  playLayers(e, e.sfx, e.getSfxParams(weaponId).impact);
}

// ── Held/looping fire sound (#53) — flamethrower/beamLaser use ONE continuous source
// instead of a retriggered one-shot burst every cadence tick (see sfxLayers.js's
// startLoopLayers for the actual node-graph lifecycle). Reuses the weapon's own `fire`
// layers (same live, tunable data the Weapon Lab panel's sliders control) rather than a
// separate table, so tuning `fire` actually retunes what you hear while holding the button.
// Gated on hasHeldSfx — every weapon has `fire` layers now, but only flamethrower/beamLaser
// actually use the held/loop dispatch; everyone else fires one-shots.
//
// #179: before falling back to procedural layers, check for a file override/bake at the
// weapon's `fire` stage (same (id,stage) key `fire()` already reads for its one-shot cue —
// reusing it means no new stage taxonomy, and tuning a weapon's `fire` override/bake retunes
// both the one-shot AND the held sustain together). If one exists, schedule it as a genuine
// LOOP via playOverrideLoop instead of the fixed-length one-shot playOverride uses, and return
// its stop() closure. With no override/bake present (every weapon today), playOverrideLoop
// returns null and this falls through to the exact same startLoopLayers call as before —
// byte-for-byte unchanged procedural behavior.
export function startHeld(e, weaponId) {
  if (!hasHeldSfx(weaponId) || !e.ready) return null;
  const loopStop = playOverrideLoop(e, e.sfx, weaponId, 'fire');
  if (loopStop) return loopStop;
  const layers = e.getSfxParams(weaponId).fire;
  if (!layers || !layers.length) return null;
  return startLoopLayers(e, e.sfx, layers);
}

// ── Per-projectile in-flight loop (#56) — missiles/lobbed weapons get a continuous
// trajectory cue for the round's actual flight time instead of one fixed-duration one-shot.
// Reuses the weapon's existing `trajectory` layers (looped, gain scaled down since several
// can play at once — e.g. Swarm Rack's 6 simultaneous missiles) rather than a new data table.
export function startTrajectory(e, weaponId) {
  const layers = e.getSfxParams(weaponId).trajectory;
  if (!layers || !layers.length || !e.ready) return null;
  return startLoopLayers(e, e.sfx, layers, TRAJECTORY_LOOP_GAIN_SCALE);
}

// ── UI/menu/pickup cues (#178) — small procedural stubs for events that had ZERO audio
// before: equipping a weapon into a garage slot, committing to Deploy, menu
// navigation (tab switching, catalog hover, skill-tile focus), the two arena pickup types
// (SCRAP, POWERUP), and (#188) toggling Sprint on/off. Each is registered as an
// `(id, 'play')` pair in sfxDomains.js's `ui` domain so the owner's generalized tuner panel
// (#177) can override/bake a real file over it later; until then uiCue() below plays these
// procedural fallbacks straight (through the SAME override/bake lookup every weapon stage
// already goes through, via playOverride in this file).
function equipCue(e) {                                    // confident mechanical "clunk-click"
  e.noise(e.sfx, { dur: 0.05, gain: 0.22, type: 'lowpass', freq: 1600, freqEnd: 300, attack: 0.001 });
  e.tone(e.sfx, { type: 'square', freq: 220, freqEnd: 110, dur: 0.07, gain: 0.14, attack: 0.001 });
}
function deployCue(e) {                                    // weightier rising anticipation whoosh
  e.noise(e.sfx, { dur: 0.42, gain: 0.20, type: 'bandpass', freq: 250, freqEnd: 1400, q: 0.5, attack: 0.02 });
  e.tone(e.sfx, { type: 'sawtooth', freq: 140, freqEnd: 360, dur: 0.4, gain: 0.16, attack: 0.02 });
  e.tone(e.sfx, { type: 'sine', freq: 620, dur: 0.12, gain: 0.08, attack: 0.28 });   // brief confirm chime at the crest
}
function menuNavCue(e) {                                   // very short/quiet — fires often, must not annoy
  e.tone(e.sfx, { type: 'sine', freq: 900, freqEnd: 1100, dur: 0.035, gain: 0.05, attack: 0.001 });
}
function scrapPickupCue(e) {                                // currency-ish coin/chime
  e.tone(e.sfx, { type: 'square', freq: 1100, dur: 0.06, gain: 0.10, attack: 0.001 });
  e.tone(e.sfx, { type: 'sine', freq: 1650, freqEnd: 2200, dur: 0.14, gain: 0.09, attack: 0.005 });
}
// #196: the old single shared powerupPickupCue is now a shared BASE synth reused by 5
// independently-tunable per-powerup cues (one per src/data/powerups.js POWERUP id), so the
// owner's tuner panel can override/bake each buff's "acquired" cue separately. Each variant
// just offsets the base's pitch (a `semitones` shift) so the five stay a recognizable family
// while remaining distinct — a cheap way to give each powerup its own flavor without hand-
// writing 5 unrelated synthesis recipes.
function powerupPickupBaseCue(e, semitones = 0) {
  const mult = Math.pow(2, semitones / 12);
  e.tone(e.sfx, { type: 'sine', freq: 500 * mult, freqEnd: 1000 * mult, dur: 0.22, gain: 0.12, attack: 0.01 });
  e.tone(e.sfx, { type: 'sine', freq: 750 * mult, freqEnd: 1500 * mult, dur: 0.22, gain: 0.09, attack: 0.01 });
}
function powerupPickupOverchargeCue(e) { powerupPickupBaseCue(e, 3); }    // brighter/urgent (unlimited ammo)
function powerupPickupOverdriveCue(e) { powerupPickupBaseCue(e, 6); }     // higher still (faster fire rate)
function powerupPickupOverclockCue(e) { powerupPickupBaseCue(e, -2); }    // slightly lower (speed/sprint)
function powerupPickupArmorPatchCue(e) { powerupPickupBaseCue(e, -6); }   // lower/warmer (repair, defensive)
function powerupPickupShieldCue(e) { powerupPickupBaseCue(e, -4); }       // lower (protective, defensive)
// #188: Sprint engage/disengage — reuses the old jump-jet dash's "thruster burst" character
// for engaging (a rising filtered-noise whoosh + pitch lift reads as "powering up"), with a
// quick falling-pitch version for disengaging (mirrors equip's confident-vs-lighter
// pairing).
function sprintOnCue(e) {
  e.noise(e.sfx, { dur: 0.3, gain: 0.18, type: 'bandpass', freq: 400, freqEnd: 1800, q: 0.6, attack: 0.01 });
  e.tone(e.sfx, { type: 'sawtooth', freq: 180, freqEnd: 520, dur: 0.26, gain: 0.07 });
}
function sprintOffCue(e) {
  e.noise(e.sfx, { dur: 0.14, gain: 0.12, type: 'bandpass', freq: 1200, freqEnd: 400, q: 0.6, attack: 0.005 });
  e.tone(e.sfx, { type: 'sawtooth', freq: 420, freqEnd: 160, dur: 0.12, gain: 0.05 });
}
// #201: three new independently-tunable cues replacing generic `Audio.explosion(...)` calls at
// specific combat/run moments (see combat.js/run.js for the call sites). Each is deliberately
// distinct in character/severity so the three read as different EVENTS, not the same boom at
// different volumes:
//   - partDestroyed: a small/light metallic break-off crack — quick, high-ish, no boom.
//   - mechDestroyed: the most severe/final of the three — a low, sustained double-hit boom
//     with a falling rumble tail, reading as "catastrophic and over."
//   - runLost: a somber descending brass/drone-like defeat cue, distinct in TIMBRE (not another
//     explosion) since it fires a beat later during the run-over transition, not at the kill.
function partDestroyedCue(e) {                              // light metallic break-off crack
  e.noise(e.sfx, { dur: 0.07, gain: 0.16, type: 'highpass', freq: 900, freqEnd: 1400, attack: 0.001 });
  e.tone(e.sfx, { type: 'square', freq: 340, freqEnd: 160, dur: 0.09, gain: 0.13, attack: 0.001 });
}
function mechDestroyedCue(e) {                               // severe/final catastrophic boom
  e.noise(e.sfx, { dur: 0.5, gain: 0.30, type: 'lowpass', freq: 500, freqEnd: 70, attack: 0.002 });
  e.tone(e.sfx, { type: 'sawtooth', freq: 90, freqEnd: 30, dur: 0.6, gain: 0.24, attack: 0.005 });
  e.tone(e.sfx, { type: 'sine', freq: 55, freqEnd: 22, dur: 0.75, gain: 0.20, attack: 0.05 });   // low rumble tail
}
function runLostCue(e) {                                     // somber descending defeat drone
  e.tone(e.sfx, { type: 'sawtooth', freq: 220, freqEnd: 110, dur: 0.5, gain: 0.14, attack: 0.03 });
  e.tone(e.sfx, { type: 'sine', freq: 165, freqEnd: 82, dur: 0.7, gain: 0.16, attack: 0.05 });
  e.tone(e.sfx, { type: 'sine', freq: 110, freqEnd: 55, dur: 0.9, gain: 0.12, attack: 0.1 });
}

export const UI_CUES = {
  equip: equipCue,
  deploy: deployCue,
  menuNav: menuNavCue,
  scrapPickup: scrapPickupCue,
  powerupPickupOvercharge: powerupPickupOverchargeCue,
  powerupPickupOverdrive: powerupPickupOverdriveCue,
  powerupPickupOverclock: powerupPickupOverclockCue,
  powerupPickupArmorPatch: powerupPickupArmorPatchCue,
  powerupPickupShield: powerupPickupShieldCue,
  sprintOn: sprintOnCue,
  sprintOff: sprintOffCue,
  partDestroyed: partDestroyedCue,
  mechDestroyed: mechDestroyedCue,
  runLost: runLostCue,
};

// Generic (id, stage) UI/pickup sound dispatch — file override/bake takes precedence (same
// playOverride helper every weapon stage uses), falling back to the procedural stub above.
export function uiCue(e, id, stage = 'play') {
  if (playOverride(e, e.sfx, id, stage)) return;
  UI_CUES[id]?.(e);
}

// ── One-shot cues (no variants). ────────────────────────────────────────────────────────
// Footfall (#34) — a heavy low thud; alternating feet shift pitch slightly. Throttled so a
// fast gait can't machine-gun the sound (throttle state lives on the engine).
export function footstep(e, foot = 0) {
  const t = e._now();
  if (t - e._lastStepSound < 0.07) return;
  e._lastStepSound = t;
  e.tone(e.sfx, { type: 'sine', freq: foot ? 78 : 66, freqEnd: 38, dur: 0.16, gain: 0.30, attack: 0.002 });
  e.noise(e.sfx, { dur: 0.09, gain: 0.08, type: 'lowpass', freq: 320 }); // dirt/servo crunch
}

// Explosion (#36, tunable data per #100) — a broken-off part / the player's own MECH DOWN.
// `scale` 0.3..1.6 sizes the blast (a couple of fixed intensities — #107 moved the actual
// per-KILL boom, which used to drive this via `deathScaleFor`, onto the discrete category path
// below instead). The cue's BASE sound lives in sfxParams.js's `deathExplosion` entry (same
// tunable-layer table every weapon's sound uses), so it's editable through the identical
// getSfxParams/setSfxParam/resetSfxParams plumbing. `scale` additionally reshapes each layer at
// trigger time via `scaleExplosionLayer` (sfxParams.js): louder, longer (more sustain = more
// "boominess"), and pitched DOWN (lower frequency = more bass/boomy) for a bigger blast.
export function explosion(e, scale = 1) {
  const s = clamp(scale, 0.3, 1.6);
  const layers = e.getSfxParams('deathExplosion').fire;
  playLayers(e, e.sfx, layers.map((l) => scaleExplosionLayer(l, s)));
}

// Destruction explosion (#100), made tunable per discrete SIZE CATEGORY by #107 — the per-kill
// boom (`scenes/arena/combat.js` `_deathFx`) instead of continuously rescaling one param set.
// `category` is one of EXPLOSION_CATEGORIES (small/medium/large/massive — see
// `explosionCategoryFor`, scenes/arena/shared.js); each has its OWN independently tunable
// DEFAULT_SFX entry (`deathExplosionSmall` etc., sfxParams.js), so this is just the generic
// layer player every weapon sound cue already uses, keyed by `explosionSfxId(category)`.
export function deathExplosionByCategory(e, category) {
  const id = explosionSfxId(category);
  if (playOverride(e, e.sfx, id, 'fire')) return;
  playLayers(e, e.sfx, e.getSfxParams(id).fire);
}
