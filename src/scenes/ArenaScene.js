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
    this.vx = 0; this.vy = 0;      // world-space velocity (twin-stick movement)
    this.speed = 0;
    this.stepMs = 0; this.hullFrame = 0;
    this.playerView = this._makeMechView('playerMech', this.px, this.py, this.angle);

    this.cameras.main.startFollow(this.playerView, true, 0.12, 0.12);

    this.controls = new Controls(this);
    this.fireCooldowns = {};   // `${loc}:${index}` → ms until this weapon can fire again
    this.input.keyboard.on('keydown-G', () => this.toGarage());

    this.fx = this.add.graphics();
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
    const aim = intent.aim.mode === 'pointer'
      ? Math.atan2(intent.aim.y - this.py, intent.aim.x - this.px)
      : intent.aim.angle;
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

  // Fire one weapon along the current turret facing. Draws a category-coloured tracer;
  // if the firing ray passes through the dummy, its nearest part takes this weapon's
  // damage and the dummy is re-skinned so a destroyed part becomes a stump.
  fireWeapon(w) {
    if (!this.scene.isActive() || this.dummy.isDestroyed()) return;
    this.mech.consumeAmmo(w.location, w.index, 1);

    const dirX = Math.cos(this.turretAngle), dirY = Math.sin(this.turretAngle);
    const muzzleX = this.px + dirX * 18, muzzleY = this.py + dirY * 18;
    const color = CATEGORIES[w.weapon.category]?.color ?? 0x9fe8ff;

    // Project the dummy onto the firing ray: forward distance `t`, perpendicular miss.
    const ex = this.dx - muzzleX, ey = this.dy - muzzleY;
    const t = ex * dirX + ey * dirY;
    const perp = Math.abs(ex * dirY - ey * dirX);
    const hit = t > 0 && t < 900 && perp < 44;

    const endX = hit ? muzzleX + dirX * t : muzzleX + dirX * 600;
    const endY = hit ? muzzleY + dirY * t : muzzleY + dirY * 600;
    this.fx.lineStyle(2, color, 0.9).beginPath();
    this.fx.moveTo(muzzleX, muzzleY); this.fx.lineTo(endX, endY); this.fx.strokePath();
    this.time.delayedCall(70, () => this.fx.clear());
    if (!hit) return;

    // Nearest dummy part to the impact point.
    const dispUnit = ARENA_MECH_SCALE * ART_SCALE;
    const lx = endX - this.dx, ly = endY - this.dy;
    const lay = mechLayout(this.dummy);
    let best = null, bestD = Infinity;
    for (const loc of DAMAGEABLE) {
      const a = lay[loc];
      const d = Math.hypot(lx - a.x * dispUnit, ly - a.y * dispUnit);
      if (d < bestD) { bestD = d; best = loc; }
    }
    const res = this.dummy.applyDamage(best, w.weapon.damage);
    reskinMech(this, 'dummyMech', this.dummy, { theme: 'enemy' });
    this._floatText(this.dx + lx, this.dy + ly, `${w.weapon.damage}`, res.destroyed ? '#e2533a' : '#ffd56b');
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
