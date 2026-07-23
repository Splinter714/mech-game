// #197: the Weapon Lab sound panel used to auto-play a live preview (_previewThrottled) on
// EVERY edit — trim sliders, pitch/detune, volume, fade-out, processing knobs, waveform/filter
// pickers, the mixer's gain slider — with no way to turn it off. This adds an "Auto-preview"
// toggle (`this.autoPreviewEnabled`, OFF by default) that gates _previewThrottled without
// touching the explicit ▶ test fire button (_testFire → _playStage directly).
//
// WeaponSfxPanel is a Phaser-scene-bound UI class with no existing test coverage (it's normally
// exercised live via GarageScene), so this test constructs it against a minimal fake `scene` +
// fake `document`/`localStorage` — just enough surface for the constructor and the methods under
// test (_previewThrottled/_playStage/_testFire) to run, matching the panel's actual code paths
// rather than re-implementing the gating logic separately. `weaponId` is set directly (bypassing
// the heavy _build() render path that needs Slider/Audio.getSfxParams etc.) since none of that
// is relevant to whether a preview call happens: _playStage's own gating is exercised for real,
// just without any procedural layers wired up. (#171 later removed the mute/solo layer that
// _playStage used to consult before playing at all.)
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('phaser', () => ({
  default: { Math: { Clamp: (v, min, max) => Math.min(Math.max(v, min), max) } },
}));

import { Audio } from '../audio/index.js';
import { WeaponSfxPanel } from './weaponSfxPanel.js';

function makeFakeElement() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    remove() {},
    setAttribute() {},
    click() {},
    files: [],
    value: '',
  };
}

function makeFakeDocument() {
  const body = makeFakeElement();
  return {
    createElement: () => makeFakeElement(),
    body,
  };
}

function makeFakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
}

function makeRectangleStub() {
  const stub = {};
  stub.setOrigin = () => stub;
  stub.setStrokeStyle = () => stub;
  stub.setInteractive = () => stub;
  stub.setFillStyle = () => stub;
  stub.setAlpha = () => stub;
  stub.disableInteractive = () => {};
  stub.on = () => {};
  return stub;
}

function makeTextStub() {
  const stub = {};
  stub.setOrigin = () => stub;
  stub.setScrollFactor = () => stub;
  stub.setText = () => stub;
  stub.destroy = () => {};
  return stub;
}

function makeFakeScene() {
  return {
    add: {
      container: () => ({ add() {}, removeAll() {}, setMask() {}, destroy() {}, y: 0 }),
      text: () => makeTextStub(),
      rectangle: () => makeRectangleStub(),
    },
    make: {
      graphics: () => ({
        clear() { return this; },
        fillStyle() { return this; },
        fillRect() { return this; },
        createGeometryMask: () => ({}),
        destroy() {},
      }),
    },
    input: { on() {}, off() {} },
    time: { now: 0, delayedCall(_delay, fn) { fn(); } },
    tweens: { add() {} },
    registry: { get: () => 1 },
  };
}

function makePanel() {
  const scene = makeFakeScene();
  const panel = new WeaponSfxPanel(scene, { x: 0, y: 0, w: 200, h: 200 });
  // Bypass the full _build() render path (Slider/Audio.getSfxParams/override rows aren't
  // relevant here) — set the target directly so _playStage/_previewThrottled/_testFire have a
  // weaponId to operate on, same as setWeapon() would leave in place, minus the actual render.
  panel.weaponId = 'testWeapon';
  return panel;
}

describe('WeaponSfxPanel auto-preview toggle (#197)', () => {
  beforeEach(() => {
    globalThis.document = makeFakeDocument();
    globalThis.localStorage = makeFakeLocalStorage();
    vi.restoreAllMocks();
  });

  it('defaults to off on a fresh panel/session', () => {
    const panel = makePanel();
    expect(panel.autoPreviewEnabled).toBe(false);
  });

  it('does NOT preview an edit while the toggle is off', () => {
    const panel = makePanel();
    const fireSpy = vi.spyOn(Audio, 'fire').mockImplementation(() => {});
    panel._previewThrottled('fire');
    expect(fireSpy).not.toHaveBeenCalled();
  });

  it('DOES preview an edit once the toggle is switched on', () => {
    const panel = makePanel();
    const fireSpy = vi.spyOn(Audio, 'fire').mockImplementation(() => {});
    panel._toggleAutoPreview();
    expect(panel.autoPreviewEnabled).toBe(true);
    panel._previewThrottled('fire');
    expect(fireSpy).toHaveBeenCalledTimes(1);
  });

  it('the explicit test-fire button still previews regardless of the toggle state', () => {
    const panel = makePanel();
    const fireSpy = vi.spyOn(Audio, 'fire').mockImplementation(() => {});
    const trajectorySpy = vi.spyOn(Audio, 'trajectory').mockImplementation(() => {});
    const impactSpy = vi.spyOn(Audio, 'impact').mockImplementation(() => {});

    expect(panel.autoPreviewEnabled).toBe(false);   // toggle stays off
    panel._testFire();
    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(trajectorySpy).toHaveBeenCalledTimes(1);
    expect(impactSpy).toHaveBeenCalledTimes(1);
  });

  it('persists the toggle choice across panel instances via localStorage', () => {
    const panelA = makePanel();
    panelA._toggleAutoPreview();
    expect(panelA.autoPreviewEnabled).toBe(true);

    const panelB = makePanel();   // fresh instance, same fake localStorage
    expect(panelB.autoPreviewEnabled).toBe(true);
  });
});
