// #377 follow-up — "if missiles miss, they should strike the ground not pass by and fly
// forever."
//
// INVESTIGATION RESULT: no round flies forever today, for any of the five missiles. Every
// projectile accrues `dist` every frame and the `landed` branch in _updateProjectiles retires
// it the moment `dist >= maxDist`, playing the impact FX and dropping napalm's fire patch. A
// round that loses its target mid-flight completes its arc to where the target WAS and strikes
// there, which is the behaviour the ask describes wanting. `maxDist` itself is always bounded:
// an arcing round gets the distance to its aim point (arcMaxDist, which falls back to
// `range.opt` when there is no usable target), a straight one gets `range.max + 40`.
//
// So this file is a REGRESSION LOCK on behaviour that already holds, not a fix. It exists
// because "flies forever" is a real thing to have observed and the guarantees it depends on
// (dist always advances; landed always retires + impacts; a dead lock does not extend flight)
// were previously implicit and untested — easy to break by accident, and hard to notice.
import { describe, it, expect, vi } from 'vitest';
import { ProjectilesMixin } from './projectiles.js';
import { WEAPONS } from '../../data/weapons.js';
import { makeProjectile } from '../../data/delivery.js';

// Referenced as OBJECTS, never as id string literals: architecture.guard.test.js forbids a
// weapon id literal anywhere under scenes/arena, tests included, so the arena stays
// variant-agnostic. `w.name` gives it.each a readable label at runtime.
const MISSILES = [WEAPONS.swarmRack, WEAPONS.streakPod, WEAPONS.napalm, WEAPONS.plasmaCannon, WEAPONS.clusterRocket];
const CASES = MISSILES.map((w) => [w.name, w]);

function makeEnemy(id, x, y) {
  let dead = false;
  return { id, x, y, vx: 0, vy: 0, kill() { dead = true; }, mech: { isDestroyed: () => dead } };
}

function makeScene(enemies) {
  const impacts = [], damaged = [];
  const scene = {
    enemies, projectiles: [], firePatches: [],
    px: 0, py: 0,
    mech: { isDestroyed: () => false },
    time: { now: 0 },
    projFx: { clear: vi.fn() },
    _hexKeyAt: () => 'h',
    _isWallForRound: () => false,
    _damageBuildingAt: vi.fn(),
    _impactFx: vi.fn((x, y, color, kind, splash) => impacts.push({ x, y, splash })),
    _damagePlayerAt: vi.fn(),
    _damageEnemyAt: vi.fn((e) => damaged.push(e.id)),
    _rangeFactor: () => 1,
  };
  Object.assign(scene, ProjectilesMixin);
  scene._drawProjectile = vi.fn();
  return { scene, impacts, damaged };
}

// Fire one round at a target 900px away, then `disrupt` it mid-flight so the round misses.
function flyAndMiss(w, disrupt, { bystander = null } = {}) {
  const target = makeEnemy('target', 900, 0);
  const enemies = [target];
  if (bystander) enemies.push(bystander);
  const { scene, impacts, damaged } = makeScene(enemies);
  const round = makeProjectile(w, 0, 0, 0, { maxDist: 900 });
  round.owner = 'player';
  round.trail = [];
  round.seekTarget = (w.delivery.guidance === 'homing' || w.delivery.tracksLock) ? target : null;
  scene.projectiles = [round];

  let frames = 0;
  for (let i = 0; i < 5000 && scene.projectiles.length; i++) {
    if (i === 30) disrupt(target);
    scene._updateProjectiles(0.016);
    frames += 1;
  }
  return { scene, impacts, damaged, round, frames, target };
}

const TARGET_DIES = (t) => t.kill();
const TARGET_FLEES = (t) => { t.x = 4000; t.y = 4000; };

describe('#377: a missile that misses strikes the ground instead of flying on forever', () => {
  it.each(CASES)('%s: its target dying mid-flight does not turn it into a ghost — it ' +
    'completes its arc, retires, and impacts', (_name, w) => {
    const { scene, impacts, round, frames } = flyAndMiss(w, TARGET_DIES);
    expect(scene.projectiles.length).toBe(0);      // gone, not still flying
    expect(frames).toBeLessThan(5000);             // terminated on its own, not by the loop cap
    expect(impacts.length).toBe(1);                // and it visibly struck something
    expect(round.dist).toBeGreaterThanOrEqual(round.maxDist * 0.9);
  });

  it.each(CASES)('%s: a target that runs away does not drag the round along forever ' +
    'either — its travel budget still expires and it comes down', (_name, w) => {
    const { scene, impacts, frames } = flyAndMiss(w, TARGET_FLEES);
    expect(scene.projectiles.length).toBe(0);
    expect(frames).toBeLessThan(5000);
    expect(impacts.length).toBe(1);
  });

  it('a missed round strikes at the END of its arc — roughly where the target WAS, which is ' +
     'what a lobbed weapon should do', () => {
    const { impacts, target } = flyAndMiss(WEAPONS.napalm, TARGET_DIES);
    expect(Math.hypot(impacts[0].x - target.x, impacts[0].y - target.y)).toBeLessThan(80);
  });

  it('a missed NAPALM still lights the ground on fire — a canister that lands and does ' +
     'nothing would be clearly wrong', () => {
    const { scene } = flyAndMiss(WEAPONS.napalm, TARGET_DIES);
    expect(scene.firePatches.length).toBe(1);
    expect(scene.firePatches[0].dps).toBeGreaterThan(0);
  });

  it('a missed round still carries its SPLASH into the impact, so a near-miss damages what ' +
     'it lands next to', () => {
    const bystander = makeEnemy('bystander', 880, 25);
    const { impacts, damaged } = flyAndMiss(WEAPONS.plasmaCannon, TARGET_DIES, { bystander });
    expect(impacts[0].splash).toBe(WEAPONS.plasmaCannon.delivery.splash);
    expect(damaged).toContain('bystander');
  });

  it('every missile has a BOUNDED travel budget — the structural reason none of them can fly ' +
     'forever', () => {
    for (const w of MISSILES) {
      const arcing = w.delivery.path === 'arcing';
      const budget = arcing ? w.range.opt : w.range.max + 40;
      expect(Number.isFinite(budget)).toBe(true);
      expect(budget).toBeGreaterThan(0);
    }
  });

  // #418 (2026-07-22): the owner kept reporting missiles that "spin around chasing their target"
  // even after the failed-pass give-up shipped. These drive the REAL arena update loop, one per
  // orbit path, and assert the round quits guiding and comes down instead of wheeling.
  it('#418 ORBIT: a round wheeling after a fast circling target quits guiding and lands', () => {
    const target = makeEnemy('target', 500, 0);
    const { scene, impacts } = makeScene([target]);
    const round = makeProjectile(WEAPONS.swarmRack, 0, 0, 0, { maxDist: 4000 });
    round.owner = 'player'; round.trail = []; round.seekTarget = target;
    round.arc = false;          // the steering the descent phase of its real lob flies with
    round.aimOffset = 0;
    scene.projectiles = [round];
    // The target wheels around a point faster than the missile flies — ordinary strafing
    // movement, and the shape that makes a seeker fall into a co-rotating chase.
    let t = 0, net = 0;
    const R = 120, w = 4;
    for (let i = 0; i < 4000 && scene.projectiles.length; i++) {
      t += 0.016;
      const nx = 500 + R * Math.cos(w * t), ny = R * Math.sin(w * t);
      target.vx = (nx - target.x) / 0.016; target.vy = (ny - target.y) / 0.016;
      target.x = nx; target.y = ny;
      const prev = round.angle;
      scene._updateProjectiles(0.016);
      net += Math.atan2(Math.sin(round.angle - prev), Math.cos(round.angle - prev));
    }
    expect(round.homingGiveUpReason).toBe('orbit');
    expect(round.homing).toBe(false);                       // fully ballistic
    expect(scene.projectiles.length).toBe(0);               // it came down
    expect(impacts.length).toBe(1);
    expect(Math.abs(net) / (2 * Math.PI)).toBeLessThan(1.5); // it never got to spin
  });

  it('#418 TARGET DESTROYED: the round routes through the eased give-up, then flies dead straight', () => {
    const target = makeEnemy('target', 900, 400);
    const { scene } = makeScene([target]);
    const round = makeProjectile(WEAPONS.swarmRack, 0, 0, 0, { maxDist: 3000 });
    round.owner = 'player'; round.trail = []; round.seekTarget = target;
    round.arc = false; round.aimOffset = 0;
    scene.projectiles = [round];
    const deltas = [];
    for (let i = 0; i < 400 && scene.projectiles.length; i++) {
      if (i === 25) target.kill();
      const prev = round.angle;
      scene._updateProjectiles(0.016);
      deltas.push(Math.abs(Math.atan2(Math.sin(round.angle - prev), Math.cos(round.angle - prev))));
    }
    expect(round.homingGiveUpReason).toBe('targetLost');
    expect(round.homing).toBe(false);
    // It kept turning for a moment after the target died (no snap/kink), then went perfectly
    // straight and stayed straight.
    expect(deltas[26]).toBeGreaterThan(0);
    for (const d of deltas.slice(60)) expect(d).toBeLessThan(1e-9);
  });

  it('dist advances every single frame, for a homing round with no target left — the ' +
     'invariant the landed check depends on', () => {
    const target = makeEnemy('target', 900, 0);
    const { scene } = makeScene([target]);
    const round = makeProjectile(WEAPONS.swarmRack, 0, 0, 0, { maxDist: 900 });
    round.owner = 'player'; round.trail = []; round.seekTarget = target;
    scene.projectiles = [round];
    target.kill();
    let prev = -1;
    for (let i = 0; i < 200 && scene.projectiles.length; i++) {
      scene._updateProjectiles(0.016);
      expect(round.dist).toBeGreaterThan(prev);
      prev = round.dist;
    }
  });
});
