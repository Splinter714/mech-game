import Phaser from 'phaser';
import { buildMechTextures, mechLayout, ART_SCALE, drawSlash } from '../art/index.js';
import { planEmissions, makeProjectile } from '../data/delivery.js';
import { buildHexTextures } from '../art/hexArt.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { CATEGORIES } from '../data/categories.js';
import { hexToPixel, range, HEX_SIZE } from '../data/hexgrid.js';
import { Controls, PadEdges, PAD } from '../input/Controls.js';
import { Audio } from '../audio/index.js';
import { WorldMixin } from './arena/world.js';
import { CombatMixin } from './arena/combat.js';
import { EnemiesMixin } from './arena/enemies.js';
import { ProjectilesMixin } from './arena/projectiles.js';

// The battlefield. Top-down hex world with one drivable mech. Locomotion is tank-style
// (forward/back + rotate) with weight-driven inertia; the turret slews toward the aim
// within a limited arc and PUSHES the chassis to turn when you aim past it; the gait is
// a stompy stepped walk. A list of mobile enemies (start: one Raider) drives the combat
// loop — they move, aim, shoot back, and take per-part damage; debug controls spawn/reset
// them. Single-file for Milestone 1 — splits into arena/ mixins as combat grows.
const ARENA_MECH_SCALE = 0.34;
// Targeting (#31) — two separate, always-on systems:
//  • Convergence (direct fire: lasers, autocannons): off-centre muzzles angle inward to a
//    forward point at the locked target's range (or CONVERGE_DIST when nothing's locked), so
//    shots land where the turret points. Purely geometric — never curves toward the enemy.
//  • Soft-lock (indirect fire: missiles, lobs): locks the enemy nearest the aim *line*, charges
//    amber→red over LOCK_TIME while held, and that enemy is what homing rounds seek / lobs land
//    on. The lock is sticky (ACQUIRE cone to grab, wider RELEASE cone to drop) so it doesn't
//    flicker. This is the only "true aim assist".
const ACQUIRE_CONE = 0.35;        // radians half-angle to grab a new soft-lock
const RELEASE_CONE = 0.55;        // wider half-angle before an existing lock is dropped
const ASSIST_RANGE = 620;         // px the enemy must be within
const LOCK_TIME = 0.6;            // seconds of holding a target in-cone to charge amber→red
const CONVERGE_DIST = 450;        // px convergence range for direct fire when nothing is locked
const DUMMY_HEX = { q: 3, r: -1 };

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

    // Enemies — armed, mobile, shoot back. Start with one Raider; the debug controls
    // (#39) can reset them or spawn more. Each is a self-contained object with its own
    // mech, textures, view, and per-mech AI state, so the arena handles N enemies.
    this.enemies = [];
    this._enemySeq = 0;
    const dp = hexToPixel(DUMMY_HEX.q, DUMMY_HEX.r);
    this._spawnEnemy(dp.x, dp.y);

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
    this.padEdges = new PadEdges(this);   // rising-edge pad buttons for one-shot actions
    this.fireCooldowns = {};   // `${loc}:${index}` → ms until this weapon can fire again
    this.abilityCd = {};       // ability location → ms until it can fire again
    this.shieldUntil = 0;      // timestamp the bubble shield is active until
    this.assistOn = true;      // soft-lock targeting: a default, always-on aid (#31)
    this.lockEnemy = null;     // the currently soft-locked enemy (sticky across frames)
    this.lockProgress = 0;     // 0→1 charge while a target is held in-cone (amber→red)

    // Debug toggles (#28): stop/start the enemy's movement and firing for testing.
    this.enemyMove = true;
    this.enemyFire = true;

    this.input.keyboard.on('keydown-G', () => this.toGarage());
    this.input.keyboard.on('keydown-T', () => this._toggleAssist());
    this.input.keyboard.on('keydown-M', () => {
      const muted = Audio.toggleMute();
      this._floatText(this.px, this.py - 30, muted ? 'MUTED' : 'SOUND ON', '#7c8794');
    });
    this.input.keyboard.on('keydown-OPEN_BRACKET', () => this._toggleAi('move'));
    this.input.keyboard.on('keydown-CLOSED_BRACKET', () => this._toggleAi('fire'));
    this.input.keyboard.on('keydown-R', () => this._resetEnemies());   // #39
    this.input.keyboard.on('keydown-N', () => this._spawnEnemyDebug()); // #39

    this.fx = this.add.graphics();        // instant beams / impact flashes (timed clear)
    this.beamFx = this.add.graphics();   // persistent beams + dying sparks (redrawn each frame)
    this.projFx = this.add.graphics();    // travelling projectiles (redrawn each frame)
    this.projectiles = [];
    this.beams = [];
    this.dyingBeams = [];
    this.firePatches = [];                // burning ground (napalm)
    this.scene.launch('HudScene');
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.scene.stop('HudScene'));
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

    // ── One-shot pad buttons (#28 AI toggles, #29 return to garage, #31 assist). ──
    if (this.padEdges.pressed(PAD.R3)) this._toggleAssist();
    if (this.padEdges.pressed(PAD.SELECT) || this.padEdges.pressed(PAD.B)) this.toGarage();
    if (this.padEdges.pressed(PAD.DPAD_UP)) this._spawnEnemyDebug();    // ↑ add enemy (#39)
    if (this.padEdges.pressed(PAD.DPAD_DOWN)) this._resetEnemies();     // ↓ reset enemies (#39)
    if (this.padEdges.pressed(PAD.DPAD_LEFT)) this._toggleAi('move');   // ← toggle move (#28)
    if (this.padEdges.pressed(PAD.DPAD_RIGHT)) this._toggleAi('fire');  // → toggle fire (#28)

    // ── Soft-lock targeting (#31): locks the enemy nearest the aim line; indirect weapons
    // (missiles/lobs) seek it. Direct weapons converge geometrically, no lock needed. ──
    this._updateLock(dt);

    // ── Stompy stepped gait ──
    let bob = 0;
    if (Math.abs(this.speed) > 5 && legF > 0) {
      this.stepMs += dt * 1000 * (Math.abs(this.speed) / mv.maxSpeed);
      if (this.stepMs >= mv.stepInterval) {
        this.stepMs -= mv.stepInterval;
        this.hullFrame = (this.hullFrame + 1) % 4;
        if (this.hullFrame % 2 === 0) { this._footImpactFx(this.hullFrame === 0 ? 0 : 1, mv.stepBob); Audio.footstep(this.hullFrame === 0 ? 0 : 1); }
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

    // ── Abilities ── the centre-torso ability fires on its button (L3 / Space) off cd. ──
    const dashDir = Math.hypot(intent.move.x, intent.move.y) > 0.1
      ? Math.atan2(intent.move.y, intent.move.x) : this.turretAngle;
    for (const ab of this.mech.abilities()) {
      let cd = (this.abilityCd[ab.location] ?? 0) - delta;
      if (intent.fire[ab.location] && cd <= 0) { this._activateAbility(ab, dashDir); cd = ab.equip.cooldown * 1000; }
      this.abilityCd[ab.location] = Math.max(0, cd);
    }
    this.registry.set('abilityCooldowns', this.abilityCd);
    this.registry.set('shieldActive', this.time.now < this.shieldUntil);

    // ── Enemy AI ──
    this._updateEnemies(dt, delta);

    // ── Projectiles + burning ground ──
    this._updateProjectiles(dt);
    this._updateFirePatches();
    this._updateBeams(delta);

    // Soft-lock reticle, drawn after projFx is cleared above so it isn't wiped.
    if (this.lockEnemy) this._drawLockReticle(this.lockEnemy.x, this.lockEnemy.y, this.lockProgress);

    // Bubble shield bubble, drawn over the player while active.
    if (this.time.now < this.shieldUntil) {
      this.projFx.lineStyle(2, 0x5ec8e0, 0.7).strokeCircle(this.px, this.py, 34);
      this.projFx.fillStyle(0x5ec8e0, 0.10).fillCircle(this.px, this.py, 34);
    }

    // ── Ammo regen ── every magazine tops back up over time.
    this.mech.regenAmmo(dt);
  }

  // Soft-lock (#31): lock the enemy nearest the aim line. The lock is sticky — kept until it
  // leaves the (wider) RELEASE cone or range, swapped only when another enemy is clearly more
  // centred — so it doesn't flicker. While a target is held the lock charges amber→red over
  // LOCK_TIME (`lockProgress`); it bleeds back down when nothing is locked. Indirect weapons
  // (homing/lob) seek `lockEnemy`; `_drawLockReticle` shows the charge.
  _updateLock(dt) {
    this.registry.set('assistOn', this.assistOn);
    if (!this.assistOn) { this.lockEnemy = null; this.lockProgress = 0; return; }

    // Angular offset of an enemy from the turret line (smaller = more centred on the aim).
    const aimOff = (e) => Math.abs(Phaser.Math.Angle.Wrap(Math.atan2(e.y - this.py, e.x - this.px) - this.turretAngle));
    const inRange = (e) => !e.mech.isDestroyed() && Math.hypot(e.x - this.px, e.y - this.py) <= ASSIST_RANGE;

    // The best fresh candidate: in range, within the ACQUIRE cone, nearest the aim line.
    let cand = null, candOff = ACQUIRE_CONE;
    for (const e of this.enemies) {
      if (!inRange(e)) continue;
      const off = aimOff(e);
      if (off < candOff) { candOff = off; cand = e; }
    }

    // Stickiness: keep the current lock while it stays in range and inside the RELEASE cone,
    // unless a fresh candidate is meaningfully more centred (hysteresis margin).
    const keep = this.lockEnemy && inRange(this.lockEnemy) && aimOff(this.lockEnemy) < RELEASE_CONE;
    const prev = this.lockEnemy;
    if (keep && (!cand || cand === this.lockEnemy || aimOff(this.lockEnemy) - candOff < 0.12)) {
      // hold existing lock
    } else {
      this.lockEnemy = cand;
    }

    // Charge amber→red over time while a target is held (reset on a fresh target); bleed down
    // when nothing is locked.
    if (!this.lockEnemy) { this.lockProgress = Math.max(0, this.lockProgress - dt / LOCK_TIME); return; }
    if (this.lockEnemy !== prev) this.lockProgress = 0;
    this.lockProgress = Math.min(1, this.lockProgress + dt / LOCK_TIME);
  }

  // The closest living enemy to a point, within `maxDist` (default: any). Used for
  // aim-assist, homing, hitscan target selection, and burning-ground ticks.
  _nearestEnemy(x, y, maxDist = Infinity) {
    let best = null, bd = maxDist;
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // Soft-lock reticle (#31): corner brackets that close in and brighten from amber→red as the
  // lock charges over time (`p` is 0→1 lockProgress). Full charge adds a ring to read "locked"
  // — the point indirect weapons commit their seek to. Drawn each frame on the live enemy.
  _drawLockReticle(x, y, p) {
    const locked = p >= 0.999;
    const col = locked ? 0xe2533a : 0xefc14a;
    const r = 34 - 14 * p;              // brackets draw inward as the lock charges
    const len = 8;
    const g = this.projFx.lineStyle(2, col, 0.6 + 0.4 * p);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = x + sx * r, cy = y + sy * r;
      g.lineBetween(cx, cy, cx - sx * len, cy);
      g.lineBetween(cx, cy, cx, cy - sy * len);
    }
    if (locked) this.projFx.lineStyle(1.5, col, 0.9).strokeCircle(x, y, r + 4);
  }

  _toggleAssist() {
    this.assistOn = !this.assistOn;
    this._floatText(this.px, this.py - 30, this.assistOn ? 'ASSIST ON' : 'ASSIST OFF', this.assistOn ? '#5ec8e0' : '#7c8794');
  }

  _activateAbility(ab, dir) {
    const e = ab.equip;
    Audio.ability(e.ability);
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
    Audio.fire(w.weapon);

    // The shared delivery sim decides what one trigger pull emits (single / spread fan /
    // tight cluster / multi-pulse burst); each emission is realised from the live muzzle
    // and aim so a slewing turret and aim-assist still apply per sub-shot.
    const plan = planEmissions(w.weapon);
    for (const s of plan.shots) {
      const go = () => {
        if (!this.scene.isActive()) return;
        const m = this._muzzle(w.location);
        const baseAngle = this._fireAngle(w, m) + s.angleOffset;
        const perp = baseAngle + Math.PI / 2;
        const ox = m.x + Math.cos(perp) * s.lateral, oy = m.y + Math.sin(perp) * s.lateral;
        if (plan.mode === 'contact') this._melee(w, ox, oy, baseAngle);
        else if (plan.mode === 'hitscan') this._fireHitscan(w, ox, oy, baseAngle);
        else this._spawnProjectile(w, ox, oy, baseAngle);
      };
      if (s.delay > 0) this.time.delayedCall(s.delay, go); else go();
    }
  }

  // The direction a weapon fires (#40, #31). Two regimes:
  //  • Indirect (homing/lob) & melee: fire straight along the turret facing — their targeting
  //    happens downrange (homing seek / lob lead), not by bending the launch angle.
  //  • Direct (lasers, autocannons): converge — aim the (off-centre) muzzle at a forward point
  //    on the turret line at the locked target's range (or CONVERGE_DIST), so shots land where
  //    the turret points. Purely geometric; never curves toward the enemy's lateral position.
  _fireAngle(w, m) {
    const d = w.weapon.delivery;
    if (d.hit === 'contact' || d.guidance === 'homing' || d.path === 'arcing') return this.turretAngle;
    const dist = this.lockEnemy ? Math.hypot(this.lockEnemy.x - this.px, this.lockEnemy.y - this.py) : CONVERGE_DIST;
    const cx = this.px + Math.cos(this.turretAngle) * dist;
    const cy = this.py + Math.sin(this.turretAngle) * dist;
    return Math.atan2(cy - m.y, cx - m.x);
  }

  // Melee swing: same forward-ray hit detection as a beam, but drawn as a sweeping
  // crescent (shared drawSlash art) instead of a straight line.
  _melee(w, mx, my, angle) {
    const reach = w.weapon.range.max || 32;
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    let target = null, t = 0;
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      const ex = e.x - mx, ey = e.y - my, tt = ex * dirX + ey * dirY, perp = Math.abs(ex * dirY - ey * dirX);
      if (tt > 0 && tt < reach && perp < 44 && (!target || tt < t)) { target = e; t = tt; }
    }
    const color = CATEGORIES[w.weapon.category]?.color ?? 0xcfd6e0;
    if (target) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      this._damageEnemyAt(target, mx + dirX * t, my + dirY * t, dmg, color);
    }
    // Animate the crescent across a few frames, then clear.
    for (const tt of [0.15, 0.45, 0.8]) {
      this.time.delayedCall(tt * 150, () => {
        if (!this.scene.isActive()) return;
        this.fx.clear(); drawSlash(this.fx, mx, my, angle, tt, color, 1, reach + 8);
      });
    }
    this.time.delayedCall(170, () => this.fx.clear());
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

  _fireHitscan(w, muzzleX, muzzleY, angle) {
    const dirX = Math.cos(angle), dirY = Math.sin(angle);
    const color = CATEGORIES[w.weapon.category]?.color ?? 0x9fe8ff;
    const reach = w.weapon.delivery.hit === 'contact' ? (w.weapon.range.max || 32) : 900;

    // Project each living enemy onto the firing ray (forward `t`, perpendicular miss) and
    // take the nearest one actually struck.
    let target = null, t = 0;
    for (const e of this.enemies) {
      if (e.mech.isDestroyed()) continue;
      const ex = e.x - muzzleX, ey = e.y - muzzleY;
      const tt = ex * dirX + ey * dirY;
      const perp = Math.abs(ex * dirY - ey * dirX);
      if (tt > 0 && tt < reach && perp < 44 && (!target || tt < t)) { target = e; t = tt; }
    }
    let hit = !!target;
    let endDist = hit ? t : Math.min(reach, 600);
    // Cover: a wall between muzzle and target stops the beam short.
    const wallT = this._wallDistance(muzzleX, muzzleY, angle, endDist);
    const blocked = wallT < endDist;
    if (blocked) { endDist = wallT; hit = false; }
    const endX = muzzleX + dirX * endDist, endY = muzzleY + dirY * endDist;

    // Persistent beam so sparks can linger after it fades. A continuously-held beam
    // (sustained/stream) keeps ONE beam object that re-pins to the muzzle each shot, so it
    // tracks the mech as it turns/moves; single-shot beams (pulse/rail) push a fresh one.
    const beamTtl = w.weapon.delivery.burst?.wubOn ?? 80;
    const heavy = w.weapon.delivery.kind === 'rail';
    const continuous = w.weapon.delivery.sustained || w.weapon.delivery.pattern === 'stream';
    const live = continuous ? this.beams.find((b) => b.loc === w.location) : null;
    if (live) {
      live.x0 = muzzleX; live.y0 = muzzleY; live.x1 = endX; live.y1 = endY;
      live.ttl = beamTtl;   // age keeps advancing → warble flows continuously
    } else {
      this.beams.push({ x0: muzzleX, y0: muzzleY, x1: endX, y1: endY, color, heavy, ttl: beamTtl, age: 0, loc: continuous ? w.location : null });
    }
    if (hit) {
      const dmg = Math.max(1, Math.round(w.weapon.damage * this._rangeFactor(w.weapon.range, t)));
      this._damageEnemyAt(target, endX, endY, dmg, color);
      this._impactFx(endX, endY, color, 'beam', 0);
    } else if (blocked) {
      this._impactFx(endX, endY, color, 'beam', 0);
    }
  }

  _spawnProjectile(w, x, y, angle, owner = 'player') {
    const d = w.weapon.delivery;
    let speed = d.velocity || 480;
    const maxRange = (w.weapon.range?.max ?? 400) + 40;
    // Indirect-fire targeting (#31): a player round seeks the locked enemy ONLY when the lock
    // is fully charged (red) — no lock, no seek, the missile dumb-fires straight. Enemy rounds
    // chase the player.
    const hasLock = owner === 'player' && this.lockProgress >= 1 && this.lockEnemy && !this.lockEnemy.mech.isDestroyed();
    const seekTarget = hasLock ? this.lockEnemy : null;
    // An arcing round lobs to where its target actually is (else to optimal range); straight
    // rounds just run out at max range. This travel budget is what the kinematic round flies.
    let maxDist = maxRange;
    if (d.path === 'arcing') {
      const tgt = owner === 'player' ? (seekTarget ?? { x, y }) : { x: this.px, y: this.py };
      const ex = tgt.x - x, ey = tgt.y - y;
      const fwd = ex * Math.cos(angle) + ey * Math.sin(angle);
      const perp = Math.abs(ex * Math.sin(angle) - ey * Math.cos(angle));
      maxDist = (fwd > 0 && fwd < maxRange && perp < 80) ? fwd : (w.weapon.range?.opt ?? 160);
      // Constant-apex lobs: hold flight time fixed so every arc peaks at the same height —
      // a far shot therefore launches faster. The weapon's `velocity` is calibrated at its
      // optimal range (T = opt / velocity), and that same airtime is reused at any range.
      const opt = w.weapon.range?.opt || maxDist;
      const flightTime = opt / speed;
      speed = maxDist / flightTime;
    }
    // Homing rounds steer toward `seekTarget` (the lock) each frame. A player round only homes
    // when it actually has a lock; without one it dumb-fires straight. Enemy rounds keep their
    // intrinsic homing (they chase the player downrange).
    const round = makeProjectile(w.weapon, x, y, angle, { maxDist });
    // Constant-flight-time lobs: override the round's speed with the per-shot value computed
    // above so every arc peaks at the same height (a far shot launches faster).
    if (d.path === 'arcing') {
      round.speed = speed;
      round.vx = Math.cos(angle) * speed;
      round.vy = Math.sin(angle) * speed;
    }
    if (owner === 'player') round.homing = round.homing && !!seekTarget;
    this.projectiles.push({ ...round, owner, trail: [], seekTarget });
  }

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
    const v = this.playerView;
    if (!v._stomping) {
      v._stomping = true;
      const sq = Math.min(0.12, 0.04 + p * 0.012);
      this.tweens.add({
        targets: v, scaleX: 1 + sq * 0.6, scaleY: 1 - sq, duration: 70, yoyo: true, ease: 'Quad.easeOut',
        onComplete: () => { v.setScale(1); v._stomping = false; },
      });
    }
  }

  toGarage() {
    this.scene.stop('HudScene');
    this.scene.start('GarageScene');
  }
}

// The scene's behaviour is split into per-concern mixins under ./arena/; each is a plain
// object of methods using `this`, composed onto the prototype here. Adding a concern = a new
// mixin file + one entry in this list (the scene stays a thin orchestrator).
Object.assign(ArenaScene.prototype, WorldMixin, CombatMixin, EnemiesMixin, ProjectilesMixin);

// Move `cur` toward `target` by at most `maxStep`.
function approach(cur, target, maxStep) {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}
