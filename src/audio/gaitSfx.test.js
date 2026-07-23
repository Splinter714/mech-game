import { describe, it, expect, beforeEach } from 'vitest';
import { GAIT_SFX_ENTRIES, renderSynthBuffer } from './gaitSfx.js';
import {
  BAKED_SFX, getBaked, pickBakedVariant, getBakedVariantCount,
  _resetForTest as _resetBaked, _setBakedBufferForTest,
} from './bakedSfx.js';
import { AudioEngine } from './AudioEngine.js';

// #479: legLift is the remaining SYNTHESISED-then-BAKED gait cue — a multi-variant pool joining
// bakedSfx.js's baked-pool mechanism, sourced from offline synthesis instead of a recorded file.
// (FOOTSTEP was promoted to a 4-variant FILE bake in bakedSfx.js — real "Hard Step" recordings —
// so it no longer lives here; the file pool is covered in bakedSfx.test.js.) Audio can't be
// unit-tested for how it SOUNDS; these pin the WIRING: the legLift pool is registered as a real
// BAKED_SFX entry, carries several distinct variants, resolves through the same
// getBaked/pickBakedVariant path as every other bake, and the cues play a baked variant (falling
// back to the live procedural stub) without throwing.

describe('gaitSfx (#479 synth-baked gait cues)', () => {
  describe('GAIT_SFX_ENTRIES data', () => {
    it('registers legLift::play as a multi-variant synth pool (footstep is now a file bake)', () => {
      // footstep::play was moved out of the synth table into a file pool; only legLift stays synth.
      expect(GAIT_SFX_ENTRIES['footstep::play']).toBeUndefined();
      const pool = GAIT_SFX_ENTRIES['legLift::play'];
      expect(Array.isArray(pool)).toBe(true);
      expect(pool.length).toBeGreaterThanOrEqual(2);   // more than one so a walk doesn't machine-gun
      for (const entry of pool) {
        expect(entry.asset).toBeUndefined();           // zero-asset: NOT a recorded file
        expect(entry.synth).toBeTruthy();
        expect(typeof entry.synth.durMs).toBe('number');
        expect(Array.isArray(entry.synth.layers)).toBe(true);
        expect(entry.synth.layers.length).toBeGreaterThan(0);
        for (const layer of entry.synth.layers) {
          expect(['tone', 'noise']).toContain(layer.kind);
          expect(typeof layer.freq).toBe('number');
          expect(typeof layer.gain).toBe('number');
        }
      }
    });

    it('spreads the legLift pool into BAKED_SFX so it decodes/resolves like every other bake', () => {
      expect(BAKED_SFX['legLift::play']).toBe(GAIT_SFX_ENTRIES['legLift::play']);
    });

    it('registers footstep::play as a 4-variant FILE pool in BAKED_SFX (each an asset, no synth)', () => {
      const pool = BAKED_SFX['footstep::play'];
      expect(Array.isArray(pool)).toBe(true);
      expect(pool.length).toBe(4);
      for (const entry of pool) {
        expect(entry.synth).toBeUndefined();           // NOT synth — a real recorded file
        expect(entry.asset).toBeTruthy();
        expect(entry.startMs).toBe(0);                 // clean full-file passthrough
      }
      // The four variants point at four DISTINCT source files (a walk rotates through them).
      expect(new Set(pool.map((e) => e.asset)).size).toBe(4);
    });

    it('gives legLift VARYING variants so consecutive steps differ', () => {
      // The first layer's base frequency should not be identical across all variants (the seeded
      // jitter spreads them), otherwise the "random variant" pick would still machine-gun one tone.
      const freqs = GAIT_SFX_ENTRIES['legLift::play'].map((e) => e.synth.layers[0].freq);
      expect(new Set(freqs).size).toBeGreaterThan(1);
    });
  });

  describe('baked-pool resolution', () => {
    beforeEach(() => { _resetBaked(); });

    it('resolves an injected legLift buffer through getBaked/pickBakedVariant with a whole-buffer recipe', () => {
      const buf = { __fake: 'legLift-v0' };
      _setBakedBufferForTest('legLift', 'play', buf);
      expect(getBakedVariantCount('legLift', 'play')).toBe(1);
      const baked = getBaked('legLift', 'play');
      expect(baked.buffer).toBe(buf);
      // A synth entry carries no start/trim/processing recipe → the whole rendered buffer plays at unity.
      expect(baked.startMs).toBeNull();
      expect(baked.trimMs).toBeNull();
      expect(baked.processing).toBeNull();
      expect(baked.volume).toBe(1);
      expect(pickBakedVariant('legLift', 'play').buffer).toBe(buf);
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
      await expect(renderSynthBuffer(GAIT_SFX_ENTRIES['legLift::play'][0].synth, 48000)).rejects.toThrow();
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
