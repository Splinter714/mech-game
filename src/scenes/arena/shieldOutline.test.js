// #302: the SHARED shield-outline visual — one implementation driven by both the player mech and
// any shielded enemy (helicopter; the carrier was shielded too until #436 moved it to pure
// armor). These tests cover the state logic that decides
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
  shieldOutlineActive, shieldOutlineAlpha, shieldAlphaCap, updateShieldOutline,
  makeShieldOutline, flashShieldOutline, SHIELD_VEHICLE_PART_KEYS, SHIELD_MECH_PART_KEYS,
  shieldPartKeys, SHIELD_ALPHA_MIN, SHIELD_ALPHA_FULL, SHIELD_OUTLINE_SCALE_MULT,
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
  return { sv: { outlines, active: false, t: 0, baseScale: 1, flash: 0 }, view };
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
    const shield = createShield({ max: 30 });                // #382: shared 3000ms pause, 7.5/s regen
    expect(shieldOutlineActive(shield)).toBe(true);           // gunship spawns shelled

    damageShield(shield, 30);                                 // burst it down
    expect(shieldOutlineActive(shield)).toBe(false);          // shell gone

    tickShield(shield, 1);                                    // still inside the hit-pause
    expect(shieldOutlineActive(shield)).toBe(false);

    tickShield(shield, 2);                                    // pause expires exactly here
    tickShield(shield, 0.5);                                  // regen accrues
    expect(shield.hp).toBeGreaterThan(0);
    expect(shieldOutlineActive(shield)).toBe(true);           // shell comes back
  });
});

// #456: shield STRENGTH drives OPACITY and nothing else. The shell's size is a constant of the art
// bake — no growth curve exists any more, and the per-frame driver makes no setScale call at all.
describe('shieldOutlineAlpha (#456: strength → opacity)', () => {
  it('is brighter at a full pool than a nearly-broken one (the "how much is left" read)', () => {
    expect(shieldOutlineAlpha(30, 30, 0)).toBeGreaterThan(shieldOutlineAlpha(3, 30, 0));
  });

  it('rises monotonically with the pool across the whole range', () => {
    let prev = -1;
    for (const hp of [0, 5, 10, 20, 30, 40, 60, 80, 100]) {
      const a = shieldOutlineAlpha(hp, 100, 0);
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
  });

  it('stays visible (never fades to nothing) at the very bottom of the pool', () => {
    expect(shieldOutlineAlpha(0.1, 50, 0)).toBeGreaterThan(0.15);
    expect(shieldOutlineAlpha(0, 50, 0)).toBeGreaterThan(0.15);
  });

  it('a temp pool stacked on a FULL base reads MORE solid than the full base alone (#456)', () => {
    const full = shieldOutlineAlpha(100, 100, 0);
    const buffed = shieldOutlineAlpha(250, 100, 0);   // 100 base + a 150 Shield-powerup grant
    expect(buffed).toBeGreaterThan(full);
    expect(buffed).toBeLessThanOrEqual(1);
  });

  it('always yields a sane 0..1 opacity, temp pools included', () => {
    for (const [hp, max, t] of [[30, 30, 0], [1, 50, 1234], [50, 50, 9999], [5, 5, 400], [400, 100, 77]]) {
      const a = shieldOutlineAlpha(hp, max, t);
      expect(a).toBeGreaterThanOrEqual(SHIELD_ALPHA_MIN * 0.9);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it('shieldAlphaCap measures against the BASE pool, falling back to temp then the live pool', () => {
    expect(shieldAlphaCap({ max: 100, temp: 150 }, 250)).toBe(100);   // temp reads as "over 100%"
    expect(shieldAlphaCap({ max: 0, temp: 150 }, 150)).toBe(150);     // no native shield at all
    expect(shieldAlphaCap(null, 20)).toBe(20);
    expect(shieldAlphaCap(null, 0)).toBe(1);                          // never divide by zero
  });

  it('never re-scales the shell as the pool changes — size is strength-independent (#456)', () => {
    const { sv, view } = makeVehicleOutline();
    const shield = createShield({ max: 100 });
    updateShieldOutline(sv, view, shield, 16.67);
    damageShield(shield, 60);
    updateShieldOutline(sv, view, shield, 16.67);
    grantTempShield(shield, 150, 10000);                              // the Shield powerup
    updateShieldOutline(sv, view, shield, 16.67);
    for (const key of SHIELD_VEHICLE_PART_KEYS) {
      expect(sv.outlines[key].setScale).not.toHaveBeenCalled();
    }
  });

  it('drives the opacity DOWN as a shield is chipped away (via updateShieldOutline)', () => {
    const { sv, view } = makeVehicleOutline();
    const shield = createShield({ max: 100 });
    updateShieldOutline(sv, view, shield, 0);
    const full = sv.outlines.hull.alpha;
    damageShield(shield, 90);
    updateShieldOutline(sv, view, shield, 0);
    expect(sv.outlines.hull.alpha).toBeLessThan(full);
    expect(full).toBeCloseTo(SHIELD_ALPHA_FULL, 1);
  });
});

// #456: the absorbed-hit feedback is an opacity POP, not the old outward size pop.
describe('flashShieldOutline (#456: an opacity pop, never a size pop)', () => {
  it('snaps the shell to fully opaque and tweens `flash` back to 0 — no sprite scaling', () => {
    const { sv, view } = makeVehicleOutline();
    sv.active = true;
    const tweens = { add: vi.fn() };
    flashShieldOutline({ tweens }, sv);

    expect(sv.flash).toBe(1);
    expect(tweens.add).toHaveBeenCalledTimes(1);
    const cfg = tweens.add.mock.calls[0][0];
    expect(cfg.targets).toBe(sv);
    expect(cfg.flash).toBe(0);
    expect(cfg.scaleX).toBeUndefined();
    expect(cfg.scaleY).toBeUndefined();

    // While the flash is live the drawn alpha is fully opaque, whatever the pool fraction is.
    updateShieldOutline(sv, view, { hp: 4, max: 100 }, 0);
    expect(sv.outlines.hull.alpha).toBeCloseTo(1, 5);
    for (const key of SHIELD_VEHICLE_PART_KEYS) {
      expect(sv.outlines[key].setScale).not.toHaveBeenCalled();
    }
  });

  it('is a no-op on a unit whose shell is down', () => {
    const { sv } = makeVehicleOutline();
    const tweens = { add: vi.fn() };
    flashShieldOutline({ tweens }, sv);
    expect(tweens.add).not.toHaveBeenCalled();
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
    const shield = createShield({ max: 30 });   // #382: shared pause/regen

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

    tickShield(shield, 3);                          // clear the shared 3s pause first
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

// #397 follow-up: the PLAYER shell is drawn from BODY-ONLY `_shield` textures so the guns + their
// muzzle glow poke out unshielded. `bodyOnly` maps each weapon-carrying part's real texture to its
// `_shield` variant (where one exists) and the driver keeps using that variant per frame.
describe('makeShieldOutline bodyOnly (#397)', () => {
  const fakeSceneSprite = () => {
    const s = {
      texture: { key: 'unset' },
      setOrigin: () => s, setScale: () => s, setTintFill: () => s, setBlendMode: () => s,
      setVisible: () => s, setTexture: vi.fn(function (k) { this.texture = { key: k }; return this; }),
      setPosition: vi.fn(function () { return this; }), setAlpha: vi.fn(function () { return this; }),
    };
    return s;
  };
  // A scene whose texture manager only knows about the parts we say have a `_shield` variant.
  const sceneWith = (shieldTextures) => ({
    add: { sprite: vi.fn((x, y, key) => { const s = fakeSceneSprite(); s.texture = { key }; return s; }) },
    textures: { exists: (k) => shieldTextures.has(k) },
  });
  const playerView = () => {
    const view = { addAt: vi.fn() };
    // turret has a body-only variant, hull (walk-cycle) does not — the real mech shape.
    view.turret = { x: 0, y: 0, originX: 0.5, originY: 0.5, rotation: 0, texture: { key: 'playerMech_turret' } };
    view.hull = { x: 0, y: 0, originX: 0.5, originY: 0.5, rotation: 0, texture: { key: 'playerMech_hull_0' } };
    return view;
  };

  it('draws a part from its `_shield` variant when one exists, and records the mapping', () => {
    const scene = sceneWith(new Set(['playerMech_turret_shield']));
    const view = playerView();
    const sv = makeShieldOutline(scene, view, { keys: ['turret', 'hull'], scale: 1, blend: 0, bodyOnly: true });

    expect(sv.outlines.turret.texture.key).toBe('playerMech_turret_shield');   // guns/muzzle omitted
    expect(sv.outlines.hull.texture.key).toBe('playerMech_hull_0');            // no variant → real frame
    expect(sv.texMap.playerMech_turret).toBe('playerMech_turret_shield');
    expect(sv.texMap.playerMech_hull_0).toBe('playerMech_hull_0');             // self, memoised
  });

  // #422: the hull swaps texture through the walk cycle and each frame has its OWN dilated shell
  // raster, so the mapping has to be resolved per frame rather than frozen at construction.
  it('resolves a shell raster for a walk frame it was never built on', () => {
    const scene = sceneWith(new Set(['playerMech_hull_0_shield', 'playerMech_hull_7_shield']));
    const view = playerView();
    const sv = makeShieldOutline(scene, view, { keys: ['hull'], scale: 1, blend: 0, bodyOnly: true, dilated: true });
    expect(sv.outlines.hull.texture.key).toBe('playerMech_hull_0_shield');

    view.hull.texture = { key: 'playerMech_hull_7' };          // gait advances
    updateShieldOutline(sv, view, { hp: 30, max: 30 }, 16.67);
    expect(sv.outlines.hull.texture.key).toBe('playerMech_hull_7_shield');
  });

  it('keeps the body-only texture across per-frame upkeep instead of reverting to the gun texture', () => {
    const scene = sceneWith(new Set(['playerMech_turret_shield']));
    const view = playerView();
    const sv = makeShieldOutline(scene, view, { keys: ['turret', 'hull'], scale: 1, blend: 0, bodyOnly: true });
    sv.outlines.turret.setTexture.mockClear();

    updateShieldOutline(sv, view, { hp: 30, max: 30 }, 16.67);

    // The driver must NOT setTexture the turret back to the weapon-carrying 'playerMech_turret'.
    expect(sv.outlines.turret.setTexture).not.toHaveBeenCalledWith('playerMech_turret');
    expect(sv.outlines.turret.texture.key).toBe('playerMech_turret_shield');
  });

  it('without bodyOnly, uses the real (weapon-carrying) textures unchanged — the enemy path', () => {
    const scene = sceneWith(new Set(['playerMech_turret_shield']));
    const view = playerView();
    const sv = makeShieldOutline(scene, view, { keys: ['turret', 'hull'], scale: 1, blend: 0 });

    expect(sv.outlines.turret.texture.key).toBe('playerMech_turret');
    expect(sv.texMap.playerMech_turret).toBe('playerMech_turret');   // never the _shield variant
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


// #422: the ACTUAL fix, after two failed passes of scale algebra. The shell can only sit a
// consistent distance outside the silhouette if it is a DILATION of the art (grown by a fixed
// distance in every direction at bake time) drawn at the mech's exact scale. Any scale multiplier
// — uniform or per-axis — displaces each edge in proportion to its own distance from the mech
// centre, which is exactly why a mech wider than it is deep kept getting a shell wider than it is
// deep. These lock in that the player path applies NO multiplier and that a scale-based margin
// really is uneven (the property that made the old approach unfixable).
describe('player shield shell sits a CONSISTENT distance outside the silhouette (#422)', () => {
  const makeScene = (sprites) => ({
    add: {
      sprite: vi.fn((x, y, key) => {
        const s = {
          texture: { key }, x, y,
          setOrigin() { return this; },
          setScale: vi.fn(function (sx, sy) { this.sx = sx; this.sy = sy ?? sx; return this; }),
          setTintFill() { return this; },
          setBlendMode() { return this; },
          setVisible() { return this; },
        };
        sprites[key] = s;
        return s;
      }),
    },
    textures: { exists: () => false },
  });
  const mechView = () => {
    const view = { addAt: vi.fn() };
    for (const key of SHIELD_MECH_PART_KEYS) {
      view[key] = { x: 0, y: 0, originX: 0.5, originY: 0.5, rotation: 0, texture: { key: `${key}_tex` } };
    }
    return view;
  };

  it('draws every part at the mech\'s EXACT display scale — no percentage growth anywhere', () => {
    const sprites = {};
    const scene = makeScene(sprites);
    const sv = makeShieldOutline(scene, mechView(), {
      keys: SHIELD_MECH_PART_KEYS, scale: 0.34, blend: 0, bodyOnly: true, dilated: true,
    });
    expect(sv.baseScale).toBe(0.34);
    for (const key of SHIELD_MECH_PART_KEYS) {
      expect(sv.outlines[key].setScale).toHaveBeenCalledWith(0.34);
    }
  });

  it('keeps the classic scaled-duplicate rim for enemies, which have no baked shell raster', () => {
    const sv = makeShieldOutline(makeScene({}), mechView(), {
      keys: SHIELD_VEHICLE_PART_KEYS, scale: 0.34, blend: 0,
    });
    expect(sv.baseScale).toBeCloseTo(0.34 * SHIELD_OUTLINE_SCALE_MULT, 6);
  });

  it('why scaling can never work: one multiplier gives a wide part a wider margin than a shallow one', () => {
    // The mech is wider (half-width) than it is deep (half-depth) — the exact shape in the report.
    const halfWidth = 30, halfDepth = 18, scale = 1, mult = 1.08;
    const sideMargin = halfWidth * scale * (mult - 1);
    const frontMargin = halfDepth * scale * (mult - 1);
    expect(sideMargin).toBeGreaterThan(frontMargin);
    // A dilation, by contrast, adds the SAME distance on both axes by construction.
    const pad = 2.4;
    expect(halfWidth + pad - halfWidth).toBeCloseTo(halfDepth + pad - halfDepth, 12);
  });
});
