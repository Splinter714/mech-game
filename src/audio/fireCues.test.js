// #200 playtest follow-up ("enemy weapon fire should probably be VERY slightly quieter than
// player fire?"): scheduleFireCues grew an optional `gainScale` param (default 1, i.e.
// unchanged for the player's own call site in scenes/arena/firing.js) that the two enemy call
// sites (scenes/arena/enemies.js) pass as ENEMY_FIRE_GAIN_SCALE. These tests verify the
// mechanism end to end: the constant is a small-but-real reduction, scheduleFireCues threads
// it through to Audio.fire/Audio.trajectory, and (lower down) it actually lands as a quieter
// recorded gain envelope through both the procedural-layers path and the buffer-override path.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scheduleFireCues, ENEMY_FIRE_GAIN_SCALE } from './fireCues.js';
import { Audio } from './index.js';
import { AudioEngine } from './AudioEngine.js';
import { planEmissions } from '../data/delivery.js';
import { getWeapon } from '../data/weapons.js';
import { playLayers } from './sfxLayers.js';

function fakeScene() {
  const calls = [];
  return {
    calls,
    time: {
      delayedCall(delay, cb) { calls.push({ delay, cb }); },
    },
  };
}

describe('ENEMY_FIRE_GAIN_SCALE', () => {
  it('is a small, real reduction — quieter but not muted, "VERY slightly" per playtest ask', () => {
    expect(ENEMY_FIRE_GAIN_SCALE).toBeLessThan(1);
    expect(ENEMY_FIRE_GAIN_SCALE).toBeGreaterThan(0.7); // not a heavy-handed cut
  });
});

describe('scheduleFireCues gainScale threading', () => {
  let fireSpy, trajectorySpy;
  beforeEach(() => {
    fireSpy = vi.spyOn(Audio, 'fire').mockImplementation(() => {});
    trajectorySpy = vi.spyOn(Audio, 'trajectory').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to gainScale 1 (player call sites are unaffected)', () => {
    const w = getWeapon('machineGun');
    const plan = planEmissions(w);
    scheduleFireCues(fakeScene(), w, plan, true);
    expect(fireSpy).toHaveBeenCalledWith(w, 1);
  });

  it('passes ENEMY_FIRE_GAIN_SCALE straight through to Audio.fire for enemy-sourced calls', () => {
    const w = getWeapon('machineGun');
    const plan = planEmissions(w);
    scheduleFireCues(fakeScene(), w, plan, true, ENEMY_FIRE_GAIN_SCALE);
    expect(fireSpy).toHaveBeenCalledWith(w, ENEMY_FIRE_GAIN_SCALE);
  });

  it('retriggers burst sub-shots with the same gainScale', () => {
    // A weapon whose plan has a delay:0 shot AND at least one later shot exercises the
    // retrigger loop; fabricate a plan directly rather than depending on a specific weapon's
    // burst config remaining unchanged.
    const w = { id: 'burstTestWeapon' };
    const plan = { shots: [{ delay: 0 }, { delay: 50 }, { delay: 100 }] };
    const scene = fakeScene();
    scheduleFireCues(scene, w, plan, true, ENEMY_FIRE_GAIN_SCALE);
    expect(fireSpy).toHaveBeenCalledWith(w, ENEMY_FIRE_GAIN_SCALE);
    // Two later sub-shots (delay 50, 100) should each have scheduled a delayedCall retrigger.
    expect(scene.calls.filter((c) => c.delay > 0).length).toBeGreaterThanOrEqual(2);
    fireSpy.mockClear();
    for (const c of scene.calls) c.cb();
    for (const call of fireSpy.mock.calls) {
      expect(call[1]).toBe(ENEMY_FIRE_GAIN_SCALE);
    }
  });

  it('no-ops for a held/looping weapon regardless of gainScale (flamethrower)', () => {
    const w = getWeapon('flamethrower');
    if (!w) return; // weapon id may differ; skip rather than false-fail if renamed
    const plan = planEmissions(w);
    scheduleFireCues(fakeScene(), w, plan, true, ENEMY_FIRE_GAIN_SCALE);
    expect(fireSpy).not.toHaveBeenCalled();
  });
});

describe('playLayers gainScale (procedural path)', () => {
  it('scales every layer\'s gain by gainScale without mutating the source layers', () => {
    const toneCalls = [];
    const noiseCalls = [];
    const e = { tone: (bus, l) => toneCalls.push(l), noise: (bus, l) => noiseCalls.push(l) };
    const layers = [
      { kind: 'tone', gain: 0.4 },
      { kind: 'noise', gain: 0.2 },
    ];
    playLayers(e, 'bus', layers, 0.85);
    expect(toneCalls[0].gain).toBeCloseTo(0.4 * 0.85, 6);
    expect(noiseCalls[0].gain).toBeCloseTo(0.2 * 0.85, 6);
    // Original layer objects are untouched (no shared-reference mutation).
    expect(layers[0].gain).toBe(0.4);
    expect(layers[1].gain).toBe(0.2);
  });

  it('is a strict passthrough at gainScale 1 (default) — same objects, same gains', () => {
    const toneCalls = [];
    const e = { tone: (bus, l) => toneCalls.push(l), noise: () => {} };
    const layers = [{ kind: 'tone', gain: 0.4 }];
    playLayers(e, 'bus', layers);
    expect(toneCalls[0]).toBe(layers[0]); // exact same object reference — no spread at all
  });
});

describe('sfx.fire gainScale end-to-end through a mock AudioEngine', () => {
  function mockContext() {
    const gainNodes = [];
    const gainParam = (events) => ({
      value: 1,
      setValueAtTime(v, t) { events.push(['set', v, t]); },
      linearRampToValueAtTime(v, t) { events.push(['ramp', v, t]); },
      exponentialRampToValueAtTime(v, t) { events.push(['exp', v, t]); },
      cancelScheduledValues() {},
    });
    const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
    return {
      state: 'running', currentTime: 1.0, sampleRate: 48000, destination: { connect: (d) => d },
      createGain: () => { const events = []; const n = { gain: gainParam(events), _events: events, connect: (d) => d, disconnect() {} }; gainNodes.push(n); return n; },
      createBiquadFilter: () => ({ type: '', frequency: param(), Q: param(), connect: (d) => d, disconnect() {} }),
      createWaveShaper: () => ({ curve: null, oversample: 'none', connect: (d) => d }),
      createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), connect: (d) => d }),
      createOscillator: () => ({ type: '', frequency: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }),
      createBufferSource: () => ({ buffer: null, detune: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }),
      createBuffer: (_c, len) => ({ getChannelData: () => new Float32Array(len) }),
      resume: () => Promise.resolve(),
      _gainNodes: () => gainNodes,
    };
  }

  it('records a lower target gain for a scaled fire cue than an unscaled one', () => {
    const eng1 = new AudioEngine();
    const ctx1 = mockContext();
    eng1.init(ctx1);
    const weapon = getWeapon('machineGun');
    eng1.fire(weapon, 1);
    const expEvents1 = ctx1._gainNodes().flatMap((g) => g._events.filter((e) => e[0] === 'exp'));
    const maxGain1 = Math.max(...expEvents1.map((e) => e[1]));

    const eng2 = new AudioEngine();
    const ctx2 = mockContext();
    eng2.init(ctx2);
    eng2.fire(weapon, ENEMY_FIRE_GAIN_SCALE);
    const expEvents2 = ctx2._gainNodes().flatMap((g) => g._events.filter((e) => e[0] === 'exp'));
    const maxGain2 = Math.max(...expEvents2.map((e) => e[1]));

    expect(maxGain2).toBeLessThan(maxGain1);
    expect(maxGain2).toBeCloseTo(maxGain1 * ENEMY_FIRE_GAIN_SCALE, 5);
  });
});
