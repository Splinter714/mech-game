import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine } from './AudioEngine.js';
import { getWeapon, WEAPON_IDS } from '../data/weapons.js';

// Minimal mock Web Audio context: records how many voices (oscillators / noise sources)
// were created so we can assert the synth actually scheduled sound, and that every event
// path runs without throwing. `connect` returns its argument so the `a.connect(b).connect(c)`
// chaining in the engine works.
function mockContext() {
  let oscillators = 0, sources = 0;
  const param = () => ({
    value: 0,
    setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
  });
  const node = () => ({ connect: (dest) => dest });
  const ctx = {
    state: 'running', currentTime: 1.0, sampleRate: 48000, destination: node(),
    createGain: () => ({ gain: param(), connect: (d) => d }),
    createWaveShaper: () => ({ curve: null, oversample: 'none', connect: (d) => d }),
    createBiquadFilter: () => ({ type: '', frequency: param(), Q: param(), connect: (d) => d }),
    createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), connect: (d) => d }),
    createOscillator: () => { oscillators++; return { type: '', frequency: param(), connect: (d) => d, start() {}, stop() {} }; },
    createBufferSource: () => { sources++; return { buffer: null, connect: (d) => d, start() {}, stop() {} }; },
    createBuffer: (_c, len) => ({ getChannelData: () => new Float32Array(len) }),
    resume: () => Promise.resolve(),
    _counts: () => ({ oscillators, sources }),
  };
  return ctx;
}

describe('AudioEngine (mock context)', () => {
  let eng, ctx;
  beforeEach(() => { eng = new AudioEngine(); ctx = mockContext(); eng.init(ctx); });

  it('initialises a bus graph and reports ready on a running context', () => {
    expect(eng.ready).toBe(true);
    expect(eng.master).toBeTruthy();
    expect(eng.sfx).toBeTruthy();
    expect(eng.music).toBeTruthy();
  });

  it('plays a firing sound for every weapon in the catalog without throwing', () => {
    for (const id of WEAPON_IDS) eng.fire(getWeapon(id));
    expect(ctx._counts().oscillators + ctx._counts().sources).toBeGreaterThan(0);
  });

  it('plays each impact kind, footsteps, abilities, and explosions', () => {
    for (const k of ['slug', 'plasma', 'missile', 'beam', 'flame', 'fire']) eng.impact(k);
    eng.footstep(0);
    eng.footstep(1); // second is throttled by time, but must not throw
    eng.ability('dash');
    eng.ability('shield');
    eng.explosion(0.6);
    eng.explosion(1.2);
    expect(ctx._counts().oscillators).toBeGreaterThan(0);
  });

  it('schedules every step of BOTH music tracks without throwing', () => {
    for (const track of ['metal', 'synthwave']) {
      eng.setTrack(track);
      const before = ctx._counts().oscillators;
      for (let step = 0; step < 32; step++) eng._playStep(step, 2.0 + step * 0.1);
      expect(ctx._counts().oscillators).toBeGreaterThan(before);
    }
  });

  it('mutes and unmutes via the master gain', () => {
    expect(eng.toggleMute()).toBe(true);
    expect(eng.ready).toBe(false);          // muted → not ready, so events skip
    expect(eng.master.gain.value).toBe(0);
    expect(eng.toggleMute()).toBe(false);
    expect(eng.ready).toBe(true);
  });

  it('no-ops safely with no context (headless / pre-init)', () => {
    const bare = new AudioEngine();
    expect(bare.ready).toBe(false);
    expect(() => { bare.fire(getWeapon('autocannon')); bare.explosion(); bare.footstep(); }).not.toThrow();
  });
});
