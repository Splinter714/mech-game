// #433 (re-architecture, then simplified from a blink to steady on/off) REGRESSION: the reload
// indicator must not change the shield outline's shape.
//
// The bug this proves fixed: the previous impl swapped the whole weapon-carrying part sprite to a
// baked "_muzzleOff" texture while reloading. The shield outline (shieldOutline.js) follows each part
// sprite's LIVE texture key every frame and maps it through `texMap` to the body-only `_shield` shell
// — but that map only knows the NORMAL key, so a swapped-in "_muzzleOff" key MISSED the map and the
// shell fell back to the full (gun-bearing) texture, changing the shield's SHAPE mid-reload. The
// re-architecture moves the indicator to a separate glow-overlay sprite's VISIBILITY, so the part
// texture is CONSTANT — these tests assert exactly that constancy and its consequence for the outline.
import { describe, it, expect, vi } from 'vitest';

// shieldOutline.js imports Phaser only for a blend-mode constant (not exercised here); stub it as the
// sibling shieldOutline.test.js does so the module imports under vitest's node env.
vi.mock('phaser', () => ({ default: {} }));

import { AmmoIndicatorsMixin } from './ammoIndicators.js';
import { updateShieldOutline } from './shieldOutline.js';

// A limited-ammo left-arm weapon, in the given reload state.
function mechWith(reloading) {
  return {
    weapons: () => [{ location: 'leftArm', online: true, ammo: 0, reloading }],
  };
}

function fakeOverlay() {
  return { visible: true };
}

// A part sprite the shield outline follows: a CONSTANT texture key + a setTexture spy so we can prove
// the reload indicator never swaps it. Origin/size fields are what updateShieldOutline reads to
// re-pose the shell.
function fakePart(key) {
  return {
    texture: { key },
    setTexture: vi.fn(function (k) { this.texture = { key: k }; return this; }),
    originX: 0.5, originY: 0.5, displayWidth: 40, displayHeight: 40, x: 0, y: 0, rotation: 0,
  };
}

function fakeOutlineSprite() {
  return {
    visible: false,
    texture: { key: 'unset' },
    setVisible: vi.fn(function (v) { this.visible = v; return this; }),
    setTexture: vi.fn(function (k) { this.texture = { key: k }; return this; }),
    setPosition: vi.fn(function () { return this; }),
    setAlpha: vi.fn(function () { return this; }),
    setScale: vi.fn(function () { return this; }),
    setOrigin: vi.fn(function () { return this; }),
    rotation: 0,
  };
}

function sceneWith(view, reloading) {
  const scene = { players: [{ mech: mechWith(reloading), view, dead: false }] };
  return scene;
}

describe('reload indicator leaves the part texture constant (#433 regression)', () => {
  it('toggles the glow OVERLAY visibility but never touches the part texture', () => {
    const armL = fakePart('pm_leftArm');
    const view = { armL, glow: { leftArm: fakeOverlay() } };

    AmmoIndicatorsMixin._drawAmmoIndicators.call(sceneWith(view, true));
    expect(view.glow.leftArm.visible).toBe(false);       // reloading → glow hidden
    AmmoIndicatorsMixin._drawAmmoIndicators.call(sceneWith(view, false));
    expect(view.glow.leftArm.visible).toBe(true);         // ready → glow shown

    // The whole point: the part sprite's texture was never swapped in either state.
    expect(armL.setTexture).not.toHaveBeenCalled();
    expect(armL.texture.key).toBe('pm_leftArm');
  });

  it("keeps the shield outline on the body-only '_shield' shell across BOTH reload states", () => {
    const armL = fakePart('pm_leftArm');
    const view = { armL, glow: { leftArm: fakeOverlay() } };
    // The player's body-only shell: the real part key maps to its '_shield' variant (bodyOnly, as
    // makeShieldOutline builds it). A live pool so the outline is active and re-poses every frame.
    const sv = {
      outlines: { armL: fakeOutlineSprite() },
      texMap: { pm_leftArm: 'pm_leftArm_shield' },
      active: false, t: 0, baseScale: 1.1, baseSxByKey: {}, baseSyByKey: {}, grow: 1,
    };
    const shield = { hp: 30, max: 30, temp: 0 };

    for (const reloading of [true, false, true, false]) {
      AmmoIndicatorsMixin._drawAmmoIndicators.call(sceneWith(view, reloading));
      updateShieldOutline(sv, view, shield, 16);
      // The shell always resolves to the body-only variant — never the full/gun texture — because the
      // part key it follows never changed. Under the old swap this flipped to a missed lookup mid-blink.
      expect(sv.outlines.armL.texture.key).toBe('pm_leftArm_shield');
    }
  });
});
