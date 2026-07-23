// #479 — the player mech's GAIT cues, SYNTHESISED then BAKED to a buffer. Zero-asset house style:
// NOT recorded audio files (unlike the Helton-Yan bakes in bakedSfx.js), and NOT live-synth-per-
// play (unlike the older footstep/UI stubs in sfx.js) — each cue is procedurally synthesised ONCE
// into an in-memory AudioBuffer at boot (rendered through an OfflineAudioContext), then played back
// as a decoded buffer through the EXACT same multi-variant baked-pool mechanism as bakedSfx.js's
// mechDestroyed pool (bakedSfx.pickBakedVariant). These entries are spread straight into BAKED_SFX
// there, so they decode, cache, resolve and play with zero new playback code.
//
// Two DISTINCT cues, distinct character AND distinct stride moment (see scenes/arena/locomotion.js
// `_stepGait` for the phase clock they hang off):
//   footstep  — the foot-plant IMPACT: a heavy low sine thud (glides down to a sub thump) plus a
//               short lowpassed dirt/servo crunch. Fires on the stride PLANT (phase 0 / 0.5, the
//               two legs-neutral crossings where the body bob bottoms out onto the foot).
//   legLift   — the LEG-MOVEMENT servo/hydraulic swing of a limb picking up: a RISING airy
//               bandpassed whir + a light rising sawtooth actuator motor + a faint high servo tick.
//               Higher, quieter and shorter than the thud (a texture, not an accent). Fires on the
//               OPPOSITE stride phase (peak swing, phase 0.25 / 0.75, where the legs are maximally
//               split and the body bob is at its HIGHEST — the machine picking itself up), so the
//               servo-whir and the foot-thud ALTERNATE every quarter-cycle instead of firing together.
//
// Each cue is a POOL of several randomised variants (same as mechDestroyed's 4-variant pool) so a
// walk cycle never machine-guns one identical sample — playback picks uniformly at random. The
// variants are generated with a deterministic seeded jitter so the shipped set is stable/testable.

// A tiny deterministic PRNG (LCG) — seeded per pool so the baked variant set is reproducible
// across boots/builds (a variant's synth params never drift between runs) while still spreading
// each variant's pitch/tone/gain apart from its siblings.
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// One foot-plant variant: a low sine thud (fast pitch-drop to a sub thump) + a lowpassed crunch.
// Mirrors the original hardcoded footstep synth (sfx.js), with per-variant jitter so consecutive
// planted feet differ. `rnd` is the pool's shared PRNG.
function footstepVariant(rnd) {
  return {
    durMs: 180,
    layers: [
      { kind: 'tone', type: 'sine', freq: 60 + rnd() * 20, freqEnd: 34 + rnd() * 8, dur: 0.16, gain: 0.26 + rnd() * 0.07, attack: 0.002 },
      { kind: 'noise', type: 'lowpass', freq: 270 + rnd() * 100, dur: 0.09, gain: 0.06 + rnd() * 0.035, attack: 0.002 },
    ],
  };
}

// One leg-lift variant: a rising servo/hydraulic whir (bandpassed noise sweeping UP) + a light
// rising sawtooth actuator motor + a faint high servo tick at the top of the lift. Deliberately
// higher, quieter (~0.15x the thud's level) and shorter than the footstep so two cues a stride at
// ~215ms cadence reads as machine TEXTURE under the plant, not a second competing accent.
function legLiftVariant(rnd) {
  return {
    durMs: 150,
    layers: [
      { kind: 'noise', type: 'bandpass', freq: 820 + rnd() * 200, freqEnd: 1480 + rnd() * 320, q: 1.1 + rnd() * 0.5, dur: 0.13, gain: 0.040 + rnd() * 0.020, attack: 0.008 },
      { kind: 'tone', type: 'sawtooth', freq: 270 + rnd() * 70, freqEnd: 480 + rnd() * 140, dur: 0.11, gain: 0.030 + rnd() * 0.016, attack: 0.006 },
      { kind: 'tone', type: 'sine', freq: 1550 + rnd() * 350, dur: 0.05, gain: 0.016 + rnd() * 0.012, attack: 0.004 },
    ],
  };
}

// Build a variant POOL: `n` recipe objects, each wrapped as a BAKED_SFX synth entry (`{ synth }`,
// the shape bakedSfx.loadAllBaked renders offline instead of fetch/decoding an asset).
function makePool(variantFn, n, seed) {
  const rnd = lcg(seed);
  return Array.from({ length: n }, () => ({ synth: variantFn(rnd) }));
}

const VARIANTS = 4;

// The gait pools, keyed `id::stage` exactly like every other BAKED_SFX entry — `play` is the
// single stage these `ui`-domain cues use (sfxDomains.js). Spread into BAKED_SFX by bakedSfx.js.
export const GAIT_SFX_ENTRIES = {
  'footstep::play': makePool(footstepVariant, VARIANTS, 0x1a2b3c),
  'legLift::play': makePool(legLiftVariant, VARIANTS, 0x77c5e9),
};

// A 1s white-noise buffer for an OfflineAudioContext's noise voices (mirrors AudioEngine._noise).
function makeNoise(octx) {
  const n = octx.sampleRate;
  const buf = octx.createBuffer(1, n, n);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// Schedule one synth layer at t=0 into the offline context. Same primitive shapes as
// AudioEngine.tone()/noise(): an oscillator or a filtered noise burst, each with a fast
// exponential attack then an exponential decay to silence over `dur`.
function renderLayer(octx, layer, noiseBuf) {
  const { kind, type = 'sine', freq = 440, freqEnd, dur = 0.15, gain = 0.3, attack = 0.004, q = 0.8 } = layer;
  if (gain <= 0) return;
  const g = octx.createGain();
  g.gain.setValueAtTime(0.0001, 0);
  g.gain.exponentialRampToValueAtTime(gain, attack);
  g.gain.exponentialRampToValueAtTime(0.0001, dur);
  g.connect(octx.destination);
  if (kind === 'noise') {
    const src = octx.createBufferSource();
    src.buffer = noiseBuf;
    const f = octx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(Math.max(40, freq), 0);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), dur);
    f.Q.value = q;
    src.connect(f).connect(g);
    src.start(0); src.stop(dur + 0.03);
  } else {
    const o = octx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, freq), 0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), dur);
    o.connect(g);
    o.start(0); o.stop(dur + 0.03);
  }
}

// Render a synth recipe to a mono AudioBuffer via an OfflineAudioContext. Async (startRendering
// returns a promise). Throws if there's no OfflineAudioContext (node/jsdom test env, or a very old
// browser) — bakedSfx.loadAllBaked catches that per-entry, leaving the slot empty so the cue falls
// back to the live procedural stub in sfx.js, exactly like an asset that failed to decode.
export async function renderSynthBuffer(recipe, sampleRate = 48000) {
  const OAC = typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext
    : (typeof webkitOfflineAudioContext !== 'undefined' ? webkitOfflineAudioContext : null);
  if (!OAC) throw new Error('no OfflineAudioContext');
  const rate = sampleRate || 48000;
  const tailSec = 0.05;
  const lengthSamples = Math.max(1, Math.ceil((recipe.durMs / 1000 + tailSec) * rate));
  const octx = new OAC(1, lengthSamples, rate);
  const noiseBuf = makeNoise(octx);
  for (const layer of recipe.layers) renderLayer(octx, layer, noiseBuf);
  return octx.startRendering();
}
