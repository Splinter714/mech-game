import { describe, it, expect, beforeEach } from 'vitest';
import { GAIT_SFX_ENTRIES, renderSynthBuffer } from './gaitSfx.js';
import {
  BAKED_SFX, getBaked, pickBakedVariant, getBakedVariantCount,
  _resetForTest as _resetBaked, _setBakedBufferForTest,
} from './bakedSfx.js';
import { AudioEngine } from './AudioEngine.js';

// #479: the two GAIT cues are SYNTHESISED then BAKED to a buffer — a multi-variant pool joining
// bakedSfx.js's baked-pool mechanism, sourced from offline synthesis instead of a recorded file.
// Audio can't be unit-tested for how it SOUNDS; these pin the WIRING: the pools are registered as
// real BAKED_SFX entries, carry several distinct variants, resolve through the same
// getBaked/pickBakedVariant path as every other bake, and the cues play a baked variant (falling
// back to the live procedural stub) without throwing.

describe('gaitSfx (#479 synth-baked gait cues)', () => {
  describe('GAIT_SFX_ENTRIES data', () => {
    it('registers footstep::play and legLift::play as multi-variant synth pools', () => {
      for (const key of ['footstep::play', 'legLift::play']) {
        const pool = GAIT_SFX_ENTRIES[key];
        expect(Array.isArray(pool), key).toBe(true);
        expect(pool.length, key).toBeGreaterThanOrEqual(2);   // more than one so a walk doesn't machine-gun
        for (const entry of pool) {
          expect(entry.asset, key).toBeUndefined();           // zero-asset: NOT a recorded file
          expect(entry.synth, key).toBeTruthy();
          expect(typeof entry.synth.durMs, key).toBe('number');
          expect(Array.isArray(entry.synth.layers), key).toBe(true);
          expect(entry.synth.layers.length, key).toBeGreaterThan(0);
          for (const layer of entry.synth.layers) {
            expect(['tone', 'noise'], key).toContain(layer.kind);
            expect(typeof layer.freq, key).toBe('number');
            expect(typeof layer.gain, key).toBe('number');
          }
        }
      }
    });

    it('spreads its pools into BAKED_SFX so they decode/resolve like every other bake', () => {
      expect(BAKED_SFX['footstep::play']).toBe(GAIT_SFX_ENTRIES['footstep::play']);
      expect(BAKED_SFX['legLift::play']).toBe(GAIT_SFX_ENTRIES['legLift::play']);
    });

    it('gives each cue VARYING variants so consecutive steps differ', () => {
      for (const key of ['footstep::play', 'legLift::play']) {
        // The first layer's base frequency should not be identical across all variants (the seeded
        // jitter spreads them), otherwise the "random variant" pick would still machine-gun one tone.
        const freqs = GAIT_SFX_ENTRIES[key].map((e) => e.synth.layers[0].freq);
        expect(new Set(freqs).size, key).toBeGreaterThan(1);
      }
    });

    it('keeps the leg-lift quieter than the footstep (texture, not a second accent)', () => {
      const loudest = (key) => Math.max(...GAIT_SFX_ENTRIES[key].flatMap((e) => e.synth.layers.map((l) => l.gain)));
      expect(loudest('legLift::play')).toBeLessThan(loudest('footstep::play'));
    });
  });

  describe('baked-pool resolution', () => {
    beforeEach(() => { _resetBaked(); });

    it('resolves an injected gait buffer through getBaked/pickBakedVariant with a whole-buffer recipe', () => {
      const buf = { __fake: 'footstep-v0' };
      _setBakedBufferForTest('footstep', 'play', buf);
      expect(getBakedVariantCount('footstep', 'play')).toBe(1);
      const baked = getBaked('footstep', 'play');
      expect(baked.buffer).toBe(buf);
      // A synth entry carries no start/trim/processing recipe → the whole rendered buffer plays at unity.
      expect(baked.startMs).toBeNull();
      expect(baked.trimMs).toBeNull();
      expect(baked.processing).toBeNull();
      expect(baked.volume).toBe(1);
      expect(pickBakedVariant('footstep', 'play').buffer).toBe(buf);
    });

    it('picks among several decoded leg-lift variants', () => {
      const bufs = [{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }];
      bufs.forEach((b, i) => _setBakedBufferForTest('legLift', 'play', b, i));
      expect(getBakedVariantCount('legLift', 'play')).toBe(bufs.length);
      const seen = new Set();
      for (let i = 0; i < 60; i++) seen.add(pickBakedVariant('legLift', 'play').buffer);
      expect(seen.size).toBeGreaterThan(1);   // not always the same variant
    });
  });

  describe('renderSynthBuffer', () => {
    it('rejects (falls back to procedural) when there is no OfflineAudioContext', async () => {
      // node/jsdom has no OfflineAudioContext — loadAllBaked catches this per-slot so the cue plays
      // its live procedural stub. Asserting the reject documents that fallback contract.
      expect(typeof OfflineAudioContext).toBe('undefined');
      await expect(renderSynthBuffer(GAIT_SFX_ENTRIES['footstep::play'][0].synth, 48000)).rejects.toThrow();
    });
  });
});

// A tiny mock Web Audio context (buffer-source aware) — enough to prove the cue actually schedules
// a decoded gait BUFFER when one is baked, and falls back to oscillator/noise voices when not.
function mockCtx() {
  let osc = 0, src = 0;
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  const node = () => ({ connect: (d) => d, disconnect() {} });
  return {
    state: 'running', currentTime: 5, sampleRate: 48000, destination: node(),
    createGain: () => ({ gain: param(), connect: (d) => d, disconnect() {} }),
    createBiquadFilter: () => ({ type: '', frequency: param(), Q: param(), connect: (d) => d, disconnect() {} }),
    createOscillator: () => { osc++; return { type: '', frequency: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }; },
    createBufferSource: () => { src++; return { buffer: null, loop: false, detune: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }; },
    createWaveShaper: () => ({ curve: null, oversample: 'none', connect: (d) => d }),
    createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), connect: (d) => d }),
    createConvolver: () => ({ buffer: null, connect: (d) => d, disconnect() {} }),
    createStereoPanner: () => ({ pan: param(), connect: (d) => d, disconnect() {} }),
    createBuffer: (_c, len) => ({ getChannelData: () => new Float32Array(len) }),
    resume: () => Promise.resolve(),
    _counts: () => ({ osc, src }),
  };
}

describe('gait cue playback (#479)', () => {
  beforeEach(() => { _resetBaked(); });

  it('footstep and legLift play a baked variant buffer when one is decoded', () => {
    const eng = new AudioEngine();
    const ctx = mockCtx();
    eng.init(ctx);
    _setBakedBufferForTest('footstep', 'play', { __fake: 'fs' });
    _setBakedBufferForTest('legLift', 'play', { __fake: 'll' });
    const before = ctx._counts().src;
    eng.footstep(0);
    eng.legLift(0);
    expect(ctx._counts().src).toBe(before + 2);   // each played a decoded buffer source, not oscillators
  });

  it('falls back to the live procedural stub when nothing is baked, without throwing', () => {
    const eng = new AudioEngine();
    const ctx = mockCtx();
    eng.init(ctx);
    const before = ctx._counts();
    expect(() => { eng.footstep(0); eng.legLift(0); }).not.toThrow();
    const after = ctx._counts();
    expect(after.osc + after.src).toBeGreaterThan(before.osc + before.src);
  });
});
