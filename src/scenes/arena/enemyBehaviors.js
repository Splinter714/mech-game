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
import { rotateToward, hullTravelAngle, isSmallUnit } from './shared.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a, b) => a + Math.random() * (b - a);

// Slew the turret toward the player and fire when the player is within the kind's fire range and
// (for ground units) line-of-sight isn't blocked by cover. Flyers ignore cover. Shared tail end
// of every behavior. Returns nothing; mutates e.turret and may spawn a shot.
function aimAndFire(scene, e, ctx, { needLos }) {
  const def = e.kindDef;
  e.turret = rotateToward(e.turret, ctx.bearing, def.move.turretSlew, ctx.dt);
  if (!scene.enemyFire) return;
  const inRange = ctx.dist < (def.fireRange ?? 300);
  // Ground units need a clear firing lane; flyers shoot over everything. #72 own-hex
  // transparency: the player's own soft-cover hex (and this unit's) doesn't block the lane.
  // #167: ground vehicles (tanks/infantry/quadrupeds, often 40+ at once) ran this raycast per
  // unit per frame — now a STAGGERED CACHE (~120ms per-enemy refresh), exact at each refresh.
  const los = needLos ? scene._cachedLosToPlayer(e, ctx.delta, e.x, e.y, ctx.bearing, ctx.dist, scene.px, scene.py, isSmallUnit(e)) : true;
  // Only fire once the gun is roughly on target, so shots read as aimed.
  const onTarget = Math.abs(Phaser.Math.Angle.Wrap(e.turret - ctx.bearing)) < 0.35;
  if (inRange && los && onTarget) scene._fireVehicleWeapon(e, ctx, e.turret);
}

// TURRET — static artillery emplacement. No locomotion at all; just track + fire. #94: fires an
// arcing artillery shell (napalm + the turret's weaponOverride, data/enemyKinds.js; #244
// consolidated the old siegeShell entry into it) at insane range. The SHELL's flight is still
// completely unaffected by LOS — it's the arcing DELIVERY (data/delivery.js `path: 'arcing'`,
// consumed by projectiles.js) that lets the round skip wall collision, nothing in `aimAndFire`
// touches that — so it still lobs over/through cover exactly as before once fired.
// #293: `needLos` here gates a SEPARATE thing — the DECISION to open fire — and per #94 that used
// to be dropped entirely (`needLos: false`) on the theory that "the shell doesn't need LOS to
// reach the target, so the turret doesn't either." That conflated the two: the shell's physics
// not needing LOS says nothing about whether the turret should be able to see the player before
// deciding to shoot at them. Result was a turret blasting the player through solid walls from
// anywhere in its (huge, 2400px) range the instant it woke, which read as omniscient rather than
// alert ("base alert vibes" playtest note). Now `needLos: true`, same as tank/quadruped — the
// turret must actually have line of sight (via the shared staggered `_cachedLosToPlayer`, same
// cache every other needLos:true kind already uses) before it opens fire; once it does fire, the
// shell itself still ignores walls in flight exactly as before. Awareness itself (`_updateVehicle`
// non-mech kinds — see its own comment) stays the existing distance+noise-only check, deliberately
// NOT given an LOS requirement: that's a separate, pre-existing design choice (kept cheap since
// vehicle kinds spawn in large numbers) about when a unit *wakes up*, not about the buggy "blind
// fire" behavior actually reported — gating just the fire decision fixes the reported issue
// without touching that cheaper wake path.
function turretBehavior(scene, e, ctx) {
  e.vx = 0; e.vy = 0;
  aimAndFire(scene, e, ctx, { needLos: true });
}

// TANK — grinds to a firing standoff and holds. #92: the HULL drives like a real tank — it
// turns to face wherever it's actually TRAVELLING, not the player — while the TURRET tracks
// the player completely independently (aimAndFire below sets e.turret on its own slew), the
// same hull-vs-turret decoupling the player's own mech has (locomotion.js `_drive`: `this.angle`
// follows travel, `this.turretAngle` follows aim). Slow, heavy; blocked by cover/water. Backs
// off if the player crowds it.
// Grind-to-standoff-and-hold movement intent, shared by the normal and #269 Part 1 hold-ground
// paths below (extracted so both run the literal SAME formula, not a copy that can drift).
// Desired radial move: close if beyond standoff, ease off inside it, back up if very close. A
// slight lateral creep so it isn't a perfectly static block once at range.
function tankMoveIntent(e, ctx, def) {
  const standoff = def.standoff ?? 300;
  let radial = 0;
  if (ctx.dist > standoff * 1.15) radial = 1;          // advance
  else if (ctx.dist < standoff * 0.7) radial = -0.8;   // reverse (keep the gun's distance)
  const strafe = (e.handed || 1) * 0.25;
  let mx = ctx.ux * radial - ctx.uy * strafe;
  let my = ctx.uy * radial + ctx.ux * strafe;
  const m = Math.hypot(mx, my) || 1;
  mx /= m; my /= m;
  return { mx, my, active: Math.abs(radial) + Math.abs(strafe) > 0 };
}

function tankBehavior(scene, e, ctx) {
  const def = e.kindDef;
  const mv = def.move;
  const { mx, my, active } = tankMoveIntent(e, ctx, def);
  // #269 §7 (wake-response split): a slow/defensive kind woken from a base dock is flagged
  // `e.holdGround` — see bases.js `_wakeBase` for what that still means. #285 ("units should
  // fully commit to attacking the player"): it used to also leash this movement to stay near
  // its dock; the leash is gone now, so a hold-ground tank just runs the exact same
  // advance-to-standoff/strafe movement a non-hold-ground tank already runs, no distance cap.
  const target = active ? mv.maxSpeed : 0;
  e.vx = approach(e.vx, mx * target, mv.accel * ctx.dt);
  e.vy = approach(e.vy, my * target, mv.accel * ctx.dt);
  // Hull faces the direction of travel (tank-like driving), turning at the chassis turn rate;
  // it holds its last heading while stopped rather than snapping to face the player.
  e.angle = hullTravelAngle(e.angle, e.vx, e.vy, mv.turnRate, ctx.dt);
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

// QUADRUPED — "Broodwalker" (#130, swarm deploy reworked in #147, drones-only + origin fixed in
// #152). Grinds to a firing standoff and holds, same tank-style hull-travel/turret-independent-
// track pattern as tankBehavior (reused deliberately, not reinvented — see tankBehavior above
// for the same radial/strafe shape), just on a slower/heavier chassis. PLUS a periodic SWARM
// deploy mechanic: while alive and AWARE (this fn only runs while aware — see _updateVehicle's
// aware gate) it acts as a mobile "nest," dropping a whole BATCH of units from its own body on a
// data-driven cadence (def.deployEveryMs), sized between def.deployBatchMin-deployBatchMax, up
// to a lifetime cap (def.deployCap) so a long fight can't have it spawn forever unbounded. This
// is PER-FRAME incremental spawning (unlike turretNest/infantryMob, which expand everything up
// front at spawn time) — the timer/count state (`e.deployCd`/`e.deployCount`) is lazily
// initialized here since _spawnKind stays a generic, kind-agnostic constructor.
//
// #152 (round-2 playtest): "deploy drones only" — DEPLOY_INFANTRY gates infantry back OUT of the
// rotation (flag-disabled, not deleted — flip it back to `true` to restore the drone+infantry
// mix from #147, same disable-not-delete pattern #144 used for the aim-line).
// #239: confirmed this already stays `false`, so the Broodwalker's nest-deploy can't spawn
// infantry even though infantryMob itself is separately pulled from ENEMY_ROTATION/DEFAULT_SQUAD/
// LATE_POOL (data/enemies.js, data/run.js) pending a redesign — no change needed here for #239,
// this flag already keeps the two consistent.
const DEPLOY_INFANTRY = false;
const QUADRUPED_DEPLOY_KINDS = DEPLOY_INFANTRY ? ['drone', 'infantry'] : ['drone'];

// Drop a fresh kind spawn essentially AT the nest's own body position — #152 (round-2 playtest:
// "spawn from within the body, not beside it" — the old 50-80px offset read as popping in beside
// the Broodwalker rather than emerging from it). A tiny few-px jitter keeps simultaneous spawns
// within one batch from stacking on the exact same pixel; still nudges off blocked terrain toward
// the nest itself (mirrors the same pattern used by enemies.js `_flankGoal`/`_idleMoveIntent`) as
// a defensive fallback, though at this radius it's rarely ever needed. A brief "emerging" pop
// (starts tiny/near-transparent, tweens up to full size/opacity) sells the idea that the unit is
// birthed from the nest rather than simply appearing.
function deployNearby(scene, e, kindId) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * 4;
  let x = e.x + Math.cos(a) * r, y = e.y + Math.sin(a) * r;
  for (let t = 0; t < 5 && scene._blocked(x, y); t++) { x = (x + e.x) / 2; y = (y + e.y) / 2; }
  const spawned = scene._spawnKind(x, y, kindId);
  if (spawned?.view) {
    const view = spawned.view;
    view.setScale(0.05, 0.05).setAlpha(0.15);
    scene.tweens.add({ targets: view, scaleX: 1, scaleY: 1, alpha: 1, duration: 260, ease: 'Back.easeOut' });
  }
}

// Same grind-to-standoff-and-hold shape as tankMoveIntent above, just its own standoff default
// and a slightly lighter strafe — extracted so the normal and #269 Part 1 hold-ground-leashed
// paths below both run the literal same formula.
function quadrupedMoveIntent(e, ctx, def) {
  const standoff = def.standoff ?? 320;
  let radial = 0;
  if (ctx.dist > standoff * 1.15) radial = 1;
  else if (ctx.dist < standoff * 0.7) radial = -0.8;
  const strafe = (e.handed || 1) * 0.2;
  let mx = ctx.ux * radial - ctx.uy * strafe;
  let my = ctx.uy * radial + ctx.ux * strafe;
  const m = Math.hypot(mx, my) || 1;
  mx /= m; my /= m;
  return { mx, my, active: Math.abs(radial) + Math.abs(strafe) > 0 };
}

function quadrupedBehavior(scene, e, ctx) {
  const def = e.kindDef;
  const mv = def.move;
  const { mx, my, active } = quadrupedMoveIntent(e, ctx, def);
  // #269 §7 / #285: same hold-ground wake response as tankBehavior above — a woken defensive
  // dock unit runs its normal advance-to-standoff/strafe movement exactly like a non-hold-ground
  // unit, no leash/distance cap (removed per #285). The deploy-drone mechanic below still runs
  // regardless (it's a support ability, not locomotion).
  const target = active ? mv.maxSpeed : 0;
  e.vx = approach(e.vx, mx * target, mv.accel * ctx.dt);
  e.vy = approach(e.vy, my * target, mv.accel * ctx.dt);
  // Hull faces the direction of travel; turret tracks the player completely independently
  // (aimAndFire below sets e.turret on its own slew) — same hull-vs-turret decoupling as tank.
  e.angle = hullTravelAngle(e.angle, e.vx, e.vy, mv.turnRate, ctx.dt);
  aimAndFire(scene, e, ctx, { needLos: true });
  quadrupedDeployTick(scene, e, def, ctx);
}

// #130/#147 deploy mechanic, split out so both the normal (advance-to-standoff) and #269
// hold-ground wake-response paths above can call it — lazily initializes the per-enemy
// timer/count on first tick so the generic _spawnKind constructor never needs kind-specific
// bootstrapping.
function quadrupedDeployTick(scene, e, def, ctx) {
  if (e.deployCd == null) e.deployCd = rand(def.deployEveryMs * 0.4, def.deployEveryMs);
  e.deployCount = e.deployCount ?? 0;
  e.deployCd -= ctx.delta;
  const cap = def.deployCap ?? 5;
  if (e.deployCd <= 0 && e.deployCount < cap) {
    // #147: deploy a whole SWARM-sized batch at once (not one unit per tick) — sized between
    // deployBatchMin/Max but clamped so a batch near the end of the lifetime cap can't overshoot
    // it and spawn more than deployCap total.
    const batchMin = def.deployBatchMin ?? 1, batchMax = def.deployBatchMax ?? batchMin;
    const wanted = batchMin + Math.floor(Math.random() * (batchMax - batchMin + 1));
    const batchSize = Math.min(wanted, cap - e.deployCount);
    for (let i = 0; i < batchSize; i++) {
      const kindId = QUADRUPED_DEPLOY_KINDS[Math.floor(Math.random() * QUADRUPED_DEPLOY_KINDS.length)];
      deployNearby(scene, e, kindId);
    }
    e.deployCount += batchSize;
    e.deployCd = def.deployEveryMs;
  }
}

// INFANTRY — one trooper of a ground swarm (#97). Simple "advance and mill": closes on the
// player until it's roughly at its fire range, then loosely mills around that ring (a small
// per-trooper jittered orbit angle, re-picked periodically) so a big mob reads as a churning
// crowd rather than a single-file conga line or a static firing line. Ground unit — needs LOS
// like a tank/turret (it can't shoot through walls), and collides with terrain like any
// ground unit (handled generically by the caller, same as tank/turret).
// "Advance and mill" movement intent, shared by the normal and #269 Part 1 hold-ground-leashed
// paths below (extracted so both run the literal same formula).
function infantryMoveIntent(e, ctx, def) {
  const standoff = (def.fireRange ?? 200) * 0.75;
  e._jitterAt = (e._jitterAt ?? 0) - ctx.delta;
  if (e._jitterAt <= 0) {
    e._jitterAt = rand(500, 1100);
    e._orbitAng = rand(0, Math.PI * 2);
  }
  let mx, my;
  if (ctx.dist > standoff * 1.2) {
    // Advance, with a little lateral jitter so the mob doesn't funnel into one file.
    mx = ctx.ux + Math.cos(e._orbitAng) * 0.35;
    my = ctx.uy + Math.sin(e._orbitAng) * 0.35;
  } else {
    // Close enough to shoot — mill loosely rather than standing dead still.
    mx = Math.cos(e._orbitAng) * 0.5;
    my = Math.sin(e._orbitAng) * 0.5;
  }
  const m = Math.hypot(mx, my) || 1;
  return { mx: mx / m, my: my / m };
}

function infantryBehavior(scene, e, ctx) {
  const def = e.kindDef;
  const mv = def.move;
  const { mx, my } = infantryMoveIntent(e, ctx, def);
  // #269 §7 / #285: same hold-ground wake response as tank/quadruped above — a woken trooper
  // advances/mills exactly like a non-hold-ground one, no leash/distance cap (removed per #285).
  e.vx = approach(e.vx, mx * mv.maxSpeed, mv.accel * ctx.dt);
  e.vy = approach(e.vy, my * mv.maxSpeed, mv.accel * ctx.dt);
  if (Math.hypot(e.vx, e.vy) > 5) e.angle = Math.atan2(e.vy, e.vx);
  aimAndFire(scene, e, ctx, { needLos: true });
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
  infantry: infantryBehavior,
  quadruped: quadrupedBehavior,
};
