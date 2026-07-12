import { describe, it, expect, beforeEach } from 'vitest';
import { isAudible, applyPreviewMuting } from './previewMuting.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { getWeapon } from '../data/weapons.js';

// #171: the SFX tuner's mixer mute/solo buttons "did nothing." Root cause was NOT the muting
// mechanism (it works — proven below) but that toggling them never replayed a preview, so the
// change was inaudible until a manual test-fire; the toggles now call _playStage. These tests
// lock in the mechanism itself: muting a component must actually remove its voice from the
// PLAYED cue, solo must silence all non-soloed, and the STORED gain must never be left mutated
// (copy/reset/persist depend on that invariant).

// Minimal Web Audio mock: a voice = one createOscillator (tone) or createBufferSource (noise).
// tone()/noise() skip creating a voice when gain <= 0, so a muted layer schedules nothing.
function mockContext() {
  let oscillators = 0, sources = 0;
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  const node = () => ({ connect: (d) => d, disconnect() {} });
  return {
    state: 'running', currentTime: 1.0, sampleRate: 48000, destination: node(),
    createGain: () => ({ gain: param(), connect: (d) => d, disconnect() {} }),
    createWaveShaper: () => ({ curve: null, oversample: 'none', connect: (d) => d }),
    createBiquadFilter: () => ({ type: '', frequency: param(), Q: param(), connect: (d) => d, disconnect() {} }),
    createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), connect: (d) => d }),
    createOscillator: () => { oscillators++; return { type: '', frequency: param(), connect: (d) => d, start() {}, stop() {}, disconnect() {} }; },
    createBufferSource: () => { sources++; return { buffer: null, loop: false, connect: (d) => d, start() {}, stop() {}, disconnect() {} }; },
    createBuffer: (_c, len) => ({ getChannelData: () => new Float32Array(len) }),
    resume: () => Promise.resolve(),
    _voices: () => oscillators + sources,
  };
}

// Rebuild the panel's `_components` list from the live params the playback path also reads —
// this is what makes muting affect the real sound: same layer object references, no copies.
function componentsFor(eng, weaponId) {
  const params = eng.getSfxParams(weaponId);
  const comps = [];
  for (const stage of ['fire', 'trajectory', 'impact']) {
    (params[stage] || []).forEach((layer, li) => comps.push({ stage, li, layer }));
  }
  return comps;
}

describe('previewMuting (#171) — audibility rule', () => {
  it('is audible when nothing is muted or soloed', () => {
    expect(isAudible('fire:0', new Set(), new Set())).toBe(true);
  });
  it('a muted component is inaudible', () => {
    expect(isAudible('fire:0', new Set(['fire:0']), new Set())).toBe(false);
    expect(isAudible('fire:1', new Set(['fire:0']), new Set())).toBe(true);
  });
  it('soloing anything silences every non-soloed component, ignoring mute state', () => {
    const soloed = new Set(['fire:2']);
    expect(isAudible('fire:2', new Set(), soloed)).toBe(true);
    expect(isAudible('fire:0', new Set(), soloed)).toBe(false);
    // a soloed-but-also-muted component still sounds (solo wins for the soloed key)
    expect(isAudible('fire:2', new Set(['fire:2']), soloed)).toBe(true);
  });
});

describe('previewMuting (#171) — mechanism against the real AudioEngine', () => {
  let eng, ctx;
  beforeEach(() => { eng = new AudioEngine(); ctx = mockContext(); eng.init(ctx); });

  it('muting a fire layer removes exactly that layer\'s voice from the played cue', () => {
    const comps = componentsFor(eng, 'autocannon');   // 4 audible fire layers
    const before = ctx._voices();
    eng.fire(getWeapon('autocannon'));
    const baseline = ctx._voices() - before;
    expect(baseline).toBe(4);

    const muted = new Set(['fire:0']);
    const b2 = ctx._voices();
    const restore = applyPreviewMuting(comps, ['fire'], muted, new Set());
    eng.fire({ id: 'autocannon' });
    restore();
    expect(ctx._voices() - b2).toBe(3);   // one fewer voice — the muted layer really dropped out
  });

  it('soloing one layer silences all the others in the played cue', () => {
    const comps = componentsFor(eng, 'autocannon');
    const before = ctx._voices();
    const restore = applyPreviewMuting(comps, ['fire'], new Set(), new Set(['fire:2']));
    eng.fire({ id: 'autocannon' });
    restore();
    expect(ctx._voices() - before).toBe(1);   // only the soloed layer sounded
  });

  it('never leaves the STORED gain mutated (copy/reset/persist see the true values)', () => {
    const comps = componentsFor(eng, 'autocannon');
    const storedBefore = eng.getSfxParams('autocannon').fire.map((l) => l.gain);
    expect(storedBefore[0]).toBeGreaterThan(0);

    const restore = applyPreviewMuting(comps, ['fire'], new Set(['fire:0', 'fire:1']), new Set());
    // mid-preview the live layers read 0 (that's the point) …
    expect(eng.getSfxParams('autocannon').fire[0].gain).toBe(0);
    eng.fire({ id: 'autocannon' });
    restore();
    // … but the moment the cue is scheduled and restored, the stored values are back, unchanged.
    expect(eng.getSfxParams('autocannon').fire.map((l) => l.gain)).toEqual(storedBefore);
  });
});
