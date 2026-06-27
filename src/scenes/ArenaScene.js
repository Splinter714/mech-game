import Phaser from 'phaser';
import { Mech } from '../data/Mech.js';
import { buildMechTextures, reskinMech, mechLayout, ART_SCALE } from '../art/index.js';
import { buildHexTextures } from '../art/hexArt.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { LOCATIONS } from '../data/anatomy.js';
import { CATEGORIES } from '../data/categories.js';
import { hexToPixel, pixelToHex, range, axialKey, distance, HEX_SIZE } from '../data/hexgrid.js';
import { Controls } from '../input/Controls.js';

// The battlefield. Top-down hex world with one drivable mech. Locomotion is tank-style
// (forward/back + rotate) with weight-driven inertia; the turret slews toward the aim
// within a limited arc and PUSHES the chassis to turn when you aim past it; the gait is
// a stompy stepped walk. A stationary target dummy proves the per-part damage loop.
// Single-file for Milestone 1 — splits into arena/ mixins as combat grows.
const ARENA_MECH_SCALE = 0.34;
const HIT_RADIUS = 32;            // a shot within this of a mech's centre strikes its body
const DUMMY_HEX = { q: 3, r: -1 };
const DAMAGEABLE = LOCATIONS.filter((l) => l !== 'cockpit'); // cockpit is hit via the head

export default class ArenaScene extends Phaser.Scene {
  constructor() {
    super('ArenaScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setBackgroundColor('#0d1014');

    buildHexTextures(this);
    this._buildWorld();

    // Player mech (repaired fresh for the sortie).
    this.allMechs = this.registry.get('allMechs');
    this.mech = this.allMechs[ACTIVE_MECH_KEY];
    this.mech.repairAll();
    this.registry.set('playerMech', this.mech);
    buildMechTextures(this, 'playerMech', this.mech);

    // Enemy mech — armed, mobile, shoots back.
    this.dummy = new Mech({ chassisId: 'light', name: 'Raider', mounts: { rightArm: ['autocannon'], leftTorso: ['srm'] } });
    this.dummy.repairAll();
    this.registry.set('dummyMech', this.dummy);
    buildMechTextures(this, 'dummyMech', this.dummy, { theme: 'enemy' });
    const dp = hexToPixel(DUMMY_HEX.q, DUMMY_HEX.r);
    this.dummyAngle = Math.PI / 2;       // legs facing
    this.dummyTurret = Math.PI / 2;      // turret facing
    this.evx = 0; this.evy = 0;          // enemy velocity
    this.enemyFireCd = {};
    this.dummyView = this._makeMechView('dummyMech', dp.x, dp.y, this.dummyAngle);
    this.dx = dp.x; this.dy = dp.y;

    // Player state.
    this.px = 0; this.py = 0;
    this.angle = -Math.PI / 2;     // legs facing up
    this.turretAngle = -Math.PI / 2;
    this.aimX = 0; this.aimY = -200;   // world aim point weapons converge on
    this.vx = 0; this.vy = 0;      // world-space velocity (twin-stick movement)
    this.speed = 0;
    this.stepMs = 0; this.hullFrame = 0;
    this.playerView = this._makeMechView('playerMech', this.px, this.py, this.angle);

    this.cameras.main.startFollow(this.playerView, true, 0.12, 0.12);

    this.controls = new Controls(this);
    this.fireCooldowns = {};   // `${loc}:${index}` → ms until this weapon can fire again
    this.abilityCd = {};       // ability location → ms until it can fire again
    this.shieldUntil = 0;      // timestamp the bubble shield is active until
    this.lockProgress = 0;     // target-lock acquisition 0..1
    this.lockTarget = null;    // 'dummy' once locked
    this.lockBonus = 1.3;
    this.input.keyboard.on('keydown-G', () => this.toGarage());

    this.fx = this.add.graphics();        // instant beams / impact flashes (timed clear)
    this.projFx = this.add.graphics();    // travelling projectiles (redrawn each frame)
    this.projectiles = [];
    this.firePatches = [];                // burning ground (napalm)
    this.scene.launch('HudScene');
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.scene.stop('HudScene'));
  }

  // Lay out a disc of hex tiles; a scattered few become walls that block movement and
  // shots (cover). The wall set + disc radius are kept for collision/LOS queries.
  _buildWorld() {
    this.worldRadius = 6;
    this.walls = new Set(['1,1', '2,-3', '-2,2', '-3,0', '4,-2', '0,3', '-1,-2', '3,2']);
    const walls = this.walls;
    for (const h of range({ q: 0, r: 0 }, 6)) {
      const { x, y } = hexToPixel(h.q, h.r);
      const key = axialKey(h.q, h.r);
      const tex = walls.has(key) ? 'hex_wall' : ((h.q + h.r) % 2 ? 'hex_groundB' : 'hex_ground');
      this.add.image(x, y, tex).setScale(1 / ART_SCALE);
    }
  }

  // A mech = hull (legs) + turret (everything else) stacked in a container so they can
  // rotate independently around the shared centre.
  _makeMechView(key, x, y, angle) {
    const hull = this.add.sprite(0, 0, `${key}_hull_0`).setScale(ARENA_MECH_SCALE);
    const turret = this.add.sprite(0, 0, `${key}_turret`).setScale(ARENA_MECH_SCALE);
    hull.rotation = angle + Math.PI / 2;
    turret.rotation = angle + Math.PI / 2;
    const c = this.add.container(x, y, [hull, turret]);
    c.hull = hull; c.turret = turret;
    return c;
  }

  update(_time, delta) {
    const dt = Math.min(0.05, delta / 1000);
    const mv = this.mech.movement;
    const legF = this.mech.legFactor();
    const intent = this.controls.read();

    // ── Twin-stick locomotion ── the left stick / WASD is a world-space move vector;
    // the mech accelerates toward it (weight inertia) and strafes freely. ──
    const maxSp = mv.maxSpeed * legF;
    this.vx = approach(this.vx, intent.move.x * maxSp, mv.accel * dt);
    this.vy = approach(this.vy, intent.move.y * maxSp, mv.accel * dt);
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

    // ── Stompy stepped gait ──
    let bob = 0;
    if (Math.abs(this.speed) > 5 && legF > 0) {
      this.stepMs += dt * 1000 * (Math.abs(this.speed) / mv.maxSpeed);
      if (this.stepMs >= mv.stepInterval) {
        this.stepMs -= mv.stepInterval;
        this.hullFrame = (this.hullFrame + 1) % 4;
        if (this.hullFrame % 2 === 0) this.cameras.main.shake(70, 0.0016 * (mv.stepBob / 2));
      }
      bob = Math.abs(Math.sin((this.stepMs / mv.stepInterval) * Math.PI)) * mv.stepBob;
    }
    this.playerView.hull.setTexture(`playerMech_hull_${this.hullFrame}`);
    this.playerView.hull.rotation = this.angle + Math.PI / 2;
    this.playerView.turret.rotation = this.turretAngle + Math.PI / 2;
    this.playerView.setPosition(this.px, this.py - bob);

    // ── Per-slot firing ── each skill slot (body location) has its own button; a held
    // button auto-fires that location's weapon at its own cadence, gated by ammo. ──
    for (const w of this.mech.weapons()) {
      let cd = (this.fireCooldowns[w.location] ?? 0) - delta;
      if (intent.fire[w.location] && cd <= 0 && w.ready) {
        this.fireWeapon(w);
        cd = this._fireInterval(w.weapon);
      }
      this.fireCooldowns[w.location] = Math.max(0, cd);
    }

    // ── Abilities ── each ability slot fires on its button (R3/L3) off cooldown. ──
    const dashDir = Math.hypot(intent.move.x, intent.move.y) > 0.1
      ? Math.atan2(intent.move.y, intent.move.x) : this.turretAngle;
    let lockAb = null;
    for (const ab of this.mech.abilities()) {
      if (ab.equip.ability === 'lock') { lockAb = ab; continue; }   // held action, below
      let cd = (this.abilityCd[ab.location] ?? 0) - delta;
      if (intent.fire[ab.location] && cd <= 0) { this._activateAbility(ab, dashDir); cd = ab.equip.cooldown * 1000; }
      this.abilityCd[ab.location] = Math.max(0, cd);
    }
    this._updateLock(lockAb, intent, dt);
    this.registry.set('abilityCooldowns', this.abilityCd);
    this.registry.set('shieldActive', this.time.now < this.shieldUntil);

    // ── Enemy AI ──
    this._updateEnemy(dt, delta);

    // ── Projectiles + burning ground ──
    this._updateProjectiles(dt);
    this._updateFirePatches();

    // Bubble shield bubble, drawn over the player while active.
    if (this.time.now < this.shieldUntil) {
      this.projFx.lineStyle(2, 0x5ec8e0, 0.7).strokeCircle(this.px, this.py, 34);
      this.projFx.fillStyle(0x5ec8e0, 0.10).fillCircle(this.px, this.py, 34);
    }

    // ── Ammo regen ── every magazine tops back up over time.
    this.mech.regenAmmo(dt);
  }

  // Target Lock: hold the head ability button with the enemy in the aim cone to build a
  // lock; locked homing missiles track harder and hit for a bonus. Draws a reticle.
  _updateLock(lockAb, intent, dt) {
    if (!lockAb || this.dummy.isDestroyed()) { this.lockProgress = 0; this.lockTarget = null; this.registry.set('lockState', null); return; }
    this.lockBonus = lockAb.equip.bonus;
    const toAng = Math.atan2(this.dy - this.py, this.dx - this.px);
    const inCone = Math.abs(Phaser.Math.Angle.Wrap(toAng - this.turretAngle)) < lockAb.equip.cone
      && Math.hypot(this.dx - this.px, this.dy - this.py) < 560;
    if (intent.fire[lockAb.location] && inCone) {
      this.lockProgress = Math.min(1, this.lockProgress + dt / lockAb.equip.lockTime);
      if (this.lockProgress >= 1) this.lockTarget = 'dummy';
    } else {
      this.lockProgress = Math.max(0, this.lockProgress - dt * 2);
      if (this.lockProgress === 0) this.lockTarget = null;
    }
    if (this.lockProgress > 0) {
      const col = this.lockTarget ? 0xe2533a : 0xefc14a;
      this.projFx.lineStyle(2, col, 0.9).strokeCircle(this.dx, this.dy, 30 - this.lockProgress * 6);
    }
    this.registry.set('lockState', this.lockTarget ? 'LOCKED' : `LOCK ${Math.round(this.lockProgress * 100)}%`);
  }

  _activateAbility(ab, dir) {
    const e = ab.equip;
    if (e.ability === 'dash') {
      this.vx += Math.cos(dir) * e.impulse;
      this.vy += Math.sin(dir) * e.impulse;
      // thruster puff at the mech, opposite the dash
      this.fx.fillStyle(0xffd56b, 0.8).fillCircle(this.px - Math.cos(dir) * 16, this.py - Math.sin(dir) * 16, 6);
      this.time.delayedCall(90, () => this.fx.clear());
    } else if (e.ability === 'shield') {
      this.shieldUntil = this.time.now + e.duration * 1000;
      this._floatText(this.px, this.py - 30, 'SHIELD', '#5ec8e0');
    }
  }

  // Incoming damage to the player (used once enemies fire) — fully absorbed while the
  // bubble shield is up.
  damagePlayer(locationId, amount) {
    if (this.time.now < this.shieldUntil) return { applied: 0, shielded: true };
    return this.mech.applyDamage(locationId, amount);
  }

  // Milliseconds between shots for a weapon: stream weapons use their fire rate, the
  // rest use their cycle time (with a small floor so nothing fires every frame).
  _fireInterval(weapon) {
    if (weapon.delivery.pattern === 'stream' && weapon.delivery.fireRate > 0) {
      return 1000 / weapon.delivery.fireRate;
    }
    return Math.max(120, weapon.cycleTime);
  }

  // Is a world point inside a wall hex? (cover / projectile blocker)
  _isWall(x, y) {
    const h = pixelToHex(x, y);
    return this.walls.has(axialKey(h.q, h.r));
  }

  // Is a world point impassable for the mech — a wall, or outside the arena disc?
  _blocked(x, y) {
    const h = pixelToHex(x, y);
    return this.walls.has(axialKey(h.q, h.r)) || distance({ q: 0, r: 0 }, h) > this.worldRadius;
  }

  // Distance from a muzzle along an angle to the first wall, or Infinity if clear within
  // `maxT`. Used so beams/shots are blocked by cover.
  _wallDistance(x0, y0, angle, maxT) {
    const cx = Math.cos(angle), cy = Math.sin(angle);
    for (let t = 8; t < maxT; t += 8) {
      if (this._isWall(x0 + cx * t, y0 + cy * t)) return t;
    }
    return Infinity;
  }

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
  }

  // Fire one weapon. Hitscan/contact resolve instantly (a beam); projectile weapons
  // spawn travelling rounds that respect velocity, arc, and spread.
  fireWeapon(w) {
    if (!this.scene.isActive()) return;
    this.mech.consumeAmmo(w.location, w.index, 1);
    const d = w.weapon.delivery;
    const m = this._muzzle(w.location);

    // Each weapon converges from its own muzzle onto the shared aim point.
    const baseAngle = Math.atan2(this.aimY - m.y, this.aimX - m.x);
    if (d.hit === 'hitscan' || d.hit === 'contact') { this._fireHitscan(w, m.x, m.y, baseAngle); return; }

    // Projectile: one shot, or a fan of `spreadCount` for spread weapons.
    const n = d.pattern === 'spread' ? Math.max(1, d.spreadCount) : 1;
    const spreadRad = ((d.spreadAngle || (n > 1 ? 16 : 0)) * Math.PI) / 180;
    for (let i = 0; i < n; i++) {
      const off = n > 1 ? ((i - (n - 1) / 2) / (n - 1)) * spreadRad : 0;
      this._spawnProjectile(w, m.x, m.y, baseAngle + off);
    }
  }

  // Damage multiplier vs. distance: full out to `opt`, falling to ~0.3 at `max` and a
  // touch beyond; below `min` (an arming distance, e.g. missiles) it's reduced too.
  _rangeFactor(range, dist) {
    if (!range) return 1;
    const { min = 0, opt = 0, max = 0 } = range;
    if (min > 0 && dist < min) return 0.4 + 0.6 * (dist / min);
    if (dist <= opt || max <= opt) return 1;
    const t = Math.min(1.2, (dist - opt) / (max - opt));
    return Math.max(0.2, 1 - 0.7 * t);
  }

  // The kind tag drives a projectile/impact's look: energy → plasma blob, missile →
  // trailed rocket, anything else → ballistic slug.
  _kind(weapon) {
    if (weapon.delivery.kind) return weapon.delivery.kind;   // explicit override (flame, fire)
    if (weapon.category === 'energy') return 'plasma';
    if (weapon.category === 'missile') return 'missile';
    return 'slug';
  }

  _fireHitscan(w, muzzleX, muzzleY, angle) {
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    const color = CATEGORIES[w.weapon.category]?.color ?? 0x9fe8ff;
    const reach = w.weapon.delivery.hit === 'contact' ? (w.weapon.range.max || 32) : 900;

    // Project the dummy onto the firing ray: forward distance `t`, perpendicular miss.
    const ex = this.dx - muzzleX, ey = this.dy - muzzleY;
    const t = ex * dirX + ey * dirY;
    const perp = Math.abs(ex * dirY - ey * dirX);
    let hit = !this.dummy.isDestroyed() && t > 0 && t < reach && perp < 44;
    let endDist = hit ? t : Math.min(reach, 600);
    // Cover: a wall between muzzle and target stops the beam short.
    const wallT = this._wallDistance(muzzleX, muzzleY, angle, endDist);
    const blocked = wallT < endDist;
    if (blocked) { endDist = wallT; hit = false; }
    const endX = muzzleX + dirX * endDist, endY = muzzleY + dirY * endDist;

    // Laser-y beam: bright core over a soft glow, quick fade.
    this.fx.lineStyle(5, color, 0.25).lineBetween(muzzleX, muzzleY, endX, endY);
    this.fx.lineStyle(1.6, 0xffffff, 0.9).lineBetween(muzzleX, muzzleY, endX, endY);
    this.time.delayedCall(80, () => this.fx.clear());
    if (hit) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      this._damageDummyAt(endX, endY, dmg, color);
      this._impactFx(endX, endY, color, 'beam', 0);
    } else if (blocked) {
      this._impactFx(endX, endY, color, 'beam', 0);
    }
  }

  _spawnProjectile(w, x, y, angle, owner = 'player') {
    const d = w.weapon.delivery;
    const speed = d.velocity || 480;
    const maxRange = (w.weapon.range?.max ?? 400) + 40;
    const tgt = owner === 'player' ? { x: this.dx, y: this.dy } : { x: this.px, y: this.py };
    let maxDist = maxRange;
    if (d.path === 'arcing') {
      // Lob toward the target if it's roughly in front, else to optimal range.
      const ex = tgt.x - x, ey = tgt.y - y;
      const fwd = ex * Math.cos(angle) + ey * Math.sin(angle);
      const perp = Math.abs(ex * Math.sin(angle) - ey * Math.cos(angle));
      maxDist = (fwd > 0 && fwd < maxRange && perp < 80) ? fwd : (w.weapon.range?.opt ?? 160);
    }
    const homing = d.guidance === 'homing';
    const locked = owner === 'player' && homing && this.lockTarget;   // a lock buffs guided missiles
    this.projectiles.push({
      x, y, angle, speed, owner,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      kind: this._kind(w.weapon), color: CATEGORIES[w.weapon.category]?.color ?? 0xffffff,
      damage: w.weapon.damage * (locked ? this.lockBonus : 1), splash: d.splash || 0, range: w.weapon.range,
      dist: 0, maxDist, arc: d.path === 'arcing', trail: [], ground: d.groundFire || null,
      homing, turn: locked ? 5.2 : 3.4,   // guided missiles steer toward a target, harder when locked
    });
  }

  _updateProjectiles(dt) {
    this.projFx.clear();
    for (const p of this.projectiles) {
      // Resolve this round's target: player rounds hit the enemy, enemy rounds the player.
      const enemyShot = p.owner === 'enemy';
      const targetGone = enemyShot ? this.mech.isDestroyed() : this.dummy.isDestroyed();
      const tx = enemyShot ? this.px : this.dx;
      const ty = enemyShot ? this.py : this.dy;

      // Guided missiles steer toward the target, capped by their turn rate.
      if (p.homing && !targetGone) {
        const desired = Math.atan2(ty - p.y, tx - p.x);
        p.angle = Phaser.Math.Angle.RotateTo(p.angle, desired, p.turn * dt);
        p.vx = Math.cos(p.angle) * p.speed; p.vy = Math.sin(p.angle) * p.speed;
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.dist += p.speed * dt;
      // Cover: a round that flies into a wall detonates there (arcing rounds lob over).
      if (!p.arc && this._isWall(p.x, p.y)) {
        p.dead = true;
        this._impactFx(p.x, p.y, p.color, p.kind, p.splash);
        continue;
      }
      const toTarget = targetGone ? Infinity : Math.hypot(p.x - tx, p.y - ty);
      const landed = p.dist >= p.maxDist;
      if (toTarget < HIT_RADIUS || landed) {
        p.dead = true;
        if (toTarget < HIT_RADIUS + p.splash) {
          const dmg = Math.max(1, Math.round(p.damage * this._rangeFactor(p.range, p.dist)));
          if (enemyShot) this._damagePlayerAt(dmg); else this._damageDummyAt(p.x, p.y, dmg, p.color);
        }
        this._impactFx(p.x, p.y, p.color, p.kind, p.splash);
        if (p.ground) this.firePatches.push({ x: p.x, y: p.y, r: p.ground.radius, dps: p.ground.dps, until: this.time.now + p.ground.duration * 1000, nextTick: this.time.now + 500 });
        continue;
      }
      this._drawProjectile(p);
    }
    if (this.projectiles.some((p) => p.dead)) this.projectiles = this.projectiles.filter((p) => !p.dead);
  }

  _drawProjectile(p) {
    const g = this.projFx;
    // Arcing rounds fake height: a ground shadow plus a lofted body.
    let lift = 0;
    if (p.arc) {
      lift = Math.sin((p.dist / p.maxDist) * Math.PI) * Math.min(28, p.maxDist * 0.12);
      g.fillStyle(0x000000, 0.25).fillEllipse(p.x, p.y, 7, 3);
    }
    const dy = p.y - lift;
    if (p.kind === 'plasma') {
      g.fillStyle(p.color, 0.30).fillCircle(p.x, dy, 7);
      g.fillStyle(p.color, 0.9).fillCircle(p.x, dy, 3.4);
      g.fillStyle(0xffffff, 0.9).fillCircle(p.x, dy, 1.4);
    } else if (p.kind === 'missile') {
      const bx = p.x - Math.cos(p.angle) * 7, by = dy - Math.sin(p.angle) * 7;
      g.lineStyle(3, 0xffb347, 0.5).lineBetween(bx, by, p.x - Math.cos(p.angle) * 14, dy - Math.sin(p.angle) * 14);
      g.fillStyle(p.color, 1).fillCircle(p.x, dy, 2.4);
    } else if (p.kind === 'flame') {
      const f = 0.7 + 0.3 * Math.sin(p.dist * 0.4);   // flicker
      g.fillStyle(0xff7a18, 0.4 * f).fillCircle(p.x, dy, 6);
      g.fillStyle(0xffd56b, 0.9 * f).fillCircle(p.x, dy, 2.6);
    } else if (p.kind === 'fire') { // napalm canister, lobbed
      g.fillStyle(0x3a2a1c, 1).fillCircle(p.x, dy, 3.2);
      g.fillStyle(0xff7a18, 0.9).fillCircle(p.x, dy, 1.6);
    } else { // slug: a short bright tracer
      const tx = p.x - Math.cos(p.angle) * 9, ty = dy - Math.sin(p.angle) * 9;
      g.lineStyle(2, p.color, 0.9).lineBetween(tx, ty, p.x, dy);
    }
  }

  // Burning ground patches (napalm): tick damage to mechs standing in them, with a
  // flickering flame visual, until they burn out.
  _updateFirePatches() {
    const now = this.time.now;
    for (const fp of this.firePatches) {
      if (now >= fp.nextTick) {
        fp.nextTick += 500;
        if (!this.dummy.isDestroyed() && Math.hypot(this.dx - fp.x, this.dy - fp.y) < fp.r) {
          this._damageDummyAt(this.dx, this.dy, Math.max(1, Math.round(fp.dps * 0.5)), 0xff7a18);
        }
      }
      // flames
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + now * 0.004;
        const rr = fp.r * (0.4 + 0.4 * Math.abs(Math.sin(now * 0.01 + i)));
        this.projFx.fillStyle(i % 2 ? 0xff7a18 : 0xffd56b, 0.45)
          .fillCircle(fp.x + Math.cos(a) * rr, fp.y + Math.sin(a) * rr, 5);
      }
      if (now >= fp.until) fp.dead = true;
    }
    if (this.firePatches.some((f) => f.dead)) this.firePatches = this.firePatches.filter((f) => !f.dead);
  }

  // ── Enemy AI ── maintain a range band, face the player, fire with LOS. ──
  _updateEnemy(dt, delta) {
    if (this.dummy.isDestroyed()) { this.dummyView.setAlpha(0.5); return; }
    const mv = this.dummy.movement;
    const dxp = this.px - this.dx, dyp = this.py - this.dy;
    const dist = Math.hypot(dxp, dyp) || 1;
    const ux = dxp / dist, uy = dyp / dist;

    // Desired movement: close if far, back off if close, else strafe.
    let mx = 0, my = 0;
    if (dist > 260) { mx = ux; my = uy; }
    else if (dist < 150) { mx = -ux; my = -uy; }
    else { this._strafeDir = this._strafeDir || 1; mx = -uy * this._strafeDir; my = ux * this._strafeDir; if (Math.random() < 0.01) this._strafeDir *= -1; }

    const spd = mv.maxSpeed * 0.8;
    this.evx = approach(this.evx, mx * spd, mv.accel * dt);
    this.evy = approach(this.evy, my * spd, mv.accel * dt);
    let ndx = this.dx + this.evx * dt, ndy = this.dy + this.evy * dt;
    if (this._blocked(ndx, ndy)) { if (!this._blocked(this.dx + this.evx * dt, this.dy)) { ndy = this.dy; this.evy = 0; } else if (!this._blocked(this.dx, this.dy + this.evy * dt)) { ndx = this.dx; this.evx = 0; } else { ndx = this.dx; ndy = this.dy; this.evx = this.evy = 0; } }
    this.dx = ndx; this.dy = ndy;

    // Aim turret + face travel.
    this.dummyTurret = Phaser.Math.Angle.RotateTo(this.dummyTurret, Math.atan2(dyp, dxp), mv.turretSlew * dt);
    if (Math.hypot(this.evx, this.evy) > 5) this.dummyAngle = Phaser.Math.Angle.RotateTo(this.dummyAngle, Math.atan2(this.evy, this.evx), mv.turnRate * dt);

    // Fire ready weapons at the player when in range with line of sight.
    for (const w of this.dummy.readyWeapons()) {
      let cd = (this.enemyFireCd[w.location] ?? 0) - delta;
      const inRange = dist < (w.weapon.range.max || 300) * 1.05;
      const los = this._wallDistance(this.dx, this.dy, Math.atan2(dyp, dxp), dist) === Infinity;
      if (cd <= 0 && inRange && los) {
        this.dummy.consumeAmmo(w.location, w.index, 1);
        const aimErr = (Math.random() - 0.5) * 0.12;
        const mx2 = this.dx + Math.cos(this.dummyTurret) * 16, my2 = this.dy + Math.sin(this.dummyTurret) * 16;
        this._spawnProjectile(w, mx2, my2, Math.atan2(dyp, dxp) + aimErr, 'enemy');
        cd = this._fireInterval(w.weapon);
      }
      this.enemyFireCd[w.location] = Math.max(0, cd);
    }
    this.dummy.regenAmmo(dt);

    this.dummyView.setPosition(this.dx, this.dy);
    this.dummyView.hull.rotation = this.dummyAngle + Math.PI / 2;
    this.dummyView.turret.rotation = this.dummyTurret + Math.PI / 2;
  }

  // Enemy round hits the player: damage a (torso-weighted) random part through the shield.
  _damagePlayerAt(dmg) {
    const parts = ['centerTorso', 'centerTorso', 'leftTorso', 'rightTorso', 'leftArm', 'rightArm', 'head'];
    const loc = parts[Math.floor(Math.random() * parts.length)];
    const res = this.damagePlayer(loc, dmg);
    if (res.shielded) { this._floatText(this.px, this.py - 24, 'shielded', '#5ec8e0'); return; }
    reskinMech(this, 'playerMech', this.mech);
    this._floatText(this.px, this.py - 20, `-${dmg}`, '#e2533a');
    if (this.mech.isDestroyed() && !this._playerDead) {
      this._playerDead = true;
      this._floatText(this.px, this.py - 36, 'MECH DOWN', '#e2533a');
      this.time.delayedCall(1600, () => this.toGarage());
    }
  }

  // Impact effect, animated per ordnance type: a bright core flash plus a kind-specific
  // burst (ballistic spark, missile/splash explosion, plasma splatter, laser scorch).
  _impactFx(x, y, color, kind, splash) {
    const burst = (r0, r1, col, alpha, dur, stroke) => {
      const c = stroke
        ? this.add.circle(x, y, r0).setStrokeStyle(2, col, alpha)
        : this.add.circle(x, y, r0, col, alpha);
      this.tweens.add({ targets: c, scale: r1 / r0, alpha: 0, duration: dur, onComplete: () => c.destroy() });
    };
    burst(3, 9, 0xffffff, 0.9, 120, false); // core flash, every hit

    if (kind === 'missile' || splash > 0) {
      const r = Math.max(10, splash);
      burst(r * 0.4, r * 1.6, 0xff7a18, 0.4, 260, false);  // fireball
      burst(r * 0.5, r * 1.9, 0xffd56b, 0.9, 300, true);   // shock ring
    } else if (kind === 'plasma') {
      burst(4, 18, color, 0.6, 240, false);                // splatter blob
      burst(3, 14, color, 0.9, 220, true);
    } else if (kind === 'beam') {
      burst(2, 7, color, 0.9, 110, false);                 // scorch flash
    } else {                                                // ballistic spark
      burst(2, 9, color, 0.85, 130, false);
      burst(1.5, 7, 0xffffff, 0.7, 100, true);
    }
  }

  // Apply `damage` to the dummy's part nearest the world point (x, y).
  _damageDummyAt(x, y, damage, color) {
    if (this.dummy.isDestroyed()) return;
    const dispUnit = ARENA_MECH_SCALE * ART_SCALE;
    const lx = x - this.dx, ly = y - this.dy;
    const lay = mechLayout(this.dummy);
    let best = null, bestD = Infinity;
    for (const loc of DAMAGEABLE) {
      const a = lay[loc];
      const d = Math.hypot(lx - a.x * dispUnit, ly - a.y * dispUnit);
      if (d < bestD) { bestD = d; best = loc; }
    }
    const res = this.dummy.applyDamage(best, damage);
    reskinMech(this, 'dummyMech', this.dummy, { theme: 'enemy' });
    this._floatText(x, y, `${damage}`, res.destroyed ? '#e2533a' : '#ffd56b');
    if (this.dummy.isDestroyed()) {
      this.dummyView.setAlpha(0.5);
      this._floatText(this.dx, this.dy - 30, 'DESTROYED', '#e2533a');
    }
  }

  _floatText(x, y, s, color) {
    const t = this.add.text(x, y, s, { fontFamily: 'monospace', fontSize: '14px', color }).setOrigin(0.5);
    this.tweens.add({ targets: t, y: y - 26, alpha: 0, duration: 700, onComplete: () => t.destroy() });
  }

  toGarage() {
    this.scene.stop('HudScene');
    this.scene.start('GarageScene');
  }
}

// Move `cur` toward `target` by at most `maxStep`.
function approach(cur, target, maxStep) {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}
