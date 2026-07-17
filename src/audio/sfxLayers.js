// Generic multi-layer SFX player — a "layer" is the data for one e.tone()/e.noise() call.
// Turning each cue into an array of layers (mirroring how music.js turned synth code into a
// tunable data table) is what makes a weapon's sound editable: tune a layer's fields instead
// of hand-editing a hardcoded function. Add/change a sound = edit its layer array.

// #200: optional overall gain multiplier (default 1 = untouched) — lets a caller quiet down
// an entire cue's layers uniformly (e.g. enemy-sourced fire cues, VERY slightly reduced vs.
// the player's own) without retuning each layer's own `gain` field, which stays the shared
// tunable data every weapon/UI cue (and the Weapon Lab panel) reads. gainScale === 1 skips
// the per-layer object spread entirely, so untouched callers build the exact same layer
// objects as before this param existed.
export function playLayers(e, bus, layers, gainScale = 1) {
  for (const l of layers || []) {
    if (!l) continue;
    const layer = gainScale === 1 ? l : { ...l, gain: (l.gain ?? 0.15) * gainScale };
    if (layer.kind === 'noise') e.noise(bus, layer);
    else e.tone(bus, layer);
  }
}

// MIN_ATTACK is just enough ramp to avoid a hard click (an instant 0->gain jump on a
// continuous waveform pops) — everything above that floor comes from the layer's OWN
// `attack` field (the same value its slider shows/controls), so tuning attack to ~0
// actually reads as instant instead of silently landing on a fixed internal ramp.
const MIN_ATTACK = 0.003;    // s, click-safety floor
const HELD_ATTACK_DEFAULT = 0.008; // s, fallback if a layer has no `attack` set
const HELD_RELEASE = 0.08;   // s, gain ramp-down on stop (60-100ms window)

// Optional per-layer START PITCH SWELL: a layer can carry `bend: { to, dur }` to open the
// loop with a brief pitch bend that settles back to the held pitch (the "bwaaah…hhhwww" of a
// beam laser spinning up) instead of a flat hum. `to` is a MULTIPLIER of the layer's base
// `freq` — 1.5 bends up a fifth, 0.75 bends down — and `dur` is the TOTAL bend time in
// seconds (base → to over the first half, back to base over the second). Applied to the
// oscillator's `.frequency` for a tone layer or the biquad filter's `.frequency` for a noise
// layer; after `dur` the frequency holds at base for the rest of the loop. Layers with no
// `bend` field are set to a constant frequency exactly as before. Generic on purpose so the
// flamethrower / missile-in-flight loops can adopt it later.
function scheduleBend(freqParam, base, bend, t) {
  const dur = bend?.dur;
  const mult = bend?.to;
  if (!(dur > 0) || !(mult > 0) || mult === 1) { freqParam.value = base; return; }
  const peak = Math.max(1, base * mult);
  const half = dur / 2;
  // linearRampToValueAtTime is fine here (all endpoints > 0); a linear sweep reads as a
  // smooth swell for these short durations. setValueAtTime anchors the ramp's start.
  freqParam.setValueAtTime(base, t);
  freqParam.linearRampToValueAtTime(peak, t + half);
  freqParam.linearRampToValueAtTime(base, t + dur);
}

// Held/looping counterpart to playLayers() (#53 held fire sounds, #56 in-flight trajectory
// loops): instead of a one-shot decay-to-zero voice per layer, build ONE genuinely continuous
// source per layer — a looping AudioBufferSourceNode through a filter for a noise layer
// (reusing e._noise()'s cached buffer), or a bare OscillatorNode left running for a tone
// layer (oscillators are inherently continuous once started, so "loop" just means "never
// schedule a stop/decay") — ramp its gain up over a short attack, and return a stop()
// closure that ramps down + disconnects every voice. Returns null if `layers` is empty/falsy.
// A layer may add a `bend` field (see scheduleBend) for a start pitch swell.
export function startLoopLayers(e, bus, layers, gainScale = 1) {
  const ctx = e.ctx;
  const t = e._now();
  const voices = [];
  for (const l of layers || []) {
    if (!l) continue;
    const g = ctx.createGain();
    const targetGain = Math.max(0.0001, (l.gain ?? 0.15) * gainScale);
    const attack = Math.max(MIN_ATTACK, l.attack ?? HELD_ATTACK_DEFAULT);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(targetGain, t + attack);
    g.connect(bus);

    const isNoise = l.kind === 'noise';
    const src = isNoise ? ctx.createBufferSource() : ctx.createOscillator();
    let filter;
    if (isNoise) {
      src.buffer = e._noise();
      src.loop = true;
      filter = ctx.createBiquadFilter();
      filter.type = l.type || 'bandpass';
      scheduleBend(filter.frequency, l.freq ?? 700, l.bend, t);
      filter.Q.value = l.q ?? 0.8;
      src.connect(filter).connect(g);
    } else {
      src.type = l.type || 'sawtooth';
      scheduleBend(src.frequency, l.freq ?? 320, l.bend, t);
      src.connect(g);
    }
    src.start(t);
    voices.push({ src, filter, g });
  }
  if (!voices.length) return null;

  let stopped = false;
  return function stop() {
    if (stopped) return;
    stopped = true;
    const now = e.ctx ? e._now() : t;
    for (const { src, g } of voices) {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + HELD_RELEASE);
      try { src.stop(now + HELD_RELEASE + 0.02); } catch { /* already stopped */ }
    }
    setTimeout(() => {
      for (const { src, filter, g } of voices) {
        try { src.disconnect(); filter?.disconnect(); g.disconnect(); } catch { /* already gone */ }
      }
    }, (HELD_RELEASE + 0.05) * 1000);
  };
}
