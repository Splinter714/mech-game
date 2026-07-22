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
  shieldOutlineActive, shieldOutlineAlpha, shieldOutlineGrowth, updateShieldOutline,
  makeShieldOutline, SHIELD_VEHICLE_PART_KEYS, SHIELD_MECH_PART_KEYS, shieldPartKeys,
  mechPartHalfExtentsPx, outlineBaseScales, SHIELD_PLAYER_OFFSET_PX, SHIELD_PLAYER_SCALE_MULT,
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
    const shield = createShield({ max: 100 });
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
    expect(sv.texMap).toEqual({ playerMech_turret: 'playerMech_turret_shield' });
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
    expect(sv.texMap).toEqual({});
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

// #422 (2nd pass): a single mech-wide half-extent applied to every part gave the arms (whose own
// silhouette sits far out to the side) a different actual outward margin than the turret (whose
// own silhouette is a shallow front/back box) — the playtest report ("still bulges more at the
// SIDES than front/back") after the first #422 fix. The fix computes each outline PART's own
// half-extent (`mechPartHalfExtentsPx`) and solves that part's own scale for the margin, so the
// side-most part (an arm, displaced on X) and the front/back part (the turret, displaced on Y)
// must land on the SAME outward pixel displacement.
describe('uniform player shield margin across parts (#422 2nd pass)', () => {
  // A bare test-double mech shape — just enough for mechLayout (chassis/index.js's real baking is
  // not needed here; mechLayout only reads bodyLen/bodyWid + the default shape).
  const fakeMech = () => ({ chassis: { art: { bodyLen: 40, bodyWid: 30 } } });

  it('mechPartHalfExtentsPx gives each part its OWN half-extent, not one mech-wide figure', () => {
    const extents = mechPartHalfExtentsPx(fakeMech());
    // The arm sits far out to the side (wide X, shallow Y); the turret is the body, wide on X too
    // but its own box doesn't reach nearly as far out as the arm's mount point.
    expect(extents.armL.w).toBeGreaterThan(extents.turret.w);
    expect(Object.keys(extents)).toEqual(
      expect.arrayContaining(['turret', 'hull', 'torL', 'torR', 'armL', 'armR']),
    );
  });

  it('falls back to null for a chassis-less test double (coop hand-built mechs) instead of throwing', () => {
    expect(mechPartHalfExtentsPx({})).toBeNull();
    expect(mechPartHalfExtentsPx(null)).toBeNull();
  });

  it('solves an equal outward PIXEL displacement for a far-out side part (arm, X) and a front/back part (turret, Y)', () => {
    const mech = fakeMech();
    const extents = mechPartHalfExtentsPx(mech);
    const scale = 1;
    const offsetPx = SHIELD_PLAYER_OFFSET_PX;

    const arm = outlineBaseScales({
      scale, scaleMult: SHIELD_PLAYER_SCALE_MULT, offsetPx, halfExtentPx: extents.armL,
    });
    const turret = outlineBaseScales({
      scale, scaleMult: SHIELD_PLAYER_SCALE_MULT, offsetPx, halfExtentPx: extents.turret,
    });

    // Displacement of a part's OWN silhouette edge = that part's own half-extent × the scale delta.
    const armSideDisplacement = extents.armL.w * (arm.sx - scale);
    const turretFrontBackDisplacement = extents.turret.d * (turret.sy - scale);

    expect(armSideDisplacement).toBeCloseTo(offsetPx, 5);
    expect(turretFrontBackDisplacement).toBeCloseTo(offsetPx, 5);
    expect(armSideDisplacement).toBeCloseTo(turretFrontBackDisplacement, 5);

    // This is the actual bug fix: the two parts need DIFFERENT scales to land on the SAME px
    // margin, because their own half-extents differ. Applying the arm's scale to the turret's own
    // (much shallower) half-extent would NOT reproduce the same offsetPx margin — proving a single
    // shared scale can't give both parts an equal margin at once.
    const turretDisplacementUnderArmScale = extents.turret.d * (arm.sx - scale);
    expect(turretDisplacementUnderArmScale).not.toBeCloseTo(offsetPx, 1);
  });

  it('makeShieldOutline assigns each outline sprite a PER-PART scale (not one shared sx/sy)', () => {
    const sprites = {};
    const scene = {
      add: {
        sprite: vi.fn((x, y, key) => {
          const s = {
            texture: { key }, x, y,
            setOrigin: function () { return this; },
            setScale: vi.fn(function (sx, sy) { this.sx = sx; this.sy = sy ?? sx; return this; }),
            setTintFill: function () { return this; },
            setBlendMode: function () { return this; },
            setVisible: function () { return this; },
          };
          sprites[key] = s;
          return s;
        }),
      },
      textures: { exists: () => false },
    };
    const view = { addAt: vi.fn() };
    for (const key of SHIELD_MECH_PART_KEYS) {
      view[key] = { x: 0, y: 0, originX: 0.5, originY: 0.5, rotation: 0, texture: { key: `${key}_tex` } };
    }
    const mech = fakeMech();
    const sv = makeShieldOutline(scene, view, {
      keys: SHIELD_MECH_PART_KEYS, scale: 1, scaleMult: SHIELD_PLAYER_SCALE_MULT,
      offsetPx: SHIELD_PLAYER_OFFSET_PX, mech, blend: 0,
    });

    // The arm and the turret must NOT have received the same sx (that was the bug) — the arm's
    // side displacement and turret's own front/back displacement land at the same px only because
    // each got its OWN scale.
    expect(sv.outlines.armL.setScale).toHaveBeenCalled();
    expect(sv.baseSxByKey.armL).not.toBeCloseTo(sv.baseSxByKey.turret, 3);

    const extents = mechPartHalfExtentsPx(mech);
    const armDisplacement = extents.armL.w * (sv.baseSxByKey.armL - 1);
    const turretDisplacement = extents.turret.d * (sv.baseSyByKey.turret - 1);
    expect(armDisplacement).toBeCloseTo(turretDisplacement, 5);
  });
});
