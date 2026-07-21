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
  getRetriggerMs, pickOverrideStage,
} from './sfxOverrides.js';
import { pickBakedVariant } from './bakedSfx.js';
import { distanceGain, stereoPan } from '../data/positionalAudio.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// #264 — positional audio: given an optional `{ x, y, listenerX, listenerY }` world-position
// pair, insert a per-cue GainNode (real distance falloff, data/positionalAudio.js's
// distanceGain) + StereoPannerNode (left/right pan, stereoPan) between the cue's own nodes and
// `bus`, and return that new head node for the caller to connect into INSTEAD of `bus`
// directly. Any half of the pair missing (no pos passed at all, or a caller that only knows
// its own position and not the listener's) is a strict no-op — returns `bus` unchanged, so
// today's behavior (full volume, centered) is exactly preserved for every call site that
// doesn't yet pass a position. `createStereoPanner` is guarded too, so a context that somehow
// lacks it (very old browser, or a minimal test mock) still gets real distance falloff, just
// without panning, rather than throwing.
function positionalBus(e, bus, pos) {
  if (!pos || !e.ctx || pos.x == null || pos.y == null || pos.listenerX == null || pos.listenerY == null) {
    return bus;
  }
  const gain = distanceGain(pos.x, pos.y, pos.listenerX, pos.listenerY);
  const pan = stereoPan(pos.x, pos.y, pos.listenerX, pos.listenerY);
  const g = e.ctx.createGain();
  g.gain.value = gain;
  if (typeof e.ctx.createStereoPanner === 'function') {
    const p = e.ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(bus);
  } else {
    g.connect(bus);
  }
  return g;
}

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
// bake — then a BAKED asset (bakedSfx.js), then (by returning null here) the caller's procedural
// fallback. Both buffer sources schedule through the shared playBuffer above, so the #166 trim +
// #172 processing recipe applies identically to either. In a shipped build there are no
// IndexedDB overrides, so this is effectively baked-then-procedural.
// #195: RANDOMIZED VARIANTS — a stage's override/bake can hold up to MAX_VARIANTS (10, #209)
// parallel variant slots
// instead of just one (see sfxOverrides.js's/bakedSfx.js's module headers); every play resolves
// WHICH one via pickOverrideStage/pickBakedVariant, uniform random among however many are
// currently loaded. `pickOverrideStage` returns null when there's no live override at all for
// this stage (any variant) — same "fall through to bake" behavior as before this feature. A
// pool of exactly 1 (every stage that predates #195) always resolves to `stage` itself, so this
// is byte-identical to the pre-#195 single-variant precedence/behavior in that case.
//
// #185 rework: this used to be duplicated between the one-shot path (playOverride) and the
// held-loop path (playOverrideLoop). Both paths (one-shot and #267's real held loop) want the
// exact same resolved recipe, so the lookup/precedence logic lives here once. Returns null when
// neither an override nor a bake exists for this (weaponId, stage) — caller falls back to
// procedural. `loopStartMs` (via getLoopStartMs — falls back to `startMs` when unset) is only
// meaningful to the held-loop path (startOverrideLoop below); the one-shot path (playOverride)
// simply ignores the extra field.
function resolveBufferSource(weaponId, stage) {
  const pickedStage = pickOverrideStage(weaponId, stage);
  if (pickedStage != null) {
    const override = getOverride(weaponId, pickedStage);
    if (override) {
      return {
        buffer: override,
        startMs: getStartMs(weaponId, pickedStage),
        trimMs: getTrimMs(weaponId, pickedStage),
        proc: getProcessing(weaponId, pickedStage),
        fadeOutMs: getFadeOutMs(weaponId, pickedStage),
        volume: getVolume(weaponId, pickedStage),
        loopStartMs: getLoopStartMs(weaponId, pickedStage),
        retriggerMs: getRetriggerMs(weaponId, pickedStage),
      };
    }
  }
  const baked = pickBakedVariant(weaponId, stage);
  if (baked) {
    return {
      buffer: baked.buffer, startMs: baked.startMs, trimMs: baked.trimMs,
      proc: baked.processing, fadeOutMs: baked.fadeOutMs, volume: baked.volume,
      loopStartMs: baked.loopStartMs, retriggerMs: baked.retriggerMs,
    };
  }
  return null;
}

// #200: `gainScale` (default 1) multiplies the resolved override/bake's own volume — same
// uniform-reduction knob playLayers grew for the procedural path, applied here so a buffer-
// backed cue (a dev override or a shipped bake) gets quieted down identically instead of only
// affecting weapons that still fall through to procedural synthesis.
function playOverride(e, bus, weaponId, stage, gainScale = 1) {
  const resolved = resolveBufferSource(weaponId, stage);
  if (!resolved) return false;
  const vol = (resolved.volume != null ? resolved.volume : 1) * gainScale;
  return playBuffer(e, bus, resolved.buffer, resolved.startMs, resolved.trimMs, resolved.proc, resolved.fadeOutMs, vol);
}

// #267: a small attack ramp for the loop's start, mirroring startLoopLayers' click-safety floor
// (sfxLayers.js's MIN_ATTACK) — an instant 0->gain jump on a continuous source pops.
const LOOP_ATTACK_SEC = 0.01;
// #267: fallback release length (ms) when a loop with no fadeOutMs set is released via stopHeld —
// same window sfxLayers.js's HELD_RELEASE uses for the procedural held path, so an untuned loop
// still ramps down cleanly instead of clicking.
const LOOP_RELEASE_DEFAULT_MS = 80;

// #267 (supersedes the #185 rework below): playtest feedback on the shipped #185 behavior — "it
// plays it once instead of for each flare or whatever, and then it keeps playing the procedural
// sound afterward" (#267) — was that a one-shot intro handing off to a DIFFERENT, procedurally
// synthesized sustain reads as broken, not as a fix. The genuine problem #185 was solving (a
// crossfaded REPEAT of the same recording has an audible seam) doesn't apply to a native
// AudioBufferSourceNode loop with a real loop POINT — `.loopStart`/`.loopEnd` wrap the source
// back into the middle of its own already-playing waveform with no re-trigger at all, so there's
// no seam to click against as long as the loop region itself doesn't start/end on a transient
// (the whole reason `loopStartMs` exists: skip past a non-repeatable "wind-up" attack into a
// steady middle region before the wraps begin).
//
// The model: the buffer plays from `startMs` (offset) same as before; if `.loop` is set, once
// playback reaches `loopEnd` it wraps back to `loopStart` (NOT to `startMs`) and keeps going
// indefinitely — so a "wind-up" intro from `startMs` to `loopStart` plays exactly once, then only
// the `loopStart`..`loopEnd` region repeats, for as long as the trigger is held. `loopStartMs`
// unset (the common case — most existing overrides predate this field's revival) falls back to
// `startMs` via getLoopStartMs(), so the ENTIRE trimmed window becomes the loop region — a
// reasonable default, and strictly better than #185's one-shot-then-procedural-handoff.
//
// #185's older rework note (superseded): "there's no clean loop point in the recorded source
// files at all... every handoff, however short, still pulses" — that was about looping a REPEAT
// of a segment via manual re-triggering/crossfading, an artifact-prone scheme this function no
// longer uses. A native loop of a properly-authored region (even the whole trimmed clip) has no
// re-trigger boundary to click against.
// #267 follow-up: opt-in OVERLAPPING RETRIGGER mode, keyed by `retriggerMs` on the resolved
// override/bake recipe (sfxOverrides.js's getRetriggerMs / bakedSfx.js's per-entry field). #267's
// single continuous native loop above reads as one seamless sustained tone — right for a beam
// weapon, but playtest feedback specifically on the flamethrower (a rapid-fire spray, not a
// sustained beam) was that the fire sound should retrigger MORE OFTEN while held, with each new
// play OVERLAPPING the previous instance (layered), instead of one tone that just wraps at a loop
// point. Rather than build a second competing lifecycle, this reuses the exact same playBuffer
// chain every one-shot cue already uses — each retrigger is its own independent instance with its
// own attack/gain/processing/fade, deliberately never stopped early (an instance still ringing
// when the next one fires is exactly the "overlapping/layered" effect being asked for). Returns a
// stop() closure like every other held-cue starter; on release it only stops SCHEDULING new
// instances — whatever's already playing rings out on its own envelope (trim/fadeOutMs), since
// with retriggering there's no single sustained tone that needs an explicit release fade.
function startOverrideRetrigger(e, bus, resolved, retriggerMs) {
  const { buffer, startMs, trimMs, proc, fadeOutMs, volume } = resolved;
  if (!buffer || !e.ctx) return null;
  let stopped = false;
  const spawn = () => {
    if (stopped || !e.ctx) return;
    playBuffer(e, bus, buffer, startMs, trimMs, proc, fadeOutMs, volume);
  };
  spawn(); // the first instance plays immediately on trigger-down, same moment the single-loop path starts
  const timer = setInterval(spawn, retriggerMs);
  return function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

function startOverrideLoop(e, bus, resolved, layers) {
  const { buffer, startMs, trimMs, proc, fadeOutMs, volume, loopStartMs, retriggerMs } = resolved;
  if (!buffer || !e.ctx) return layers && layers.length ? startLoopLayers(e, bus, layers) : null;
  // #267 follow-up: retriggerMs opts a weapon/bake OUT of the single continuous loop below and
  // INTO the overlapping-retrigger mode instead. Unset/absent (every override/bake before this
  // field existed, and every weapon that hasn't opted in) falls straight through to the exact
  // #267 single-loop behavior beneath this check — a strict no-op for the common case.
  if (retriggerMs > 0) return startOverrideRetrigger(e, bus, resolved, retriggerMs);
  const ctx = e.ctx;
  const offsetSec = (startMs ?? 0) / 1000;
  // Loop start: the authored loopStartMs (getLoopStartMs already falls back to startMs when
  // unset), so an unconfigured loop point loops the whole startMs..loopEnd window (item 2's
  // fallback). Loop end: startMs + trimMs (the trimmed window's own end) when trimMs is set,
  // otherwise 0 — the Web Audio spec treats a loopEnd of 0 (or <= loopStart) as "the buffer's own
  // end," so an untrimmed override/bake loops to its natural end, same convention playBuffer's
  // own trim/no-trim distinction uses.
  const loopStartSec = (loopStartMs ?? startMs ?? 0) / 1000;
  const loopEndSec = trimMs != null ? ((startMs ?? 0) + trimMs) / 1000 : 0;

  const vol = volume != null ? volume : 1;
  const target = vol > 0 ? vol : 0.0001;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
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

  // Gain node carries the loop's start attack and (on release) the fade-out ramp — same role
  // playBuffer's own fade-out node serves for the one-shot path.
  const g = ctx.createGain();
  const startAt = e._now();
  g.gain.setValueAtTime(0.0001, startAt);
  g.gain.exponentialRampToValueAtTime(target, startAt + LOOP_ATTACK_SEC);
  tail.connect(g);
  tail = g;

  if (proc?.reverbMix > 0) connectReverb(ctx, tail, bus, proc.reverbMix, proc.reverbSize);
  else tail.connect(bus);

  // Native looping (#267): set loop + loop-region BEFORE start() so the very first playthrough
  // already knows where to wrap. No `duration` arg to start() — passing one would schedule a
  // hard stop at that time regardless of `.loop`, defeating the whole point. Playback keeps going
  // until this cue's own stop() below calls src.stop() explicitly (on release).
  src.loop = true;
  src.loopStart = loopStartSec;
  src.loopEnd = loopEndSec;
  src.start(startAt, offsetSec);

  let stopped = false;
  return function stop() {
    if (stopped) return;
    stopped = true;
    const now = e.ctx ? e._now() : startAt;
    const releaseSec = (fadeOutMs > 0 ? fadeOutMs : LOOP_RELEASE_DEFAULT_MS) / 1000;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
    g.gain.linearRampToValueAtTime(0, now + releaseSec);
    try { src.stop(now + releaseSec + 0.02); } catch { /* already stopped */ }
    setTimeout(() => {
      try { src.disconnect(); filter?.disconnect(); g.disconnect(); } catch { /* already gone */ }
    }, (releaseSec + 0.05) * 1000);
  };
}

// #200: `gainScale` (default 1, i.e. unchanged) lets a caller uniformly quiet this cue.
// #264: `pos` (default null, i.e. unchanged) is the optional `{ x, y, listenerX, listenerY }`
// world-position pair for REAL distance falloff + stereo pan (see positionalBus above) —
// this is what replaced the old flat ENEMY_FIRE_GAIN_SCALE approximation. Both threads through
// the buffer-override/bake path and the procedural-layers fallback so they apply no matter
// which one actually plays.
export function fire(e, weapon, gainScale = 1, pos = null) {
  const bus = positionalBus(e, e.sfx, pos);
  if (playOverride(e, bus, weapon.id, 'fire', gainScale)) return;
  playLayers(e, bus, e.getSfxParams(weapon.id).fire, gainScale);
}

export function trajectory(e, weaponId, gainScale = 1, pos = null) {
  const bus = positionalBus(e, e.sfx, pos);
  if (playOverride(e, bus, weaponId, 'trajectory', gainScale)) return;
  const p = e.getSfxParams(weaponId);
  if (p.trajectory) playLayers(e, bus, p.trajectory, gainScale);
}

export function impact(e, weaponId, pos = null) {
  const bus = positionalBus(e, e.sfx, pos);
  if (playOverride(e, bus, weaponId, 'impact')) return;
  playLayers(e, bus, e.getSfxParams(weaponId).impact);
}

// ── Held/looping fire sound (#53) — flamethrower/beamLaser use ONE continuous source
// instead of a retriggered one-shot burst every cadence tick (see sfxLayers.js's
// startLoopLayers for the actual node-graph lifecycle). Reuses the weapon's own `fire`
// layers (same live, tunable data the Weapon Lab panel's sliders control) rather than a
// separate table, so tuning `fire` actually retunes what you hear while holding the button.
// Gated on hasHeldSfx — every weapon has `fire` layers now, but only flamethrower/beamLaser
// actually use the held/loop dispatch; everyone else fires one-shots.
//
// #179/#267: before falling back to procedural layers, check for a file override/bake at the
// weapon's `fire` stage (same (id,stage) key `fire()` already reads for its one-shot cue —
// reusing it means no new stage taxonomy, and tuning a weapon's `fire` override/bake retunes both
// the one-shot AND the held loop together). If one exists, it plays for the ENTIRE held duration
// via a genuine native loop (startOverrideLoop above — see its header for the #267 rework this
// replaced #185's one-shot-intro-then-procedural-handoff with). With no override/bake present
// (every weapon before #179, and still most weapons today), resolveBufferSource returns null and
// this falls through to the exact same startLoopLayers call as before — byte-for-byte unchanged
// procedural behavior.
export function startHeld(e, weaponId) {
  if (!hasHeldSfx(weaponId) || !e.ready) return null;
  const layers = e.getSfxParams(weaponId).fire;
  const resolved = resolveBufferSource(weaponId, 'fire');
  if (resolved) return startOverrideLoop(e, e.sfx, resolved, layers);
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
// #196: the old single shared powerupPickupCue is now a shared BASE synth reused by the
// independently-tunable per-powerup cues (one per src/data/powerups.js POWERUP id), so the
// owner's tuner panel can override/bake each buff's "acquired" cue separately. Each variant
// just offsets the base's pitch (a `semitones` shift) so they stay a recognizable family
// while remaining distinct — a cheap way to give each powerup its own flavor without hand-
// writing unrelated synthesis recipes. (#381: Overcharge was folded into every powerup and
// removed, so its cue is gone; the rest are unchanged.)
function powerupPickupBaseCue(e, semitones = 0) {
  const mult = Math.pow(2, semitones / 12);
  e.tone(e.sfx, { type: 'sine', freq: 500 * mult, freqEnd: 1000 * mult, dur: 0.22, gain: 0.12, attack: 0.01 });
  e.tone(e.sfx, { type: 'sine', freq: 750 * mult, freqEnd: 1500 * mult, dur: 0.22, gain: 0.09, attack: 0.01 });
}
function powerupPickupOverdriveCue(e) { powerupPickupBaseCue(e, 6); }     // higher still (faster fire rate)
function powerupPickupOverclockCue(e) { powerupPickupBaseCue(e, -2); }    // slightly lower (speed/sprint)
function powerupPickupArmorPatchCue(e) { powerupPickupBaseCue(e, -6); }   // lower/warmer (repair, defensive)
function powerupPickupShieldCue(e) { powerupPickupBaseCue(e, -4); }       // lower (protective, defensive)
function powerupPickupBarrageCue(e) { powerupPickupBaseCue(e, 9); }       // highest (#137: more shots at once)
function powerupPickupInfiniteFireCue(e) { powerupPickupBaseCue(e, 3); }  // #409: bright, mid-high (free ammo + no reload)
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
//
// #210: `runLost` (a beat-later, losing-only defeat drone) was removed as redundant with
// mechDestroyed. In its place, `returnToGarage` fires at the actual scene-transition moment,
// for BOTH win and loss — a neutral "coming home" beat, deliberately NOT another severity cue
// (mechDestroyed already owns that) and distinct from deploy's outbound departure-energy
// (this is the inverse, settling motion rather than a rising launch).
function partDestroyedCue(e) {                              // light metallic break-off crack
  e.noise(e.sfx, { dur: 0.07, gain: 0.16, type: 'highpass', freq: 900, freqEnd: 1400, attack: 0.001 });
  e.tone(e.sfx, { type: 'square', freq: 340, freqEnd: 160, dur: 0.09, gain: 0.13, attack: 0.001 });
}
function mechDestroyedCue(e) {                               // severe/final catastrophic boom
  e.noise(e.sfx, { dur: 0.5, gain: 0.30, type: 'lowpass', freq: 500, freqEnd: 70, attack: 0.002 });
  e.tone(e.sfx, { type: 'sawtooth', freq: 90, freqEnd: 30, dur: 0.6, gain: 0.24, attack: 0.005 });
  e.tone(e.sfx, { type: 'sine', freq: 55, freqEnd: 22, dur: 0.75, gain: 0.20, attack: 0.05 });   // low rumble tail
}
// #210: neutral "returning home" transition beat — a gentle settling descent (falling pitch,
// soft landing) rather than a defeat drone or a rising launch whoosh, since it fires for a
// win just as much as a loss.
function returnToGarageCue(e) {
  e.noise(e.sfx, { dur: 0.24, gain: 0.10, type: 'lowpass', freq: 900, freqEnd: 300, attack: 0.01 });
  e.tone(e.sfx, { type: 'sine', freq: 340, freqEnd: 220, dur: 0.28, gain: 0.13, attack: 0.01 });
  e.tone(e.sfx, { type: 'sine', freq: 500, freqEnd: 330, dur: 0.2, gain: 0.07, attack: 0.02 }); // soft settling chime
}

export const UI_CUES = {
  equip: equipCue,
  deploy: deployCue,
  returnToGarage: returnToGarageCue,
  menuNav: menuNavCue,
  scrapPickup: scrapPickupCue,
  powerupPickupOverdrive: powerupPickupOverdriveCue,
  powerupPickupOverclock: powerupPickupOverclockCue,
  powerupPickupArmorPatch: powerupPickupArmorPatchCue,
  powerupPickupShield: powerupPickupShieldCue,
  powerupPickupBarrage: powerupPickupBarrageCue,
  powerupPickupInfiniteFire: powerupPickupInfiniteFireCue,
  sprintOn: sprintOnCue,
  sprintOff: sprintOffCue,
  partDestroyed: partDestroyedCue,
  mechDestroyed: mechDestroyedCue,
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

// #269 playtest follow-up — alert tower "spooling up" warning: a periodic radar-style beep,
// re-triggered by the caller (scenes/arena/bases.js `_updateAlertTowers`) on an interval that
// SHRINKS as the countdown nears completion, so the pulse rate itself reads as "quickening,"
// not just a fixed metronome. `fraction` (0 at countdown start -> 1 at completion, see
// data/alertTower.js `tickAlertTower`) also brightens/raises the pitch and adds a touch more
// bite on each successive beep, so a beep heard right before the tower fires reads
// unmistakably more urgent than the first one. No loop/held state here at all — each call is a
// single one-shot cue (like footstep above), so there's nothing to explicitly stop: the caller
// simply stops CALLING this once the countdown cancels or completes (see bases.js), which is
// what "stops cleanly" means for a one-shot-pulse cue instead of a held drone.
// Positional via `pos` (the tower's own world position vs. the player/listener) like every
// other world-anchored cue — see positionalBus above / data/positionalAudio.js.
export function alertPulse(e, fraction, pos = null) {
  const f = clamp(fraction, 0, 1);
  const bus = positionalBus(e, e.sfx, pos);
  const freq = 640 + f * 480;              // rising pitch as it nears completion
  e.tone(bus, { type: 'square', freq, freqEnd: freq * 0.82, dur: 0.085, gain: 0.20 + f * 0.16, attack: 0.002 });
  e.noise(bus, { dur: 0.045, gain: 0.05 + f * 0.09, type: 'highpass', freq: 3400 }); // digital "chirp" edge
}

// #385 — the CONTINUOUS alert siren, for a tower that has already SIGNALED (woken its base) and
// stays live until destroyed. Unlike alertPulse above (a one-shot beep re-fired on a timer while
// the countdown SPOOLS UP), this is a genuinely HELD, looping source — the same held/loop pattern
// as the flamethrower/beam-laser fire loops (startLoopLayers): oscillators left running until an
// explicit stop, so nothing is re-triggered per frame. Only ONE of these ever exists at a time
// (AudioEngine holds a single `_siren` handle); scenes/arena/bases.js picks the nearest
// signaled-alive tower each frame (data/alertTower.js `pickSirenSource`) and steers this one
// voice's POSITION with setSirenPos below — so the voice reassigns to a nearer tower, and tracks
// the moving listener, with no restart. Returns a handle `{ stop, posGain, pan }`; `null` if the
// context isn't up. The wail: two saw voices a fifth apart, their pitch swept up and down by a
// shared slow LFO (an air-raid rise/fall), through a master attack-ramped gain into a persistent
// positional gain(+pan) stage that setSirenPos updates live for distance falloff.
const SIREN_BASE_HZ = 520;      // fundamental of the lower siren voice
const SIREN_WAIL_HZ = 0.55;     // LFO rate — ~one full up/down wail cycle every ~1.8s
const SIREN_WAIL_DEPTH = 90;    // Hz the pitch swings +/- around the base as it wails
const SIREN_GAIN = 0.16;        // master voice gain BEFORE positional distance attenuation
export function startSiren(e) {
  const ctx = e.ctx;
  if (!ctx) return null;
  const t = e._now();
  // Persistent positional stage: distance gain -> optional stereo pan -> sfx bus. setSirenPos
  // writes both live each frame; kept as standing nodes (not rebuilt) so steering the voice never
  // restarts the loop. Starts at unity — setSirenPos on the very next frame sets the real value.
  const posGain = ctx.createGain();
  posGain.gain.value = 1;
  let pan = null;
  if (typeof ctx.createStereoPanner === 'function') {
    pan = ctx.createStereoPanner();
    pan.pan.value = 0;
    posGain.connect(pan).connect(e.sfx);
  } else {
    posGain.connect(e.sfx);
  }
  // Master gain with a short attack ramp (click-safe loop start), feeding the positional stage.
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.exponentialRampToValueAtTime(SIREN_GAIN, t + 0.12);
  master.connect(posGain);
  // The shared wail LFO -> depth gain -> each oscillator's frequency, so both voices rise/fall
  // together like a real siren rather than droning flat.
  const lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = SIREN_WAIL_HZ;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = SIREN_WAIL_DEPTH;
  lfo.connect(lfoDepth);
  const oscs = [];
  for (const [mult, g] of [[1, 0.6], [1.5, 0.4]]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = SIREN_BASE_HZ * mult;
    if (lfoDepth.connect) lfoDepth.connect(osc.frequency);
    const vg = ctx.createGain();
    vg.gain.value = g;
    osc.connect(vg).connect(master);
    osc.start(t);
    oscs.push(osc);
  }
  lfo.start(t);
  let stopped = false;
  // fadeSec: how long the master gain ramps to silence. The default (0.1s) is a click-safe near-
  // instant cut for shutdown / return-to-garage; the tower-DESTRUCTION path (#385) passes a longer
  // value so the wail trails off instead of snapping silent. Oscillators are held a touch past the
  // ramp end, and the node teardown waits until after that, so a long fade is never cut short.
  function stop(fadeSec = 0.1) {
    if (stopped) return;
    stopped = true;
    const now = e.ctx ? e._now() : t;
    const fade = Math.max(0.02, fadeSec);
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + fade);
    const stopAt = now + fade + 0.04;
    for (const osc of oscs) { try { osc.stop(stopAt); } catch { /* already stopped */ } }
    try { lfo.stop(stopAt); } catch { /* already stopped */ }
    setTimeout(() => {
      try {
        for (const osc of oscs) osc.disconnect();
        lfoDepth.disconnect(); lfo.disconnect(); master.disconnect();
        pan?.disconnect(); posGain.disconnect();
      } catch { /* already gone */ }
    }, (fade + 0.1) * 1000);
  }
  return { stop, posGain, pan };
}

// Steer the single live siren voice to a source position for distance falloff (+ stereo pan),
// using the same `{ x, y, listenerX, listenerY }` pair every world-anchored cue takes
// (data/positionalAudio.js). Called every frame with the CURRENT nearest signaled-alive tower —
// so both reassignment (a nearer tower, or the previous one dying) and the moving listener are
// just a new target here, no loop restart. A missing/partial pos is a no-op (leaves the last
// value). `setTargetAtTime` glides to avoid a click when the source jumps between towers.
export function setSirenPos(e, siren, pos) {
  if (!siren || !e.ctx) return;
  if (!pos || pos.x == null || pos.y == null || pos.listenerX == null || pos.listenerY == null) return;
  const now = e._now();
  const gain = distanceGain(pos.x, pos.y, pos.listenerX, pos.listenerY);
  siren.posGain.gain.setTargetAtTime(gain, now, 0.05);
  if (siren.pan) siren.pan.pan.setTargetAtTime(stereoPan(pos.x, pos.y, pos.listenerX, pos.listenerY), now, 0.05);
}

// Explosion (#36, tunable data per #100) — a broken-off part / the player's own MECH DOWN.
// `scale` 0.3..1.6 sizes the blast (a couple of fixed intensities — #107 moved the actual
// per-KILL boom, which used to drive this via `deathScaleFor`, onto the discrete category path
// below instead). The cue's BASE sound lives in sfxParams.js's `deathExplosion` entry (same
// tunable-layer table every weapon's sound uses), so it's editable through the identical
// getSfxParams/setSfxParam/resetSfxParams plumbing. `scale` additionally reshapes each layer at
// trigger time via `scaleExplosionLayer` (sfxParams.js): louder, longer (more sustain = more
// "boominess"), and pitched DOWN (lower frequency = more bass/boomy) for a bigger blast.
export function explosion(e, scale = 1, pos = null) {
  const s = clamp(scale, 0.3, 1.6);
  const bus = positionalBus(e, e.sfx, pos);
  const layers = e.getSfxParams('deathExplosion').fire;
  playLayers(e, bus, layers.map((l) => scaleExplosionLayer(l, s)));
}

// Destruction explosion (#100), made tunable per discrete SIZE CATEGORY by #107 — the per-kill
// boom (`scenes/arena/combat.js` `_deathFx`) instead of continuously rescaling one param set.
// `category` is one of EXPLOSION_CATEGORIES (small/medium/large/massive — see
// `explosionCategoryFor`, scenes/arena/shared.js); each has its OWN independently tunable
// DEFAULT_SFX entry (`deathExplosionSmall` etc., sfxParams.js), so this is just the generic
// layer player every weapon sound cue already uses, keyed by `explosionSfxId(category)`.
export function deathExplosionByCategory(e, category, pos = null) {
  const id = explosionSfxId(category);
  const bus = positionalBus(e, e.sfx, pos);
  if (playOverride(e, bus, id, 'fire')) return;
  playLayers(e, bus, e.getSfxParams(id).fire);
}
