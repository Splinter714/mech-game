// Per-KIND AI + movement for non-mech enemies (turret / tank / drone / helicopter). Each kind
// gets ONE small update function, looked up from ENEMY_BEHAVIORS by the enemy's behavior key —
// a registry dispatch, NOT an `=== 'tank'` chain (keeps architecture.guard green). The mech
// tactical AI (enemies.js `_updateEnemy`) is untouched; these are simpler, kind-specific brains.
//
// A behavior fn has the signature (scene, e, ctx) where `scene` is the ArenaScene (so it can use
// _blocked / _wallDistance / _fireVehicleWeapon etc.), `e` is the enemy record, and `ctx` carries
// the per-frame basics computed once by the caller:
//   { dt, delta, dxp, dyp, dist, bearing, ux, uy }   (bearing/ux/uy point enemy → player)
//
// Movement convention matches the mech path: a behavior sets e.vx/e.vy (world px/s) and e.angle
// (hull facing) + e.turret (gun facing); the caller integrates position with collision (unless
// the unit flies, which ignores walls). Firing is delegated to scene._fireVehicleWeapon(e, aim),
// which pulls the weapon from data (no weapon-id literal here) and respects the kind's cadence.

import Phaser from 'phaser';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a, b) => a + Math.random() * (b - a);

// Slew the turret toward the player and fire when the player is within the kind's fire range and
// (for ground units) line-of-sight isn't blocked by cover. Flyers ignore cover. Shared tail end
// of every behavior. Returns nothing; mutates e.turret and may spawn a shot.
function aimAndFire(scene, e, ctx, { needLos }) {
  const def = e.kindDef;
  e.turret = Phaser.Math.Angle.RotateTo(e.turret, ctx.bearing, def.move.turretSlew * ctx.dt);
  if (!scene.enemyFire) return;
  const inRange = ctx.dist < (def.fireRange ?? 300);
  // Ground units need a clear firing lane; flyers shoot over everything. #72 own-hex
  // transparency: the player's own soft-cover hex (and this unit's) doesn't block the lane.
  const los = needLos ? scene._wallDistance(e.x, e.y, ctx.bearing, ctx.dist, scene._losTransparency(e.x, e.y, scene.px, scene.py)) === Infinity : true;
  // Only fire once the gun is roughly on target, so shots read as aimed.
  const onTarget = Math.abs(Phaser.Math.Angle.Wrap(e.turret - ctx.bearing)) < 0.35;
  if (inRange && los && onTarget) scene._fireVehicleWeapon(e, ctx, e.turret);
}

// TURRET — static emplacement. No locomotion at all; just track + fire. Needs LOS (ground).
function turretBehavior(scene, e, ctx) {
  e.vx = 0; e.vy = 0;
  aimAndFire(scene, e, ctx, { needLos: true });
}

// TANK — grinds to a firing standoff and holds, hull facing the player (tough frontal facing
// toward the threat). Slow, heavy; blocked by cover/water. Backs off if the player crowds it.
function tankBehavior(scene, e, ctx) {
  const def = e.kindDef;
  const standoff = def.standoff ?? 300;
  const mv = def.move;
  // Desired radial move: close if beyond standoff, ease off inside it, back up if very close.
  let radial = 0;
  if (ctx.dist > standoff * 1.15) radial = 1;          // advance
  else if (ctx.dist < standoff * 0.7) radial = -0.8;   // reverse (keep the gun's distance)
  // A slight lateral creep so it isn't a perfectly static block once at range.
  const strafe = (e.handed || 1) * 0.25;
  let mx = ctx.ux * radial - ctx.uy * strafe;
  let my = ctx.uy * radial + ctx.ux * strafe;
  const m = Math.hypot(mx, my) || 1;
  mx /= m; my /= m;
  const target = radial === 0 && strafe === 0 ? 0 : mv.maxSpeed;
  e.vx = approach(e.vx, mx * (Math.abs(radial) + Math.abs(strafe) > 0 ? target : 0), mv.accel * ctx.dt);
  e.vy = approach(e.vy, my * (Math.abs(radial) + Math.abs(strafe) > 0 ? target : 0), mv.accel * ctx.dt);
  // Hull faces the player (present the frontal armour), turning at the chassis turn rate.
  e.angle = Phaser.Math.Angle.RotateTo(e.angle, ctx.bearing, mv.turnRate * ctx.dt);
  aimAndFire(scene, e, ctx, { needLos: true });
}

// DRONE — one of a swarm. Hovers at a loose orbit radius, jittering so the pack reads as a
// cloud, not a line. Flies (ignores cover). Light fast weapon, fired whenever roughly in range.
function droneBehavior(scene, e, ctx) {
  const def = e.kindDef;
  const mv = def.move;
  const orbit = def.swarmRadius ?? 150;
  // Re-pick a small random orbit offset periodically so drones don't stack.
  e._jitterAt = (e._jitterAt ?? 0) - ctx.delta;
  if (e._jitterAt <= 0) {
    e._jitterAt = rand(300, 700);
    e._orbitAng = rand(0, Math.PI * 2);
    e._orbitR = orbit * rand(0.75, 1.25);
  }
  // Target point: on a ring around the player at the drone's jittered angle.
  const tx = scene.px + Math.cos(e._orbitAng) * (e._orbitR ?? orbit);
  const ty = scene.py + Math.sin(e._orbitAng) * (e._orbitR ?? orbit);
  let dx = tx - e.x, dy = ty - e.y;
  const dm = Math.hypot(dx, dy) || 1;
  // Add a tangential swirl so the swarm churns around the player.
  const swirl = (e.handed || 1);
  const desiredX = dx / dm + (-ctx.uy) * swirl * 0.5;
  const desiredY = dy / dm + (ctx.ux) * swirl * 0.5;
  const dmag = Math.hypot(desiredX, desiredY) || 1;
  e.vx = approach(e.vx, (desiredX / dmag) * mv.maxSpeed, mv.accel * ctx.dt);
  e.vy = approach(e.vy, (desiredY / dmag) * mv.maxSpeed, mv.accel * ctx.dt);
  e.angle = Math.atan2(e.vy, e.vx);
  aimAndFire(scene, e, ctx, { needLos: false });
}

// HELICOPTER — fast strafing runs. Flies a pass line offset from the player, crossing its front,
// then peels off and comes back on the other side. Flies (ignores cover). Missiles on the pass.
function helicopterBehavior(scene, e, ctx) {
  const def = e.kindDef;
  const mv = def.move;
  const offset = def.strafeRange ?? 320;
  // A pass has a heading (perpendicular-ish to the player bearing) and a side. Re-plan the pass
  // when we've overshot the player's flank or a timer elapses.
  e._passAt = (e._passAt ?? 0) - ctx.delta;
  const passSide = e.handed || 1;
  // The waypoint we're strafing toward: a point offset to the player's side and ahead along the
  // pass. Compute a perpendicular to the bearing; run along it, holding the standoff offset.
  const perpX = -ctx.uy * passSide, perpY = ctx.ux * passSide;   // player-relative lateral dir
  // Aim point sits offset from the player and leads along the pass direction.
  const holdX = scene.px - ctx.ux * offset;   // stay `offset` out along the bearing
  const holdY = scene.py - ctx.uy * offset;
  const waypointX = holdX + perpX * 220;
  const waypointY = holdY + perpY * 220;
  let dx = waypointX - e.x, dy = waypointY - e.y;
  const dm = Math.hypot(dx, dy) || 1;
  if (e._passAt <= 0 || dm < 60) { e._passAt = rand(1400, 2400); e.handed = (e.handed || 1) * -1; }
  e.vx = approach(e.vx, (dx / dm) * mv.maxSpeed, mv.accel * ctx.dt);
  e.vy = approach(e.vy, (dy / dm) * mv.maxSpeed, mv.accel * ctx.dt);
  e.angle = Math.atan2(e.vy, e.vx);
  aimAndFire(scene, e, ctx, { needLos: false });
}

// Local copy of the shared approach() (avoid importing the whole shared module chain here).
function approach(cur, target, maxStep) {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}

export const ENEMY_BEHAVIORS = {
  turret: turretBehavior,
  tank: tankBehavior,
  drone: droneBehavior,
  helicopter: helicopterBehavior,
};
