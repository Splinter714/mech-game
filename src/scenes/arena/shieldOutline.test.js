// #302: the SHARED shield-outline visual — one implementation driven by both the player mech and
// any shielded enemy (helicopter/carrier). These tests cover the state logic that decides
// whether a unit is wearing its shell right now, and the per-frame driver's show/hide/early-exit
// behaviour against fake sprites — the same contract powerups.test.js locks in for the player,
// now asserted on an arbitrary (two-sprite, vehicle-shaped) part set so a regression can't sneak
// in through the enemy path alone.
import { describe, it, expect, vi } from 'vitest';

// The module imports Phaser only for `Phaser.BlendModes.ADD` inside `makeShieldOutline` (not
// exercised here). Phaser's top-level device detection touches `navigator`, which throws under
// vitest's node environment — same stub pattern as powerups.test.js.
vi.mock('phaser', () => ({ default: {} }));

import {
  shieldOutlineActive, shieldOutlineAlpha, shieldOutlineGrowth, updateShieldOutline,
  SHIELD_VEHICLE_PART_KEYS, shieldPartKeys,
} from './shieldOutline.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { createShield, damageShield, tickShield, grantTempShield } from '../../data/shield.js';

function fakeOutlineSprite() {
  return {
    visible: false,
    texture: { key: 'tex_a' },
    setVisible: vi.fn(function (v) { this.visible = v; return this; }),
    setTexture: vi.fn(function (k) { this.texture = { key: k }; return this; }),
    setPosition: vi.fn(function (x, y) { this.x = x; this.y = y; return this; }),
    setOrigin: vi.fn(function () { return this; }),
    setAlpha: vi.fn(function (a) { this.alpha = a; return this; }),
    setScale: vi.fn(function (s) { this.scale = s; return this; }),
    rotation: 0,
  };
}

function makeVehicleOutline() {
  const outlines = {}; const view = {};
  for (const key of SHIELD_VEHICLE_PART_KEYS) {
    outlines[key] = fakeOutlineSprite();
    view[key] = { x: 0, y: 0, originX: 0.5, originY: 0.5, rotation: 0.3, texture: { key: `${key}_tex` } };
  }
  return { sv: { outlines, active: false, t: 0, baseScale: 1 }, view };
}

describe('shieldOutlineActive', () => {
  it('is true only while the pool is above zero', () => {
    expect(shieldOutlineActive({ hp: 30, max: 30 })).toBe(true);
    expect(shieldOutlineActive({ hp: 0.4, max: 30 })).toBe(true);
    expect(shieldOutlineActive({ hp: 0, max: 30 })).toBe(false);
    expect(shieldOutlineActive(null)).toBe(false);
    expect(shieldOutlineActive(undefined)).toBe(false);
  });

  it('tracks a real shield through break and regen (data/shield.js), which is the whole point of #302', () => {
    const shield = createShield({ max: 30, regenPerSec: 3, pauseMs: 900 });
    expect(shieldOutlineActive(shield)).toBe(true);           // gunship spawns shelled

    damageShield(shield, 30);                                 // burst it down
    expect(shieldOutlineActive(shield)).toBe(false);          // shell gone

    tickShield(shield, 0.5);                                  // still inside the hit-pause
    expect(shieldOutlineActive(shield)).toBe(false);

    tickShield(shield, 0.5);                                  // pause expires, regen accrues
    tickShield(shield, 0.5);
    expect(shield.hp).toBeGreaterThan(0);
    expect(shieldOutlineActive(shield)).toBe(true);           // shell comes back
  });
});

// #381: the glow SWELLS with a live temporary pool and is exactly 1 (no change) without one, so
// every enemy outline is untouched. Pure growth curve, tested here without any sprites.
describe('shieldOutlineGrowth (#381)', () => {
  it('is 1 for a plain (temp-less) shield — enemies and un-buffed players never grow', () => {
    expect(shieldOutlineGrowth({ max: 100, temp: 0 })).toBe(1);
    expect(shieldOutlineGrowth({ max: 30 })).toBe(1);       // gunship: no temp field at all
    expect(shieldOutlineGrowth(null)).toBe(1);
    expect(shieldOutlineGrowth({ max: 0, temp: 0 })).toBe(1);
  });

  it('grows above 1 in proportion to the temp-to-base ratio', () => {
    const g = shieldOutlineGrowth({ max: 100, temp: 150 });
    expect(g).toBeGreaterThan(1);
    // Bigger pool ⇒ bigger shell; shrinks back toward 1 as the pool is spent.
    expect(shieldOutlineGrowth({ max: 100, temp: 150 }))
      .toBeGreaterThan(shieldOutlineGrowth({ max: 100, temp: 40 }));
  });

  it('re-scales the outline sprites only when a temp pool changes the growth (via updateShieldOutline)', () => {
    const { sv, view } = makeVehicleOutline();
    const shield = createShield({ max: 100, regenPerSec: 0, pauseMs: 0 });
    // No temp: active but growth stays 1, so setScale is never called.
    updateShieldOutline(sv, view, shield, 16.67);
    for (const key of SHIELD_VEHICLE_PART_KEYS) expect(sv.outlines[key].setScale).not.toHaveBeenCalled();

    // Grant a temp pool: growth jumps, so the shell re-scales up.
    grantTempShield(shield, 150, 10000);
    updateShieldOutline(sv, view, shield, 16.67);
    const grown = shieldOutlineGrowth(shield);
    for (const key of SHIELD_VEHICLE_PART_KEYS) {
      expect(sv.outlines[key].setScale).toHaveBeenCalledWith(sv.baseScale * grown);
    }
    expect(sv.grow).toBeCloseTo(grown, 5);
  });
});

describe('shieldOutlineAlpha', () => {
  it('is brighter at a full pool than a nearly-broken one (the "how much is left" read)', () => {
    expect(shieldOutlineAlpha(30, 30, 0)).toBeGreaterThan(shieldOutlineAlpha(3, 30, 0));
  });

  it('stays visible (never fades to nothing) at the very bottom of the pool', () => {
    expect(shieldOutlineAlpha(0.1, 50, 0)).toBeGreaterThan(0.2);
  });

  it('always yields a sane 0..1 opacity', () => {
    for (const [hp, max, t] of [[30, 30, 0], [1, 50, 1234], [50, 50, 9999], [5, 5, 400]]) {
      const a = shieldOutlineAlpha(hp, max, t);
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });
});

describe('updateShieldOutline (shared driver, driven here on a vehicle-shaped 2-sprite set)', () => {
  it('does no per-frame sprite work at all while the pool is empty (#237 property, now for N enemies)', () => {
    const { sv, view } = makeVehicleOutline();
    const shield = { hp: 0, max: 30 };
    updateShieldOutline(sv, view, shield, 16.67);   // settle at inactive
    for (const key of SHIELD_VEHICLE_PART_KEYS) {
      const o = sv.outlines[key];
      o.setPosition.mockClear(); o.setOrigin.mockClear(); o.setTexture.mockClear();
      o.setAlpha.mockClear(); o.setVisible.mockClear();
    }

    updateShieldOutline(sv, view, shield, 16.67);

    for (const key of SHIELD_VEHICLE_PART_KEYS) {
      const o = sv.outlines[key];
      expect(o.setPosition).not.toHaveBeenCalled();
      expect(o.setOrigin).not.toHaveBeenCalled();
      expect(o.setTexture).not.toHaveBeenCalled();
      expect(o.setAlpha).not.toHaveBeenCalled();
      expect(o.setVisible).not.toHaveBeenCalled();
    }
  });

  it('is a no-op for a unit with no outline at all (every unshielded enemy)', () => {
    expect(() => updateShieldOutline(null, {}, null, 16.67)).not.toThrow();
  });

  it('shows on the 0→>0 edge, hides on the >0→0 edge, and shows again on regen — once each', () => {
    const { sv, view } = makeVehicleOutline();
    const shield = createShield({ max: 30, regenPerSec: 3, pauseMs: 0 });

    updateShieldOutline(sv, view, shield, 16.67);
    for (const key of SHIELD_VEHICLE_PART_KEYS) {
      expect(sv.outlines[key].setVisible).toHaveBeenCalledWith(true);
      sv.outlines[key].setVisible.mockClear();
    }

    updateShieldOutline(sv, view, shield, 16.67);   // still up: no redundant edge call
    for (const key of SHIELD_VEHICLE_PART_KEYS) expect(sv.outlines[key].setVisible).not.toHaveBeenCalled();

    damageShield(shield, 30);
    updateShieldOutline(sv, view, shield, 16.67);
    for (const key of SHIELD_VEHICLE_PART_KEYS) {
      expect(sv.outlines[key].setVisible).toHaveBeenCalledWith(false);
      sv.outlines[key].setVisible.mockClear();
    }

    tickShield(shield, 1);                          // regen brings the pool back
    updateShieldOutline(sv, view, shield, 16.67);
    for (const key of SHIELD_VEHICLE_PART_KEYS) expect(sv.outlines[key].setVisible).toHaveBeenCalledWith(true);
  });

  it('re-poses each outline onto its real part while up (position/rotation/origin/texture)', () => {
    const { sv, view } = makeVehicleOutline();
    view.hull.texture = { key: 'hull_frame_2' };    // walk-cycle frame swap
    view.hull.x = 4; view.hull.y = -7; view.hull.rotation = 1.1;

    updateShieldOutline(sv, view, { hp: 30, max: 30 }, 16.67);

    expect(sv.outlines.hull.setTexture).toHaveBeenCalledWith('hull_frame_2');
    expect(sv.outlines.hull.setPosition).toHaveBeenCalledWith(4, -7);
    expect(sv.outlines.hull.rotation).toBe(1.1);
    expect(sv.outlines.turret.setAlpha).toHaveBeenCalled();
  });

  it('resets its pulse clock when the shell breaks, so a regenerated shell fades back in cleanly', () => {
    const { sv, view } = makeVehicleOutline();
    updateShieldOutline(sv, view, { hp: 30, max: 30 }, 500);
    expect(sv.t).toBeGreaterThan(0);
    updateShieldOutline(sv, view, { hp: 0, max: 30 }, 16.67);
    expect(sv.t).toBe(0);
  });
});

// #379: which sprites the outline hugs is now a per-kind data statement. The drone opts out of
// shadowing its rotor-blur overlay; the fix must NOT leak to any other shielded kind.
describe('shieldPartKeys (#379)', () => {
  it('defaults to the shared hull+turret pair for a kind that says nothing', () => {
    expect(shieldPartKeys({})).toEqual(SHIELD_VEHICLE_PART_KEYS);
    expect(shieldPartKeys(undefined)).toEqual(SHIELD_VEHICLE_PART_KEYS);
  });

  it('gives the DRONE a body-only (hull) outline — no glow around the rotor overlay', () => {
    expect(shieldPartKeys(ENEMY_KINDS.drone)).toEqual(['hull']);
  });

  it('leaves every OTHER kind on the shared default, drone included as the only exception', () => {
    for (const [id, def] of Object.entries(ENEMY_KINDS)) {
      if (id === 'drone') continue;
      expect(shieldPartKeys(def), id).toEqual(SHIELD_VEHICLE_PART_KEYS);
    }
  });
});
