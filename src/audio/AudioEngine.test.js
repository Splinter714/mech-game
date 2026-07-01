import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine } from './AudioEngine.js';
import { getWeapon, WEAPON_IDS } from '../data/weapons.js';

// Minimal mock Web Audio context: records how many voices (oscillators / noise sources)
// were created so we can assert the synth actually scheduled sound, and that every event
// path runs without throwing. `connect` returns its argument so the `a.connect(b).connect(c)`
// chaining in the engine works.
function mockContext() {
  let oscillators = 0, sources = 0;
  const gainLogs = [];
  // `log` (only given to gain params) records the automation calls a voice schedules, so
  // tests can assert on the ENVELOPE SHAPE, not just "it didn't throw".
  const param = (log) => ({
    value: 0,
    setValueAtTime(v, t) { log?.push(['set', v, t]); },
    linearRampToValueAtTime(v, t) { log?.push(['linRamp', v, t]); },
    exponentialRampToValueAtTime(v, t) { log?.push(['expRamp', v, t]); },
  });
  const node = () => ({ connect: (dest) => dest });
  const ctx = {
    state: 'running', currentTime: 1.0, sampleRate: 48000, destination: node(),
    createGain: () => { const log = []; gainLogs.push(log); return { gain: param(log), connect: (d) => d }; },
    createWaveShaper: () => ({ curve: null, oversample: 'none', connect: (d) => d }),
    createBiquadFilter: () => ({ type: '', frequency: param(), Q: param(), connect: (d) => d }),
    createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), connect: (d) => d }),
    createOscillator: () => { oscillators++; return { type: '', frequency: param(), connect: (d) => d, start() {}, stop() {} }; },
    createBufferSource: () => { sources++; return { buffer: null, connect: (d) => d, start() {}, stop() {} }; },
    createBuffer: (_c, len) => ({ getChannelData: () => new Float32Array(len) }),
    resume: () => Promise.resolve(),
    _counts: () => ({ oscillators, sources }),
    _lastGainLog: () => gainLogs[gainLogs.length - 1],
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

  it('plays a fire, trajectory, and impact sound for every weapon without throwing', () => {
    for (const id of WEAPON_IDS) { eng.fire(getWeapon(id)); eng.trajectory(id); eng.impact(id); }
    expect(ctx._counts().oscillators + ctx._counts().sources).toBeGreaterThan(0);
  });

  it('falls back to a generic sound for an unknown weapon id, without throwing', () => {
    expect(() => { eng.fire({ id: 'made-up', delivery: {} }); eng.trajectory('made-up'); eng.impact('made-up'); }).not.toThrow();
  });

  it('plays footsteps, abilities, and explosions', () => {
    eng.footstep(0);
    eng.footstep(1); // second is throttled by time, but must not throw
    eng.ability('dash');
    eng.ability('shield');
    eng.explosion(0.6);
    eng.explosion(1.2);
    expect(ctx._counts().oscillators).toBeGreaterThan(0);
  });

  it('holds gain through a freq sweep instead of decaying across it (else the swept target is inaudible)', () => {
    eng.tone(eng.sfx, { freq: 200, freqEnd: 2000, dur: 0.2, gain: 0.5, attack: 0.01 });
    const swept = ctx._lastGainLog();
    // attack ramp up, THEN an explicit hold at full gain, THEN the final release ramp down —
    // three automation events, not two, and the hold sits at the full `gain` value.
    expect(swept.filter((c) => c[0] === 'set').length).toBe(2);   // initial silence + the hold
    expect(swept.at(-2)[0]).toBe('set');
    expect(swept.at(-2)[1]).toBe(0.5);                            // holds at full gain...
    expect(swept.at(-1)[0]).toBe('expRamp');                      // ...then releases to silence
    expect(swept.at(-1)[1]).toBeCloseTo(0.0001, 4);

    eng.tone(eng.sfx, { freq: 200, dur: 0.2, gain: 0.5, attack: 0.01 }); // no freqEnd -> no hold
    const plain = ctx._lastGainLog();
    expect(plain.filter((c) => c[0] === 'set').length).toBe(1);    // just the initial silence
  });

  it('tunes a weapon SFX param live (Weapon Lab sound panel) without touching other weapons', () => {
    const shotgunGainBefore = eng.getSfxParams('shotgun').fire[0].gain;
    eng.setSfxParam('autocannon', 'fire', 0, 'gain', 0.9);
    expect(eng.getSfxParams('autocannon').fire[0].gain).toBe(0.9);
    expect(eng.getSfxParams('shotgun').fire[0].gain).toBe(shotgunGainBefore); // unaffected
  });

  it('schedules every step of every metal track without throwing', () => {
    expect(eng.trackIds.length).toBeGreaterThan(1);        // several switchable tracks (#43)
    for (const track of eng.trackIds) {
      eng.setTrack(track);
      expect(eng.track).toBe(track);                       // unknown ids would fall back to metal
      const before = ctx._counts().oscillators;
      // Cover all 384 steps so the full 24-bar arrangement (incl. the lead-layering sections) runs.
      for (let step = 0; step < 384; step++) eng._playStep(step, 2.0 + step * 0.1);
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
