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
import { kindWeaponSlot } from '../../data/kindWeapons.js';
import {
  APPROACH, STRAFE, FACE_PLAYER, FACE_BROADSIDE,
  initGunshipCycle, stepGunshipCycle, phasePlan,
} from '../../data/gunshipCycle.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a, b) => a + Math.random() * (b - a);

// Slew the turret toward the player and fire when the player is within the kind's fire range and
// (for ground units) line-of-sight isn't blocked by cover. Flyers ignore cover. Shared tail end
// of every behavior. Returns nothing; mutates e.turret and may spawn a shot.
// #305: `slot` names which of the kind's WEAPON SLOTS (data/kindWeapons.js) is live this call —
// a role name the kind's data defines, not a weapon. Omitted ⇒ the kind's default/only gun, so
// every existing caller is unchanged. `slot: null` explicitly means HOLD FIRE: the turret still
// slews to track the player (so the unit stays menacing and is instantly ready when it re-opens)
// but nothing is fired — that's what the gunship's break-off phase uses.
function aimAndFire(scene, e, ctx, { slot = undefined, fire = true } = {}) {
  const def = e.kindDef;
  e.turret = rotateToward(e.turret, ctx.bearing, def.move.turretSlew, ctx.dt);
  // Record the live slot BEFORE the hold-fire bail, so `e.weaponSlot` always reflects what the
  // unit is currently pointing (null while holding fire) rather than going stale on the last gun
  // it happened to shoot.
  e.weaponSlot = slot;
  if (!fire) return;
  // Range comes from the LIVE slot (each gun has its own reach) rather than the kind as a whole.
  const mount = kindWeaponSlot(def, slot);
  // #304: `_enemyFireAllowed()` = the #28 debug toggle AND "the player isn't dead (past the
  // stand-down beat)". In practice a stood-down vehicle never even reaches here — _updateVehicle
  // swaps the whole behavior call out for its withdrawal move — but this keeps the gate on the
  // literal fire path too, so any future caller of a behavior fn inherits it.
  if (!scene._enemyFireAllowed()) return;
  const inRange = ctx.dist < (mount?.fireRange ?? 300);
  // EVERY unit needs a clear firing lane before it opens fire. #316 removed the last `needLos:
  // false` opt-out (flyers, #245/#94) — flyers now run this exact same gate, so the parameter is
  // gone entirely rather than left as an unused door. #72 own-hex transparency: the player's own
  // soft-cover hex (and this unit's) doesn't block the lane; and since `isSmallUnit` is false for
  // both flyer kinds (drone/helicopter are size 'large'), soft cover — forest/scrub — doesn't
  // block a flyer's lane either, exactly as it doesn't block a mech's. Hard cover blocks everyone.
  // #167: ground vehicles (tanks/infantry/carriers, often 40+ at once) ran this raycast per
  // unit per frame — now a STAGGERED CACHE (~120ms per-enemy refresh), exact at each refresh.
  const los = scene._cachedLosToPlayer(e, ctx.delta, e.x, e.y, ctx.bearing, ctx.dist, scene.px, scene.py, isSmallUnit(e));
  // Only fire once the gun is roughly on target, so shots read as aimed.
  //
  // #305: a slot may be a FIXED FORWARD mount (`fixedForward` in the kind's data) — a gun bolted
  // to the airframe rather than sitting on a slewing turret, like the gunship's nose rockets.
  // Two consequences, and the real-game run showed both matter:
  //   * It aims with the HULL, not the turret. The turret tracks the player continuously (it
  //     never stops, even through the break-off), so gating a nose gun on `e.turret` let the
  //     gunship dump a rocket salvo the instant it entered its approach — while the airframe
  //     was still ~77° off from the previous phase, firing rockets sideways out of its nose.
  //     Measured in the running game before this gate existed.
  //   * It FIRES along the hull axis for the same reason. That's what makes the dumbfire salvo
  //     something the player can read and sidestep: the rockets go where the aircraft is
  //     pointed, which he can see coming, rather than wherever an invisible turret is aimed.
  const fixed = !!mount?.fixedForward;
  const aimAxis = fixed ? e.angle : e.turret;
  const onTarget = Math.abs(Phaser.Math.Angle.Wrap(aimAxis - ctx.bearing)) < 0.35;
  if (inRange && los && onTarget) scene._fireVehicleWeapon(e, ctx, aimAxis);
}

// TURRET — static artillery emplacement. No locomotion at all; just track + fire. #94: fires an
// arcing artillery shell (napalm + the turret's weaponOverride, data/enemyKinds.js; #244
// consolidated the old siegeShell entry into it) at insane range. The SHELL's flight is still
// completely unaffected by LOS — it's the arcing DELIVERY (data/delivery.js `path: 'arcing'`,
// consumed by projectiles.js) that lets the round skip wall collision, nothing in `aimAndFire`
// touches that — so it still lobs over/through cover exactly as before once fired.
// #293: `aimAndFire`'s LOS gate covers a SEPARATE thing — the DECISION to open fire — and per #94
// the turret used to opt out of it (the old `needLos: false` flag) on the theory that "the shell
// doesn't need LOS to reach the target, so the turret doesn't either." That conflated the two:
// the shell's physics
// not needing LOS says nothing about whether the turret should be able to see the player before
// deciding to shoot at them. Result was a turret blasting the player through solid walls from
// anywhere in its (huge, 2400px) range the instant it woke, which read as omniscient rather than
// alert ("base alert vibes" playtest note). #293 put the turret back on the gate, and #316 made it
// unconditional for every kind (the opt-out flag is gone) — the turret must actually have line of
// sight (via the shared staggered `_cachedLosToPlayer`) before it opens fire; once it does fire, the
// shell itself still ignores walls in flight exactly as before. Awareness itself (`_updateVehicle`
// non-mech kinds — see its own comment) stays the existing distance+noise-only check, deliberately
// NOT given an LOS requirement: that's a separate, pre-existing design choice (kept cheap since
// vehicle kinds spawn in large numbers) about when a unit *wakes up*, not about the buggy "blind
// fire" behavior actually reported — gating just the fire decision fixes the reported issue
// without touching that cheaper wake path.
function turretBehavior(scene, e, ctx) {
  e.vx = 0; e.vy = 0;
  aimAndFire(scene, e, ctx);
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
  // #312: TRAVEL heading (routed around walls/blocking terrain), not the raw bearing to the
  // player — see `_updateVehicle`'s ctx comment. `tux/tuy` equals `ux/uy` whenever the line is
  // clear, so an unobstructed tank drives exactly as it did before. The strafe stays perpendicular
  // to travel, which is what it always meant.
  const tux = ctx.tux ?? ctx.ux, tuy = ctx.tuy ?? ctx.uy;   // #312 fallback: unrouted callers
  let mx = tux * radial - tuy * strafe;
  let my = tuy * radial + tux * strafe;
  const m = Math.hypot(mx, my) || 1;
  mx /= m; my /= m;
  return { mx, my, active: Math.abs(radial) + Math.abs(strafe) > 0 };
}

// #294 (playtest: "tread turning feels a bit too often or too smooth"): tankMoveIntent's
// radial/strafe target isn't jittery by itself — the radial component has hysteresis bands
// (advance/hold/reverse) — but `ctx.ux/uy` (the bearing to the player) drifts continuously every
// single frame as the tank moves along its strafe arc, and that drift feeds straight into
// mx/my → e.vx/e.vy → hullTravelAngle's target angle. So the hull was re-aiming at a slightly
// different heading every tick, which reads as smooth/constant re-tracking rather than a
// treaded vehicle committing to a heading and holding it. That's the actual driver, not
// `turnRate` itself (1.4 rad/s is already fairly deliberate) — so the fix is a MINIMUM COMMIT
// TIME on the desired heading: only recompute the movement intent every
// TANK_HEADING_COMMIT_MS-ish, and hold it steady in between. The hull still turns at the same
// chassis turnRate, but now toward a target that only changes in discrete beats, which is what
// makes a tread vehicle read as notchy/deliberate rather than fluidly tracking.
const TANK_HEADING_COMMIT_MS = 650;
// #294 follow-up (Jackson, live playtest note): "when the treads turn, the turret stays perfect
// on target instead of kinda moving with the tread turning and then needing to re-adjust." The
// turret was tracking the player's bearing in pure world-space (aimAndFire's rotateToward),
// totally decoupled from the hull's own rotation — but the turret is physically MOUNTED on the
// hull, so a real one would get dragged when the hull re-orients underneath it and need to
// re-settle. TANK_TURRET_DRAG is the fraction of a heading SWING (see below) applied as a
// one-time jolt to the turret's current angle.
//
// This is deliberately applied only at the moment the tank COMMITS to a new heading (the same
// beat the movement-commit fix above already introduced), not smoothly every single frame: a
// per-frame nudge sized off the hull's tiny per-tick rotation (turnRate*dt) is always smaller
// than what turretSlew*dt can correct in that same tick — rotateToward SNAPS exactly onto the
// target whenever the remaining gap is within its per-tick reach (see shared.js), so a
// same-tick drag-then-correct pair is invisible; the turret would appear perfectly locked again
// by the time this frame's aimAndFire call returns, and onTarget would never see it as knocked
// off. Applying the jolt once, sized off the FULL angular swing between the old and new
// committed heading, gives a disturbance that isn't bounded by a single tick's slew budget —
// so it genuinely takes several subsequent frames of turretSlew correction to re-settle,
// exactly the "moves with the turn, then needs to re-adjust" read Jackson described. Firing
// gates on aimAndFire's existing onTarget check (`|turret - bearing| < 0.35`), so a turret
// freshly knocked off by a heading change correctly withholds fire until it re-settles — no
// change needed there.
const TANK_TURRET_DRAG = 0.35;
function tankBehavior(scene, e, ctx) {
  const def = e.kindDef;
  const mv = def.move;
  e._headingCd = (e._headingCd ?? 0) - ctx.delta;
  if (e._headingCd <= 0 || e._heading == null) {
    e._headingCd = rand(TANK_HEADING_COMMIT_MS * 0.75, TANK_HEADING_COMMIT_MS * 1.25);
    const nextHeading = tankMoveIntent(e, ctx, def);
    if (e._heading != null) {
      const prevA = Math.atan2(e._heading.my, e._heading.mx);
      const nextA = Math.atan2(nextHeading.my, nextHeading.mx);
      const swing = Phaser.Math.Angle.Wrap(nextA - prevA);
      e.turret = (e.turret ?? 0) + swing * TANK_TURRET_DRAG;
    }
    e._heading = nextHeading;
  }
  const { mx, my, active } = e._heading;
  // #269 §7 (wake-response split): a slow/defensive kind woken from a base dock is flagged
  // `e.holdGround` — see bases.js `_wakeBase` for what that still means. #285 ("units should
  // fully commit to attacking the player"): it used to also leash this movement to stay near
  // its dock; the leash is gone now, so a hold-ground tank just runs the exact same
  // advance-to-standoff/strafe movement a non-hold-ground tank already runs, no distance cap.
  const target = active ? mv.maxSpeed : 0;
  // #295 (playtest: "tanks feel like they're sliding around as they turn... start moving in a
  // direction and the turning kinda happens to match in response, instead of turning and THEN
  // moving"): the root cause was that `e.vx`/`e.vy` used to be set DIRECTLY toward the desired
  // heading (mx, my) via `approach`, completely free of the hull's current facing — the hull
  // (`e.angle`) was then only a COSMETIC catch-up, rotating after the fact to match whatever
  // velocity already existed. That's an omnidirectional strafer with decorative hull rotation,
  // not a real point-and-drive vehicle.
  //
  // Fix: the hull still turns toward the desired heading every tick, same turnRate/#294 commit
  // stagger as before — but it now turns off the intent vector (mx, my) itself, scaled to a
  // synthetic "desired velocity" (mx/my * maxSpeed) rather than off the tank's ACTUAL e.vx/e.vy.
  // That distinction matters once thrust (below) is gated by hull alignment: a badly-misaligned
  // tank's real velocity sits near zero, and turning off e.vx/e.vy directly would strand it
  // facing the wrong way forever — no thrust because it hasn't turned yet, and it never turns
  // because hullTravelAngle's moveThreshold sees ~0 velocity and treats that as "stopped."
  // Turning off the intent vector (which is what the hull SHOULD end up facing) sidesteps that
  // chicken-and-egg trap and keeps the turn even from a dead stop or a hard reversal.
  e.angle = hullTravelAngle(e.angle, mx * mv.maxSpeed, my * mv.maxSpeed, mv.turnRate, ctx.dt);
  // Thrust is applied ALONG the hull's current facing (e.angle) — NOT toward the raw desired
  // direction (mx, my) — scaled by how well that facing is currently aligned with the desired
  // heading. `alignment` uses cos(angleBetween)^2 rather than a plain cosine: full speed dead
  // on, but a steeper falloff off-axis (~25% thrust at a 60° mismatch instead of cosine's 50%)
  // so a tank that's still mostly turned away reads as genuinely pivoting-in-place rather than
  // crabbing forward at a still-substantial diagonal clip. Clamped to 0 past 90° either way — a
  // tank facing away from where it wants to go doesn't drift there, it turns first.
  const desiredAngle = Math.atan2(my, mx);
  const alignment = Math.max(0, Math.cos(Phaser.Math.Angle.Wrap(desiredAngle - e.angle))) ** 2;
  const thrust = target * alignment;
  e.vx = approach(e.vx, Math.cos(e.angle) * thrust, mv.accel * ctx.dt);
  e.vy = approach(e.vy, Math.sin(e.angle) * thrust, mv.accel * ctx.dt);
  aimAndFire(scene, e, ctx);
}

// #282: boids-style SEPARATION for flyers — replaces the old HARD `_blockedByOtherFlyer`
// movement block (world.js), which rejected a flyer's move outright whenever its target position
// overlapped ANY other flyer's collision circle. A swarm (SWARM_SIZE = 18 drones, _spawnSwarm)
// spawns in a tight overlapping pile, so under that hard block every drone's every candidate move
// landed inside a neighbour and got rejected → the whole swarm gridlocked, unable to separate
// (there was no non-overlapping move available to break out). Soft separation fixes that: each
// flyer sums a repulsion vector pointing AWAY from every other live flyer within
// FLYER_SEPARATION_RADIUS, weighted so a closer neighbour pushes harder, and blends it into its
// desired heading. An overlapping flyer therefore always has a non-zero move carrying it apart —
// it can never freeze. The blend renormalizes to full speed, so when no flyer is nearby the
// separation term is zero and the behaviour is bit-identical to before; when flyers pile up the
// summed push dominates the orbit/pass heading and drives them apart.
//
// Cheap by construction (#237 collision-cost audit): a single radius loop over the other flyers
// with NO allocation inside it — the accumulator is a shared module-level scratch object reused
// every call (safe: JS is single-threaded and behaviours run sequentially per frame). A swarm is
// ~18, so this is a small O(n_flyers) pass per flyer.
const FLYER_SEPARATION_RADIUS = 46;   // px — comfortable spacing a flyer keeps from other flyers
const FLYER_SEPARATION_WEIGHT = 1.8;  // how strongly separation competes with the orbit/pass heading
const _sep = { x: 0, y: 0 };          // reused scratch — no per-call allocation
function flyerSeparation(scene, e) {
  _sep.x = 0; _sep.y = 0;
  const r = FLYER_SEPARATION_RADIUS;
  const r2 = r * r;
  for (const o of scene.enemies) {
    if (o === e || !o.flying) continue;
    if (o.mech.isDestroyed()) continue;
    let dx = e.x - o.x, dy = e.y - o.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r2) continue;
    const d = Math.sqrt(d2);
    // Near-exact overlap has no defined "away" direction; skip it — each flyer's OWN orbit/pass
    // target already differs (its own jittered angle / pass side), so coincident flyers still
    // pull toward different points and separate on their own; the weighted push handles the rest.
    if (d <= 0.0001) continue;
    const w = (1 - d / r) / d;   // closer ⇒ stronger; /d normalizes (dx,dy) to a unit away-vector
    _sep.x += dx * w;
    _sep.y += dy * w;
  }
  return _sep;
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
  // #282: blend in boids separation (away from nearby flyers) so a dense swarm spreads instead of
  // piling — see flyerSeparation above.
  const sep = flyerSeparation(scene, e);
  const desiredX = dx / dm + (-ctx.uy) * swirl * 0.5 + sep.x * FLYER_SEPARATION_WEIGHT;
  const desiredY = dy / dm + (ctx.ux) * swirl * 0.5 + sep.y * FLYER_SEPARATION_WEIGHT;
  const dmag = Math.hypot(desiredX, desiredY) || 1;
  e.vx = approach(e.vx, (desiredX / dmag) * mv.maxSpeed, mv.accel * ctx.dt);
  e.vy = approach(e.vy, (desiredY / dmag) * mv.maxSpeed, mv.accel * ctx.dt);
  e.angle = Math.atan2(e.vy, e.vx);
  aimAndFire(scene, e, ctx);
}

// HELICOPTER — a GUNSHIP running the #305 three-phase attack cycle. The state machine itself
// (phases, transition triggers, per-phase facing + weapon slot, the randomised standoff) is a
// pure module: data/gunshipCycle.js. Read its header for the design and the rationale; this
// function is the adapter that turns "which phase, facing which way" into velocity and a shot.
//
// This REPLACES the old flyby: it used to pick a waypoint 220px along a perpendicular, fly there,
// flip sides and repeat, facing its own velocity the whole time and hosing one weapon regardless
// of where it pointed. Jackson (2026-07-18): "helicopters should do strafe firing, not flyby
// firing." Now:
//   APPROACH   nose on the player, closing, firing the DUMBFIRE cluster salvo down the airframe
//              axis — a run the player can sidestep.
//   STRAFE     broadside, sliding laterally across the player's front, door gun chattering.
//   REPOSITION guns cold, nose into travel, out to a fresh angle of attack. Then round again.
//
// Weapon selection is driven by FACING, which is the entire point of the feature — the phase
// picks both, together, from PHASE_PLAN.
//
// Preserved from before: #282 boids `flyerSeparation` blending (so two gunships, or a gunship
// inside a drone swarm, push apart rather than overlapping) applies in EVERY phase. #316 removed
// #245's `needLos: false` (flyers shoot over cover): the gunship must now actually have line of
// sight to open fire, like every other kind.
function helicopterBehavior(scene, e, ctx) {
  const def = e.kindDef;
  const mv = def.move;
  // Lazily initialised, like the Broodhauler's deploy state above — _spawnKind stays a generic,
  // kind-agnostic constructor. The spawn-time standoff roll happens here (cycle zero).
  e.gunship ??= initGunshipCycle();
  const st = e.gunship;

  const repoDist = st.repoX == null ? Infinity : Math.hypot(st.repoX - e.x, st.repoY - e.y);
  stepGunshipCycle(st, ctx.delta, ctx.dist, {
    px: scene.px, py: scene.py, ex: e.x, ey: e.y, handed: e.handed || 1, repoDist,
  });
  const plan = phasePlan(st.phase);

  // ── Desired movement direction, per phase ──────────────────────────────────────────────
  let desiredX = 0, desiredY = 0;
  if (st.phase === APPROACH) {
    // Straight in at the player. ctx.ux/uy already point enemy → player.
    desiredX = ctx.ux; desiredY = ctx.uy;
  } else if (st.phase === STRAFE) {
    // Slide laterally across the player's front while HOLDING the standoff radius. The radial
    // component uses the same hysteresis bands as `tankMoveIntent` above (advance / hold /
    // back off) — deliberately reused rather than reinvented, because that's what stops the
    // unit oscillating between closing and retreating and reads as a steady pass instead of a
    // wobble. The lateral component is what makes it a strafe.
    const side = e.handed || 1;
    let radial = 0;
    if (ctx.dist > st.standoff * 1.15) radial = 1;
    else if (ctx.dist < st.standoff * 0.75) radial = -0.9;
    desiredX = ctx.ux * radial + (-ctx.uy * side);
    desiredY = ctx.uy * radial + (ctx.ux * side);
  } else {
    // REPOSITION — cruise out to the fresh attack point the machine picked on entry.
    const dx = (st.repoX ?? scene.px) - e.x, dy = (st.repoY ?? scene.py) - e.y;
    const dm = Math.hypot(dx, dy) || 1;
    desiredX = dx / dm; desiredY = dy / dm;
  }
  // #282: boids separation, blended into whatever the phase wanted.
  const sep = flyerSeparation(scene, e);
  desiredX += sep.x * FLYER_SEPARATION_WEIGHT;
  desiredY += sep.y * FLYER_SEPARATION_WEIGHT;
  const dmag = Math.hypot(desiredX, desiredY) || 1;
  e.vx = approach(e.vx, (desiredX / dmag) * mv.maxSpeed, mv.accel * ctx.dt);
  e.vy = approach(e.vy, (desiredY / dmag) * mv.maxSpeed, mv.accel * ctx.dt);

  // ── Facing, per phase ──────────────────────────────────────────────────────────────────
  // Rotated at the chassis `turnRate` rather than snapped, so the turn between phases is a
  // visible manoeuvre — the gunship is seen swinging broadside, which is the tell that tells
  // the player which gun is about to speak.
  let want;
  if (plan.facing === FACE_PLAYER) want = ctx.bearing;
  else if (plan.facing === FACE_BROADSIDE) want = ctx.bearing + (Math.PI / 2) * (e.handed || 1);
  else want = Math.atan2(e.vy, e.vx);
  e.angle = rotateToward(e.angle, want, mv.turnRate, ctx.dt);

  // ── Guns ───────────────────────────────────────────────────────────────────────────────
  // The phase names the slot; `slot: null` (REPOSITION) holds fire while still tracking.
  // #316: no flyer LOS exemption any more — `aimAndFire`'s shared cover gate applies here too.
  aimAndFire(scene, e, ctx, { slot: plan.slot, fire: plan.slot != null });
}

// CARRIER — "Broodhauler" (#130, swarm deploy reworked in #147, drones-only + origin fixed in
// #152, reworked into an unarmed tank-bodied carrier in #328). Grinds to a standoff and holds,
// the same tank-style hull-travel pattern as tankBehavior (reused deliberately, not reinvented —
// see tankBehavior above for the same radial/strafe shape), just on a slower/heavier chassis.
// Its whole threat is the periodic SWARM deploy: while alive and AWARE (this fn only runs while
// aware — see _updateVehicle's aware gate) it acts as a mobile "nest," dropping a whole BATCH of
// drones from its own body on a data-driven cadence (def.deployEveryMs), sized between
// def.deployBatchMin-deployBatchMax, up to a lifetime cap (def.deployCap) so a long fight can't
// have it spawn forever unbounded. This is PER-FRAME incremental spawning (unlike
// turretNest/infantryMob, which expand everything up front at spawn time) — the timer/count
// state (`e.deployCd`/`e.deployCount`) is lazily initialized here since _spawnKind stays a
// generic, kind-agnostic constructor.
//
// #328: UNARMED. Jackson chose "unarmed — pure carrier", so this behaviour never calls
// `aimAndFire` and the kind carries no weapon data at all. With nothing to aim, the unit's
// second sprite — the launch BAY DOOR, where every other kind has a gun turret — is pinned to
// the hull's own angle so it reads as bolted to the deck.
//
// #152 (round-2 playtest): "deploy drones only" — DEPLOY_INFANTRY gates infantry back OUT of the
// rotation (flag-disabled, not deleted — flip it back to `true` to restore the drone+infantry
// mix from #147, same disable-not-delete pattern #144 used for the aim-line).
// #239: confirmed this already stays `false`, so the nest-deploy can't spawn infantry even
// though infantryMob itself is separately pulled from ENEMY_ROTATION/DEFAULT_SQUAD/LATE_POOL
// (data/enemies.js, data/run.js) pending a redesign — no change needed here for #239.
const DEPLOY_INFANTRY = false;
const CARRIER_DEPLOY_KINDS = DEPLOY_INFANTRY ? ['drone', 'infantry'] : ['drone'];

// #328: how long (ms) the bay door holds OPEN after a batch launches. Long enough to actually
// read at gameplay zoom (the batch's own "emerging" pop tween below is 260ms), short enough that
// the carrier spends most of its 4s deploy cycle visibly buttoned up. Owner: tunable.
const DOOR_OPEN_MS = 900;

// Drop a fresh kind spawn essentially AT the nest's own body position — #152 (round-2 playtest:
// "spawn from within the body, not beside it" — the old 50-80px offset read as popping in beside
// the unit rather than emerging from it). A tiny few-px jitter keeps simultaneous spawns
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
function carrierMoveIntent(e, ctx, def) {
  const standoff = def.standoff ?? 320;
  let radial = 0;
  if (ctx.dist > standoff * 1.15) radial = 1;
  else if (ctx.dist < standoff * 0.7) radial = -0.8;
  const strafe = (e.handed || 1) * 0.2;
  // #312: routed travel heading — see tankMoveIntent above.
  const tux = ctx.tux ?? ctx.ux, tuy = ctx.tuy ?? ctx.uy;   // #312 fallback: unrouted callers
  let mx = tux * radial - tuy * strafe;
  let my = tuy * radial + tux * strafe;
  const m = Math.hypot(mx, my) || 1;
  mx /= m; my /= m;
  return { mx, my, active: Math.abs(radial) + Math.abs(strafe) > 0 };
}

function carrierBehavior(scene, e, ctx) {
  const def = e.kindDef;
  const mv = def.move;
  const { mx, my, active } = carrierMoveIntent(e, ctx, def);
  // #269 §7 / #285: same hold-ground wake response as tankBehavior above — a woken defensive
  // dock unit runs its normal advance-to-standoff/strafe movement exactly like a non-hold-ground
  // unit, no leash/distance cap (removed per #285). The deploy mechanic below still runs
  // regardless (it's a support ability, not locomotion).
  const target = active ? mv.maxSpeed : 0;
  // #295 follow-up: this shares tankBehavior's exact hull-travel pattern by design (see the
  // header comment above) and had the identical "hull is a cosmetic catch-up, thrust is free of
  // facing" bug — same root cause, same fix, applied the same way: the hull turns toward the
  // intent vector (scaled to a synthetic desired velocity so it clears hullTravelAngle's
  // moveThreshold even when actual thrust is ~0), then thrust is applied along the hull's OWN
  // current facing, scaled by alignment with the desired heading. Deliberately NOT porting
  // #294's heading-commit stagger here — that solved a separate "re-aims too smoothly" complaint
  // that was never reported for this unit. See tankBehavior above for the fuller rationale.
  e.angle = hullTravelAngle(e.angle, mx * mv.maxSpeed, my * mv.maxSpeed, mv.turnRate, ctx.dt);
  const desiredAngle = Math.atan2(my, mx);
  const alignment = Math.max(0, Math.cos(Phaser.Math.Angle.Wrap(desiredAngle - e.angle))) ** 2;
  const thrust = target * alignment;
  e.vx = approach(e.vx, Math.cos(e.angle) * thrust, mv.accel * ctx.dt);
  e.vy = approach(e.vy, Math.sin(e.angle) * thrust, mv.accel * ctx.dt);
  // #328: unarmed — no aimAndFire. The bay door is deck-mounted, so it rides the hull's angle
  // rather than tracking the player like every armed kind's turret does.
  e.turret = e.angle;
  carrierDeployTick(scene, e, def, ctx);
}

// #130/#147 deploy mechanic — lazily initializes the per-enemy timer/count on first tick so the
// generic _spawnKind constructor never needs kind-specific bootstrapping.
function carrierDeployTick(scene, e, def, ctx) {
  if (e.deployCd == null) e.deployCd = rand(def.deployEveryMs * 0.4, def.deployEveryMs);
  e.deployCount = e.deployCount ?? 0;
  e.deployCd -= ctx.delta;
  // #328: tick the bay door's open timer down and publish the live art frame. `turretFrame` is
  // the generic multi-frame-turret seam (enemies.js `_updateVehicle`), 0 = shut, 1 = open.
  e.doorMs = Math.max(0, (e.doorMs ?? 0) - ctx.delta);
  e.turretFrame = e.doorMs > 0 ? 1 : 0;
  const cap = def.deployCap ?? 5;
  if (e.deployCd <= 0 && e.deployCount < cap) {
    // #147: deploy a whole SWARM-sized batch at once (not one unit per tick) — sized between
    // deployBatchMin/Max but clamped so a batch near the end of the lifetime cap can't overshoot
    // it and spawn more than deployCap total.
    const batchMin = def.deployBatchMin ?? 1, batchMax = def.deployBatchMax ?? batchMin;
    const wanted = batchMin + Math.floor(Math.random() * (batchMax - batchMin + 1));
    const batchSize = Math.min(wanted, cap - e.deployCount);
    for (let i = 0; i < batchSize; i++) {
      const kindId = CARRIER_DEPLOY_KINDS[Math.floor(Math.random() * CARRIER_DEPLOY_KINDS.length)];
      deployNearby(scene, e, kindId);
    }
    e.deployCount += batchSize;
    e.deployCd = def.deployEveryMs;
    // #328: the doors fly open for the launch, then shut again (DOOR_OPEN_MS above).
    e.doorMs = DOOR_OPEN_MS;
    e.turretFrame = 1;
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
    // #312: routed travel heading — see tankMoveIntent. Infantry are the single largest ground
    // population on a generated map, so this is where routing is most visible.
    mx = (ctx.tux ?? ctx.ux) + Math.cos(e._orbitAng) * 0.35;
    my = (ctx.tuy ?? ctx.uy) + Math.sin(e._orbitAng) * 0.35;
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
  // #269 §7 / #285: same hold-ground wake response as tank/carrier above — a woken trooper
  // advances/mills exactly like a non-hold-ground one, no leash/distance cap (removed per #285).
  e.vx = approach(e.vx, mx * mv.maxSpeed, mv.accel * ctx.dt);
  e.vy = approach(e.vy, my * mv.maxSpeed, mv.accel * ctx.dt);
  if (Math.hypot(e.vx, e.vy) > 5) e.angle = Math.atan2(e.vy, e.vx);
  aimAndFire(scene, e, ctx);
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
  carrier: carrierBehavior,
};
