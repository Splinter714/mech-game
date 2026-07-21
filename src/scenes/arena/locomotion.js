// Arena locomotion mixin — the player mech's view, muzzle geometry, twin-stick drive,
// stompy stepped gait, and footfall FX. Methods use `this` (the ArenaScene); composed onto
// the prototype via Object.assign. The pure relocation keeps `update()` a thin orchestrator
// that calls `_drive` then `_stepGait`.
import Phaser from 'phaser';
import { mechLayout, ART_SCALE, partSpriteTransform } from '../../art/index.js';
import { isWeapon } from '../../data/items.js';
import { getWeapon } from '../../data/weapons.js';
import { Audio } from '../../audio/index.js';
import { ARENA_MECH_SCALE, DEPTH, PLAYER_WALL_COLLIDE_RADIUS, approach, mechMuzzleTipOffset, partMuzzle, rotateToward, unitDepth } from './shared.js';
import { PART_PIVOT, PIVOT_LOCATIONS } from '../../art/mechArt.js';
import { STICK_DEADZONE } from '../../input/Controls.js';
import { HEX_SIZE } from '../../data/hexgrid.js';
import { primaryPlayerOf } from './players.js';
import { SPRINT_SPEED_MULT } from '../../data/sprint.js';
import { DASH_SPEED_MULT } from '../../data/dash.js';

// Convergence tilt is temporal-smoothed so a part EASES toward its target angle instead of
// snapping every frame. Without this the tilt snaps on each frame-to-frame change in the
// convergence geometry — the turret slewing, the target moving, and ESPECIALLY a soft-lock
// engaging/dropping (which jumps the convergence distance CONVERGE_DIST↔the locked range),
// reading as jitter/flapping. `TILT_SMOOTH_K` is the exponential rate (1/s): higher = snappier.
// ~12 gives a weighted actuated-limb swing that settles in a couple hundred ms — not instant,
// not sluggish, not springy.
const TILT_SMOOTH_K = 12;

// #154 experiment: try an instant-turning control feel — the PLAYER's body/leg facing and
// turret snap immediately to their target angle every frame, bypassing the chassis'
// `turnRate`/`turretSlew` rate limits entirely. This is a trivially-reversible toggle, not a
// committed design change (same pattern as #144's aim-line disable flag): flip back to false
// to restore the exact previous rate-limited feel. Only affects the player's _drive() below —
// enemy turn-rate/turret-slew logic (enemies.js / enemyBehaviors.js) is separate and untouched.
const INSTANT_TURNING = true;

// #159 follow-up to #154/#156: INSTANT_TURNING only snapped the player's FACING to input —
// the underlying VELOCITY still eased toward the commanded speed via the accel/decel
// weight-inertia model below (`approach(this.vx, tx, ...)`), so the mech still visibly
// ramped up/down rather than moving at full commanded speed immediately. This flag, same
// trivially-reversible pattern as INSTANT_TURNING, snaps vx/vy directly to the target (tx/ty)
// each frame instead of easing when true. Per-chassis accel/decel become moot while this is
// on (left in the chassis data, just bypassed). Flip back to false to restore the exact
// previous accel/decel behavior.
const INSTANT_VELOCITY = true;

// #159 follow-up (collision-tunneling fix): `_blocked` is a single-POINT check — it only tests
// the mech's post-move endpoint each frame, not the path swept to get there. That was safe as
// long as a frame's movement stayed comfortably smaller than a hex, but higher chassis speeds +
// INSTANT_VELOCITY's no-ramp-up snap mean a single frame can now cover enough ground to graze
// clean past a hex's narrow cross-section (at a shallow/grazing angle a hex's width along the
// path can be far smaller than its ~48px radius) without ever landing a sample point inside it —
// confirmed by direct measurement: forcing a wall hex and driving a fast, INSTANT_VELOCITY mech
// into it from a broad sweep of continuous approach angles (simulating analog-stick input)
// tunneled through in the MAJORITY of angles, even with an intermediate fix that substepped
// position by a fixed 8px (nowhere near fine enough — a corner-graze can have an arbitrarily
// small crossing width, so no fixed pixel substep size can fully close that gap). The actual
// fix is `_blockedAlongSegment` (world.js) below, which walks every hex a substep's straight
// path crosses (hexgrid.js `hexesAlongSegment`, the standard hex line-draw algorithm) instead
// of sampling only its endpoint — exact regardless of angle or speed. `COLLISION_SUBSTEP_PX`
// still subdivides the frame's movement, now mainly so the ENEMY-circle checks below
// (`_crushTargetAt`/`_blockedByGroundEnemy`, still single-point per substep) stay reasonably
// fine-grained at high speed too. HEX_SIZE/6 (=8px) keeps that reasonably tight while adding at
// most a handful of cheap substeps per frame (worst-case ~18px/frame ÷ 8 ≈ 3). Applies
// regardless of INSTANT_VELOCITY — the old ramped-accel path was just less likely to reach
// tunneling-capable speeds, not immune to the underlying gap.
const COLLISION_SUBSTEP_PX = HEX_SIZE / 6;

export const LocomotionMixin = {
  // A mech = hull (legs) + side torsos + arms + turret-body stacked in a container so they can
  // rotate independently around the shared centre. Layer order back→front:
  // [hull, leftTorso, rightTorso, armL, armR, body]. The side torsos sit behind the arms and
  // UNDER the body (centre torso + head) so the body occludes their inner edges and the arms
  // occlude them — the top-down read at tilt 0, and what keeps an inward-canted part tucked
  // under the body. Each off-centre part pivots at its own joint (arms at the shoulder, side
  // torsos nearer their centre — see partSpriteTransform).
  // #113/#289: `isPlayer` picks the depth tier — the player mech (ArenaScene.create()) passes true
  // and stays at DEPTH.UNITS; every enemy mech (enemies.js `_spawnMech`) leaves it false. A mech is
  // always a LARGE ground unit (`small=false`), so an enemy mech renders at DEPTH.LARGE_GROUND_UNITS
  // — below the player but ABOVE the cover canopy, so it towers over tree tops (see `unitDepth`).
  _makeMechView(key, x, y, angle, isPlayer = false) {
    const hull = this.add.sprite(0, 0, `${key}_hull_0`).setScale(ARENA_MECH_SCALE);
    const torL = this.add.sprite(0, 0, `${key}_leftTorso`).setScale(ARENA_MECH_SCALE);
    const torR = this.add.sprite(0, 0, `${key}_rightTorso`).setScale(ARENA_MECH_SCALE);
    const armL = this.add.sprite(0, 0, `${key}_leftArm`).setScale(ARENA_MECH_SCALE);
    const armR = this.add.sprite(0, 0, `${key}_rightArm`).setScale(ARENA_MECH_SCALE);
    const turret = this.add.sprite(0, 0, `${key}_turret`).setScale(ARENA_MECH_SCALE);
    hull.rotation = angle + Math.PI / 2;
    turret.rotation = angle + Math.PI / 2;
    const c = this.add.container(x, y, [hull, torL, torR, armL, armR, turret]);
    // #99: explicit depth — was relying on scene add-order, which put whichever mech view got
    // created LAST (any enemy spawned after the player) on top regardless of actual position.
    // #113/#289: enemy mechs are LARGE GROUND units — below the player (DEPTH.UNITS) but above the
    // cover canopy (DEPTH.LARGE_GROUND_UNITS) — see `unitDepth` / the tier comment in shared.js. An
    // enemy mech is never flying (`flying=false`) and is never small (`small=false`).
    c.setDepth(unitDepth(isPlayer, false, false));
    c.hull = hull; c.torL = torL; c.torR = torR; c.armL = armL; c.armR = armR; c.turret = turret;
    // Per-view smoothing state: the CURRENTLY-APPLIED convergence tilt of each pivoting part,
    // eased toward its target each frame (see _syncTilts). Starts at the resting tilt (0) so a
    // fresh deploy/spawn doesn't swing in from a stale angle.
    c._tilt = { leftTorso: 0, rightTorso: 0, leftArm: 0, rightArm: 0 };
    return c;
  },

  // Ease a view's stored per-part tilts toward `targets` (loc → target tilt), then apply them
  // via _syncPivots. Exponential smoothing at TILT_SMOOTH_K, wrapping each step so it takes the
  // short way around the ±π seam (a lock-flip must not spin the long way). `targets` may omit a
  // loc (treated as 0). Enemies pass all-0 targets, which the smoothing handles cleanly (stays
  // 0, no drift). Falls back to snapping if dt is absent/NaN so the first frame can't produce NaN.
  _syncTilts(view, mech, angle, scale, baseX, baseY, targets, dt) {
    const a = 1 - Math.exp(-TILT_SMOOTH_K * dt);
    const smooth = Number.isFinite(a) ? Phaser.Math.Clamp(a, 0, 1) : 1;
    const t = view._tilt;
    for (const loc of PIVOT_LOCATIONS) {
      const target = targets[loc] || 0;
      const delta = Phaser.Math.Angle.Wrap(target - t[loc]);
      t[loc] = Phaser.Math.Angle.Wrap(t[loc] + delta * smooth);
    }
    this._syncPivots(view, mech, angle, scale, baseX, baseY, t);
  },

  // Place + pivot a mech view's four off-centre part sprites (side torsos + arms) toward their
  // convergence tilt. The sprites are children of the container (local origin = centre), so
  // callers pass baseX = baseY = 0. `tilts` maps a loc → its convergence tilt (0 = straight).
  _syncPivots(view, mech, angle, scale, baseX, baseY, tilts) {
    const parts = [
      [view.torL, 'leftTorso'], [view.torR, 'rightTorso'],
      [view.armL, 'leftArm'], [view.armR, 'rightArm'],
    ];
    for (const [sprite, loc] of parts) {
      const t = partSpriteTransform(mech, loc, angle, scale);
      sprite.setOrigin(t.ox, t.oy);
      sprite.setPosition(baseX + t.dx, baseY + t.dy);
      sprite.rotation = t.rot + (tilts[loc] || 0);
    }
  },

  // Convergence tilt for one off-centre part (arm or side torso), from its own first mounted
  // weapon: how far that weapon's fire angle deviates from the turret facing. Direct-fire
  // weapons converge inward (a small tilt — smaller for side torsos, whose muzzles are less
  // off-centre); indirect/melee/empty parts return 0 (straight). Mirrors firing's _fireAngle.
  // #347: `player` is whose limb this is. Defaults to the primary player, so every existing
  // caller and arena test double is unaffected.
  _partTilt(loc, player = primaryPlayerOf(this)) {
    if (player.mech.isPartDestroyed(loc)) return 0;
    const ids = player.mech.mounts[loc].filter(isWeapon);
    if (!ids.length) return 0;
    const w = { weapon: getWeapon(ids[0]), location: loc };
    const m = this._muzzle(loc, player);
    const fireAngle = this._fireAngle(w, m, player);
    return Phaser.Math.Angle.Wrap(fireAngle - player.turretAngle);
  },

  // World position of a weapon's muzzle: its body-location offset (the mounted weapon's
  // actual ART TIP — #233 — not just the front edge of the part) rotated by the turret
  // facing. So a left-arm shot leaves the tip of the left arm's gun, a right-torso shot the
  // tip of the right torso's, etc.
  // #233 follow-up: a pivoting part (arm/side-torso) is currently sitting at its OWN live
  // convergence tilt (`this.playerView._tilt[loc]`, eased in `_syncTilts`/`_stepGait`, which
  // runs earlier in the same frame — see ArenaScene.update()'s `_stepGait` before
  // `_handleFiring`), not necessarily its neutral/rest angle. Passing that live tilt (plus the
  // matching `PART_PIVOT` joint fraction the sprite itself pivots around) into `partMuzzle`
  // rotates the tip offset by the part's ACTUAL current orientation instead of assuming it's
  // still square with the turret — otherwise the computed muzzle drifts from the real rendered
  // barrel tip any time convergence has the part tilted. centerTorso/head never pivot, so their
  // tilt/pivot stay at the defaults (0), same math as before.
  _muzzle(loc, player = primaryPlayerOf(this)) {
    const disp = ARENA_MECH_SCALE * ART_SCALE;
    const part = mechLayout(player.mech)[loc];
    const tipOffset = mechMuzzleTipOffset(player.mech, loc, part);
    const tilt = player.view?._tilt?.[loc] || 0;
    const pivotFrac = PART_PIVOT[loc] ?? 0;
    return partMuzzle(part, player.x, player.y, player.turretAngle, disp, tipOffset, tilt, pivotFrac);
  },

  // Twin-stick locomotion + turret aim. The left stick / WASD is a world-space move vector;
  // the mech accelerates toward it (weight inertia), strafes freely, and slides along blocked
  // axes; the legs turn to face travel and the turret slews toward the aim (full 360°).
  // #347: drives ONE player. `player` defaults to the primary so every existing caller and the
  // arena's locomotion test doubles are unchanged; ArenaScene.update() now passes each player
  // explicitly. The body below reads `p.*` in place of the former `this.px`/`this.vx`/… — the
  // scene accessors alias exactly that same storage for players[0], so for one player this is a
  // literally equivalent substitution, not a behavioural rewrite.
  //
  // #348 did exactly what that note said: `sprint`/`dash`/`fireCooldowns` now live on the
  // PLAYER, alongside its own `intent` from its own controller.
  _drive(intent, dt, player = primaryPlayerOf(this)) {
    const p = player;
    const mv = p.mech.movement;
    const legF = p.mech.legFactor();

    // #399 (owner decision): the PLAYER moves at full forward speed in EVERY direction — the old
    // #45 reverse/backpedal penalty (`backwardSpeedScale`) is removed for the player, so backing
    // up and strafing are no slower than driving forward. Enemy AI keeps its own backpedal scaling
    // (enemies.js) — only the player's directional speed penalty is gone.
    // #41: the terrain UNDER the mech scales its top speed — a shallow river or forest bogs it
    // down (rubble mildly), open grass is normal.
    const terrainScale = this._speedFactorAt(p.x, p.y);
    // #188/#189: Sprint (SPRINT_SPEED_MULT) is no longer player-triggered (#261) — it's now
    // Overclock-only, force-activated fuel-free for the powerup's duration (see arena/firing.js
    // `_handleSprint`). #261: Dash (DASH_SPEED_MULT) is the new player-facing L3/Space ability —
    // a short, much stronger burst gated by `_handleDash`'s cooldown state machine
    // (data/dash.js). The two are independent sources and simply multiply together if both
    // happen to be active at once (e.g. the player dashes while Overclock's forced Sprint is
    // also running) — there's no special-casing needed, each just contributes its own factor.
    const sprintMult = p.sprint?.active ? SPRINT_SPEED_MULT : 1;
    const dashMult = p.dash?.active ? DASH_SPEED_MULT : 1;
    // #3 weight inertia drives the accel curve.
    const maxSp = mv.maxSpeed * legF * terrainScale * sprintMult * dashMult;
    // Weight-driven inertia (#3): accelerate toward the throttle target at `accel`, but bleed
    // speed at the (lower) `decel` — so releasing the stick coasts the mech to a stop instead
    // of braking on a dime, and it "leans into" starts. Pick the rate per-axis by whether that
    // axis is winding up (target farther from 0 than current, same sign) or slowing/reversing.
    const tx = intent.move.x * maxSp, ty = intent.move.y * maxSp;
    const rampX = (tx !== 0 && Math.sign(tx) === Math.sign(p.vx) && Math.abs(tx) > Math.abs(p.vx));
    const rampY = (ty !== 0 && Math.sign(ty) === Math.sign(p.vy) && Math.abs(ty) > Math.abs(p.vy));
    p.vx = INSTANT_VELOCITY ? tx : approach(p.vx, tx, (rampX ? mv.accel : mv.decel) * dt);
    p.vy = INSTANT_VELOCITY ? ty : approach(p.vy, ty, (rampY ? mv.accel : mv.decel) * dt);
    // Move with wall/boundary collision, sliding along blocked axes. #92: a living GROUND enemy
    // (mech/tank/turret — flyers narratively fly over ground obstacles, see
    // `_blockedByGroundEnemy`) blocks the player the same way impassable terrain does.
    // #159: substep a large frame movement into COLLISION_SUBSTEP_PX-sized chunks — mainly so
    // the ENEMY-circle checks below (`_crushTargetAt`/`_blockedByGroundEnemy`, still single-point
    // samples) stay fine-grained at high speed. Terrain/wall blocking itself is now handled by
    // `_blockedAlongSegment` (swept across the whole substep, not just its endpoint), which is
    // exact regardless of step size — see its comment for why a pure position substep alone
    // isn't: a fast mech grazing a hex at a shallow angle can clip a cross-section narrower than
    // any fixed substep length. At normal speeds/dt this loop is a single iteration, identical
    // to the old code — `steps` only exceeds 1 once a frame's total movement exceeds one substep.
    const totalDist = Math.hypot(p.vx * dt, p.vy * dt);
    const steps = Math.max(1, Math.ceil(totalDist / COLLISION_SUBSTEP_PX));
    const stepDt = dt / steps;
    for (let s = 0; s < steps; s++) {
      const ox = p.x, oy = p.y;
      // #320: the player's chassis collides with a wall at its BODY radius, not as a point.
      // `PLAYER_WALL_COLLIDE_RADIUS` (shared.js) rather than the full `ENEMY_COLLIDE_RADIUS_MECH`
      // — see that constant for the measured reason a wall gets a slightly smaller body than
      // another unit does, and for the table of what each value costs at a breach. Terrain and
      // enemy-circle blocking are untouched; only the wall half of the sweep inflates.
      const groundBlocked = (x, y) => this._blockedAlongSegment(ox, oy, x, y, PLAYER_WALL_COLLIDE_RADIUS) || !!this._blockedByGroundEnemy(x, y);
      let nx = p.x + p.vx * stepDt, ny = p.y + p.vy * stepDt;
      // #92 (corrected 2026-07-10): walking INTO a TANK is an INSTANT kill, not a gradual crush —
      // `_crushGroundEnemyAt` destroys it in this one call (normal death path: explosion FX, corpse
      // teardown, powerup/salvage drop — `_removeEnemy` runs synchronously the same tick). #104
      // extends the same instant-crush treatment to INFANTRY (see #269's `isSmallUnit`, shared.js) — and
      // loops rather than crushing just once, so driving into a packed infantry cluster crushes
      // every trooper the mech is actually touching this frame, not only the first one found (a
      // tight mob can have several troopers overlapping the same contact point at once). #112: the
      // crush check itself uses `_crushTargetAt` (the enemy's radius PLUS the player's own
      // crush-trigger contribution — see `PLAYER_CRUSH_RADIUS_BONUS`, shared.js), a deliberately
      // bigger/looser test than the general blocking check below so a stomp is easy to trigger
      // without also loosening how tightly a mech/turret blocks the player. Re-check
      // `_crushTargetAt` after each kill: the crushed enemy is gone from `this.enemies` now, so this
      // either finds the next overlapping trooper to crush too, or nothing — in which case the
      // player rolls straight through into the space just vacated instead of still sliding/stopping
      // against a corpse that no longer blocks.
      let crushTarget = this._crushTargetAt(nx, ny);
      while (crushTarget) {
        this._crushGroundEnemyAt(crushTarget);
        crushTarget = this._crushTargetAt(nx, ny);
      }
      // General ground-enemy blocking (mech/turret, or a crushable enemy just outside the tighter
      // block radius) still uses the unchanged, tighter `groundEnemyRadius` via
      // `_blockedByGroundEnemy` — only the crush trigger above got bigger.
      const enemyHit = this._blockedByGroundEnemy(nx, ny);
      // #159: swept, not endpoint-only — walks every hex between (ox,oy) and (nx,ny), so a wall
      // this substep would have crossed through (not just ended inside) still blocks correctly.
      if (this._blockedAlongSegment(ox, oy, nx, ny, PLAYER_WALL_COLLIDE_RADIUS) || enemyHit) {
        // #41: walking INTO a destructible outpost stomps it — the mech crushes buildings by
        // pressing against them (damage scaled by how hard it's driving in). Once flattened to
        // rubble the hex becomes passable and the mech rolls over it. Uses `stepDt` (not the full
        // frame `dt`) since this can now run once per substep — a mech pressed against a building
        // for the whole frame still accumulates ~`dt` worth of stomp damage total across substeps.
        this._stompBuildingAt(nx, ny, stepDt, p);
        if (!groundBlocked(ox, ny)) { nx = ox; p.vx = 0; }
        else if (!groundBlocked(nx, oy)) { ny = oy; p.vy = 0; }
        else { nx = ox; ny = oy; p.vx = 0; p.vy = 0; }
      }
      p.x = nx; p.y = ny;
    }
    p.speed = Math.hypot(p.vx, p.vy);

    // Legs turn to face the direction of travel (so the walk reads), at the chassis turn
    // rate — heavier mechs pivot their stance more slowly.
    // #156: under INSTANT_TURNING the target facing must come from the RAW INPUT direction
    // (intent.move), not from velocity — this.vx/this.vy still ease toward the commanded
    // direction via the accel/decel weight-inertia model above, so snapping `this.angle` to
    // atan2(vy, vx) would still visibly lag the player's actual input while velocity ramps up.
    // Gate on input magnitude (not mech speed, which is meaningless for this path) and hold the
    // last facing when the stick/keys are centred, mirroring how aim holds its last angle.
    // The non-instant path is completely unchanged: it still derives moveAng from velocity.
    if (INSTANT_TURNING) {
      const inputMag = Math.hypot(intent.move.x, intent.move.y);
      if (inputMag > STICK_DEADZONE) {
        p.angle = Math.atan2(intent.move.y, intent.move.x);
      }
    } else if (p.speed > 5) {
      const moveAng = Math.atan2(p.vy, p.vx);
      p.angle = Phaser.Math.Angle.RotateTo(p.angle, moveAng, mv.turnRate * dt * (0.4 + 0.6 * legF));
    }

    // ── Turret: aim freely, full 360° (no torso-twist arc), slewing toward the aim. ──
    if (intent.aim.mode === 'pointer') {
      p.aimX = intent.aim.x; p.aimY = intent.aim.y;
    } else {
      p.aimX = p.x + Math.cos(intent.aim.angle) * 800;
      p.aimY = p.y + Math.sin(intent.aim.angle) * 800;
    }
    const aim = Math.atan2(p.aimY - p.y, p.aimX - p.x);
    // #189: turret slew no longer has a buff multiplier — Overclock's old slewMult was
    // removed along with moveMult when it was redesigned to force-activate Sprint instead.
    p.turretAngle = INSTANT_TURNING
      ? aim
      : rotateToward(p.turretAngle, aim, mv.turretSlew, dt);
    // #348: the HUD's input-mode hint belongs to the LOCAL player's device.
    if (p === primaryPlayerOf(this)) this.registry.set('inputMode', intent.mode);
  },

  // Stompy stepped gait: advance the walk frames with speed, kick a footfall FX (+ sound)
  // on each plant, and apply the per-step body bob. Then pin the view to the mech.
  _stepGait(dt, player = primaryPlayerOf(this)) {
    const p = player;
    const mv = p.mech.movement;
    const legF = p.mech.legFactor();
    let bob = 0;
    if (Math.abs(p.speed) > 5 && legF > 0) {
      p.stepMs += dt * 1000 * (Math.abs(p.speed) / mv.maxSpeed);
      if (p.stepMs >= mv.stepInterval) {
        p.stepMs -= mv.stepInterval;
        p.hullFrame = (p.hullFrame + 1) % 4;
        // A footfall lands only on the two planted frames (0 and 2); frames 1/3 are the
        // mid-stride swing. Kick the local impact FX + weight-scaled camera shake + sound.
        if (p.hullFrame % 2 === 0) {
          const foot = p.hullFrame === 0 ? 0 : 1;
          this._footImpactFx(foot, mv.stepBob, p);
          this._footShake(mv.footShake, p);
          Audio.footstep(foot);
        }
      }
      // Stompy lurch: the body rides UP mid-stride and DROPS onto the plant. Skewing the
      // sine toward the front of the stride (the ^1.4 easing) makes the drop feel like the
      // mech's mass settling onto the foot rather than a smooth float. Scales with speed so a
      // crawl barely bobs and a full-tilt march heaves. `stepBob` is the per-chassis amplitude.
      const phase = p.stepMs / mv.stepInterval;                 // 0→1 across one step
      const speedScale = Phaser.Math.Clamp(Math.abs(p.speed) / mv.maxSpeed, 0, 1);
      bob = Math.pow(Math.abs(Math.sin(phase * Math.PI)), 1.4) * mv.stepBob * speedScale;
    }
    p.view.hull.setTexture(`${p.textureKey ?? 'playerMech'}_hull_${p.hullFrame}`);
    p.view.hull.rotation = p.angle + Math.PI / 2;
    p.view.turret.rotation = p.turretAngle + Math.PI / 2;
    // Ease each pivoting part toward its convergence tilt (smoothing kills the lock-engage snap).
    this._syncTilts(p.view, p.mech, p.turretAngle, ARENA_MECH_SCALE, 0, 0, {
      leftTorso: this._partTilt('leftTorso', p), rightTorso: this._partTilt('rightTorso', p),
      leftArm: this._partTilt('leftArm', p), rightArm: this._partTilt('rightArm', p),
    }, dt);
    p.view.setPosition(p.x, p.y - bob);
  },

  // Footfall impact (#37): convey weight with a LOCAL effect at the planted foot instead
  // of a full-screen camera shake — an expanding ground shock ring, a few dust puffs
  // kicking outward, and a quick squash-and-recover of the mech body. `power` (the
  // chassis stepBob) scales it, so a heavy lands harder than a light.
  _footImpactFx(foot, power, player = primaryPlayerOf(this)) {
    const p = Math.max(2, power);
    const x = player.x + (foot ? 11 : -11);
    const y = player.y + 16;                       // roughly at the feet, below the torso

    // #99: DEPTH.GROUND_FX — a footfall ring/dust puff is ground decal at the mech's own feet,
    // same tier as the fire-patch decal; it should never render OVER the mech casting it.
    const ring = this.add.circle(x, y, 3).setStrokeStyle(2, 0x8a93a0, 0.55).setDepth(DEPTH.GROUND_FX);
    this.tweens.add({ targets: ring, scale: 1.6 + p * 0.5, alpha: 0, duration: 300, ease: 'Quad.easeOut', onComplete: () => ring.destroy() });

    for (let i = 0; i < 4; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;   // fan up-and-out from the foot
      const dust = this.add.circle(x, y, 1.5 + Math.random() * 2, 0x6b7280, 0.45).setDepth(DEPTH.GROUND_FX);
      this.tweens.add({
        targets: dust, x: x + Math.cos(ang) * (8 + p * 2 + Math.random() * 8),
        y: y + Math.sin(ang) * (5 + Math.random() * 5), alpha: 0, scale: 0.3,
        duration: 320 + Math.random() * 140, ease: 'Quad.easeOut', onComplete: () => dust.destroy(),
      });
    }

    // Squash the body briefly (heavier stomp = deeper). Guard against stacking tweens so a
    // fast gait doesn't leave the container mis-scaled.
    // (Camera shake is kicked separately by _footShake, synced to the same footfall.)
    const v = player.view;
    if (!v._stomping) {
      v._stomping = true;
      const sq = Math.min(0.12, 0.04 + p * 0.012);
      this.tweens.add({
        targets: v, scaleX: 1 + sq * 0.6, scaleY: 1 - sq, duration: 70, yoyo: true, ease: 'Quad.easeOut',
        onComplete: () => { v.setScale(1); v._stomping = false; },
      });
    }
  },

  // Step-synced camera shake (#3/#37): a short, sharp kick on each footfall so the WHOLE
  // world jolts when the mech plants a foot — the headline "heavy machine" cue. `powerPx` is
  // the chassis' `footShake` in pixels (heavy stomps hardest, light barely). Scaled by how
  // fast we're moving so a slow creep only trembles and a full march really pounds. Phaser's
  // camera.shake() intensity is a fraction of the viewport, so convert px→fraction via the
  // camera height. Duration is deliberately brief (a jolt, not a rumble) and the offset is
  // capped so a heavy can't shake the frame into nausea — a knob the owner can still push.
  //
  // #3 feel follow-up: the full-screen shake was jarring/nauseating, so it's dialled WAY back
  // here — a lower px→offset cap (SHAKE_MAX_PX), a smaller share of the kick coming from the
  // per-chassis magnitude (SHAKE_GAIN), and a shorter duration (SHAKE_MS). A heavy still
  // "thumps" but no longer heaves the frame. All three are named knobs, easy to re-tune.
  _footShake(powerPx, player = primaryPlayerOf(this)) {
    if (!powerPx) return;
    const SHAKE_GAIN = 0.45;  // fraction of the chassis footShake px that reaches the camera
    const SHAKE_MAX_PX = 4;   // hard cap on camera offset (was 9) — kills the nausea ceiling
    const SHAKE_MS = 60;      // duration of the jolt (was 90) — a shorter, softer tick
    const cam = this.cameras.main;
    const speedScale = Phaser.Math.Clamp(Math.abs(player.speed) / player.mech.movement.maxSpeed, 0, 1);
    const px = Math.min(SHAKE_MAX_PX, powerPx * SHAKE_GAIN) * (0.5 + 0.5 * speedScale);
    const intensity = px / Math.max(1, cam.height);
    cam.shake(SHAKE_MS, intensity, true);   // force=true so a new step overrides the tail of the last
  },
};
