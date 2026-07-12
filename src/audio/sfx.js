// Gameplay SFX — the procedural cues for firing, impacts, abilities, footfalls, and
// explosions, factored out of AudioEngine. Weapon fire/trajectory/impact cues are DATA (a
// per-weapon table of tunable layers in sfxParams.js, edited live by the Weapon Lab sound
// panel) played back by the generic playLayers() — **add/retune a weapon's sound = edit its
// entry in sfxParams.js, not a new function.** Ability/footstep/explosion cues are still
// small dedicated functions; they're not weapon-specific. The engine keeps the public
// facade (guards + `_resume`) and delegates here.
import { playLayers, startLoopLayers } from './sfxLayers.js';
import { hasHeldSfx, scaleExplosionLayer, explosionSfxId } from './sfxParams.js';
import { getOverride, getTrimMs, getStartMs, getProcessing } from './sfxOverrides.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Dial the one-shot trajectory cue's gain down for the sustained loop — up to 6 can play at
// once (Swarm Rack); tune here.
const TRAJECTORY_LOOP_GAIN_SCALE = 0.6;

// #150: at each one-shot choke point, a real loaded file (Weapon Lab sound panel) takes
// priority over the procedural layers for that weapon+stage. `getOverride` is a synchronous
// in-memory lookup (null until a file's been loaded+decoded for this weaponId/stage, which is
// the common case for every weapon that's never touched the feature), so this is a strict
// no-op — same node graph, same behavior — whenever no override exists. Returns true if it
// played the override (so callers skip the procedural fallback), false otherwise.
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

// #166: non-destructive start/end pair — `getStartMs`/`getTrimMs` are the same kind of
// synchronous no-await lookup, null unless set for this weapon+stage. `startMs` becomes the
// `offset` arg (skip ahead into the buffer before playback begins) and `trimMs` becomes the
// `duration` arg (how long to play FROM that new start point, not from the original file
// start) to AudioBufferSourceNode.start(when, offset, duration); the buffer itself is never
// sliced/copied, so both stay purely scheduling parameters, instantly adjustable/reversible.
//
// #172: non-destructive PROCESSING chain layered on top — pitch/rate (a `detune` on the source
// node, pitch+speed coupled), a BiquadFilter, and a wet/dry reverb, read via getProcessing().
// Chain order: source (with #166 offset/duration + detune) → [filter] → [reverb wet/dry] → bus
// (the existing sfx gain) → output. Each stage is inserted ONLY when its param is non-neutral,
// so an override with no processing set builds the exact same `source → bus` graph as before —
// a strict clean passthrough, no regression.
function playOverride(e, bus, weaponId, stage) {
  const buffer = getOverride(weaponId, stage);
  if (!buffer || !e.ctx) return false;
  const ctx = e.ctx;
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  // #172: assemble the processing chain from src outward; `tail` is whatever the next node
  // should connect FROM. Neutral/absent params add nothing, leaving src → bus untouched.
  const proc = getProcessing(weaponId, stage);
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
  if (proc?.reverbMix > 0) connectReverb(ctx, tail, bus, proc.reverbMix, proc.reverbSize);
  else tail.connect(bus);

  const startMs = getStartMs(weaponId, stage);
  const trimMs = getTrimMs(weaponId, stage);
  const offsetSec = (startMs ?? 0) / 1000;
  if (startMs == null && trimMs == null) src.start(e._now());
  else if (trimMs != null) src.start(e._now(), offsetSec, trimMs / 1000);
  else src.start(e._now(), offsetSec);
  return true;
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
export function startHeld(e, weaponId) {
  if (!hasHeldSfx(weaponId) || !e.ready) return null;
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

// ── Ability cues (jump-jet dash vs. bubble-shield raise). ───────────────────────────────
function dashCue(e) {                                      // thruster burst: rising filtered noise + pitch lift
  e.noise(e.sfx, { dur: 0.3, gain: 0.18, type: 'bandpass', freq: 400, freqEnd: 1800, q: 0.6, attack: 0.01 });
  e.tone(e.sfx, { type: 'sawtooth', freq: 180, freqEnd: 520, dur: 0.26, gain: 0.07 });
}
function shieldCue(e) {                                    // shimmering power-up: two detuned bell tones
  e.tone(e.sfx, { type: 'sine', freq: 520, freqEnd: 780, dur: 0.5, gain: 0.10, attack: 0.02 });
  e.tone(e.sfx, { type: 'sine', freq: 523, freqEnd: 784, dur: 0.5, gain: 0.08, attack: 0.02 });
}

export const ABILITY_CUES = { dash: dashCue, shield: shieldCue };

export function ability(e, kind) {
  ABILITY_CUES[kind]?.(e);
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
  playLayers(e, e.sfx, e.getSfxParams(explosionSfxId(category)).fire);
}
