import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AudioEngine } from './AudioEngine.js';
import { getWeapon, WEAPON_IDS } from '../data/weapons.js';
import {
  storeOverride, clearOverride, setAudioContext, setTrim, setStart, setProcessing, _resetForTest,
} from './sfxOverrides.js';

// Minimal mock Web Audio context: records how many voices (oscillators / noise sources)
// were created so we can assert the synth actually scheduled sound, and that every event
// path runs without throwing. `connect` returns its argument so the `a.connect(b).connect(c)`
// chaining in the engine works.
function mockContext() {
  let oscillators = 0, sources = 0;
  const bufferSourceStarts = [];   // #166: recorded (when, offset, duration) args from every src.start() call
  const biquads = [];              // #172: every BiquadFilter created (incl. the music chain + override filters)
  const convolvers = [];           // #172: every ConvolverNode created (only the override reverb makes these)
  const bufferSources = [];        // #172: every buffer source node (so its detune AudioParam is inspectable)
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
    createBiquadFilter: () => { const n = { type: '', frequency: param(), Q: param(), connect: (d) => d, disconnect() {} }; biquads.push(n); return n; },
    createConvolver: () => { const n = { buffer: null, normalize: true, connect: (d) => d, disconnect() {} }; convolvers.push(n); return n; },
    createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), connect: (d) => d }),
    createOscillator: () => { oscillators++; return { type: '', frequency: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }; },
    createBufferSource: () => {
      sources++;
      const n = {
        buffer: null, loop: false, detune: param(), connect: (d) => d,
        start(...args) { bufferSourceStarts.push(args); },
        stop() {}, disconnect() {},
      };
      bufferSources.push(n);
      return n;
    },
    createBuffer: (_c, len) => ({ getChannelData: () => new Float32Array(len) }),
    // #150: real-file SFX overrides decode through the context too — a trivial fake decode
    // (tag the "buffer" with the byte length) is enough to prove override plumbing, without
    // needing an actual audio codec in tests.
    decodeAudioData: async (bytes) => ({ __fakeDecodedBytes: bytes.byteLength }),
    resume: () => Promise.resolve(),
    _counts: () => ({ oscillators, sources, biquads: biquads.length, convolvers: convolvers.length }),
    _lastBufferSourceStart: () => bufferSourceStarts[bufferSourceStarts.length - 1],
    _lastBufferSource: () => bufferSources[bufferSources.length - 1],
    _biquads: () => biquads,
    _convolvers: () => convolvers,
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

  // #107: the per-kill destruction-explosion boom, tunable by discrete size category (not the
  // continuous `explosion(scale)` above, still used for a part breaking off / player MECH DOWN).
  it('plays a death explosion for every size category without throwing', () => {
    for (const category of ['small', 'medium', 'large', 'massive']) {
      expect(() => eng.deathExplosion(category)).not.toThrow();
    }
    expect(ctx._counts().oscillators).toBeGreaterThan(0);
  });

  it('falls back to medium for an unrecognized category, without throwing', () => {
    expect(() => eng.deathExplosion('bogus')).not.toThrow();
  });

  it('tunes a death-explosion category live without touching the others or the continuous deathExplosion entry', () => {
    const smallGainBefore = eng.getSfxParams('deathExplosionSmall').fire[0].gain;
    const continuousGainBefore = eng.getSfxParams('deathExplosion').fire[0].gain;
    eng.setSfxParam('deathExplosionMassive', 'fire', 0, 'gain', 0.99);
    expect(eng.getSfxParams('deathExplosionMassive').fire[0].gain).toBe(0.99);
    expect(eng.getSfxParams('deathExplosionSmall').fire[0].gain).toBe(smallGainBefore);
    expect(eng.getSfxParams('deathExplosion').fire[0].gain).toBe(continuousGainBefore);
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

  // #150: real-file SFX overrides — a loaded file takes priority over the procedural layers
  // for that weaponId+stage; everything else must be an untouched no-op.
  describe('real-file SFX overrides (#150)', () => {
    const fakeFile = (name, tag) => ({
      name, type: 'audio/wav', arrayBuffer: async () => new TextEncoder().encode(tag).buffer,
    });

    // Reset sfxOverrides' shared in-memory cache between tests (it's a module-level
    // singleton), then re-point it at THIS test's engine context directly — the outer
    // `beforeEach` above already called `eng.init(ctx)`, which normally wires this up via
    // AudioEngine.init, but `_resetForTest()` clears that wiring too (and `eng.init` no-ops
    // on an already-initialized engine), so it must be redone explicitly.
    beforeEach(() => { _resetForTest(); setAudioContext(ctx); });
    afterEach(() => { delete globalThis.indexedDB; }); // no fake DB set up here — persistence is covered in sfxOverrides.test.js

    it('plays the override buffer via a buffer source instead of the procedural layers', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
      // AudioEngine.init (in the outer beforeEach) already wired the engine's ctx into
      // sfxOverrides — decode above used it, so getOverride resolves without needing a
      // persisted DB (globalThis.indexedDB is unset here on purpose).
      const before = ctx._counts();
      eng.fire(getWeapon('autocannon'));
      const after = ctx._counts();
      expect(after.sources).toBe(before.sources + 1);      // exactly one buffer source: the override
      expect(after.oscillators).toBe(before.oscillators);  // no procedural tone layers ran
    });

    it('falls back to procedural playback once the override is cleared', async () => {
      await storeOverride('autocannon', 'impact', fakeFile('b.wav', 'B'));
      await clearOverride('autocannon', 'impact');
      const before = ctx._counts();
      eng.impact('autocannon');
      const after = ctx._counts();
      // autocannon's impact stage is 1 noise + 1 tone layer — procedural playback ran again.
      expect(after.oscillators).toBeGreaterThan(before.oscillators);
    });

    it('is scoped to the exact weaponId+stage — other stages/weapons are unaffected', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('c.wav', 'C'));
      const before = ctx._counts();
      eng.impact('autocannon');            // different stage, no override
      eng.fire(getWeapon('shotgun'));      // different weapon, no override
      const after = ctx._counts();
      expect(after.oscillators).toBeGreaterThan(before.oscillators); // both ran procedurally
    });

    // #166: non-destructive trim — applied purely via AudioBufferSourceNode.start's `duration`
    // arg, never by slicing/re-encoding the buffer itself.
    describe('trim (#166)', () => {
      it('passes trimMs (converted to seconds) as start()\'s duration arg when a trim is set', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('d.wav', 'D'));
        await setTrim('autocannon', 'fire', 400);   // 400ms
        eng.fire(getWeapon('autocannon'));
        const [when, offset, duration] = ctx._lastBufferSourceStart();
        expect(when).toBe(ctx.currentTime);
        expect(offset).toBe(0);
        expect(duration).toBeCloseTo(0.4, 5);
      });

      it('omits the duration arg (plays the full file) when no trim is set', async () => {
        await storeOverride('autocannon', 'impact', fakeFile('e.wav', 'E'));
        eng.impact('autocannon');
        const args = ctx._lastBufferSourceStart();
        expect(args.length).toBe(1);   // just `when` — untouched, exactly the pre-#166 call shape
      });

      it('an untrimmed pre-existing (#150-era) override plays full length, completely unaffected', async () => {
        // Mirrors an override stored before trimMs existed: never calls setTrim at all.
        await storeOverride('shotgun', 'fire', fakeFile('legacy.wav', 'LEGACY'));
        eng.fire(getWeapon('shotgun'));
        const args = ctx._lastBufferSourceStart();
        expect(args.length).toBe(1);
      });
    });

    // #166 (scope expansion): a real START offset alongside the end trim — together they form
    // an actual start/end pair mapped onto start(when, offset, duration).
    describe('start offset (#166)', () => {
      it('passes startMs (converted to seconds) as start()\'s offset arg when only a start is set', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('f.wav', 'F'));
        await setStart('autocannon', 'fire', 500);   // 500ms in, no end trim
        eng.fire(getWeapon('autocannon'));
        const [when, offset, duration] = ctx._lastBufferSourceStart();
        expect(when).toBe(ctx.currentTime);
        expect(offset).toBeCloseTo(0.5, 5);
        expect(duration).toBeUndefined();   // plays from the offset to the end of the file
      });

      it('combines start + trim: plays a 300ms window beginning 500ms into the file', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('g.wav', 'G'));
        await setStart('autocannon', 'fire', 500);
        await setTrim('autocannon', 'fire', 300);   // duration FROM the new start point
        eng.fire(getWeapon('autocannon'));
        const [when, offset, duration] = ctx._lastBufferSourceStart();
        expect(when).toBe(ctx.currentTime);
        expect(offset).toBeCloseTo(0.5, 5);
        expect(duration).toBeCloseTo(0.3, 5);
      });

      it('omits both offset and duration (plays the full file) when neither start nor trim is set', async () => {
        await storeOverride('autocannon', 'impact', fakeFile('h.wav', 'H'));
        eng.impact('autocannon');
        const args = ctx._lastBufferSourceStart();
        expect(args.length).toBe(1);
      });

      it('an untrimmed pre-existing override with no start set plays full length, unaffected', async () => {
        await storeOverride('shotgun', 'impact', fakeFile('legacy2.wav', 'LEGACY2'));
        eng.impact('shotgun');
        const args = ctx._lastBufferSourceStart();
        expect(args.length).toBe(1);
      });
    });

    // #172: non-destructive playback processing — pitch (detune on the source), a BiquadFilter,
    // and a wet/dry reverb (ConvolverNode). Asserted by inspecting the REAL scheduled node graph
    // (the mock records each node), not just UI/param state.
    describe('processing (#172)', () => {
      it('default (no processing set) is a strict clean passthrough — no detune, filter, or reverb', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        const before = ctx._counts();
        eng.fire(getWeapon('autocannon'));
        const after = ctx._counts();
        expect(after.sources).toBe(before.sources + 1);          // just the override source
        expect(after.biquads).toBe(before.biquads);              // no filter node added
        expect(after.convolvers).toBe(before.convolvers);        // no reverb node added
        expect(ctx._lastBufferSource().detune.value).toBe(0);    // pitch untouched
      });

      it('applies detune (cents) to the source node when a pitch is set', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setProcessing('autocannon', 'fire', { detune: 300 });
        eng.fire(getWeapon('autocannon'));
        expect(ctx._lastBufferSource().detune.value).toBe(300);
        // ...and no filter/reverb crept in from a pitch-only change
        expect(ctx._convolvers().length).toBe(0);
      });

      it('inserts a BiquadFilter with the set type/frequency/Q when a filter is set', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setProcessing('autocannon', 'fire', { filterType: 'highpass', filterFreq: 1200, filterQ: 3 });
        const before = ctx._counts().biquads;
        eng.fire(getWeapon('autocannon'));
        const added = ctx._biquads().slice(before);
        expect(added.length).toBe(1);
        expect(added[0].type).toBe('highpass');
        expect(added[0].frequency.value).toBe(1200);
        expect(added[0].Q.value).toBe(3);
      });

      it('inserts a reverb (ConvolverNode wet path) when reverb mix > 0', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setProcessing('autocannon', 'fire', { reverbMix: 0.4, reverbSize: 1.2 });
        const before = ctx._counts().convolvers;
        eng.fire(getWeapon('autocannon'));
        const added = ctx._convolvers().slice(before);
        expect(added.length).toBe(1);
        expect(added[0].buffer).toBeTruthy();                     // a generated IR was assigned
      });

      it('a reverb mix of 0 adds no convolver (clean passthrough)', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setProcessing('autocannon', 'fire', { reverbMix: 0 });   // setProcessing treats a stored 0 as-is; playback gates on > 0
        const before = ctx._counts().convolvers;
        eng.fire(getWeapon('autocannon'));
        expect(ctx._counts().convolvers).toBe(before);
      });

      it('composes with #166 start/trim: detune on the source AND the start/duration args together', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setStart('autocannon', 'fire', 500);
        await setTrim('autocannon', 'fire', 300);
        await setProcessing('autocannon', 'fire', { detune: -200, filterType: 'lowpass', filterFreq: 800, filterQ: 1 });
        const beforeBq = ctx._counts().biquads;
        eng.fire(getWeapon('autocannon'));
        const [when, offset, duration] = ctx._lastBufferSourceStart();
        expect(when).toBe(ctx.currentTime);
        expect(offset).toBeCloseTo(0.5, 5);
        expect(duration).toBeCloseTo(0.3, 5);
        expect(ctx._lastBufferSource().detune.value).toBe(-200);
        expect(ctx._biquads().slice(beforeBq)[0].type).toBe('lowpass');
      });

      it('clearing all processing back to neutral restores the clean passthrough', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setProcessing('autocannon', 'fire', { detune: 400, filterType: 'bandpass', filterFreq: 900, filterQ: 2, reverbMix: 0.5, reverbSize: 1 });
        // Now clear every field.
        await setProcessing('autocannon', 'fire', { detune: null, filterType: null, filterFreq: null, filterQ: null, reverbMix: null, reverbSize: null });
        const before = ctx._counts();
        eng.fire(getWeapon('autocannon'));
        const after = ctx._counts();
        expect(after.biquads).toBe(before.biquads);
        expect(after.convolvers).toBe(before.convolvers);
        expect(ctx._lastBufferSource().detune.value).toBe(0);
      });
    });
  });
});
