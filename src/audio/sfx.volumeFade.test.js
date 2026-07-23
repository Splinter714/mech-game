// #479 regression: a buffer-backed cue (dev override OR shipped bake) that carries BOTH a
// fade-out AND a non-unity volume must play at that volume from the VERY START — not at unity
// until the fade point, then jump to volume. A Web Audio GainNode.gain defaults to 1.0 and holds
// that default until its first scheduled event; before the fix the first scheduled event was at
// the fade-start, so the whole loud head of the cue played at unity. Jackson heard legLift (played
// 870ms, fade 530ms → fade starts at 340ms) "start loud then become very quiet very quickly."
// This exercises the SHARED playBuffer path through a live override (fully controllable in-test),
// which is the exact path the baked legLift ships through — so it guards the bake too.
import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine } from './AudioEngine.js';
import * as Overrides from './sfxOverrides.js';

// A mock AudioParam that RECORDS every scheduled event so the test can inspect what the gain was
// at any given time. `value` mirrors the last set (as a real AudioParam would for setValueAtTime).
function recordingParam(initial) {
  const events = [];
  return {
    value: initial,
    events,
    setValueAtTime(v, t) { this.value = v; events.push({ kind: 'set', v, t }); return this; },
    linearRampToValueAtTime(v, t) { events.push({ kind: 'linramp', v, t }); return this; },
    exponentialRampToValueAtTime(v, t) { events.push({ kind: 'expramp', v, t }); return this; },
    cancelScheduledValues() { return this; },
  };
}

function mockContext() {
  const gainNodes = [];
  const param = () => recordingParam(0);
  const ctx = {
    state: 'running', currentTime: 1.0, sampleRate: 48000, destination: { connect: (d) => d },
    createGain: () => { const n = { gain: recordingParam(1), connect: (d) => d, disconnect() {} }; gainNodes.push(n); return n; },
    createBiquadFilter: () => ({ type: '', frequency: param(), Q: param(), connect: (d) => d, disconnect() {} }),
    createWaveShaper: () => ({ curve: null, oversample: 'none', connect: (d) => d }),
    createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), connect: (d) => d }),
    createOscillator: () => ({ type: '', frequency: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }),
    createBufferSource: () => ({ buffer: null, detune: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }),
    createBuffer: (_c, len) => ({ getChannelData: () => new Float32Array(len) }),
    createStereoPanner: () => ({ pan: { value: 0 }, connect: (d) => d, disconnect() {} }),
    decodeAudioData: () => Promise.resolve({ duration: 2.5, numberOfChannels: 2, sampleRate: 48000 }),
    resume: () => Promise.resolve(),
    _gainNodes: () => gainNodes,
  };
  return ctx;
}

// Seed a live override BUFFER for (id, 'play') by pushing a fake blob through storeOverride (the
// real production entry point) against a mock context whose decodeAudioData yields a buffer.
async function seedOverride(ctx, id) {
  const blob = { name: 'x.wav', type: 'audio/wav', arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
  await Overrides.storeOverride(id, 'play', blob);
}

describe('#479 volume+fade: gain holds at volume from the start (not unity until the fade point)', () => {
  beforeEach(() => { Overrides._resetForTest(); });

  it('a played cue with fadeOutMs>0 AND volume 0.10 anchors the gain at 0.10 at playback start', async () => {
    const eng = new AudioEngine();
    const ctx = mockContext();
    eng.init(ctx);
    Overrides.setAudioContext(ctx);
    await seedOverride(ctx, 'legLift');
    await Overrides.setTrim('legLift', 'play', 870);
    await Overrides.setFadeOut('legLift', 'play', 530);
    await Overrides.setVolume('legLift', 'play', 0.10);

    const before = ctx._gainNodes().length;
    eng.ui('legLift', 'play');
    const newGains = ctx._gainNodes().slice(before);

    // The fade gain node is the one carrying a linear ramp to 0.
    const fadeGain = newGains.find((g) => g.gain.events.some((e) => e.kind === 'linramp' && e.v === 0));
    expect(fadeGain).toBeTruthy();

    const startAt = ctx.currentTime; // eng._now() === ctx.currentTime at play time
    // The VERY FIRST scheduled event must set the gain to 0.10 at playback start — NOT leave it at
    // the 1.0 default until the fade point. (Pre-fix regression: first event was the fade-start.)
    const first = fadeGain.gain.events.find((e) => e.kind === 'set');
    expect(first).toBeTruthy();
    expect(first.t).toBeCloseTo(startAt, 6);
    expect(first.v).toBeCloseTo(0.10, 6);

    // And it must still be 0.10 at the fade-start (fade rides FROM the volume level, not unity),
    // then ramp to 0 at the end.
    const endTime = startAt + 0.870;
    const fadeStart = endTime - 0.530;
    const atFade = fadeGain.gain.events.find((e) => e.kind === 'set' && Math.abs(e.t - fadeStart) < 1e-6);
    expect(atFade).toBeTruthy();
    expect(atFade.v).toBeCloseTo(0.10, 6);
    const ramp = fadeGain.gain.events.find((e) => e.kind === 'linramp');
    expect(ramp.v).toBe(0);
    expect(ramp.t).toBeCloseTo(endTime, 6);
  });

  it('the no-fade branch still applies volume as a plain constant gain (unchanged)', async () => {
    const eng = new AudioEngine();
    const ctx = mockContext();
    eng.init(ctx);
    Overrides.setAudioContext(ctx);
    await seedOverride(ctx, 'legLift');
    await Overrides.setVolume('legLift', 'play', 0.10);

    const before = ctx._gainNodes().length;
    eng.ui('legLift', 'play');
    const newGains = ctx._gainNodes().slice(before);
    // A constant-gain node whose .value is 0.10 (no ramp scheduled).
    const volGain = newGains.find((g) => Math.abs(g.gain.value - 0.10) < 1e-6);
    expect(volGain).toBeTruthy();
  });
});
