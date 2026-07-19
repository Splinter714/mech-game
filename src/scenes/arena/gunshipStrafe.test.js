// #305 — the gunship (helicopter) attack cycle at the BEHAVIOUR level: the adapter that turns
// the pure phase machine (data/gunshipCycle.js) into facing, velocity and a shot from the right
// weapon slot.
//
// The pure machine is tested in data/gunshipCycle.test.js. What's tested here is the wiring the
// player actually experiences: that the hull really does end up nose-on during the approach and
// really does end up BROADSIDE during the strafing pass, that the weapon slot handed to
// `_fireVehicleWeapon` follows that facing (rockets nose-on, door gun broadside), and that the
// break-off genuinely holds fire. Plus the two things #305 said must not regress: #282 flyer
// separation blending in every phase, and #245 flyers ignoring cover.
//
// Same Phaser stub as tankTurning.test.js — enemyBehaviors.js imports Phaser only for
// `Phaser.Math.Angle.Wrap`, which throws under vitest's node env if left real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { ENEMY_BEHAVIORS } from './enemyBehaviors.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { APPROACH, STRAFE, REPOSITION, SLOT_NOSE, SLOT_FLANK } from '../../data/gunshipCycle.js';

const gunship = ENEMY_BEHAVIORS.helicopter;

// The cycle rolls its standoff, its pass length and its break-off arc off Math.random (see
// data/gunshipCycle.js), and this suite flies a whole multi-cycle sortie and measures the
// resulting trajectory. With the real Math.random that trajectory differs every run, and
// geometric assertions about an ARC — how far out the break-off swing gets, whether it reaches
// its point before the phase times out — genuinely do vary run to run. Seeding makes every
// flight reproducible while still exercising a full spread of rolls, so a failure here means a
// real regression rather than an unlucky draw.
let seed = 0;
beforeEach(() => {
  seed = 0x2f6e2b1;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    // Park-Miller LCG — cheap, deterministic, well-distributed over (0,1).
    seed = (seed * 48271) % 0x7fffffff;
    return seed / 0x7fffffff;
  });
});
afterEach(() => vi.restoreAllMocks());

// Player parked at the origin; the gunship starts out along +x, so bearing to the player is π.
function makeScene({ enemies = [] } = {}) {
  return {
    px: 0, py: 0,
    enemies,
    enemyFire: true,
    _enemyFireAllowed: () => true,
    _cachedLosToPlayer: () => true,
    _fireVehicleWeapon: vi.fn(),
  };
}

function makeGunship({ x = 900, y = 0, handed = 1 } = {}) {
  return {
    kind: 'helicopter', kindDef: ENEMY_KINDS.helicopter, key: 'helicopter',
    x, y, vx: 0, vy: 0, angle: 0, turret: 0, handed, flying: true,
    mech: { isDestroyed: () => false },
    slotCd: {}, slotBurst: {}, weaponSlot: null,
  };
}

function makeCtx(e, scene, { dt = 0.016, delta = 16 } = {}) {
  const dxp = scene.px - e.x, dyp = scene.py - e.y;
  const dist = Math.hypot(dxp, dyp) || 1;
  return { dt, delta, dxp, dyp, dist, bearing: Math.atan2(dyp, dxp), ux: dxp / dist, uy: dyp / dist };
}

// Run the behaviour for `frames`, integrating position from the velocity it sets (the arena does
// this for real; flyers ignore terrain so plain integration is faithful). Records what happened.
function fly(scene, e, frames, { delta = 16 } = {}) {
  const log = [];
  for (let i = 0; i < frames; i++) {
    const ctx = makeCtx(e, scene, { dt: delta / 1000, delta });
    scene._fireVehicleWeapon.mockClear();
    gunship(scene, e, ctx);
    e.x += e.vx * (delta / 1000);
    e.y += e.vy * (delta / 1000);
    const bearing = Math.atan2(scene.py - e.y, scene.px - e.x);
    log.push({
      phase: e.gunship.phase,
      // How far the hull's nose is off the line to the player: 0 = nose-on, π/2 = broadside.
      offBearing: Math.abs(Math.atan2(Math.sin(e.angle - bearing), Math.cos(e.angle - bearing))),
      slot: e.weaponSlot,
      fired: scene._fireVehicleWeapon.mock.calls.length > 0,
      dist: Math.hypot(e.x - scene.px, e.y - scene.py),
      // Bearing FROM the player TO the gunship — the "angle of attack" the break-off relocates.
      fromPlayer: Math.atan2(e.y - scene.py, e.x - scene.px),
      standoff: e.gunship.standoff,
    });
  }
  return log;
}

// The last frame of each phase's first occurrence — i.e. once the hull has had time to finish
// swinging to that phase's facing, which is what the player actually sees.
function settled(log, phase) {
  const idx = log.map((f, i) => (f.phase === phase ? i : -1)).filter((i) => i >= 0);
  return log[idx[idx.length - 1]];
}

describe('gunship attack cycle — facing drives the weapon (#305)', () => {
  it('APPROACH: swings NOSE-ON to the player, closes the distance, and fires the NOSE slot', () => {
    const scene = makeScene();
    const e = makeGunship({ x: 700 });
    const log = fly(scene, e, 150);
    const approach = log.filter((f) => f.phase === APPROACH);
    expect(approach.length).toBeGreaterThan(30);

    // Nose comes onto the player and stays there.
    const late = approach[approach.length - 1];
    expect(late.offBearing).toBeLessThan(0.15);
    // It is genuinely CLOSING, not holding station.
    expect(late.dist).toBeLessThan(approach[0].dist - 100);
    // Every shot taken during the approach comes from the nose slot.
    const fired = approach.filter((f) => f.fired);
    expect(fired.length).toBeGreaterThan(0);
    for (const f of fired) expect(f.slot).toBe(SLOT_NOSE);
  });

  it('STRAFE: turns BROADSIDE (~90° off the player) and fires the FLANK slot', () => {
    const scene = makeScene();
    const e = makeGunship({ x: 900 });
    const log = fly(scene, e, 400);
    const strafe = log.filter((f) => f.phase === STRAFE);
    expect(strafe.length).toBeGreaterThan(30);

    // Once the hull has settled into the pass it really is side-on, not nose-on.
    const late = settled(log, STRAFE);
    expect(late.offBearing).toBeGreaterThan(Math.PI / 2 - 0.35);
    expect(late.offBearing).toBeLessThan(Math.PI / 2 + 0.35);
    for (const f of strafe.filter((x) => x.fired)) expect(f.slot).toBe(SLOT_FLANK);
  });

  it('STRAFE holds its standoff radius instead of drifting in or out (tankMoveIntent hysteresis)', () => {
    const scene = makeScene();
    const e = makeGunship({ x: 900 });
    const log = fly(scene, e, 400);
    // Skip the first stretch — the hull is still swinging broadside and bleeding off approach speed.
    const strafe = log.filter((f) => f.phase === STRAFE).slice(20);
    for (const f of strafe) {
      expect(f.dist).toBeGreaterThan(f.standoff * 0.5);
      expect(f.dist).toBeLessThan(f.standoff * 1.7);
    }
  });

  it('STRAFE really is a LATERAL slide — it travels sideways across the player\'s front', () => {
    const scene = makeScene();
    const e = makeGunship({ x: 900 });
    const log = fly(scene, e, 400);
    const first = log.findIndex((f) => f.phase === STRAFE);
    const strafeFrames = log.filter((f) => f.phase === STRAFE).length;
    expect(strafeFrames).toBeGreaterThan(30);
    // The angular bearing FROM the player to the gunship sweeps through a real arc during the
    // pass — a purely radial hold would leave it unchanged. `fly` doesn't record that bearing,
    // so re-run the same flight on a fresh pair and sample it directly.
    const e2 = makeGunship({ x: 900 });
    const scene2 = makeScene();
    let startAng = null, endAng = null;
    for (let i = 0; i < first + strafeFrames; i++) {
      const ctx = makeCtx(e2, scene2, { dt: 0.016, delta: 16 });
      gunship(scene2, e2, ctx);
      e2.x += e2.vx * 0.016; e2.y += e2.vy * 0.016;
      if (e2.gunship.phase === STRAFE) {
        const a = Math.atan2(e2.y - scene2.py, e2.x - scene2.px);
        if (startAng === null) startAng = a;
        endAng = a;
      }
    }
    expect(Math.abs(endAng - startAng)).toBeGreaterThan(0.3);
  });

  it('REPOSITION: breaks off, HOLDS FIRE, and opens the distance', () => {
    const scene = makeScene();
    const e = makeGunship({ x: 900 });
    const log = fly(scene, e, 600);
    // The FIRST contiguous break-off only — the log may clip mid-way through a later one.
    const start = log.findIndex((f) => f.phase === REPOSITION);
    let end = start;
    while (end + 1 < log.length && log[end + 1].phase === REPOSITION) end++;
    const repo = log.slice(start, end + 1);
    expect(repo.length).toBeGreaterThan(20);
    // Guns cold for the entire break-off — this is the visible "flies off in a non-strafing
    // style" beat Jackson described.
    for (const f of repo) {
      expect(f.fired).toBe(false);
      expect(f.slot).toBeNull();
    }
    // And it genuinely leaves. Note the break-off is an ARC, not a straight retreat: it swings
    // 1.1-2.3 rad around the player on its way to a point at ~1.9x standoff, and the chord of
    // that swing dips inside the old radius partway through — so neither "further every frame"
    // nor "ends at a fixed radius" is an honest claim (on a long arc the phase can also time
    // out mid-swing). What IS always true, and is what the player actually sees, is that the
    // break-off carries it well clear of the pass it was just flying.
    const strafeDist = log[start - 1].dist;                 // where it was strafing, just before
    expect(Math.max(...repo.map((f) => f.dist))).toBeGreaterThan(strafeDist * 1.3);
  });

  it('re-enters the cycle after repositioning — approach, strafe, break off, approach again', () => {
    const scene = makeScene();
    const e = makeGunship({ x: 900 });
    const log = fly(scene, e, 1400);
    const order = [];
    for (const f of log) if (order[order.length - 1] !== f.phase) order.push(f.phase);
    expect(order.slice(0, 4)).toEqual([APPROACH, STRAFE, REPOSITION, APPROACH]);
    expect(order.length).toBeGreaterThanOrEqual(5);   // it keeps going round
  });

  it('the standoff is re-rolled per cycle inside the 240-400 band, so it never settles on one radius', () => {
    const scene = makeScene();
    const e = makeGunship({ x: 900 });
    const log = fly(scene, e, 2000);
    const rolls = [...new Set(log.map((f) => f.standoff))];
    expect(rolls.length).toBeGreaterThan(1);          // genuinely re-rolled, not fixed at spawn
    for (const r of rolls) { expect(r).toBeGreaterThanOrEqual(240); expect(r).toBeLessThanOrEqual(400); }
  });

  it('two gunships spawned on top of each other push APART (#282 flyer separation, all phases)', () => {
    const a = makeGunship({ x: 900, y: 0, handed: 1 });
    const b = makeGunship({ x: 906, y: 0, handed: 1 });
    const scene = makeScene({ enemies: [a, b] });
    let minGap = Infinity;
    for (let i = 0; i < 400; i++) {
      for (const e of [a, b]) gunship(scene, e, makeCtx(e, scene));
      for (const e of [a, b]) { e.x += e.vx * 0.016; e.y += e.vy * 0.016; }
      if (i > 30) minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.y - b.y));
    }
    // Same handedness and same phase clock: without separation these two would fly in lockstep,
    // overlapping. They must have been pushed apart instead.
    expect(minGap).toBeGreaterThan(20);
  });

  it('never asks for line of sight — flyers shoot over cover (#245)', () => {
    const scene = makeScene();
    // A cover field that blocks EVERYTHING. If the gunship consulted LOS it would never fire.
    scene._cachedLosToPlayer = () => false;
    const e = makeGunship({ x: 500 });
    const log = fly(scene, e, 300);
    expect(log.some((f) => f.fired)).toBe(true);
  });

  it('holds fire entirely when the scene\'s fire gate is shut (#304 stand-down)', () => {
    const scene = makeScene();
    scene._enemyFireAllowed = () => false;
    const e = makeGunship({ x: 500 });
    const log = fly(scene, e, 300);
    expect(log.some((f) => f.fired)).toBe(false);
    // But it still manoeuvres — the phases keep running.
    expect(new Set(log.map((f) => f.phase)).size).toBeGreaterThan(1);
  });
});
