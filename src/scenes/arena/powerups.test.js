// #237: FPS-regression investigation into #205's shield-outline visual. #205 replaced the
// Shield powerup's floating bubble with a "duplicate every mech-part sprite, re-tint, re-pose
// every frame" outline technique (see the big comment on `_initShieldVisual` in powerups.js).
// The concern raised in #237: does `_updateShieldVisual` actually SKIP that per-part re-pose
// work when the shield isn't active (#246: `this.mech.shield.hp <= 0` — the shield is now a
// real layer living on the mech itself, not a scene-tracked `shieldPool`), or does it silently
// do all 6 sprites' worth of position/texture/rotation/alpha writes every single frame
// regardless of state?
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
import { playersOf } from './players.js';

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

// #246: the shield now lives on `scene.mech.shield` (data/shield.js's plain state shape), not a
// scene-level `shieldPool` number — this fake mirrors just enough of that shape (`hp`/`max`).
function makeScene({ shieldHp = 0, shieldMax = 60 } = {}) {
  const outlines = {};
  const view = {};
  for (const key of SHIELD_PART_KEYS) {
    outlines[key] = fakeOutlineSprite();
    view[key] = fakeRealPart(key);
  }
  const scene = Object.assign(
    {
      mech: { shield: { hp: shieldHp, max: shieldMax } },
      playerView: view,
      registry: { set: vi.fn() },
    },
    PowerupsMixin,
  );
  // #364: the outline set lives on the PLAYER now, not the scene — one per player, so co-op's
  // player 2 gets its own bubble. This scene is a legacy single-player double, so it goes on the
  // adapter `playersOf` synthesizes for it (which is also what proves that path still works).
  playersOf(scene)[0].shieldVisual = { outlines, active: false, t: 0 };
  return scene;
}

// The outline set under test — player `i`'s.
const sv = (scene, i = 0) => playersOf(scene)[i].shieldVisual;

describe('_updateShieldVisual (#237 — FPS regression check on #205)', () => {
  it('does NOT touch any outline sprite transform/texture when the shield is empty (inactive, steady state)', () => {
    const scene = makeScene({ shieldHp: 0 });
    // Prime it through one frame first so `sv.active` settles at false with no pending
    // visibility-edge transition, matching the steady-state "shield never picked up" case.
    scene._updateShieldVisual(16.67);
    for (const key of SHIELD_PART_KEYS) {
      const o = sv(scene).outlines[key];
      o.setPosition.mockClear();
      o.setOrigin.mockClear();
      o.setTexture.mockClear();
      o.setAlpha.mockClear();
      o.setVisible.mockClear();
    }

    // The actual per-frame call, same as ArenaScene.update() -> _updatePowerups makes every tick.
    scene._updateShieldVisual(16.67);

    for (const key of SHIELD_PART_KEYS) {
      const o = sv(scene).outlines[key];
      expect(o.setPosition).not.toHaveBeenCalled();
      expect(o.setOrigin).not.toHaveBeenCalled();
      expect(o.setTexture).not.toHaveBeenCalled();
      expect(o.setAlpha).not.toHaveBeenCalled();
      expect(o.setVisible).not.toHaveBeenCalled();
    }
  });

  it('DOES re-pose every outline sprite each frame while the shield is charged (shield actually active)', () => {
    const scene = makeScene({ shieldHp: 60, shieldMax: 60 });

    scene._updateShieldVisual(16.67);   // first frame: visibility edge fires + full re-pose

    for (const key of SHIELD_PART_KEYS) {
      const o = sv(scene).outlines[key];
      expect(o.setVisible).toHaveBeenCalledWith(true);
      expect(o.setPosition).toHaveBeenCalled();
      expect(o.setAlpha).toHaveBeenCalled();
    }
  });

  it('shows the outlines on the 0→>0 edge and hides them again on the >0→0 edge, exactly once each', () => {
    const scene = makeScene({ shieldHp: 0 });
    scene._updateShieldVisual(16.67);   // starts inactive, no edge
    for (const key of SHIELD_PART_KEYS) expect(sv(scene).outlines[key].setVisible).not.toHaveBeenCalled();

    scene.mech.shield.hp = 50;
    scene.mech.shield.max = 50;
    scene._updateShieldVisual(16.67);   // 0 -> >0 edge: show
    for (const key of SHIELD_PART_KEYS) expect(sv(scene).outlines[key].setVisible).toHaveBeenCalledWith(true);

    for (const key of SHIELD_PART_KEYS) sv(scene).outlines[key].setVisible.mockClear();
    scene._updateShieldVisual(16.67);   // still active, no edge, no extra setVisible call
    for (const key of SHIELD_PART_KEYS) expect(sv(scene).outlines[key].setVisible).not.toHaveBeenCalled();

    scene.mech.shield.hp = 0;
    scene._updateShieldVisual(16.67);   // >0 -> 0 edge: hide
    for (const key of SHIELD_PART_KEYS) expect(sv(scene).outlines[key].setVisible).toHaveBeenCalledWith(false);
  });
});

// ── #339: the scene wiring for duration stacking ───────────────────────────────────────────
// The pure rule is proven in data/powerups.test.js; this proves `_activatePowerup` actually
// USES it on all three paths (plain timed buff, Shield's on-mech boost, instant Armor Patch)
// rather than the old "set to durationMs" refresh. Driven against a minimal fake scene, same
// pattern as the shield-visual tests above.
import {
  POWERUPS, durationMs, maxStackedMs, buffModifiers,
} from '../../data/powerups.js';

function fakeArena() {
  return {
    px: 0, py: 0,
    activePowerups: {},
    _floatText() {},
    boostCalls: [],
    mech: {
      _remaining: 0,
      _repairs: 0,
      get tempShieldRemainingMs() { return this._remaining; },
      grantTempShield(pool, ms) { this._pool = pool; this._remaining = ms; this._grantCalls = (this._grantCalls || 0) + 1; },
      repairArmor() { this._repairs++; return 10; },
      exposedArmorLocations() { return []; },
    },
    _activatePowerup: PowerupsMixin._activatePowerup,
    _applyInstantPowerup: PowerupsMixin._applyInstantPowerup,
    _refreshBuffMods: PowerupsMixin._refreshBuffMods,
  };
}

describe('#339: _activatePowerup stacks duration on duplicate pickups', () => {
  it('a second timed pickup ADDS a duration rather than resetting to one', () => {
    const s = fakeArena();
    s._activatePowerup('overdrive');
    expect(s.activePowerups.overdrive).toBe(durationMs('overdrive'));
    s._activatePowerup('overdrive');
    expect(s.activePowerups.overdrive).toBe(durationMs('overdrive') * 2);
  });

  it('stacks on top of a PARTIALLY DRAINED timer (the real in-game case)', () => {
    const s = fakeArena();
    s._activatePowerup('barrage');
    s.activePowerups.barrage -= 4000;                       // 4s of play elapses
    const before = s.activePowerups.barrage;
    s._activatePowerup('barrage');
    expect(s.activePowerups.barrage).toBe(before + durationMs('barrage'));
  });

  it('plateaus at the cap however many are collected, and never shortens the buff', () => {
    const s = fakeArena();
    let prev = 0;
    for (let i = 0; i < 12; i++) {
      s._activatePowerup('overclock');
      expect(s.activePowerups.overclock).toBeGreaterThanOrEqual(prev);
      prev = s.activePowerups.overclock;
    }
    expect(prev).toBe(maxStackedMs('overclock'));
  });

  it('does NOT change magnitude — the collapsed modifiers are identical however long it runs', () => {
    const s = fakeArena();
    s._activatePowerup('overdrive');
    const once = buffModifiers(s.activePowerups);
    for (let i = 0; i < 5; i++) s._activatePowerup('overdrive');
    expect(buffModifiers(s.activePowerups)).toEqual(once);
  });

  it('#381: Shield grants the temp pool at the same size with NO finite expiry (persists until spent); the free-ammo window is the only timed half', () => {
    const s = fakeArena();
    s._activatePowerup('shield');
    expect(s.mech._pool).toBe(POWERUPS.shield.tempPool);
    expect(s.mech._remaining).toBeUndefined();                   // #381: no durationMs passed — pool never time-expires
    expect(s.activePowerups.shield).toBe(durationMs('shield'));   // #381: free-ammo window is 10s
    s._activatePowerup('shield');
    expect(s.mech._pool).toBe(POWERUPS.shield.tempPool);          // same pool size, does not compound
    expect(s.mech._remaining).toBeUndefined();                   // still no expiry on the pool
    expect(s.activePowerups.shield).toBe(durationMs('shield') * 2); // …only the free-ammo window stacks
  });

  it('#381: Armor Patch repairs again on each pickup AND opens a free-ammo window (so it now enters the active set)', () => {
    const s = fakeArena();
    s._activatePowerup('armorPatch');
    expect(s.activePowerups.armorPatch).toBe(durationMs('armorPatch'));  // #381: free-ammo window
    s._activatePowerup('armorPatch');
    expect(s.mech._repairs).toBe(2);                                     // repair still applies each time
    expect(s.activePowerups.armorPatch).toBe(durationMs('armorPatch') * 2);
  });

  it('different types keep their own independent clocks', () => {
    const s = fakeArena();
    s._activatePowerup('overdrive');
    s._activatePowerup('overdrive');
    s._activatePowerup('barrage');
    expect(s.activePowerups.overdrive).toBe(durationMs('overdrive') * 2);
    expect(s.activePowerups.barrage).toBe(durationMs('barrage'));
  });
});

// ── #390: Shield & Armor Patch apply to the WHOLE TEAM, not just the collector ──────────────
// Owner decision: a single Shield or Armor-Patch pickup grants its FULL effect to EVERY live
// player (each gets its own full temp pool / full repair), while the pickup cue stays on the
// collector. Other types (overdrive/overclock/barrage) keep the shared scene-level overlay.
function fakeMech() {
  return {
    _pool: undefined, _grantCalls: 0, _repairs: 0,
    grantTempShield(pool, ms) { this._pool = pool; this._remaining = ms; this._grantCalls++; },
    repairArmor() { this._repairs++; return 10; },
    exposedArmorLocations() { return []; },
  };
}

// A co-op scene with a REAL `players` collection (not the legacy single-player adapter), so
// `livePlayersOf` genuinely iterates two independent players each with their own mech.
function fakeCoopArena() {
  const players = [
    { id: 0, x: 0, y: 0, dead: false, mech: fakeMech() },
    { id: 1, x: 100, y: 50, dead: false, mech: fakeMech() },
  ];
  return Object.assign(
    {
      players,
      activePowerups: {},
      _floatText: vi.fn(),
    },
    PowerupsMixin,
  );
}

describe('#390: Shield / Armor Patch apply to every live player', () => {
  it('Shield grants BOTH players their own full temp pool from one pickup', () => {
    const s = fakeCoopArena();
    const collector = s.players[1];
    s._activatePowerup('shield', collector);
    for (const p of s.players) {
      expect(p.mech._grantCalls).toBe(1);
      expect(p.mech._pool).toBe(POWERUPS.shield.tempPool);
      expect(p.mech._remaining).toBeUndefined();   // no finite expiry — pool persists until spent
    }
    // The pickup cue lands on the collector's position, once.
    expect(s._floatText).toHaveBeenCalledTimes(1);
    expect(s._floatText.mock.calls[0][0]).toBe(collector.x);
  });

  it('Armor Patch repairs BOTH players from one pickup; cue only on the collector', () => {
    const s = fakeCoopArena();
    const collector = s.players[0];
    s._activatePowerup('armorPatch', collector);
    for (const p of s.players) expect(p.mech._repairs).toBe(1);
    // Two float texts: the "+N armor" for the collector only, plus the shared pickup label.
    const armorCalls = s._floatText.mock.calls.filter((c) => String(c[2]).includes('armor'));
    expect(armorCalls).toHaveLength(1);
    expect(armorCalls[0][0]).toBe(collector.x);
  });

  it('a DEAD player receives neither shield nor repair (only live players)', () => {
    const s = fakeCoopArena();
    s.players[1].dead = true;
    s._activatePowerup('shield', s.players[0]);
    s._activatePowerup('armorPatch', s.players[0]);
    expect(s.players[0].mech._grantCalls).toBe(1);
    expect(s.players[0].mech._repairs).toBe(1);
    expect(s.players[1].mech._grantCalls).toBe(0);
    expect(s.players[1].mech._repairs).toBe(0);
  });

  it('each player\'s shield pool is independent — one spending its pool does not touch the other', () => {
    const s = fakeCoopArena();
    s._activatePowerup('shield', s.players[0]);
    // Simulate player 0 spending its pool; player 1 keeps its own full pool.
    s.players[0].mech._pool = 0;
    expect(s.players[1].mech._pool).toBe(POWERUPS.shield.tempPool);
  });
});
