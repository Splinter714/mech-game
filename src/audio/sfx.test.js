// #264 — verifies the positional-audio node-wiring in sfx.js (positionalBus): a call site that
// passes a full `{ x, y, listenerX, listenerY }` pair gets an extra GainNode (distance falloff)
// + StereoPannerNode (pan) spliced into the chain with the values data/positionalAudio.js's
// distanceGain/stereoPan compute; a call site that passes nothing (or an incomplete pair) is a
// strict no-op — the existing playback tests (AudioEngine.test.js, fireCues.test.js) don't pass
// a position at all, so this also proves that graceful fallback in the code path they exercise.
import { describe, it, expect } from 'vitest';
import { AudioEngine } from './AudioEngine.js';
import { getWeapon } from '../data/weapons.js';
import { distanceGain, stereoPan } from '../data/positionalAudio.js';

function mockContext({ withPanner = true } = {}) {
  const gainNodes = [];
  const panners = [];
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });
  const gainParam = () => ({ value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });
  const ctx = {
    state: 'running', currentTime: 1.0, sampleRate: 48000, destination: { connect: (d) => d },
    createGain: () => { const n = { gain: gainParam(), connect: (d) => d, disconnect() {} }; gainNodes.push(n); return n; },
    createBiquadFilter: () => ({ type: '', frequency: param(), Q: param(), connect: (d) => d, disconnect() {} }),
    createWaveShaper: () => ({ curve: null, oversample: 'none', connect: (d) => d }),
    createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), connect: (d) => d }),
    createOscillator: () => ({ type: '', frequency: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }),
    createBufferSource: () => ({ buffer: null, detune: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }),
    createBuffer: (_c, len) => ({ getChannelData: () => new Float32Array(len) }),
    resume: () => Promise.resolve(),
    _gainNodes: () => gainNodes,
    _panners: () => panners,
  };
  if (withPanner) {
    ctx.createStereoPanner = () => { const n = { pan: { value: 0 }, connect: (d) => d, disconnect() {} }; panners.push(n); return n; };
  }
  return ctx;
}

describe('positional audio wiring in sfx.js', () => {
  it('inserts a StereoPannerNode with the computed pan value when a full position pair is given', () => {
    const eng = new AudioEngine();
    const ctx = mockContext();
    eng.init(ctx);
    const weapon = getWeapon('machineGun');
    const pos = { x: 300, y: 0, listenerX: 0, listenerY: 0 };
    eng.fire(weapon, 1, pos);
    expect(ctx._panners().length).toBeGreaterThan(0);
    expect(ctx._panners()[0].pan.value).toBeCloseTo(stereoPan(pos.x, pos.y, pos.listenerX, pos.listenerY), 6);
  });

  it('sets the positional gain node to the computed distance falloff', () => {
    const eng = new AudioEngine();
    const ctx = mockContext();
    eng.init(ctx);
    const weapon = getWeapon('machineGun');
    const pos = { x: 1200, y: 0, listenerX: 0, listenerY: 0 };
    const gainCountBefore = ctx._gainNodes().length;
    eng.fire(weapon, 1, pos);
    const newGains = ctx._gainNodes().slice(gainCountBefore);
    const expected = distanceGain(pos.x, pos.y, pos.listenerX, pos.listenerY);
    expect(newGains.some((g) => Math.abs(g.gain.value - expected) < 1e-6)).toBe(true);
  });

  it('does not throw and still schedules a positional gain node even without createStereoPanner (older-browser/mock fallback)', () => {
    const eng = new AudioEngine();
    const ctx = mockContext({ withPanner: false });
    eng.init(ctx);
    const weapon = getWeapon('machineGun');
    const pos = { x: 300, y: 0, listenerX: 0, listenerY: 0 };
    const gainCountBefore = ctx._gainNodes().length;
    expect(() => eng.fire(weapon, 1, pos)).not.toThrow();
    expect(ctx._gainNodes().length).toBeGreaterThan(gainCountBefore);
  });

  it('is a strict no-op (no extra positional nodes) when no position is passed', () => {
    const eng = new AudioEngine();
    const ctx = mockContext();
    eng.init(ctx);
    const weapon = getWeapon('machineGun');
    eng.fire(weapon, 1);
    expect(ctx._panners().length).toBe(0);
  });

  it('is a strict no-op when the position pair is incomplete (missing listener half)', () => {
    const eng = new AudioEngine();
    const ctx = mockContext();
    eng.init(ctx);
    const weapon = getWeapon('machineGun');
    eng.fire(weapon, 1, { x: 100, y: 100 }); // no listenerX/listenerY
    expect(ctx._panners().length).toBe(0);
  });

  it('applies positional treatment to impact, explosion, and deathExplosion the same way', () => {
    const eng = new AudioEngine();
    const ctx = mockContext();
    eng.init(ctx);
    const pos = { x: -400, y: 0, listenerX: 0, listenerY: 0 };
    eng.impact('machineGun', pos);
    eng.explosion(1, pos);
    eng.deathExplosion('medium', pos);
    // Three positional cues, each contributing at least one panner.
    expect(ctx._panners().length).toBeGreaterThanOrEqual(3);
    for (const p of ctx._panners()) {
      expect(p.pan.value).toBeCloseTo(stereoPan(pos.x, pos.y, pos.listenerX, pos.listenerY), 6);
    }
  });

  // #269 playtest follow-up — alert tower spool-up warning pulse: same positional treatment as
  // every other world-anchored cue above, and safe to call across the full 0..1 fraction range
  // (bases.js `_updateAlertTowers` drives it straight from the countdown's own progress).
  it('alertPulse is positional like the other world-anchored cues, and never throws across the fraction range', () => {
    const eng = new AudioEngine();
    const ctx = mockContext();
    eng.init(ctx);
    const pos = { x: 250, y: 0, listenerX: 0, listenerY: 0 };
    for (const fraction of [0, 0.25, 0.5, 0.99, 1]) {
      expect(() => eng.alertPulse(fraction, pos)).not.toThrow();
    }
    expect(ctx._panners().length).toBeGreaterThan(0);
    for (const p of ctx._panners()) {
      expect(p.pan.value).toBeCloseTo(stereoPan(pos.x, pos.y, pos.listenerX, pos.listenerY), 6);
    }
  });

  it('alertPulse is a strict no-op (no positional nodes) with no position passed', () => {
    const eng = new AudioEngine();
    const ctx = mockContext();
    eng.init(ctx);
    const panCountBefore = ctx._panners().length;
    expect(() => eng.alertPulse(0.5)).not.toThrow();
    expect(ctx._panners().length).toBe(panCountBefore);
  });
});
