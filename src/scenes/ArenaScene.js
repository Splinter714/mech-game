import Phaser from 'phaser';
import { Mech } from '../data/Mech.js';
import { buildMechTextures, reskinMech, mechLayout, ART_SCALE } from '../art/index.js';
import { buildHexTextures } from '../art/hexArt.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { LOCATIONS } from '../data/anatomy.js';
import { hexToPixel, range, axialKey, HEX_SIZE } from '../data/hexgrid.js';

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
    buildMechTextures(this, 'dummyMech', this.dummy);
    const dp = hexToPixel(DUMMY_HEX.q, DUMMY_HEX.r);
    this.dummyAngle = Math.PI / 2; // facing "down" toward the player spawn
    this.dummyView = this._makeMechView('dummyMech', dp.x, dp.y, this.dummyAngle);
    this.dx = dp.x; this.dy = dp.y;

    // Player state.
    this.px = 0; this.py = 0;
    this.angle = -Math.PI / 2;     // facing up
    this.turretAngle = -Math.PI / 2;
    this.speed = 0;
    this.stepMs = 0; this.hullFrame = 0;
    this.playerView = this._makeMechView('playerMech', this.px, this.py, this.angle);

    this.cameras.main.startFollow(this.playerView, true, 0.12, 0.12);

    this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,G');
    this.input.keyboard.on('keydown-G', () => this.toGarage());
    this.input.keyboard.on('keydown-SPACE', () => this.fire());
    this.input.on('pointerdown', () => this.fire());

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

    // ── Tank locomotion with weight inertia ──
    const k = this.keys;
    const throttle = (k.W.isDown || k.UP.isDown ? 1 : 0) - (k.S.isDown || k.DOWN.isDown ? 1 : 0);
    const turn = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
    const targetSpeed = throttle * mv.maxSpeed * legF;
    this.speed = approach(this.speed, targetSpeed, mv.accel * dt);
    this.angle += turn * mv.turnRate * dt * (0.4 + 0.6 * legF);
    this.px += Math.cos(this.angle) * this.speed * dt;
    this.py += Math.sin(this.angle) * this.speed * dt;

    // ── Turret: slew toward aim, clamped to the arc; aim past the arc turns the mech ──
    const p = this.input.activePointer;
    const aim = Math.atan2(p.worldY - this.py, p.worldX - this.px);
    const raw = Phaser.Math.Angle.Wrap(aim - this.angle);
    const clamped = Phaser.Math.Clamp(raw, -mv.turretArc, mv.turretArc);
    const target = this.angle + clamped;
    this.turretAngle = Phaser.Math.Angle.RotateTo(this.turretAngle, target, mv.turretSlew * dt);
    if (Math.abs(raw) > mv.turretArc) {
      const over = Math.abs(raw) - mv.turretArc;
      this.angle += Math.sign(raw) * Math.min(mv.turnRate * dt * 0.7, over);
    }

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

    // ── Heat dissipation ──
    if (this.mech.heat > 0) this.mech.heat = Math.max(0, this.mech.heat - this.mech.dissipation() * dt);
  }

  // Fire every online weapon as one volley toward the aim. Draws tracers; if the aim
  // point lands on the dummy, the nearest dummy part takes the summed damage (and the
  // dummy is re-skinned so a destroyed part becomes a stump).
  fire() {
    if (!this.scene.isActive() || this.dummy.isDestroyed()) return;
    const online = this.mech.onlineWeapons();
    if (online.length === 0) return;

    const aimX = this.input.activePointer.worldX;
    const aimY = this.input.activePointer.worldY;
    const muzzleX = this.px + Math.cos(this.turretAngle) * 18;
    const muzzleY = this.py + Math.sin(this.turretAngle) * 18;

    let damage = 0, heat = 0;
    for (const w of online) { damage += w.weapon.damage; heat += w.weapon.heat; }
    this.mech.heat = Math.min(this.mech.heatCapacity(), this.mech.heat + heat);

    // Tracer.
    this.fx.clear();
    this.fx.lineStyle(2, 0x9fe8ff, 0.9).beginPath();
    this.fx.moveTo(muzzleX, muzzleY); this.fx.lineTo(aimX, aimY); this.fx.strokePath();
    this.time.delayedCall(70, () => this.fx.clear());

    // Did the aim land on the dummy?
    const dispUnit = ARENA_MECH_SCALE * ART_SCALE;
    const lx = aimX - this.dx, ly = aimY - this.dy;
    if (Math.hypot(lx, ly) > 64) return; // missed the dummy

    const lay = mechLayout(this.dummy);
    let best = null, bestD = Infinity;
    for (const loc of DAMAGEABLE) {
      const a = lay[loc];
      const d = Math.hypot(lx - a.x * dispUnit, ly - a.y * dispUnit);
      if (d < bestD) { bestD = d; best = loc; }
    }
    const res = this.dummy.applyDamage(best, damage);
    reskinMech(this, 'dummyMech', this.dummy);
    this._floatText(this.dx + lx, this.dy + ly, `${damage}`, res.destroyed ? '#e2533a' : '#ffd56b');
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
