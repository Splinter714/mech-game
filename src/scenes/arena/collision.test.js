// #92 — tank independent turret movement, player-vs-ground-enemy collision, and (originally)
// tank crush damage. Each piece has a PURE helper factored into shared.js specifically so it's
// testable without a Phaser scene: `hullTravelAngle` (hull faces travel, not the player,
// decoupled from the turret which tracks the player on its own slew), `circleContains`/
// `groundEnemyRadius` (the circular collision test used to block the player against ground
// enemies), and `crushDamage` (the outpost-stomp damage-per-frame formula, #41). #92 correction
// (2026-07-10): tank-crushing is now an instant kill, not a `crushDamage`-based gradual grind —
// see `crush.test.js` for that behavior.
import { describe, it, expect } from 'vitest';
import {
  hullTravelAngle, circleContains, groundEnemyRadius,
  ENEMY_COLLIDE_RADIUS_MECH, ENEMY_COLLIDE_RADIUS_VEHICLE, crushDamage,
  crushTriggerRadius, PLAYER_CRUSH_RADIUS_BONUS, DEPTH, unitDepth,
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

describe('crushTriggerRadius — the #112 player crush-trigger contribution', () => {
  it('is strictly bigger than the plain blocking radius for the same enemy', () => {
    const tank = { kind: 'tank', kindDef: { scale: 0.48 } };
    expect(crushTriggerRadius(tank)).toBeGreaterThan(groundEnemyRadius(tank));
  });

  it('adds exactly PLAYER_CRUSH_RADIUS_BONUS on top of the enemy\'s own radius', () => {
    const tank = { kind: 'tank', kindDef: { scale: 0.48 } };
    expect(crushTriggerRadius(tank)).toBeCloseTo(groundEnemyRadius(tank) + PLAYER_CRUSH_RADIUS_BONUS, 10);
    const infantry = { kind: 'infantry', kindDef: { scale: 0.38 } };
    expect(crushTriggerRadius(infantry)).toBeCloseTo(groundEnemyRadius(infantry) + PLAYER_CRUSH_RADIUS_BONUS, 10);
  });

  it('makes a point that would have missed the tight blocking radius still trigger a crush', () => {
    // A point 20px off a small-footprint tank misses the plain (tight) blocking radius...
    const tank = { x: 0, y: 0, kind: 'tank', kindDef: { scale: 0.48 } };
    expect(circleContains(20, 0, tank.x, tank.y, groundEnemyRadius(tank))).toBe(false);
    // ...but IS inside the looser crush-trigger radius, per #112's "much larger" ask.
    expect(circleContains(20, 0, tank.x, tank.y, crushTriggerRadius(tank))).toBe(true);
  });
});

describe('unitDepth — the #113/#289 ground-unit depth tier selection', () => {
  it('puts the player at DEPTH.UNITS', () => {
    expect(unitDepth(true, false, false)).toBe(DEPTH.UNITS);
    // #289: size is ignored for the player — isPlayer wins even if `small` is passed true.
    expect(unitDepth(true, false, true)).toBe(DEPTH.UNITS);
  });

  // #327 (re-reverses #316's depth choice): #316 dropped flyers to their own tier BELOW LOS_DIM so
  // the fog overlay dimmed them like ground units, but that also put them below the player — an
  // aircraft drew UNDERNEATH the mech it flew over, which read wrong in play. LOS dimming is off,
  // so #327 raises flyers ABOVE the player instead. They keep their own tier (not shared with the
  // player) and stay below PROJECTILES so shots and FX still draw over them.
  it('#327: puts a flying enemy (helicopter/drone) at DEPTH.FLYING_UNITS, its own tier, regardless of size', () => {
    expect(unitDepth(false, true, false)).toBe(DEPTH.FLYING_UNITS);
    expect(unitDepth(false, true, true)).toBe(DEPTH.FLYING_UNITS);
    expect(DEPTH.FLYING_UNITS).not.toBe(DEPTH.UNITS);
  });

  it('#327: FLYING_UNITS sits ABOVE the player, so aircraft visibly pass over mechs', () => {
    expect(DEPTH.FLYING_UNITS).toBeGreaterThan(DEPTH.UNITS);
    // ...and the player still sits above the dimming layer and is never dimmed.
    expect(DEPTH.UNITS).toBeGreaterThan(DEPTH.LOS_DIM);
    // Accepted trade (#327): flyers are now above LOS_DIM too, so if dimming is ever re-enabled
    // they'd stay bright over un-sighted ground. Pinned so a future LOS change has to face it.
    expect(DEPTH.FLYING_UNITS).toBeGreaterThan(DEPTH.LOS_DIM);
  });

  it('#327: projectiles, impact FX and world UI still draw ABOVE flyers', () => {
    expect(DEPTH.FLYING_UNITS).toBeLessThan(DEPTH.PROJECTILES);
    expect(DEPTH.FLYING_UNITS).toBeLessThan(DEPTH.IMPACT_FX);
    expect(DEPTH.FLYING_UNITS).toBeLessThan(DEPTH.WORLD_UI);
  });

  it('#327: FLYING_UNITS still sits above the cover canopy and every ground unit tier', () => {
    expect(DEPTH.FLYING_UNITS).toBeGreaterThan(DEPTH.COVER_CANOPY);
    expect(DEPTH.FLYING_UNITS).toBeGreaterThan(DEPTH.LARGE_GROUND_UNITS);
    expect(DEPTH.FLYING_UNITS).toBeGreaterThan(DEPTH.GROUND_UNITS);
  });

  it('#289: puts a SMALL ground enemy (tank/infantry) at DEPTH.GROUND_UNITS, below the cover canopy', () => {
    expect(unitDepth(false, false, true)).toBe(DEPTH.GROUND_UNITS);
    expect(DEPTH.GROUND_UNITS).toBeLessThan(DEPTH.COVER_CANOPY);
    expect(DEPTH.GROUND_UNITS).toBeLessThan(DEPTH.UNITS);
  });

  it('#289: puts a LARGE ground enemy (mech/carrier/turret) at DEPTH.LARGE_GROUND_UNITS — above the cover canopy but below the player', () => {
    expect(unitDepth(false, false, false)).toBe(DEPTH.LARGE_GROUND_UNITS);
    expect(DEPTH.LARGE_GROUND_UNITS).toBeGreaterThan(DEPTH.COVER_CANOPY);
    expect(DEPTH.LARGE_GROUND_UNITS).toBeLessThan(DEPTH.UNITS);
  });

  it('#289/#327: the full layering is small (2) < canopy (2.5) < large (2.75) < dimming (2.9) < player (3) < flyers (3.5) < projectiles (4)', () => {
    expect(DEPTH.GROUND_UNITS)
      .toBeLessThan(DEPTH.COVER_CANOPY);
    expect(DEPTH.COVER_CANOPY)
      .toBeLessThan(DEPTH.LARGE_GROUND_UNITS);
    expect(DEPTH.LARGE_GROUND_UNITS)
      .toBeLessThan(DEPTH.LOS_DIM);
    expect(DEPTH.LOS_DIM)
      .toBeLessThan(DEPTH.UNITS);
    expect(DEPTH.UNITS)
      .toBeLessThan(DEPTH.FLYING_UNITS);
    expect(DEPTH.FLYING_UNITS)
      .toBeLessThan(DEPTH.PROJECTILES);
  });

  it('a hypothetical flying player still resolves to DEPTH.UNITS (isPlayer wins either way)', () => {
    expect(unitDepth(true, true, false)).toBe(DEPTH.UNITS);
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
});
