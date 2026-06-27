import Phaser from 'phaser';
import { Mech } from '../data/Mech.js';
import { buildMechTextures, reskinMech, mechLayout, ART_SCALE } from '../art/index.js';
import { buildHexTextures } from '../art/hexArt.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { LOCATIONS } from '../data/anatomy.js';
import { CATEGORIES } from '../data/categories.js';
import { hexToPixel, range, axialKey, HEX_SIZE } from '../data/hexgrid.js';
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

    // Target dummy.
    this.dummy = new Mech({ chassisId: 'light', name: 'Target' });
    this.registry.set('dummyMech', this.dummy);
    buildMechTextures(this, 'dummyMech', this.dummy, { theme: 'enemy' });
    const dp = hexToPixel(DUMMY_HEX.q, DUMMY_HEX.r);
    this.dummyAngle = Math.PI / 2; // facing "down" toward the player spawn
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
    this.input.keyboard.on('keydown-G', () => this.toGarage());

    this.fx = this.add.graphics();        // instant beams / impact flashes (timed clear)
    this.projFx = this.add.graphics();    // travelling projectiles (redrawn each frame)
    this.projectiles = [];
    this.scene.launch('HudScene');
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.scene.stop('HudScene'));
  }

  // Lay out a disc of hex tiles; a scattered few become walls (cover). Visual only for
  // now — collision is a later, physics-based step.
  _buildWorld() {
    const walls = new Set(['1,1', '2,-3', '-2,2', '-3,0', '4,-2', '0,3', '-1,-2', '3,2']);
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
    this.px += this.vx * dt;
    this.py += this.vy * dt;
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

    // ── Projectiles in flight ──
    this._updateProjectiles(dt);

    // ── Ammo regen ── every magazine tops back up over time.
    this.mech.regenAmmo(dt);
  }

  // Milliseconds between shots for a weapon: stream weapons use their fire rate, the
  // rest use their cycle time (with a small floor so nothing fires every frame).
  _fireInterval(weapon) {
    if (weapon.delivery.pattern === 'stream' && weapon.delivery.fireRate > 0) {
      return 1000 / weapon.delivery.fireRate;
    }
    return Math.max(120, weapon.cycleTime);
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

  // The kind tag drives a projectile/impact's look: energy → plasma blob, missile →
  // trailed rocket, anything else → ballistic slug.
  _kind(weapon) {
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
    const hit = !this.dummy.isDestroyed() && t > 0 && t < reach && perp < 44;
    const endX = hit ? muzzleX + dirX * t : muzzleX + dirX * Math.min(reach, 600);
    const endY = hit ? muzzleY + dirY * t : muzzleY + dirY * Math.min(reach, 600);

    // Laser-y beam: bright core over a soft glow, quick fade.
    this.fx.lineStyle(5, color, 0.25).lineBetween(muzzleX, muzzleY, endX, endY);
    this.fx.lineStyle(1.6, 0xffffff, 0.9).lineBetween(muzzleX, muzzleY, endX, endY);
    this.time.delayedCall(80, () => this.fx.clear());
    if (hit) { this._damageDummyAt(endX, endY, w.weapon.damage, color); this._impactFx(endX, endY, color, 'beam', 0); }
  }

  _spawnProjectile(w, x, y, angle) {
    const d = w.weapon.delivery;
    const speed = d.velocity || 480;
    const maxRange = (w.weapon.range?.max ?? 400) + 40;
    let maxDist = maxRange;
    if (d.path === 'arcing') {
      // Lob toward the dummy if it's roughly in front, else to optimal range.
      const ex = this.dx - x, ey = this.dy - y;
      const fwd = ex * Math.cos(angle) + ey * Math.sin(angle);
      const perp = Math.abs(ex * Math.sin(angle) - ey * Math.cos(angle));
      maxDist = (fwd > 0 && fwd < maxRange && perp < 80) ? fwd : (w.weapon.range?.opt ?? 160);
    }
    this.projectiles.push({
      x, y, angle, speed,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      kind: this._kind(w.weapon), color: CATEGORIES[w.weapon.category]?.color ?? 0xffffff,
      damage: w.weapon.damage, splash: d.splash || 0,
      dist: 0, maxDist, arc: d.path === 'arcing', trail: [],
    });
  }

  _updateProjectiles(dt) {
    this.projFx.clear();
    for (const p of this.projectiles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.dist += p.speed * dt;
      const toDummy = this.dummy.isDestroyed() ? Infinity : Math.hypot(p.x - this.dx, p.y - this.dy);
      const landed = p.dist >= p.maxDist;
      if (toDummy < HIT_RADIUS || landed) {
        p.dead = true;
        if (toDummy < HIT_RADIUS + p.splash) this._damageDummyAt(p.x, p.y, p.damage, p.color);
        this._impactFx(p.x, p.y, p.color, p.kind, p.splash);
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
    } else { // slug: a short bright tracer
      const tx = p.x - Math.cos(p.angle) * 9, ty = dy - Math.sin(p.angle) * 9;
      g.lineStyle(2, p.color, 0.9).lineBetween(tx, ty, p.x, dy);
    }
  }

  // A short-lived impact flash (richer per-ordnance visuals are a follow-up).
  _impactFx(x, y, color, kind, splash) {
    const r = Math.max(7, splash);
    this.fx.lineStyle(2, color, 0.8).strokeCircle(x, y, r * 0.6);
    this.fx.fillStyle(0xffffff, 0.6).fillCircle(x, y, 2.5);
    this.time.delayedCall(90, () => this.fx.clear());
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
