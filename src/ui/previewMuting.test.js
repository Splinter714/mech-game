import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAudible, isStageAudible, applyPreviewMuting } from './previewMuting.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { getWeapon } from '../data/weapons.js';
import { _setBakedBufferForTest, _resetForTest as _resetBakedForTest } from '../audio/bakedSfx.js';

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

describe('previewMuting (#171) — isStageAudible (a stage that bypasses procedural gain)', () => {
  it('a stage is audible when nothing mutes it out', () => {
    const comps = [{ stage: 'fire', li: 0, layer: { gain: 1 } }];
    expect(isStageAudible('fire', comps, new Set(), new Set())).toBe(true);
  });
  it('a stage with every one of its own components muted is NOT audible', () => {
    const comps = [
      { stage: 'fire', li: 0, layer: { gain: 1 } },
      { stage: 'fire', li: 1, layer: { gain: 1 } },
    ];
    expect(isStageAudible('fire', comps, new Set(['fire:0', 'fire:1']), new Set())).toBe(false);
  });
  it('a stage with at least one un-muted component IS audible', () => {
    const comps = [
      { stage: 'fire', li: 0, layer: { gain: 1 } },
      { stage: 'fire', li: 1, layer: { gain: 1 } },
    ];
    expect(isStageAudible('fire', comps, new Set(['fire:0']), new Set())).toBe(true);
  });
  it('soloing a component in a DIFFERENT stage silences this whole stage', () => {
    const comps = [
      { stage: 'fire', li: 0, layer: { gain: 1 } },
      { stage: 'impact', li: 0, layer: { gain: 1 } },
    ];
    expect(isStageAudible('fire', comps, new Set(), new Set(['impact:0']))).toBe(false);
    expect(isStageAudible('impact', comps, new Set(), new Set(['impact:0']))).toBe(true);
  });
  it('a stage with no components of its own is always treated as audible', () => {
    const comps = [{ stage: 'impact', li: 0, layer: { gain: 1 } }];
    expect(isStageAudible('fire', comps, new Set(), new Set())).toBe(true);
  });
});

describe('previewMuting (#171 re-fix) — mute/solo must silence a stage even when playback bypasses procedural layers entirely (a live override or a shipped bake)', () => {
  let eng, ctx;
  beforeEach(() => { eng = new AudioEngine(); ctx = mockContext(); eng.init(ctx); });
  afterEach(() => { _resetBakedForTest(); });

  // plasmaLance's `fire` stage ships a real baked sound (#175) — sfx.js's fire() checks
  // playOverride/getBaked FIRST and, when a bake is decoded, plays that buffer and returns
  // WITHOUT ever touching plasmaLance's procedural fire layers. This is exactly the scenario
  // that made the panel's original #171 fix (which only zeroed procedural `layer.gain`) look
  // broken again: muting/soloing a baked stage's mixer row had zero audible effect. The panel
  // must skip the Audio.fire() call outright — proven here by asserting no buffer-source voice
  // gets scheduled at all when the (baked) stage is muted out.
  it('muting out a BAKED stage prevents the buffer from ever being scheduled', () => {
    const fakeBuffer = { duration: 1, numberOfChannels: 1, sampleRate: 48000 };
    _setBakedBufferForTest('plasmaLance', 'fire', fakeBuffer);

    const comps = componentsFor(eng, 'plasmaLance'); // procedural fire layer(s), now bypassed
    const before = ctx._voices();

    // Un-muted: the baked buffer DOES play (a createBufferSource voice is scheduled).
    if (isStageAudible('fire', comps, new Set(), new Set())) eng.fire({ id: 'plasmaLance' });
    expect(ctx._voices() - before).toBeGreaterThan(0);

    // Mute every component belonging to plasmaLance's fire stage — the stage must not play at
    // all now, i.e. the panel must skip calling Audio.fire() entirely.
    const muted = new Set(comps.filter((c) => c.stage === 'fire').map((c) => `${c.stage}:${c.li}`));
    const b2 = ctx._voices();
    if (isStageAudible('fire', comps, muted, new Set())) eng.fire({ id: 'plasmaLance' });
    expect(ctx._voices() - b2).toBe(0);   // no voice scheduled — the mute genuinely silenced it
  });

  it('soloing a DIFFERENT stage silences a baked stage the same way', () => {
    const fakeBuffer = { duration: 1, numberOfChannels: 1, sampleRate: 48000 };
    _setBakedBufferForTest('plasmaLance', 'fire', fakeBuffer);
    const comps = componentsFor(eng, 'plasmaLance');

    const soloedElsewhere = new Set(['impact:0']);
    const before = ctx._voices();
    if (isStageAudible('fire', comps, new Set(), soloedElsewhere)) eng.fire({ id: 'plasmaLance' });
    expect(ctx._voices() - before).toBe(0);
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
