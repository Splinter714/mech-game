import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudioEngine } from './AudioEngine.js';
import { getWeapon, WEAPON_IDS } from '../data/weapons.js';
import {
  storeOverride, clearOverride, setAudioContext, setTrim, setStart, setProcessing, setFadeOut, setVolume,
  setLoopStartMs, _resetForTest, variantStage, removeOverrideVariant,
} from './sfxOverrides.js';
import {
  BAKED_SFX, _resetForTest as _resetBakedForTest, _setBakedBufferForTest,
} from './bakedSfx.js';
import { findSfxDomainEntry } from './sfxDomains.js';

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
  const gainNodes = [];            // #174: every gain node created, with its recorded envelope events
  const param = () => ({
    value: 0,
    setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
  });
  // #174: a gain AudioParam that RECORDS its scheduled envelope events (as ['set'|'ramp'|'exp',
  // value, time] tuples) so a test can assert the exact fade-out ramp — setValueAtTime(full) then
  // linearRampToValueAtTime(0) — landing on the trim point. Real GainNode gain defaults to 1.
  // #182: exponentialRampToValueAtTime also records (as 'exp') so a test can assert the held-loop
  // attack ramp's target (the #182 volume) — previously a no-op, since nothing needed its args.
  const gainParam = (events) => ({
    value: 1,
    setValueAtTime(v, t) { events.push(['set', v, t]); return this; },
    linearRampToValueAtTime(v, t) { events.push(['ramp', v, t]); return this; },
    exponentialRampToValueAtTime(v, t) { events.push(['exp', v, t]); return this; },
    cancelScheduledValues() {},
  });
  const node = () => ({ connect: (dest) => dest, disconnect() {} });
  const ctx = {
    state: 'running', currentTime: 1.0, sampleRate: 48000, baseLatency: 0.0053, outputLatency: 0.168, destination: node(),
    createGain: () => { const events = []; const n = { gain: gainParam(events), _events: events, connect: (d) => d, disconnect() {} }; gainNodes.push(n); return n; },
    createWaveShaper: () => ({ curve: null, oversample: 'none', connect: (d) => d }),
    createBiquadFilter: () => { const n = { type: '', frequency: param(), Q: param(), connect: (d) => d, disconnect() {} }; biquads.push(n); return n; },
    createConvolver: () => { const n = { buffer: null, normalize: true, connect: (d) => d, disconnect() {} }; convolvers.push(n); return n; },
    createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), connect: (d) => d }),
    createOscillator: () => { oscillators++; return { type: '', frequency: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }; },
    createBufferSource: () => {
      sources++;
      const n = {
        buffer: null, loop: false, detune: param(), connect: (d) => d, _stopArgs: null,
        start(...args) { bufferSourceStarts.push(args); },
        stop(...args) { n._stopArgs = args; }, disconnect() {},
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
    _bufferSources: () => bufferSources.slice(),
    _bufferSourceStarts: () => bufferSourceStarts.slice(),
    _biquads: () => biquads,
    _convolvers: () => convolvers,
    _gainNodes: () => gainNodes,
    // #174: the gain node(s) carrying a fade envelope — i.e. any gain that scheduled a linear
    // ramp to 0 (the fade-out to silence). None means no fade node was inserted.
    _fadeGains: () => gainNodes.filter((g) => g._events.some((e) => e[0] === 'ramp' && e[1] === 0)),
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

  it('plays footsteps and explosions', () => {
    eng.footstep(0);
    eng.footstep(1); // second is throttled by time, but must not throw
    eng.explosion(0.6);
    eng.explosion(1.2);
    expect(ctx._counts().oscillators).toBeGreaterThan(0);
  });

  // #178/#188/#196/#201/#210: the generic UI/pickup cue dispatch (equip/deploy/returnToGarage/
  // menuNav/scrapPickup/the 5 per-powerup powerupPickup* ids/sprintOn/sprintOff/partDestroyed/
  // mechDestroyed) — every id registered in sfxDomains.js's `ui` domain plays a procedural stub
  // without throwing, and an unregistered id is a safe no-op (mirrors the weapon fallback
  // behavior above).
  it('plays a UI/pickup cue for every registered ui-domain id without throwing', () => {
    for (const id of [
      'equip', 'deploy', 'returnToGarage', 'menuNav', 'scrapPickup',
      'powerupPickupOvercharge', 'powerupPickupOverdrive', 'powerupPickupOverclock',
      'powerupPickupArmorPatch', 'powerupPickupShield',
      'sprintOn', 'sprintOff',
      'partDestroyed', 'mechDestroyed',
    ]) {
      expect(() => eng.ui(id)).not.toThrow();
    }
    expect(ctx._counts().oscillators + ctx._counts().sources).toBeGreaterThan(0);
  });

  // #201/#210: these triggers must each be independently registered in sfxDomains.js's `ui`
  // array (mirroring #192/#194/#196's equip/deploy/powerup-pickup entries) so the owner's
  // generalized tuner panel can override/bake each one separately.
  it('registers partDestroyed/mechDestroyed/returnToGarage as their own SFX domain entries (#201/#210)', () => {
    for (const id of ['partDestroyed', 'mechDestroyed', 'returnToGarage']) {
      const entry = findSfxDomainEntry(id);
      expect(entry).toBeTruthy();
      expect(entry.stages).toEqual([['play', 'PLAY']]);
    }
  });

  it('no-ops for an unregistered ui id rather than throwing', () => {
    expect(() => eng.ui('not-a-real-id')).not.toThrow();
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

    // #178: Audio.ui(id, stage) — the generic UI/pickup cue dispatch — resolves an override
    // through the exact SAME playOverride path a weapon's fire/trajectory/impact stage does,
    // even though 'equip'/'play' aren't a weapon id or one of the three weapon stage names.
    it('plays an override buffer for a ui-domain (id, stage) pair via a buffer source', async () => {
      await storeOverride('equip', 'play', fakeFile('clunk.wav', 'CLUNK'));
      const before = ctx._counts();
      eng.ui('equip', 'play');
      const after = ctx._counts();
      expect(after.sources).toBe(before.sources + 1);
      expect(after.oscillators).toBe(before.oscillators);   // procedural equip cue did NOT run
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

    // #174: non-destructive FADE-OUT — a gain node scheduled to hold full then linearly ramp to
    // 0 landing exactly on the scheduled stop, so an early-trimmed cutoff fades instead of
    // clicking. Asserted by inspecting the REAL scheduled gain envelope on the mock node graph.
    describe('fade-out (#174)', () => {
      it('default (no fade set) schedules NO gain ramp — a strict hard-cut, unchanged behavior', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setTrim('autocannon', 'fire', 400);   // trimmed, but no fade
        eng.fire(getWeapon('autocannon'));
        expect(ctx._fadeGains().length).toBe(0);     // no fade gain node inserted at all
      });

      it('schedules setValueAtTime(1, end - fade) then linearRampToValueAtTime(0, end) ending exactly at the trim point', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setTrim('autocannon', 'fire', 400);    // plays 400ms from start=0
        await setFadeOut('autocannon', 'fire', 120);  // fade the last 120ms
        eng.fire(getWeapon('autocannon'));
        const fades = ctx._fadeGains();
        expect(fades.length).toBe(1);
        const events = fades[0]._events;
        // endTime = _now (== currentTime 1.0) + played 0.4s = 1.4s; fade starts at 1.4 - 0.12.
        const endTime = ctx.currentTime + 0.4;
        expect(events).toHaveLength(2);
        expect(events[0][0]).toBe('set');
        expect(events[0][1]).toBe(1);                        // holds FULL gain...
        expect(events[0][2]).toBeCloseTo(endTime - 0.12, 5); // ...until end - fadeOut
        expect(events[1][0]).toBe('ramp');
        expect(events[1][1]).toBe(0);                        // ramps to SILENCE...
        expect(events[1][2]).toBeCloseTo(endTime, 5);        // ...landing exactly on the trim point
      });

      it('clamps a fade longer than the played window down to the played duration (never over-runs)', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setTrim('autocannon', 'fire', 200);     // only 200ms plays
        await setFadeOut('autocannon', 'fire', 5000);  // absurd 5s fade
        eng.fire(getWeapon('autocannon'));
        const events = ctx._fadeGains()[0]._events;
        const endTime = ctx.currentTime + 0.2;
        // clamped: fade spans the WHOLE 200ms window — set anchor sits at endTime - 0.2 == start.
        expect(events[0][2]).toBeCloseTo(endTime - 0.2, 5);
        expect(events[1][2]).toBeCloseTo(endTime, 5);
      });

      it('composes with a start offset: endTime = start-offset window, fade rides on top of #166 trim', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setStart('autocannon', 'fire', 500);    // begin 500ms in
        await setTrim('autocannon', 'fire', 300);     // play 300ms from there
        await setFadeOut('autocannon', 'fire', 100);
        eng.fire(getWeapon('autocannon'));
        const [when, offset, duration] = ctx._lastBufferSourceStart();
        expect(offset).toBeCloseTo(0.5, 5);           // #166 start/trim still applied to the source...
        expect(duration).toBeCloseTo(0.3, 5);
        const events = ctx._fadeGains()[0]._events;
        const endTime = when + 0.3;                   // played window is the trim duration
        expect(events[0][2]).toBeCloseTo(endTime - 0.1, 5);
        expect(events[1][2]).toBeCloseTo(endTime, 5);
      });

      it('clearing the fade back to 0 restores the hard cut (no ramp scheduled)', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setTrim('autocannon', 'fire', 400);
        await setFadeOut('autocannon', 'fire', 150);
        await setFadeOut('autocannon', 'fire', 0);    // back to no fade
        eng.fire(getWeapon('autocannon'));
        expect(ctx._fadeGains().length).toBe(0);
      });
    });

    // #182: non-destructive overall VOLUME multiplier — a plain gain multiplier composing with
    // the existing detune/filter/reverb (#172) chain and the #174 fade-out envelope.
    describe('volume (#182)', () => {
      it('default (volume unset/1.0) builds the exact SAME node graph as before #182 — no extra gain node', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        const before = ctx._counts();
        const beforeGains = ctx._gainNodes().length;
        eng.fire(getWeapon('autocannon'));
        const after = ctx._counts();
        expect(after.sources).toBe(before.sources + 1);
        expect(ctx._gainNodes().length).toBe(beforeGains);   // no gain node inserted at all
        expect(ctx._fadeGains().length).toBe(0);
      });

      it('inserts a plain gain node reflecting the volume value when set (no fade active)', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setVolume('autocannon', 'fire', 1.5);
        const beforeGains = ctx._gainNodes().length;
        eng.fire(getWeapon('autocannon'));
        const added = ctx._gainNodes().slice(beforeGains);
        expect(added.length).toBe(1);
        expect(added[0].gain.value).toBe(1.5);
        expect(ctx._fadeGains().length).toBe(0);   // this is a plain gain, not a fade-envelope node
      });

      it('composes with fade-out: the SAME gain node holds at volume (not 1) before ramping to 0', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setTrim('autocannon', 'fire', 400);
        await setFadeOut('autocannon', 'fire', 120);
        await setVolume('autocannon', 'fire', 1.5);
        eng.fire(getWeapon('autocannon'));
        const fades = ctx._fadeGains();
        // With volume set, the fade-envelope gain now holds at 1.5 rather than a straight ramp-
        // to-0 match on _fadeGains' 'ramp to 0' filter — still exactly one such node, only ONE
        // gain node total was added for this stage (fade + volume share the same node).
        expect(fades.length).toBe(1);
        const events = fades[0]._events;
        const endTime = ctx.currentTime + 0.4;
        expect(events[0]).toEqual(['set', 1.5, expect.closeTo(endTime - 0.12, 5)]); // holds at VOLUME, not 1
        expect(events[1]).toEqual(['ramp', 0, expect.closeTo(endTime, 5)]);          // still ramps to silence
      });

      it('clamps volume into the 0..2 range via setVolume, reflected in the gain node', async () => {
        await storeOverride('autocannon', 'fire', fakeFile('a.wav', 'A'));
        await setVolume('autocannon', 'fire', 9);   // clamped to 2 by setVolume
        const beforeGains = ctx._gainNodes().length;
        eng.fire(getWeapon('autocannon'));
        const added = ctx._gainNodes().slice(beforeGains);
        expect(added[0].gain.value).toBe(2);
      });

      it('applies to a BAKED sound too (volume on the BAKED_SFX entry)', () => {
        const entry = BAKED_SFX['clusterRocket::fire'];
        const saved = { volume: entry.volume };
        entry.volume = 0.6;
        try {
          _setBakedBufferForTest('clusterRocket', 'fire', { __baked: 'bitBomb' });
          const beforeGains = ctx._gainNodes().length;
          eng.fire(getWeapon('clusterRocket'));
          const added = ctx._gainNodes().slice(beforeGains);
          expect(added.length).toBe(1);
          expect(added[0].gain.value).toBe(0.6);
        } finally {
          entry.volume = saved.volume;
        }
      });

      it('a BAKED entry with no volume field defaults to unity — unaffected, no regression', () => {
        // clusterRocket::fire ships with no `volume` field at all today.
        expect(BAKED_SFX['clusterRocket::fire'].volume).toBeUndefined();
        _setBakedBufferForTest('clusterRocket', 'fire', { __baked: 'bitBomb' });
        const beforeGains = ctx._gainNodes().length;
        eng.fire(getWeapon('clusterRocket'));
        expect(ctx._gainNodes().length).toBe(beforeGains);   // no extra gain node — unity, unchanged
      });
    });
  });

  // #173: baked-in SFX assets — a file shipped in the build plays for a weapon+stage, sitting
  // BELOW a dev IndexedDB override but ABOVE procedural synthesis. Buffers are seeded directly
  // (node can't fetch a bundled Vite URL); the decode+cache path itself is covered in
  // bakedSfx.test.js. Precedence + procedural fallback are the point here.
  describe('baked SFX (#173)', () => {
    const fakeFile = (name, tag) => ({
      name, type: 'audio/wav', arrayBuffer: async () => new TextEncoder().encode(tag).buffer,
    });

    // Both override modules are module-level singletons — reset each and re-point the override
    // module at THIS test's context (the outer beforeEach's eng.init already wired baked+override
    // contexts, but _resetForTest clears them and eng.init no-ops on an initialised engine).
    beforeEach(() => { _resetForTest(); _resetBakedForTest(); setAudioContext(ctx); });
    afterEach(() => { _resetBakedForTest(); delete globalThis.indexedDB; });

    it('plays the baked buffer via a buffer source instead of the procedural layers', () => {
      const bakedBuf = { __baked: 'bitBomb' };
      _setBakedBufferForTest('clusterRocket', 'fire', bakedBuf);
      const before = ctx._counts();
      eng.fire(getWeapon('clusterRocket'));
      const after = ctx._counts();
      expect(after.sources).toBe(before.sources + 1);          // exactly one buffer source: the bake
      expect(after.oscillators).toBe(before.oscillators);      // no procedural tone layers ran
      expect(ctx._lastBufferSource().buffer).toBe(bakedBuf);   // and it was the baked buffer
    });

    it('a dev IndexedDB override still WINS over the baked asset for the same weapon+stage', async () => {
      const bakedBuf = { __baked: 'bitBomb' };
      _setBakedBufferForTest('clusterRocket', 'fire', bakedBuf);
      const overrideBuf = await storeOverride('clusterRocket', 'fire', fakeFile('dev.wav', 'DEV'));
      const before = ctx._counts();
      eng.fire(getWeapon('clusterRocket'));
      const after = ctx._counts();
      expect(after.sources).toBe(before.sources + 1);              // one buffer source...
      expect(ctx._lastBufferSource().buffer).toBe(overrideBuf);    // ...the OVERRIDE, not the bake
      expect(ctx._lastBufferSource().buffer).not.toBe(bakedBuf);
    });

    it('a weapon+stage with a bake but no decoded buffer yet plays procedurally (never throws)', () => {
      // clusterRocket HAS a BAKED_SFX entry, but nothing seeded into the cache = pre-decode state.
      const before = ctx._counts();
      eng.fire(getWeapon('clusterRocket'));
      const after = ctx._counts();
      expect(after.oscillators + after.sources).toBeGreaterThan(before.oscillators + before.sources);
    });

    it('a weapon with NO baked entry is unaffected — plays procedurally even with bakes loaded', () => {
      _setBakedBufferForTest('clusterRocket', 'fire', { __baked: 'bitBomb' });
      const before = ctx._counts();
      eng.fire(getWeapon('autocannon'));   // no bake for autocannon/fire
      const after = ctx._counts();
      expect(after.oscillators).toBeGreaterThan(before.oscillators);  // procedural layers ran
    });

    it('the bake is scoped to fire — clusterRocket impact still plays procedurally', () => {
      _setBakedBufferForTest('clusterRocket', 'fire', { __baked: 'bitBomb' });
      const before = ctx._counts();
      eng.impact('clusterRocket');   // impact stage, no bake
      const after = ctx._counts();
      expect(after.oscillators).toBeGreaterThan(before.oscillators);
    });

    // #175: firing plasmaLance (no dev override) schedules exactly ONE baked buffer source, with
    // the #166 trim applied via start(when, offset≈0, duration≈0.13s) and the #174 fade ramping
    // the gain to 0 within that played window — and NO procedural oscillators. Uses the shipped
    // BAKED_SFX['plasmaLance::fire'] recipe (startMs 0, trimMs 130, fadeOutMs 420) as-is.
    it('plays plasmaLance/fire as a single trimmed+faded baked buffer source, no procedural tones', () => {
      _setBakedBufferForTest('plasmaLance', 'fire', { __baked: 'bassWave' });
      const before = ctx._counts();
      eng.fire(getWeapon('plasmaLance'));
      const after = ctx._counts();
      expect(after.sources).toBe(before.sources + 1);        // exactly one buffer source: the bake
      expect(after.oscillators).toBe(before.oscillators);    // no procedural tone layers ran
      expect(ctx._lastBufferSource().buffer).toEqual({ __baked: 'bassWave' });

      // #166 trim: start(when, offset, duration) — offset≈0s, duration≈0.13s (130ms trim).
      const [, offset, duration] = ctx._lastBufferSourceStart();
      expect(offset).toBeCloseTo(0, 5);
      expect(duration).toBeCloseTo(0.13, 5);

      // #174 fade: one gain node ramps to 0, landing on the end of the played 130ms window. The
      // 420ms fadeOutMs is clamped to the 130ms played duration, so the ramp starts at the very
      // beginning of the window (end - 0.13s) and lands exactly on the trim point (end).
      const fades = ctx._fadeGains();
      expect(fades.length).toBe(1);
      const events = fades[0]._events;
      const endTime = ctx.currentTime + 0.13;
      expect(events[0]).toEqual(['set', 1, expect.closeTo(endTime - 0.13, 5)]);
      expect(events[1]).toEqual(['ramp', 0, expect.closeTo(endTime, 5)]);
    });

    it('plasmaLance impact is unbaked — never plays the baked fire buffer (bake is fire-only)', () => {
      _setBakedBufferForTest('plasmaLance', 'fire', { __baked: 'bassWave' });
      const beforeFire = ctx._counts();
      // Sanity: firing DOES schedule the baked buffer, so the bake is loaded/reachable here...
      eng.fire(getWeapon('plasmaLance'));
      expect(ctx._counts().sources).toBe(beforeFire.sources + 1);
      expect(ctx._lastBufferSource().buffer).toEqual({ __baked: 'bassWave' });

      // ...but the impact stage (a separate, procedurally-silenced cue — its layers are gain:0
      // by design) never routes through the bake: no additional buffer source, no baked buffer.
      const afterFire = ctx._counts();
      eng.impact('plasmaLance');   // impact stage, no bake
      expect(ctx._counts().sources).toBe(afterFire.sources);        // impact scheduled no buffer source
      expect(ctx._lastBufferSource().buffer).toEqual({ __baked: 'bassWave' }); // last source is still the FIRE bake
    });

    // #176: firing pulseLaser (no dev override) schedules exactly ONE baked buffer source with the
    // #166 start+trim window (offset≈0.32s, duration≈0.06s), the #172 processing chain applied —
    // +10c detune ON the source and a reverb ConvolverNode with a 0.25 wet-mix gain — plus a #174
    // fade ramping the gain to 0 within the played window, and ZERO procedural oscillators. This is
    // the first bake to exercise a NON-null baked `processing`. Uses the shipped
    // BAKED_SFX['pulseLaser::fire'] recipe (startMs 320, trimMs 60, fadeOutMs 450, detune 10,
    // reverbMix 0.25, reverbSize 2.3) as-is.
    it('plays pulseLaser/fire as a single start+trimmed baked buffer with detune + reverb + fade, no procedural tones', () => {
      _setBakedBufferForTest('pulseLaser', 'fire', { __baked: 'bassBuzz' });
      const before = ctx._counts();
      eng.fire(getWeapon('pulseLaser'));
      const after = ctx._counts();
      expect(after.sources).toBe(before.sources + 1);        // exactly one buffer source: the bake
      expect(after.oscillators).toBe(before.oscillators);    // no procedural tone layers ran
      const src = ctx._lastBufferSource();
      expect(src.buffer).toEqual({ __baked: 'bassBuzz' });

      // #166 start+trim: start(when, offset≈0.32s, duration≈0.06s → the 320-380ms window).
      const [when, offset, duration] = ctx._lastBufferSourceStart();
      expect(when).toBe(ctx.currentTime);
      expect(offset).toBeCloseTo(0.32, 5);
      expect(duration).toBeCloseTo(0.06, 5);

      // #172 pitch: +10 cents detune applied directly to the source node.
      expect(src.detune.value).toBe(10);

      // #172 reverb: a ConvolverNode with a generated IR, plus a wet-mix gain node at 0.25 and a
      // dry gain at 1 - 0.25 = 0.75 (connectReverb's wet/dry split).
      const convolvers = ctx._convolvers().slice(before.convolvers);
      expect(convolvers.length).toBe(1);
      expect(convolvers[0].buffer).toBeTruthy();             // a generated impulse-response was assigned
      const gainValues = ctx._gainNodes().map((g) => g.gain.value);
      expect(gainValues).toContain(0.25);                    // wet mix
      expect(gainValues).toContain(0.75);                    // dry (1 - mix)

      // #174 fade: one gain node ramps to 0 within the 60ms window. The 450ms fadeOutMs is clamped
      // to the 60ms played duration, so the ramp spans the whole window (end - 0.06s → end).
      const fades = ctx._fadeGains();
      expect(fades.length).toBe(1);
      const events = fades[0]._events;
      const endTime = ctx.currentTime + 0.06;
      expect(events[0]).toEqual(['set', 1, expect.closeTo(endTime - 0.06, 5)]);
      expect(events[1]).toEqual(['ramp', 0, expect.closeTo(endTime, 5)]);
    });

    // #176: the other bakes and pulseLaser's own impact stage are unaffected by the pulseLaser/fire
    // bake — plasmaLance/fire still plays ITS baked buffer, and pulseLaser/impact stays procedural.
    it('leaves plasmaLance/fire and pulseLaser/impact unaffected by the pulseLaser/fire bake', () => {
      _setBakedBufferForTest('pulseLaser', 'fire', { __baked: 'bassBuzz' });
      _setBakedBufferForTest('plasmaLance', 'fire', { __baked: 'bassWave' });

      // plasmaLance/fire still routes to ITS own baked buffer, not pulseLaser's.
      const beforePlasma = ctx._counts();
      eng.fire(getWeapon('plasmaLance'));
      expect(ctx._counts().sources).toBe(beforePlasma.sources + 1);
      expect(ctx._lastBufferSource().buffer).toEqual({ __baked: 'bassWave' });

      // pulseLaser/impact has no bake → plays procedurally, never routing through the baked buffer.
      const beforeImpact = ctx._counts();
      eng.impact('pulseLaser');
      const afterImpact = ctx._counts();
      expect(afterImpact.oscillators + afterImpact.sources)
        .toBeGreaterThan(beforeImpact.oscillators + beforeImpact.sources); // procedural layers ran
      expect(ctx._lastBufferSource().buffer).not.toEqual({ __baked: 'bassBuzz' }); // impact never used the fire bake
    });

    // #174: a baked entry can carry a fadeOutMs (same recipe shape as an override), and it fades
    // through the identical shared playBuffer path. Temporarily attach a trim+fade to the shipped
    // clusterRocket/fire entry (restored afterward) so the assertion doesn't depend on ship data.
    it('applies a fade-out to a BAKED sound too (fadeOutMs on the BAKED_SFX entry)', () => {
      const entry = BAKED_SFX['clusterRocket::fire'];
      const saved = { trimMs: entry.trimMs, fadeOutMs: entry.fadeOutMs };
      entry.trimMs = 500;        // 500ms played window (baked buffers have no .duration in tests)
      entry.fadeOutMs = 90;      // fade the last 90ms
      try {
        _setBakedBufferForTest('clusterRocket', 'fire', { __baked: 'bitBomb' });
        eng.fire(getWeapon('clusterRocket'));
        const fades = ctx._fadeGains();
        expect(fades.length).toBe(1);
        const events = fades[0]._events;
        const endTime = ctx.currentTime + 0.5;
        expect(events[0]).toEqual(['set', 1, expect.closeTo(endTime - 0.09, 5)]);
        expect(events[1]).toEqual(['ramp', 0, expect.closeTo(endTime, 5)]);
      } finally {
        entry.trimMs = saved.trimMs;
        entry.fadeOutMs = saved.fadeOutMs;
      }
    });

    // #184: deathExplosionByCategory previously called playLayers directly, completely bypassing
    // playOverride — so the shipped deathExplosionMassive::fire bake (#180) was dead code at
    // runtime and a mech kill always played the procedural explosion instead. These mirror the
    // clusterRocket bake-precedence tests above, but through eng.deathExplosion('massive') (the
    // actual per-kill call path: ArenaScene's combat.js `_deathFx` → Audio.deathExplosion(category)
    // → AudioEngine.deathExplosion → Sfx.deathExplosionByCategory).
    it('a mech-kill death explosion plays the BAKED buffer instead of procedural layers', () => {
      const bakedBuf = { __baked: 'mechaDamaged2' };
      _setBakedBufferForTest('deathExplosionMassive', 'fire', bakedBuf);
      const before = ctx._counts();
      eng.deathExplosion('massive');
      const after = ctx._counts();
      expect(after.sources).toBe(before.sources + 1);          // exactly one buffer source: the bake
      expect(after.oscillators).toBe(before.oscillators);      // no procedural tone/noise layers ran
      expect(ctx._lastBufferSource().buffer).toBe(bakedBuf);   // and it was the baked buffer
    });

    it('a dev IndexedDB override still wins over the deathExplosionMassive bake', async () => {
      const bakedBuf = { __baked: 'mechaDamaged2' };
      _setBakedBufferForTest('deathExplosionMassive', 'fire', bakedBuf);
      const overrideBuf = await storeOverride('deathExplosionMassive', 'fire', fakeFile('dev.wav', 'DEV'));
      const before = ctx._counts();
      eng.deathExplosion('massive');
      const after = ctx._counts();
      expect(after.sources).toBe(before.sources + 1);              // one buffer source...
      expect(ctx._lastBufferSource().buffer).toBe(overrideBuf);    // ...the OVERRIDE, not the bake
      expect(ctx._lastBufferSource().buffer).not.toBe(bakedBuf);
    });

    // Critical no-regression check: small/medium/large have no baked/override entry (only
    // massive does, from #180), so they must keep firing constantly in normal play through the
    // exact same procedural playLayers path as before this fix.
    it('death explosions with no bake/override (small/medium/large) still play procedurally, unchanged', () => {
      for (const category of ['small', 'medium', 'large']) {
        const before = ctx._counts();
        eng.deathExplosion(category);
        const after = ctx._counts();
        expect(after.oscillators + after.sources).toBeGreaterThan(before.oscillators + before.sources);
      }
    });
  });

  // #179/#185/#267: held-sustain (beamLaser/flamethrower) file override/baked support. #179 added
  // override/bake lookup to startHeld() (which previously went straight to procedural
  // startLoopLayers). The first #185 attempt then tried to LOOP the override/bake buffer itself
  // via manual re-triggering/crossfading — Jackson's playtest feedback was "it sounds so
  // robotic"/"still feels like there's some oscillation happening," so #185's rework instead
  // played the buffer ONCE as an "intro" and handed off permanently to procedural synthesis. That
  // read as broken in practice too ("it plays it once... then keeps playing the procedural sound
  // afterward" — #267 playtest report). #267 (tested below) is the real fix: a genuine NATIVE
  // loop (`AudioBufferSourceNode.loop`/`.loopStart`/`.loopEnd`) — seamless and sample-accurate, so
  // the file itself keeps playing for the whole held duration, no procedural handoff at all.
  describe('held-sustain: native file loop for the whole held duration (#179, #267)', () => {
    const fakeFile = (name, tag) => ({
      name, type: 'audio/wav', arrayBuffer: async () => new TextEncoder().encode(tag).buffer,
    });

    beforeEach(() => { _resetForTest(); _resetBakedForTest(); setAudioContext(ctx); });
    afterEach(() => { _resetBakedForTest(); delete globalThis.indexedDB; });

    it('(a) no override/bake present: startHeld is 100% procedural, unchanged', () => {
      const before = ctx._counts();
      eng.startHeld('leftArm', 'beamLaser');
      const after = ctx._counts();
      // Procedural voices only (oscillator + a noise-layer buffer source, both from
      // startLoopLayers) — nothing plays through the override/bake loop machinery at all, since
      // there's no override/bake file to loop.
      expect(after.oscillators + after.sources).toBeGreaterThan(before.oscillators + before.sources);
      expect(() => eng.stopHeld('leftArm')).not.toThrow();
    });

    it('(b) an override present with no loopStartMs set: loops the WHOLE trimmed startMs..trimMs window natively', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      await setStart('beamLaser', 'fire', 200);   // 200ms in
      await setTrim('beamLaser', 'fire', 500);    // 500ms window from there
      const before = ctx._counts();
      eng.startHeld('leftArm', 'beamLaser');
      const after = ctx._counts();
      expect(after.sources).toBe(before.sources + 1);   // exactly one buffer source — no procedural handoff voice
      const src = ctx._lastBufferSource();
      expect(src.loop).toBe(true);                       // a genuine native loop now, not a one-shot
      expect(src.loopStart).toBeCloseTo(0.2, 5);          // falls back to startMs (no loopStartMs configured)
      expect(src.loopEnd).toBeCloseTo(0.7, 5);            // startMs + trimMs = 0.2 + 0.5
      const [, offset] = ctx._lastBufferSourceStart();
      expect(offset).toBeCloseTo(0.2, 5);                 // first playthrough still starts at startMs
      eng.stopHeld('leftArm');
    });

    it('an override with loopStartMs set loops from that point (not from startMs) once it wraps', async () => {
      await storeOverride('flamethrower', 'fire', fakeFile('roar.wav', 'ROAR'));
      await setStart('flamethrower', 'fire', 100);      // a non-repeatable "wind-up" plays once, from 100ms
      await setTrim('flamethrower', 'fire', 900);       // trimmed window ends at 100 + 900 = 1000ms
      await setLoopStartMs('flamethrower', 'fire', 400); // the repeating region starts at 400ms
      eng.startHeld('rightArm', 'flamethrower');
      const src = ctx._lastBufferSource();
      expect(src.loop).toBe(true);
      const [, offset] = ctx._lastBufferSourceStart();
      expect(offset).toBeCloseTo(0.1, 5);       // first playthrough starts at startMs (the wind-up)
      expect(src.loopStart).toBeCloseTo(0.4, 5); // wraps back to loopStartMs, not startMs
      expect(src.loopEnd).toBeCloseTo(1.0, 5);   // startMs + trimMs
      eng.stopHeld('rightArm');
    });

    it('no start() `duration` arg is passed for a loop — passing one would schedule a hard stop regardless of `.loop`', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      await setTrim('beamLaser', 'fire', 500);
      eng.startHeld('leftArm', 'beamLaser');
      const args = ctx._lastBufferSourceStart();
      expect(args.length).toBe(2);   // (when, offset) only — no duration
      eng.stopHeld('leftArm');
    });

    it('untrimmed (no trimMs): loopEnd is left at its native default (0 → the Web Audio spec treats that as the buffer\'s own end)', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      // No setTrim at all.
      eng.startHeld('leftArm', 'beamLaser');
      expect(ctx._lastBufferSource().loopEnd).toBe(0);
      eng.stopHeld('leftArm');
    });

    it('applies the detune/filter/reverb processing chain (#172) to the loop the same way the one-shot path does', async () => {
      await storeOverride('flamethrower', 'fire', fakeFile('roar.wav', 'ROAR'));
      await setProcessing('flamethrower', 'fire', {
        detune: 150, filterType: 'lowpass', filterFreq: 900, filterQ: 1, reverbMix: 0.3, reverbSize: 1.5,
      });
      const beforeBq = ctx._counts().biquads;
      const beforeConv = ctx._counts().convolvers;
      eng.startHeld('rightArm', 'flamethrower');
      expect(ctx._lastBufferSource().loop).toBe(true);
      expect(ctx._lastBufferSource().detune.value).toBe(150);
      expect(ctx._counts().biquads).toBe(beforeBq + 1);
      expect(ctx._counts().convolvers).toBe(beforeConv + 1);
      eng.stopHeld('rightArm');
    });

    it('(c) stopHeld fades the loop out over the fadeOutMs release and stops the source cleanly — no error if called twice', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      await setTrim('beamLaser', 'fire', 500);
      await setFadeOut('beamLaser', 'fire', 150);   // 150ms release
      eng.startHeld('leftArm', 'beamLaser');
      const loopGain = ctx._gainNodes()[ctx._gainNodes().length - 1];
      expect(() => eng.stopHeld('leftArm')).not.toThrow();
      const events = loopGain._events;
      const rampEvent = events.find((e) => e[0] === 'ramp' && e[1] === 0);
      expect(rampEvent).toBeTruthy();
      expect(rampEvent[2]).toBeCloseTo(ctx.currentTime + 0.15, 5);   // now + releaseSec
      // The source itself is actually stopped (not left looping forever) once the release ramp lands.
      const src = ctx._lastBufferSource();
      expect(src._stopArgs).toBeTruthy();
      expect(src._stopArgs[0]).toBeCloseTo(ctx.currentTime + 0.17, 2);
      // Calling stopHeld again for the same location is a no-op (nothing tracked anymore).
      expect(() => eng.stopHeld('leftArm')).not.toThrow();
    });

    it('falls back to the default release window when no fadeOutMs is set on the override', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      await setTrim('beamLaser', 'fire', 500);
      eng.startHeld('leftArm', 'beamLaser');
      const loopGain = ctx._gainNodes()[ctx._gainNodes().length - 1];
      eng.stopHeld('leftArm');
      const rampEvent = loopGain._events.find((e) => e[0] === 'ramp' && e[1] === 0);
      expect(rampEvent[2]).toBeCloseTo(ctx.currentTime + 0.08, 5);   // 80ms default release
    });

    // #182: the overall volume multiplier also applies to the loop's attack ramp target.
    it('applies the #182 volume to the loop\'s attack ramp target', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      await setTrim('beamLaser', 'fire', 500);
      await setVolume('beamLaser', 'fire', 1.6);
      eng.startHeld('leftArm', 'beamLaser');
      const loopGain = ctx._gainNodes()[ctx._gainNodes().length - 1];
      const expEvent = loopGain._events.find((e) => e[0] === 'exp');
      expect(expEvent).toBeTruthy();
      expect(expEvent[1]).toBe(1.6);   // attack ramps to the volume, not unity
      eng.stopHeld('leftArm');
      const rampEvent = loopGain._events.find((e) => e[0] === 'ramp' && e[1] === 0);
      expect(rampEvent).toBeTruthy();
    });

    it('loop volume unset/1.0 attacks to unity, unchanged from before #182', async () => {
      await storeOverride('beamLaser', 'fire', fakeFile('hum.wav', 'HUM'));
      await setTrim('beamLaser', 'fire', 500);
      eng.startHeld('leftArm', 'beamLaser');
      const loopGain = ctx._gainNodes()[ctx._gainNodes().length - 1];
      const expEvent = loopGain._events.find((e) => e[0] === 'exp');
      expect(expEvent[1]).toBe(1);
      eng.stopHeld('leftArm');
    });

    it('a dev override still wins over a baked loop for the same held weapon+stage', async () => {
      _setBakedBufferForTest('flamethrower', 'fire', { __baked: 'bakedRoar' });
      const overrideBuf = await storeOverride('flamethrower', 'fire', fakeFile('dev-roar.wav', 'DEVROAR'));
      eng.startHeld('leftArm', 'flamethrower');
      expect(ctx._lastBufferSource().buffer).toBe(overrideBuf);
      expect(ctx._lastBufferSource().loop).toBe(true);
      eng.stopHeld('leftArm');
    });

    it('a baked loop plays when no dev override exists for the held weapon+stage', () => {
      // beamLaser has no shipped BAKED_SFX entry yet — temporarily add one (mirrors the existing
      // "applies a fade-out to a BAKED sound too" test's pattern of mutating+restoring a live
      // entry) so this exercises the real getBaked() data shape rather than a bespoke test-only one.
      BAKED_SFX['beamLaser::fire'] = { startMs: 0, trimMs: null, processing: null, fadeOutMs: null };
      try {
        _setBakedBufferForTest('beamLaser', 'fire', { __baked: 'bakedHum' });
        eng.startHeld('leftArm', 'beamLaser');
        expect(ctx._lastBufferSource().buffer).toEqual({ __baked: 'bakedHum' });
        expect(ctx._lastBufferSource().loop).toBe(true);
        eng.stopHeld('leftArm');
      } finally {
        delete BAKED_SFX['beamLaser::fire'];
      }
    });

    it('a baked entry\'s own loopStartMs is honored the same way a live override\'s is', () => {
      BAKED_SFX['flamethrower::fire'] = {
        startMs: 100, trimMs: 300, loopStartMs: 250, processing: null,
      };
      try {
        _setBakedBufferForTest('flamethrower', 'fire', { __baked: 'bakedRoar' });
        eng.startHeld('leftArm', 'flamethrower');
        const [, offset] = ctx._lastBufferSourceStart();
        const src = ctx._lastBufferSource();
        expect(offset).toBeCloseTo(0.1, 5);              // startMs
        expect(src.loopStart).toBeCloseTo(0.25, 5);       // loopStartMs
        expect(src.loopEnd).toBeCloseTo(0.4, 5);          // startMs + trimMs
        eng.stopHeld('leftArm');
      } finally {
        delete BAKED_SFX['flamethrower::fire'];
      }
    });

    it('an override/bake on a non-held weapon has no effect on startHeld (gated on hasHeldSfx first)', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('x.wav', 'X'));
      const before = ctx._counts();
      eng.startHeld('leftArm', 'autocannon');
      expect(ctx._counts()).toEqual(before);   // no voice/source scheduled at all
    });
  });

  // #195: RANDOMIZED VARIANTS — the real end-to-end playback paths (one-shot fire, the
  // held-loop sustain, and the per-kill death-explosion category dispatch) must all resolve a
  // random variant from a stage's pool instead of assuming exactly one override/bake exists.
  describe('randomized variants (#195)', () => {
    const fakeFile = (name, tag) => ({
      name, type: 'audio/wav', arrayBuffer: async () => new TextEncoder().encode(tag).buffer,
    });

    beforeEach(() => { _resetForTest(); _resetBakedForTest(); setAudioContext(ctx); });
    afterEach(() => { _resetBakedForTest(); delete globalThis.indexedDB; });

    it('(c) a one-shot fire cue with a 3-variant override pool resolves EVERY variant across many trials', async () => {
      const bufV0 = await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      const bufV1 = await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      const bufV2 = await storeOverride('autocannon', variantStage('fire', 2), fakeFile('v2.wav', 'V2'));
      const seenBuffers = new Set();
      for (let i = 0; i < 200; i++) {
        eng.fire(getWeapon('autocannon'));
        seenBuffers.add(ctx._lastBufferSource().buffer);
      }
      expect(seenBuffers).toEqual(new Set([bufV0, bufV1, bufV2]));
    });

    it('a one-shot fire cue with only ONE variant always resolves that single buffer (byte-identical to pre-#195)', async () => {
      const buf = await storeOverride('autocannon', 'fire', fakeFile('only.wav', 'ONLY'));
      for (let i = 0; i < 10; i++) {
        eng.fire(getWeapon('autocannon'));
        expect(ctx._lastBufferSource().buffer).toBe(buf);
      }
    });

    it('deterministic pick (mocked Math.random) resolves the exact variant slot, params and all', async () => {
      await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      await setStart('autocannon', variantStage('fire', 1), 42);
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9); // floor(0.9*2) = 1
      try {
        eng.fire(getWeapon('autocannon'));
        expect(ctx._lastBufferSourceStart()[1]).toBeCloseTo(0.042, 5); // variant 1's own startMs
      } finally {
        spy.mockRestore();
      }
    });

    it('(c) the held-sustain loop also picks among a 3-variant override pool', async () => {
      const bufV0 = await storeOverride('beamLaser', 'fire', fakeFile('v0.wav', 'V0'));
      const bufV1 = await storeOverride('beamLaser', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      const bufV2 = await storeOverride('beamLaser', variantStage('fire', 2), fakeFile('v2.wav', 'V2'));
      const seenBuffers = new Set();
      for (let i = 0; i < 200; i++) {
        eng.startHeld('leftArm', 'beamLaser');
        seenBuffers.add(ctx._lastBufferSource().buffer);
        eng.stopHeld('leftArm');
      }
      expect(seenBuffers).toEqual(new Set([bufV0, bufV1, bufV2]));
    });

    it('(c) a mech-kill death explosion picks among a multi-variant BAKED pool for that category', () => {
      BAKED_SFX['deathExplosionMassive::fire'] = [
        { startMs: 0, trimMs: 100, processing: null },
        { startMs: 0, trimMs: 200, processing: null },
      ];
      try {
        _setBakedBufferForTest('deathExplosionMassive', 'fire', { __baked: 'boomA' }, 0);
        _setBakedBufferForTest('deathExplosionMassive', 'fire', { __baked: 'boomB' }, 1);
        const seen = new Set();
        for (let i = 0; i < 200; i++) {
          eng.deathExplosion('massive');
          seen.add(ctx._lastBufferSource().buffer.__baked);
        }
        expect(seen).toEqual(new Set(['boomA', 'boomB']));
      } finally {
        delete BAKED_SFX['deathExplosionMassive::fire'];
      }
    });

    it('a live override pool takes precedence over a baked pool entirely (unchanged #173 precedence)', async () => {
      BAKED_SFX['autocannon::fire'] = [{ startMs: 0 }, { startMs: 0 }];
      try {
        _setBakedBufferForTest('autocannon', 'fire', { __baked: 'bakeA' }, 0);
        _setBakedBufferForTest('autocannon', 'fire', { __baked: 'bakeB' }, 1);
        const overrideBuf = await storeOverride('autocannon', 'fire', fakeFile('dev.wav', 'DEV'));
        for (let i = 0; i < 10; i++) {
          eng.fire(getWeapon('autocannon'));
          expect(ctx._lastBufferSource().buffer).toBe(overrideBuf);
        }
      } finally {
        delete BAKED_SFX['autocannon::fire'];
      }
    });

    it('removeOverrideVariant shrinks the pool that eng.fire draws from', async () => {
      const bufV0 = await storeOverride('autocannon', 'fire', fakeFile('v0.wav', 'V0'));
      await storeOverride('autocannon', variantStage('fire', 1), fakeFile('v1.wav', 'V1'));
      await removeOverrideVariant('autocannon', 'fire', 1);
      for (let i = 0; i < 10; i++) {
        eng.fire(getWeapon('autocannon'));
        expect(ctx._lastBufferSource().buffer).toBe(bufV0);
      }
    });
  });

  // #200 reopened — Jackson's playtest report ("especially with drones... eventually sounds stop
  // and never resume") pointed at a Web Audio node pile-up. The actual root cause turned out to
  // be enemies.js's fire-cue throttle not accounting for a burst weapon's own retrigger tail (see
  // scenes/arena/vehicleFire.test.js's new #200-reopen case), but this suite covers the second,
  // defense-in-depth half of the fix: AudioEngine.tone()/noise() now refuse to create MORE than
  // MAX_ACTIVE_VOICES concurrently in-flight one-shot voices, so no caller bug (this one, or a
  // future one) can pile up Web Audio nodes without bound.
  describe('one-shot voice safety valve (#200 reopen) — caps concurrent node creation', () => {
    it('stops creating new oscillator nodes once the cap is reached, without breaking the engine', () => {
      for (let i = 0; i < 500; i++) {
        eng.tone(eng.sfx, { type: 'sine', freq: 440, dur: 0.05, gain: 0.3 });
      }
      const { oscillators } = ctx._counts();
      // Bounded well below the 500 attempts — the mock context's nodes never fire `onended` (no
      // real audio clock driving them), so every one of the 500 calls looks "still in flight" and
      // the cap holds firm well before 500.
      expect(oscillators).toBeGreaterThan(0);       // some genuinely got through before the cap
      expect(oscillators).toBeLessThan(500);
      expect(oscillators).toBeLessThanOrEqual(128);  // never exceeds MAX_ACTIVE_VOICES
      // A silent drop, not a broken engine — the context/engine keep working normally.
      expect(eng.ctx.state).toBe('running');
      expect(eng.ready).toBe(true);
    });

    it('also caps noise-voice (buffer source) creation the same way', () => {
      for (let i = 0; i < 500; i++) {
        eng.noise(eng.sfx, { dur: 0.05, gain: 0.3 });
      }
      expect(ctx._counts().sources).toBeLessThanOrEqual(128);
    });

    it('frees a slot once a voice genuinely finishes, letting a subsequent voice through', () => {
      for (let i = 0; i < 128; i++) eng.tone(eng.sfx, { type: 'sine', freq: 440, dur: 0.05, gain: 0.3 });
      const atCap = ctx._counts().oscillators;
      expect(atCap).toBe(128);
      expect(eng._activeVoices).toBe(128);

      eng.tone(eng.sfx, { type: 'sine', freq: 440, dur: 0.05, gain: 0.3 });
      expect(ctx._counts().oscillators).toBe(atCap);   // still capped — nothing has ended yet

      // Simulate a real AudioContext firing `onended` once the oldest voice's scheduled stop()
      // time passes (AudioEngine._trackVoice wires exactly this decrement onto every voice it
      // creates) — the mock context never drives this itself since it has no real audio clock.
      eng._activeVoices -= 1;
      eng.tone(eng.sfx, { type: 'sine', freq: 440, dur: 0.05, gain: 0.3 });
      expect(ctx._counts().oscillators).toBe(atCap + 1);   // a slot freed up, so this one got through
    });
  });
});
