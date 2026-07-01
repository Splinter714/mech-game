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
    cancelScheduledValues() {},
  });
  const node = () => ({ connect: (dest) => dest, disconnect() {} });
  const ctx = {
    state: 'running', currentTime: 1.0, sampleRate: 48000, baseLatency: 0.0053, outputLatency: 0.168, destination: node(),
    createGain: () => ({ gain: param(), connect: (d) => d, disconnect() {} }),
    createWaveShaper: () => ({ curve: null, oversample: 'none', connect: (d) => d }),
    createBiquadFilter: () => ({ type: '', frequency: param(), Q: param(), connect: (d) => d, disconnect() {} }),
    createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), connect: (d) => d }),
    createOscillator: () => { oscillators++; return { type: '', frequency: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }; },
    createBufferSource: () => { sources++; return { buffer: null, loop: false, connect: (d) => d, start() {}, stop() {}, disconnect() {} }; },
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

  it('latencyReport surfaces the context base + output latency as ms plus their sum (the platform floor)', () => {
    const r = eng.latencyReport();
    expect(r.baseLatencyMs).toBeCloseTo(5.3, 1);
    expect(r.outputLatencyMs).toBeCloseTo(168, 0);
    expect(r.floorMs).toBeCloseTo(173.3, 1);
    expect(r.sampleRate).toBe(48000);
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

  // #53: held/looping fire sound (flamethrower/beam laser) instead of a retriggered one-shot.
  describe('held/looping fire sound (#53)', () => {
    it('starts a continuous voice for a held-sound weapon and stops it cleanly', () => {
      const before = ctx._counts();
      eng.startHeld('leftArm', 'flamethrower');
      expect(ctx._counts().sources).toBeGreaterThan(before.sources); // noise loop voice created
      expect(() => eng.stopHeld('leftArm')).not.toThrow();
    });

    it('guards against double-starting the same location', () => {
      eng.startHeld('leftArm', 'flamethrower');
      const after1 = ctx._counts();
      eng.startHeld('leftArm', 'flamethrower');   // same location again — should no-op
      expect(ctx._counts()).toEqual(after1);
      eng.stopHeld('leftArm');
    });

    it('tracks two simultaneous held weapons at different locations independently', () => {
      eng.startHeld('leftArm', 'flamethrower');
      eng.startHeld('rightArm', 'beamLaser');
      expect(() => { eng.stopHeld('leftArm'); eng.stopHeld('rightArm'); }).not.toThrow();
    });

    it('is a no-op for a weapon with no held/looping sound', () => {
      const before = ctx._counts();
      eng.startHeld('leftArm', 'autocannon');
      expect(ctx._counts()).toEqual(before);
    });

    it('stopHeld is safe to call on a location with nothing playing', () => {
      expect(() => eng.stopHeld('rightTorso')).not.toThrow();
    });

    it('stopAllHeld stops every tracked location and clears the map', () => {
      eng.startHeld('leftArm', 'flamethrower');
      eng.startHeld('rightArm', 'beamLaser');
      eng.stopAllHeld();
      expect(eng._heldSounds.size).toBe(0);
    });
  });

  // #56: per-projectile in-flight trajectory loop (missiles/lobbed weapons).
  describe('per-projectile trajectory loop (#56)', () => {
    it('starts a loop and returns a stop closure for a weapon with a trajectory stage', () => {
      const stop = eng.startTrajectoryLoop('swarmRack');
      expect(typeof stop).toBe('function');
      expect(() => stop()).not.toThrow();
    });

    it('returns null for a weapon with no trajectory stage', () => {
      expect(eng.startTrajectoryLoop('autocannon')).toBeNull();
    });

    it('returns null when the engine is not ready', () => {
      const bare = new AudioEngine();
      expect(bare.startTrajectoryLoop('swarmRack')).toBeNull();
    });
  });
});
