// Arena locomotion mixin — the player mech's view, muzzle geometry, twin-stick drive,
// stompy stepped gait, and footfall FX. Methods use `this` (the ArenaScene); composed onto
// the prototype via Object.assign. The pure relocation keeps `update()` a thin orchestrator
// that calls `_drive` then `_stepGait`.
import Phaser from 'phaser';
import { mechLayout, ART_SCALE, partSpriteTransform } from '../../art/index.js';
import { isWeapon } from '../../data/items.js';
import { getWeapon } from '../../data/weapons.js';
import { Audio } from '../../audio/index.js';
import { ARENA_MECH_SCALE, approach, backwardSpeedScale } from './shared.js';
import { PIVOT_LOCATIONS } from '../../art/mechArt.js';

// Convergence tilt is temporal-smoothed so a part EASES toward its target angle instead of
// snapping every frame. Without this the tilt snaps on each frame-to-frame change in the
// convergence geometry — the turret slewing, the target moving, and ESPECIALLY a soft-lock
// engaging/dropping (which jumps the convergence distance CONVERGE_DIST↔the locked range),
// reading as jitter/flapping. `TILT_SMOOTH_K` is the exponential rate (1/s): higher = snappier.
// ~12 gives a weighted actuated-limb swing that settles in a couple hundred ms — not instant,
// not sluggish, not springy.
const TILT_SMOOTH_K = 12;

export const LocomotionMixin = {
  // A mech = hull (legs) + side torsos + arms + turret-body stacked in a container so they can
  // rotate independently around the shared centre. Layer order back→front:
  // [hull, leftTorso, rightTorso, armL, armR, body]. The side torsos sit behind the arms and
  // UNDER the body (centre torso + head) so the body occludes their inner edges and the arms
  // occlude them — the top-down read at tilt 0, and what keeps an inward-canted part tucked
  // under the body. Each off-centre part pivots at its own joint (arms at the shoulder, side
  // torsos nearer their centre — see partSpriteTransform).
  _makeMechView(key, x, y, angle) {
    const hull = this.add.sprite(0, 0, `${key}_hull_0`).setScale(ARENA_MECH_SCALE);
    const torL = this.add.sprite(0, 0, `${key}_leftTorso`).setScale(ARENA_MECH_SCALE);
    const torR = this.add.sprite(0, 0, `${key}_rightTorso`).setScale(ARENA_MECH_SCALE);
    const armL = this.add.sprite(0, 0, `${key}_leftArm`).setScale(ARENA_MECH_SCALE);
    const armR = this.add.sprite(0, 0, `${key}_rightArm`).setScale(ARENA_MECH_SCALE);
    const turret = this.add.sprite(0, 0, `${key}_turret`).setScale(ARENA_MECH_SCALE);
    hull.rotation = angle + Math.PI / 2;
    turret.rotation = angle + Math.PI / 2;
    const c = this.add.container(x, y, [hull, torL, torR, armL, armR, turret]);
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
  _partTilt(loc) {
    if (this.mech.isPartDestroyed(loc)) return 0;
    const ids = this.mech.mounts[loc].filter(isWeapon);
    if (!ids.length) return 0;
    const w = { weapon: getWeapon(ids[0]), location: loc };
    const m = this._muzzle(loc);
    const fireAngle = this._fireAngle(w, m);
    return Phaser.Math.Angle.Wrap(fireAngle - this.turretAngle);
  },

  // World position of a weapon's muzzle: its body-location offset (front edge of the
  // part, in design coords where -y is forward) rotated by the turret facing. So a
  // left-arm shot leaves the left arm, a right-torso shot the right torso, etc.
  _muzzle(loc) {
    const disp = ARENA_MECH_SCALE * ART_SCALE;
    const part = mechLayout(this.mech)[loc];
    const f = (-part.y + part.h / 2) * disp;  // forward, to the part's front edge
    const r = part.x * disp;                  // right of centre
    const a = this.turretAngle;
    return {
      x: this.px + f * Math.cos(a) - r * Math.sin(a),
      y: this.py + f * Math.sin(a) + r * Math.cos(a),
    };
  },

  // Twin-stick locomotion + turret aim. The left stick / WASD is a world-space move vector;
  // the mech accelerates toward it (weight inertia), strafes freely, and slides along blocked
  // axes; the legs turn to face travel and the turret slews toward the aim (full 360°).
  _drive(intent, dt) {
    const mv = this.mech.movement;
    const legF = this.mech.legFactor();

    // #45: moving opposite the turret facing (backing up) is slower than forward/strafe.
    const backScale = backwardSpeedScale(intent.move.x, intent.move.y, this.turretAngle);
    const maxSp = mv.maxSpeed * legF * backScale;
    // Weight-driven inertia (#3): accelerate toward the throttle target at `accel`, but bleed
    // speed at the (lower) `decel` — so releasing the stick coasts the mech to a stop instead
    // of braking on a dime, and it "leans into" starts. Pick the rate per-axis by whether that
    // axis is winding up (target farther from 0 than current, same sign) or slowing/reversing.
    const tx = intent.move.x * maxSp, ty = intent.move.y * maxSp;
    const rampX = (tx !== 0 && Math.sign(tx) === Math.sign(this.vx) && Math.abs(tx) > Math.abs(this.vx));
    const rampY = (ty !== 0 && Math.sign(ty) === Math.sign(this.vy) && Math.abs(ty) > Math.abs(this.vy));
    this.vx = approach(this.vx, tx, (rampX ? mv.accel : mv.decel) * dt);
    this.vy = approach(this.vy, ty, (rampY ? mv.accel : mv.decel) * dt);
    // Move with wall/boundary collision, sliding along blocked axes.
    const ox = this.px, oy = this.py;
    let nx = this.px + this.vx * dt, ny = this.py + this.vy * dt;
    if (this._blocked(nx, ny)) {
      if (!this._blocked(ox, ny)) { nx = ox; this.vx = 0; }
      else if (!this._blocked(nx, oy)) { ny = oy; this.vy = 0; }
      else { nx = ox; ny = oy; this.vx = 0; this.vy = 0; }
    }
    this.px = nx; this.py = ny;
    this.speed = Math.hypot(this.vx, this.vy);

    // Legs turn to face the direction of travel (so the walk reads), at the chassis turn
    // rate — heavier mechs pivot their stance more slowly.
    if (this.speed > 5) {
      const moveAng = Math.atan2(this.vy, this.vx);
      this.angle = Phaser.Math.Angle.RotateTo(this.angle, moveAng, mv.turnRate * dt * (0.4 + 0.6 * legF));
    }

    // ── Turret: aim freely, full 360° (no torso-twist arc), slewing toward the aim. ──
    if (intent.aim.mode === 'pointer') {
      this.aimX = intent.aim.x; this.aimY = intent.aim.y;
    } else {
      this.aimX = this.px + Math.cos(intent.aim.angle) * 800;
      this.aimY = this.py + Math.sin(intent.aim.angle) * 800;
    }
    const aim = Math.atan2(this.aimY - this.py, this.aimX - this.px);
    this.turretAngle = Phaser.Math.Angle.RotateTo(this.turretAngle, aim, mv.turretSlew * dt);
    this.registry.set('inputMode', intent.mode);
  },

  // Stompy stepped gait: advance the walk frames with speed, kick a footfall FX (+ sound)
  // on each plant, and apply the per-step body bob. Then pin the view to the mech.
  _stepGait(dt) {
    const mv = this.mech.movement;
    const legF = this.mech.legFactor();
    let bob = 0;
    if (Math.abs(this.speed) > 5 && legF > 0) {
      this.stepMs += dt * 1000 * (Math.abs(this.speed) / mv.maxSpeed);
      if (this.stepMs >= mv.stepInterval) {
        this.stepMs -= mv.stepInterval;
        this.hullFrame = (this.hullFrame + 1) % 4;
        // A footfall lands only on the two planted frames (0 and 2); frames 1/3 are the
        // mid-stride swing. Kick the local impact FX + weight-scaled camera shake + sound.
        if (this.hullFrame % 2 === 0) {
          const foot = this.hullFrame === 0 ? 0 : 1;
          this._footImpactFx(foot, mv.stepBob);
          this._footShake(mv.footShake);
          Audio.footstep(foot);
        }
      }
      // Stompy lurch: the body rides UP mid-stride and DROPS onto the plant. Skewing the
      // sine toward the front of the stride (the ^1.4 easing) makes the drop feel like the
      // mech's mass settling onto the foot rather than a smooth float. Scales with speed so a
      // crawl barely bobs and a full-tilt march heaves. `stepBob` is the per-chassis amplitude.
      const phase = this.stepMs / mv.stepInterval;                 // 0→1 across one step
      const speedScale = Phaser.Math.Clamp(Math.abs(this.speed) / mv.maxSpeed, 0, 1);
      bob = Math.pow(Math.abs(Math.sin(phase * Math.PI)), 1.4) * mv.stepBob * speedScale;
    }
    this.playerView.hull.setTexture(`playerMech_hull_${this.hullFrame}`);
    this.playerView.hull.rotation = this.angle + Math.PI / 2;
    this.playerView.turret.rotation = this.turretAngle + Math.PI / 2;
    // Ease each pivoting part toward its convergence tilt (smoothing kills the lock-engage snap).
    this._syncTilts(this.playerView, this.mech, this.turretAngle, ARENA_MECH_SCALE, 0, 0, {
      leftTorso: this._partTilt('leftTorso'), rightTorso: this._partTilt('rightTorso'),
      leftArm: this._partTilt('leftArm'), rightArm: this._partTilt('rightArm'),
    }, dt);
    this.playerView.setPosition(this.px, this.py - bob);
  },

  // Footfall impact (#37): convey weight with a LOCAL effect at the planted foot instead
  // of a full-screen camera shake — an expanding ground shock ring, a few dust puffs
  // kicking outward, and a quick squash-and-recover of the mech body. `power` (the
  // chassis stepBob) scales it, so a heavy lands harder than a light.
  _footImpactFx(foot, power) {
    const p = Math.max(2, power);
    const x = this.px + (foot ? 11 : -11);
    const y = this.py + 16;                       // roughly at the feet, below the torso

    const ring = this.add.circle(x, y, 3).setStrokeStyle(2, 0x8a93a0, 0.55);
    this.tweens.add({ targets: ring, scale: 1.6 + p * 0.5, alpha: 0, duration: 300, ease: 'Quad.easeOut', onComplete: () => ring.destroy() });

    for (let i = 0; i < 4; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;   // fan up-and-out from the foot
      const dust = this.add.circle(x, y, 1.5 + Math.random() * 2, 0x6b7280, 0.45);
      this.tweens.add({
        targets: dust, x: x + Math.cos(ang) * (8 + p * 2 + Math.random() * 8),
        y: y + Math.sin(ang) * (5 + Math.random() * 5), alpha: 0, scale: 0.3,
        duration: 320 + Math.random() * 140, ease: 'Quad.easeOut', onComplete: () => dust.destroy(),
      });
    }

    // Squash the body briefly (heavier stomp = deeper). Guard against stacking tweens so a
    // fast gait doesn't leave the container mis-scaled.
    // (Camera shake is kicked separately by _footShake, synced to the same footfall.)
    const v = this.playerView;
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
  _footShake(powerPx) {
    if (!powerPx) return;
    const cam = this.cameras.main;
    const speedScale = Phaser.Math.Clamp(Math.abs(this.speed) / this.mech.movement.maxSpeed, 0, 1);
    const px = Math.min(9, powerPx) * (0.5 + 0.5 * speedScale);   // px of camera offset
    const intensity = px / Math.max(1, cam.height);
    cam.shake(90, intensity, true);   // force=true so a new step overrides the tail of the last
  },
};
