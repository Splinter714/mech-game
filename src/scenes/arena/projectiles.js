// Arena projectiles mixin — the travelling-round simulation (advance, cover, hit/land,
// draw), plus the persistent-beam and burning-ground passes. Methods use `this` (the
// ArenaScene); composed onto the prototype via Object.assign.
import { drawProjectileBody, drawBeam, drawGroundFire } from '../../art/index.js';
import { stepProjectile } from '../../data/delivery.js';

const HIT_RADIUS = 32;            // a shot within this of a mech's centre strikes its body

export const ProjectilesMixin = {
  _updateProjectiles(dt) {
    this.projFx.clear();
    for (const p of this.projectiles) {
      // Hit detection chases the nearest living enemy (enemy rounds chase the player), so a
      // round detonates on whatever it reaches.
      const enemyShot = p.owner === 'enemy';
      const hitEnemy = enemyShot ? null : this._nearestEnemy(p.x, p.y);
      const targetGone = enemyShot ? this.mech.isDestroyed() : !hitEnemy;
      const tx = enemyShot ? this.px : (hitEnemy ? hitEnemy.x : p.x);
      const ty = enemyShot ? this.py : (hitEnemy ? hitEnemy.y : p.y);

      // Homing steers toward the round's seek target (the lock, captured at fire). If the
      // locked enemy dies mid-flight the round goes dumb — it does not retarget to the nearest.
      let hx = tx, hy = ty;
      if (p.homing && !enemyShot) {
        if (p.seekTarget && !p.seekTarget.mech.isDestroyed()) { hx = p.seekTarget.x; hy = p.seekTarget.y; }
        else p.homing = false;
      }
      // Advance via the shared kinematics — guided rounds steer toward the live target
      // (capped by turn rate); ballistic rounds just integrate velocity.
      stepProjectile(p, dt, p.homing && !targetGone ? Math.atan2(hy - p.y, hx - p.x) : null);
      // Cover: a round that flies into a wall detonates there (arcing rounds lob over).
      if (!p.arc && this._isWall(p.x, p.y)) {
        p.dead = true;
        p.stopTrajectorySfx?.();   // #56: stop this round's in-flight loop the instant it dies
        this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
        continue;
      }
      const toTarget = targetGone ? Infinity : Math.hypot(p.x - tx, p.y - ty);
      const landed = p.dist >= p.maxDist;
      if (toTarget < HIT_RADIUS || landed) {
        p.dead = true;
        p.stopTrajectorySfx?.();   // #56: ditto — impact/landing is the other death site
        if (toTarget < HIT_RADIUS + p.splash) {
          const dmg = Math.max(1, Math.round(p.damage * this._rangeFactor(p.range, p.dist)));
          if (enemyShot) this._damagePlayerAt(dmg);
          else if (hitEnemy) this._damageEnemyAt(hitEnemy, p.x, p.y, dmg, p.color);
        }
        this._impactFx(p.x, p.y, p.color, p.kind, p.splash, p.weaponId);
        if (p.ground) this.firePatches.push({ x: p.x, y: p.y, r: p.ground.radius, dps: p.ground.dps, until: this.time.now + p.ground.duration * 1000, nextTick: this.time.now + 500 });
        continue;
      }
      this._drawProjectile(p);
    }
    if (this.projectiles.some((p) => p.dead)) this.projectiles = this.projectiles.filter((p) => !p.dead);
  },

  _drawProjectile(p) {
    const g = this.projFx;
    // Arcing rounds fake height with size alone (no vertical offset): the body grows as it
    // lofts toward the "camera" and the ground shadow tightens beneath it, so the round
    // stays planted on its true ground position.
    let scale = 1;
    if (p.arc) {
      const t = p.dist / p.maxDist;
      const h = 4 * t * (1 - t);                              // 0..1 parabolic height fraction
      // Constant apex: every lob peaks at the same height regardless of range, so a near
      // toss looks like a steep mortar pop and a far shot looks flat and skimming.
      const bump = 0.75;                                      // peak size gain at apex
      scale = 1 + h * bump;
      const sw = 8 - h * 4;                                   // shadow tightens with height
      g.fillStyle(0x000000, 0.28 - h * 0.16).fillEllipse(p.x, p.y, sw, sw * 0.42);
    }
    // The round body itself is shared art (so the garage icon matches); `p.dist` drives
    // the flame flicker.
    drawProjectileBody(g, p.x, p.y, p.angle, p.kind, p.color, scale * (p.scale || 1), p.dist);
  },

  // Persistent hitscan beams: age them, retire expired ones into a brief spark-fade, and
  // redraw the live + dying beams each frame (shared drawBeam art).
  _updateBeams(delta) {
    const SPARK_FADE = 300;
    for (const b of this.beams) { b.ttl -= delta; b.age += delta; }
    for (const b of this.beams) { if (b.ttl <= 0) this.dyingBeams.push({ ...b, fadeAge: 0, fadeTtl: SPARK_FADE }); }
    this.beams = this.beams.filter((b) => b.ttl > 0);
    for (const b of this.dyingBeams) b.fadeAge += delta;
    this.dyingBeams = this.dyingBeams.filter((b) => b.fadeAge < b.fadeTtl);

    this.beamFx.clear();
    for (const b of this.beams) drawBeam(this.beamFx, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age);
    for (const b of this.dyingBeams) drawBeam(this.beamFx, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age + b.fadeAge, 1 - b.fadeAge / b.fadeTtl);
  },

  // Burning ground patches (napalm): tick damage to mechs standing in them, with a
  // flickering flame visual, until they burn out.
  _updateFirePatches() {
    const now = this.time.now;
    for (const fp of this.firePatches) {
      if (now >= fp.nextTick) {
        fp.nextTick += 500;
        for (const e of this.enemies) {
          if (!e.mech.isDestroyed() && Math.hypot(e.x - fp.x, e.y - fp.y) < fp.r) {
            this._damageEnemyAt(e, e.x, e.y, Math.max(1, Math.round(fp.dps * 0.5)), 0xff7a18);
          }
        }
      }
      drawGroundFire(this.projFx, fp.x, fp.y, fp.r, now);   // shared flame art (matches the lab)
      if (now >= fp.until) fp.dead = true;
    }
    if (this.firePatches.some((f) => f.dead)) this.firePatches = this.firePatches.filter((f) => !f.dead);
  },
};
