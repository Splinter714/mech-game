// Generic multi-layer SFX player — a "layer" is the data for one e.tone()/e.noise() call.
// Turning each cue into an array of layers (mirroring how music.js turned synth code into a
// tunable data table) is what makes a weapon's sound editable: tune a layer's fields instead
// of hand-editing a hardcoded function. Add/change a sound = edit its layer array.

export function playLayers(e, bus, layers) {
  for (const l of layers || []) {
    if (!l) continue;
    if (l.kind === 'noise') e.noise(bus, l);
    else e.tone(bus, l);
  }
}

const HELD_ATTACK = 0.05;    // s, gain ramp-up on start (30-60ms window)
const HELD_RELEASE = 0.08;   // s, gain ramp-down on stop (60-100ms window)

// Held/looping counterpart to playLayers() (#53 held fire sounds, #56 in-flight trajectory
// loops): instead of a one-shot decay-to-zero voice per layer, build ONE genuinely continuous
// source per layer — a looping AudioBufferSourceNode through a filter for a noise layer
// (reusing e._noise()'s cached buffer), or a bare OscillatorNode left running for a tone
// layer (oscillators are inherently continuous once started, so "loop" just means "never
// schedule a stop/decay") — ramp its gain up over a short attack, and return a stop()
// closure that ramps down + disconnects every voice. Returns null if `layers` is empty/falsy.
export function startLoopLayers(e, bus, layers, gainScale = 1) {
  const ctx = e.ctx;
  const t = e._now();
  const voices = [];
  for (const l of layers || []) {
    if (!l) continue;
    const g = ctx.createGain();
    const targetGain = Math.max(0.0001, (l.gain ?? 0.15) * gainScale);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(targetGain, t + HELD_ATTACK);
    g.connect(bus);

    const isNoise = l.kind === 'noise';
    const src = isNoise ? ctx.createBufferSource() : ctx.createOscillator();
    let filter;
    if (isNoise) {
      src.buffer = e._noise();
      src.loop = true;
      filter = ctx.createBiquadFilter();
      filter.type = l.type || 'bandpass';
      filter.frequency.value = l.freq ?? 700;
      filter.Q.value = l.q ?? 0.8;
      src.connect(filter).connect(g);
    } else {
      src.type = l.type || 'sawtooth';
      src.frequency.value = l.freq ?? 320;
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
