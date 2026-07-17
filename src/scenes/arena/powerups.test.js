// #237: FPS-regression investigation into #205's shield-outline visual. #205 replaced the
// Shield powerup's floating bubble with a "duplicate every mech-part sprite, re-tint, re-pose
// every frame" outline technique (see the big comment on `_initShieldVisual` in powerups.js).
// The concern raised in #237: does `_updateShieldVisual` actually SKIP that per-part re-pose
// work when the shield isn't active (`shieldPool <= 0`, i.e. the vast majority of play time —
// most runs, most players never even pick up Shield), or does it silently do all 6 sprites'
// worth of position/texture/rotation/alpha writes every single frame regardless of state?
//
// This locks in the correct (already-present) behavior: `_updateShieldVisual` must bail out
// before touching any outline sprite's transform/texture when the pool is empty, only paying
// for the full per-part update while the shield is actually up. PowerupsMixin has no Phaser
// dependency in `_updateShieldVisual` beyond the sprite-like objects it's handed, so this
// drives it directly against a minimal fake scene, same pattern as salvage.test.js.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../audio/index.js', () => ({ Audio: { ui: vi.fn() } }));
// powerups.js imports Phaser only for `Phaser.BlendModes.ADD` in `_initShieldVisual` (not
// exercised here — this test drives `_updateShieldVisual` directly against a pre-built fake
// `_shieldVisual`). Phaser's top-level device-detection touches `navigator`, which throws
// under vitest's node environment; same stub pattern as enemyFireAngle.test.js.
vi.mock('phaser', () => ({ default: {} }));

import { PowerupsMixin } from './powerups.js';
import { POWERUPS } from '../../data/powerups.js';

const SHIELD_PART_KEYS = ['hull', 'torL', 'torR', 'armL', 'armR', 'turret'];

// A spy-instrumented fake outline sprite: records every call the expensive per-frame re-pose
// loop would make, so a test can assert none of them fired.
function fakeOutlineSprite() {
  return {
    visible: false,
    texture: { key: 'tex_a' },
    setVisible: vi.fn(function (v) { this.visible = v; return this; }),
    setTexture: vi.fn(function (k) { this.texture = { key: k }; return this; }),
    setPosition: vi.fn(function (x, y) { this.x = x; this.y = y; return this; }),
    setOrigin: vi.fn(function () { return this; }),
    setAlpha: vi.fn(function (a) { this.alpha = a; return this; }),
    rotation: 0,
  };
}

function fakeRealPart(key) {
  return { x: 10, y: 20, originX: 0.5, originY: 0.5, rotation: 0, texture: { key: `${key}_tex` } };
}

function makeScene({ shieldPool = 0 } = {}) {
  const outlines = {};
  const view = {};
  for (const key of SHIELD_PART_KEYS) {
    outlines[key] = fakeOutlineSprite();
    view[key] = fakeRealPart(key);
  }
  return Object.assign(
    {
      shieldPool,
      playerView: view,
      _shieldVisual: { outlines, active: false, t: 0 },
      registry: { set: vi.fn() },
    },
    PowerupsMixin,
  );
}

describe('_updateShieldVisual (#237 — FPS regression check on #205)', () => {
  it('does NOT touch any outline sprite transform/texture when shieldPool is 0 (inactive, steady state)', () => {
    const scene = makeScene({ shieldPool: 0 });
    // Prime it through one frame first so `sv.active` settles at false with no pending
    // visibility-edge transition, matching the steady-state "shield never picked up" case.
    scene._updateShieldVisual(16.67);
    for (const key of SHIELD_PART_KEYS) {
      const o = scene._shieldVisual.outlines[key];
      o.setPosition.mockClear();
      o.setOrigin.mockClear();
      o.setTexture.mockClear();
      o.setAlpha.mockClear();
      o.setVisible.mockClear();
    }

    // The actual per-frame call, same as ArenaScene.update() -> _updatePowerups makes every tick.
    scene._updateShieldVisual(16.67);

    for (const key of SHIELD_PART_KEYS) {
      const o = scene._shieldVisual.outlines[key];
      expect(o.setPosition).not.toHaveBeenCalled();
      expect(o.setOrigin).not.toHaveBeenCalled();
      expect(o.setTexture).not.toHaveBeenCalled();
      expect(o.setAlpha).not.toHaveBeenCalled();
      expect(o.setVisible).not.toHaveBeenCalled();
    }
  });

  it('DOES re-pose every outline sprite each frame while shieldPool > 0 (shield actually active)', () => {
    const scene = makeScene({ shieldPool: POWERUPS.shield.shieldCap });
    scene._shieldPeak = POWERUPS.shield.shieldCap;

    scene._updateShieldVisual(16.67);   // first frame: visibility edge fires + full re-pose

    for (const key of SHIELD_PART_KEYS) {
      const o = scene._shieldVisual.outlines[key];
      expect(o.setVisible).toHaveBeenCalledWith(true);
      expect(o.setPosition).toHaveBeenCalled();
      expect(o.setAlpha).toHaveBeenCalled();
    }
  });

  it('shows the outlines on the 0→>0 edge and hides them again on the >0→0 edge, exactly once each', () => {
    const scene = makeScene({ shieldPool: 0 });
    scene._updateShieldVisual(16.67);   // starts inactive, no edge
    for (const key of SHIELD_PART_KEYS) expect(scene._shieldVisual.outlines[key].setVisible).not.toHaveBeenCalled();

    scene.shieldPool = 50;
    scene._shieldPeak = 50;
    scene._updateShieldVisual(16.67);   // 0 -> >0 edge: show
    for (const key of SHIELD_PART_KEYS) expect(scene._shieldVisual.outlines[key].setVisible).toHaveBeenCalledWith(true);

    for (const key of SHIELD_PART_KEYS) scene._shieldVisual.outlines[key].setVisible.mockClear();
    scene._updateShieldVisual(16.67);   // still active, no edge, no extra setVisible call
    for (const key of SHIELD_PART_KEYS) expect(scene._shieldVisual.outlines[key].setVisible).not.toHaveBeenCalled();

    scene.shieldPool = 0;
    scene._updateShieldVisual(16.67);   // >0 -> 0 edge: hide
    for (const key of SHIELD_PART_KEYS) expect(scene._shieldVisual.outlines[key].setVisible).toHaveBeenCalledWith(false);
  });
});
