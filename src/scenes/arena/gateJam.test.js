// #361 — THE REPRODUCTION. Playtest 2026-07-19, Jackson: "just saw a bunch of tanks get piled up
// at a base gate and couldn't get out."
//
// Two halves:
//  1. A GATE-MOUTH SIMULATION that reproduces the jam. A garrison converges on one gate-sized
//     opening in a wall; the units are integrated with the exact candidate-move + per-axis-slide
//     step enemies.js uses. Run once with the OLD hard mutual block (the control — this is what
//     shipped and what Jackson hit) and once with #361's soft separation. The control is the
//     point: "they got through" proves nothing about the bug without it.
//  2. SCENE-SEAM tests: the real `_updateEnemies` tick actually calls the separation step, it
//     resolves real overlap between real enemy kinds, and it never lands a body inside a wall.
import { describe, it, expect, vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Math: { Angle: { Wrap: (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; } } },
  },
}));

import { EnemiesMixin } from './enemies.js';
import { WorldMixin } from './world.js';
import { HpBody } from '../../data/HpBody.js';
import { ENEMY_KINDS } from '../../data/enemyKinds.js';
import { AWARE, detectionRangeFor } from '../../data/awareness.js';
import { groundEnemyRadius, wallCollideRadius } from './shared.js';
import { separateGroundUnits, MASS_SMALL, MASS_LARGE } from '../../data/groundSeparation.js';

// ── 1. The gate ─────────────────────────────────────────────────────────────────────────
// A solid vertical wall at x = WALL_X with a single opening at y = 0, standing between the
// garrison (west, inside the base) and the player (east). Nothing else is impassable, so the ONLY
// things that can stop a unit are the wall and another unit — which is what makes a jam
// unambiguous when it happens. The opening is a bit over one tank wide, like a real gate span.
const WALL_X = 400, WALL_HALF_THICK = 18, GATE_HALF = 26;
const TANK_R = groundEnemyRadius({ kind: 'tank', kindDef: ENEMY_KINDS.tank });
const wallBlocks = (x, y, r = TANK_R) =>
  Math.abs(x - WALL_X) < WALL_HALF_THICK + r && Math.abs(y) > GATE_HALF - r;

// A garrison strung out along the inside of the wall — #332's sortie: everyone wakes at once and
// everyone heads for the same doorway from a different angle. The convergence is what produces
// the pile; a single-file queue never jams under either rule.
function sortie({ hardBlock }) {
  const units = [];
  for (let i = 0; i < 12; i++) units.push({ x: WALL_X - 70 - (i % 2) * TANK_R * 2.2, y: (i - 5.5) * 26, vx: 0, vy: 0 });
  // The old rule: a candidate move overlapping another unit is rejected outright.
  const otherUnitBlocks = (self, x, y) => {
    for (const o of units) {
      if (o === self) continue;
      if (Math.hypot(x - o.x, y - o.y) < TANK_R * 2) return true;
    }
    return false;
  };
  const dt = 1 / 60, SPEED = 60;
  for (let t = 0; t < 45; t += dt) {
    for (const u of units) {
      // Steer straight at the player beyond the gate — the same straight-line pursuit the vehicle
      // behaviours use once a unit is AWARE.
      const dx = 1200 - u.x, dy = -u.y, d = Math.hypot(dx, dy);
      u.vx = (dx / d) * SPEED; u.vy = (dy / d) * SPEED;
      // enemies.js `_updateVehicle`'s integration, verbatim in shape: whole move, then each axis
      // alone, then stop dead.
      let nx = u.x + u.vx * dt, ny = u.y + u.vy * dt;
      const blocked = (x, y) => wallBlocks(x, y) || (hardBlock && otherUnitBlocks(u, x, y));
      if (blocked(nx, ny)) {
        if (!blocked(u.x + u.vx * dt, u.y)) { ny = u.y; u.vy = 0; }
        else if (!blocked(u.x, u.y + u.vy * dt)) { nx = u.x; u.vx = 0; }
        else { nx = u.x; ny = u.y; u.vx = u.vy = 0; }
      }
      u.x = nx; u.y = ny;
    }
    // #361's fix: overlap is resolved AFTER everyone moves, clipped so a push can never put a
    // body inside a wall plate.
    if (!hardBlock) {
      separateGroundUnits(units, {
        radiusOf: () => TANK_R, massOf: () => MASS_SMALL,
        canMove: (u, x, y) => !wallBlocks(x, y),
      });
    }
  }
  return { units, out: units.filter((u) => u.x > WALL_X + WALL_HALF_THICK).length };
}

describe('#361 — a garrison sortieing through one gate', () => {
  it('CONTROL: the old hard mutual block leaves part of the garrison stuck behind the wall', () => {
    const { out } = sortie({ hardBlock: true });
    expect(out).toBeLessThan(12);   // the playtest report: they piled up and couldn't get out
  });

  it('with soft separation the WHOLE garrison clears the gate', () => {
    const { out } = sortie({ hardBlock: false });
    expect(out).toBe(12);
  });

  it('and separation never leaves a unit inside a wall plate', () => {
    const { units } = sortie({ hardBlock: false });
    for (const u of units) expect(wallBlocks(u.x, u.y)).toBe(false);
  });

  // #361 follow-up (playtest 2026-07-21): the BROODHAULER (carrier) reported as "stuck at gates".
  // The carrier is the odd unit out in a crowd — a large-MASS body (MASS_LARGE) with a bigger
  // radius and the slowest move speed of any mobile kind, wedged among small fast tanks. This
  // pins down that it still CLEARS: soft separation only ever adds an outward push and strips the
  // closing velocity, so no arrangement plugs a slow heavy unit in the mouth. If this regresses,
  // the carrier really is deadlocking and the report is a genuine collision bug, not just feel.
  it('a slow heavy carrier wedged in a tank pile still clears the gate', () => {
    const CAR_R = groundEnemyRadius({ kind: 'carrier', kindDef: ENEMY_KINDS.carrier });
    const units = [];
    // The carrier dead-centre in the pile, tanks strung out around it, everyone at the same y-band.
    units.push({ x: WALL_X - 70, y: 0, vx: 0, vy: 0, r: CAR_R, m: MASS_LARGE, speed: ENEMY_KINDS.carrier.move.maxSpeed });
    for (let i = 0; i < 10; i++) units.push({ x: WALL_X - 70 - (i % 2) * TANK_R * 2.2, y: (i - 5) * 26, vx: 0, vy: 0, r: TANK_R, m: MASS_SMALL, speed: 60 });
    const dt = 1 / 60;
    for (let t = 0; t < 60; t += dt) {
      for (const u of units) {
        const dx = 1200 - u.x, dy = -u.y, d = Math.hypot(dx, dy) || 1;
        u.vx = (dx / d) * u.speed; u.vy = (dy / d) * u.speed;
        let nx = u.x + u.vx * dt, ny = u.y + u.vy * dt;
        const bl = (x, y) => wallBlocks(x, y, u.r);
        if (bl(nx, ny)) {
          if (!bl(u.x + u.vx * dt, u.y)) ny = u.y;
          else if (!bl(u.x, u.y + u.vy * dt)) nx = u.x;
          else { nx = u.x; ny = u.y; }
        }
        u.x = nx; u.y = ny;
      }
      separateGroundUnits(units, {
        radiusOf: (u) => u.r, massOf: (u) => u.m,
        canMove: (u, x, y) => !wallBlocks(x, y, u.r),
      });
    }
    const car = units[0];
    expect(car.x).toBeGreaterThan(WALL_X + WALL_HALF_THICK);   // the carrier itself got out
    expect(units.every((u) => !wallBlocks(u.x, u.y, u.r))).toBe(true);
  });
});

// ── 2. The scene seam ───────────────────────────────────────────────────────────────────
function makeScene() {
  const scene = {
    time: { now: 0 }, enemies: [], px: 1200, py: 0, bases: [], alertTowerHexes: [],
    enemyMove: true, enemyFire: true, registry: { set() {} },
    _blocked: (x, y, radius = 0) => wallBlocks(x, y, radius),
    _speedFactorAt: () => 1, _cachedLosToPlayer: () => true, _losClear: () => true,
    _syncEnemyFogVisibility: () => {},
  };
  Object.assign(scene, EnemiesMixin);
  scene._fireVehicleWeapon = () => {};                // firing is irrelevant here
  scene._blockedByOtherGroundUnit = WorldMixin._blockedByOtherGroundUnit;
  scene.players = [{ x: 1200, y: 0, mech: { isDestroyed: () => false } }];
  return scene;
}

function unit(scene, kindId, x, y) {
  const def = ENEMY_KINDS[kindId];
  const e = {
    key: `${kindId}@${x},${y}`, mech: new HpBody(def), kind: def.kind, kindDef: def, behavior: def.behavior,
    view: { setPosition() {}, hull: { setTexture() {}, rotation: 0 }, turret: { rotation: 0 }, shadow: null },
    x, y, vx: 0, vy: 0, angle: 0, turret: 0, fireCd: 0, handed: 1, slotCd: {},
    awareness: AWARE, reactDelayMs: 0, detectRange: detectionRangeFor(def.fireRange),
  };
  scene.enemies.push(e);
  return e;
}

describe('#361 — the scene seam', () => {
  it('the enemy tick runs separation (source check + live effect)', () => {
    // The ordering matters: separation must run after the per-enemy movement, not before.
    const src = EnemiesMixin._updateEnemies.toString();
    expect(src.indexOf('_updateEnemy')).toBeLessThan(src.indexOf('_separateGroundUnits'));
    const scene = makeScene();
    const a = unit(scene, 'tank', 0, 0), b = unit(scene, 'tank', 4, 0);
    scene._updateEnemies(1 / 60, 1000 / 60);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(2 * TANK_R - 1e-6);
  });

  it('separates a real overlapping pile, and no unit ends up inside the wall', () => {
    const scene = makeScene();
    const pile = [];
    for (let i = 0; i < 8; i++) pile.push(unit(scene, 'tank', WALL_X - 40 + (i % 3), i));
    for (let t = 0; t < 120; t++) { scene.time.now += 1000 / 60; scene._updateEnemies(1 / 60, 1000 / 60); }
    for (let i = 0; i < pile.length; i++) {
      expect(scene._blocked(pile[i].x, pile[i].y, wallCollideRadius(pile[i]))).toBe(false);
      for (let j = i + 1; j < pile.length; j++) {
        const d = Math.hypot(pile[j].x - pile[i].x, pile[j].y - pile[i].y);
        expect(d).toBeGreaterThan(2 * TANK_R - 0.5);
      }
    }
  });

  it('a turret is never displaced by the tank that bumps it', () => {
    const scene = makeScene();
    const turret = unit(scene, 'turret', 0, 0);
    turret.emplaced = true;
    const tank = unit(scene, 'tank', 8, 0);
    scene._separateGroundUnits();
    expect(turret.x).toBe(0); expect(turret.y).toBe(0);
    expect(Math.hypot(tank.x - turret.x, tank.y - turret.y))
      .toBeGreaterThan(groundEnemyRadius(turret) + TANK_R - 1e-6);
  });

  it('players are still HARD obstacles to a ground unit (unchanged)', () => {
    const scene = makeScene();
    const tank = unit(scene, 'tank', 1190, 0);
    expect(scene._blockedByOtherGroundUnit(tank, 1200, 0)).toBe(true);
  });

  it('but another ENEMY no longer blocks a unit\'s movement — that is the deadlock removal', () => {
    const scene = makeScene();
    const a = unit(scene, 'tank', 0, 0);
    unit(scene, 'turret', 10, 0);
    expect(scene._blockedByOtherGroundUnit(a, 10, 0)).toBe(false);
  });
});
