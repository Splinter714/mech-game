// #92 — tank independent turret movement, player-vs-ground-enemy collision, and tank crush
// damage. Each piece has a PURE helper factored into shared.js specifically so it's testable
// without a Phaser scene: `hullTravelAngle` (hull faces travel, not the player, decoupled from
// the turret which tracks the player on its own slew), `circleContains`/`groundEnemyRadius`
// (the circular collision test used to block the player against ground enemies), and
// `crushDamage` (the shared crush/stomp damage-per-frame formula behind both the outpost stomp
// and the new tank crush).
import { describe, it, expect } from 'vitest';
import {
  hullTravelAngle, circleContains, groundEnemyRadius,
  ENEMY_COLLIDE_RADIUS_MECH, ENEMY_COLLIDE_RADIUS_VEHICLE, crushDamage,
} from './shared.js';

describe('hullTravelAngle — tank hull faces travel, decoupled from turret (#92)', () => {
  it('turns the hull toward the direction of travel, not an arbitrary bearing', () => {
    // Travelling straight "east" (vx>0, vy=0) should rotate the hull toward angle 0.
    const got = hullTravelAngle(Math.PI / 2, 100, 0, 10, 0.05);
    expect(Math.abs(got)).toBeLessThan(Math.PI / 2);
  });

  it('holds its last heading while stopped rather than snapping to face something else', () => {
    const held = hullTravelAngle(1.234, 0, 0, 10, 0.05);
    expect(held).toBe(1.234);
  });

  it('does not react to tiny/jitter velocity at or below the move threshold', () => {
    const held = hullTravelAngle(0.5, 3, 0, 10, 0.05, 5);
    expect(held).toBe(0.5);
  });

  it('diverges from a turret angle that tracks a different bearing (the player), proving the '
    + 'two facings are independently driven', () => {
    // Tank travelling "north" (vy<0) while its turret (driven separately, e.g. via rotateToward
    // toward the player to the east) tracks bearing 0 — hull and turret must end up different.
    const hullAngle = hullTravelAngle(Math.PI / 2, 0, -100, 10, 1); // travelling north
    const turretAngle = 0; // tracking the player due east, independent of hull
    expect(Math.abs(hullAngle - turretAngle)).toBeGreaterThan(0.5);
  });
});

describe('circleContains + groundEnemyRadius — player-vs-ground-enemy collision geometry (#92)', () => {
  it('reports inside/outside a circle correctly', () => {
    expect(circleContains(5, 0, 0, 0, 10)).toBe(true);
    expect(circleContains(15, 0, 0, 0, 10)).toBe(false);
    expect(circleContains(0, 0, 0, 0, 10)).toBe(true); // exactly at centre
  });

  it('gives a mech enemy the flat mech collision radius', () => {
    expect(groundEnemyRadius({ kind: 'mech' })).toBe(ENEMY_COLLIDE_RADIUS_MECH);
    expect(groundEnemyRadius({ kind: undefined })).toBe(ENEMY_COLLIDE_RADIUS_MECH);
  });

  it('scales a non-mech vehicle kind radius by its data-driven art scale', () => {
    const tank = { kind: 'tank', kindDef: { scale: 0.6 } };
    expect(groundEnemyRadius(tank)).toBeCloseTo(ENEMY_COLLIDE_RADIUS_VEHICLE * 0.6, 10);
  });

  it('falls back to the base vehicle radius when a kind has no scale', () => {
    const turret = { kind: 'turret', kindDef: {} };
    expect(groundEnemyRadius(turret)).toBe(ENEMY_COLLIDE_RADIUS_VEHICLE);
  });
});

describe('crushDamage — shared stomp/crush-per-frame formula (#92, mirrors #41)', () => {
  it('is zero-speed-floored, not zero — a gentle press still chips away', () => {
    const dps = 40, dt = 1;
    const atRest = crushDamage(dps, dt, 0);
    expect(atRest).toBeCloseTo(dps * 0.35, 10);
  });

  it('scales up to the full DPS at full drive-in speed', () => {
    const dps = 40, dt = 1;
    expect(crushDamage(dps, dt, 1)).toBeCloseTo(dps, 10);
  });

  it('is linear in dt (frame-rate independent, like the rest of the arena\'s tuning)', () => {
    const dps = 50;
    const half = crushDamage(dps, 0.5, 0.8);
    const full = crushDamage(dps, 1, 0.8);
    expect(full).toBeCloseTo(half * 2, 10);
  });

  it('clamps an out-of-range speedFrac instead of producing negative/over-scaled damage', () => {
    const dps = 40, dt = 1;
    expect(crushDamage(dps, dt, -5)).toBeCloseTo(crushDamage(dps, dt, 0), 10);
    expect(crushDamage(dps, dt, 5)).toBeCloseTo(crushDamage(dps, dt, 1), 10);
  });

  it('a tank (160 HP) driven into at full speed dies within a handful of seconds, not '
    + 'instantly and not never', () => {
    const TANK_CRUSH_DPS = 55; // mirrors world.js's constant
    const secondsToKill = 160 / TANK_CRUSH_DPS; // full-speed dps == crushDamage at speedFrac=1
    expect(secondsToKill).toBeGreaterThan(1.5);
    expect(secondsToKill).toBeLessThan(6);
  });
});
