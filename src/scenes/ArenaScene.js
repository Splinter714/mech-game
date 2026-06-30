import Phaser from 'phaser';
import { Mech } from '../data/Mech.js';
import { buildMechTextures, reskinMech, mechLayout, ART_SCALE, drawProjectileBody, drawBeam, drawSlash, drawGroundFire } from '../art/index.js';
import { planEmissions, makeProjectile, stepProjectile } from '../data/delivery.js';
import { buildHexTextures } from '../art/hexArt.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { LOCATIONS } from '../data/anatomy.js';
import { CATEGORIES } from '../data/categories.js';
import { hexToPixel, pixelToHex, range, axialKey, neighbors, HEX_SIZE } from '../data/hexgrid.js';
import { getTerrain } from '../data/terrain.js';
import { Controls, PadEdges, PAD } from '../input/Controls.js';
import { Audio } from '../audio/index.js';

// The battlefield. Top-down hex world with one drivable mech. Locomotion is tank-style
// (forward/back + rotate) with weight-driven inertia; the turret slews toward the aim
// within a limited arc and PUSHES the chassis to turn when you aim past it; the gait is
// a stompy stepped walk. A list of mobile enemies (start: one Raider) drives the combat
// loop — they move, aim, shoot back, and take per-part damage; debug controls spawn/reset
// them. Single-file for Milestone 1 — splits into arena/ mixins as combat grows.
const ARENA_MECH_SCALE = 0.34;
const HIT_RADIUS = 32;            // a shot within this of a mech's centre strikes its body
// Soft-lock targeting (#31) — a default, always-on aid. You instantly lock the enemy nearest
// your aim *line* (not the nearest by distance), and shots get a rotational nudge toward it
// scaled by how centred it is — capped at ASSIST_STRENGTH so it never perfectly snaps. The
// lock is sticky (ACQUIRE cone to grab, wider RELEASE cone to drop) so it doesn't flicker.
const ASSIST_STRENGTH = 0.55;     // max fraction a shot is rotated toward the locked enemy
const ACQUIRE_CONE = 0.35;        // radians half-angle to grab a new soft-lock
const RELEASE_CONE = 0.55;        // wider half-angle before an existing lock is dropped
const ASSIST_RANGE = 620;         // px the enemy must be within
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
    this.assistTarget = null;  // firing solution this frame: { x, y, strength } toward the lock
    this.lockEnemy = null;     // the currently soft-locked enemy (sticky across frames)

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

  // Generate a large natural battlefield (#41): a big grass disc with a winding river,
  // scattered forest clusters, and a few industrial outposts to roam through. Terrain is
  // kept in `this.terrain` (hexKey → terrain id); collision + line-of-sight read its
  // passable/blocksLOS props. Seeded so the layout is deterministic.
  _buildWorld() {
    this.worldRadius = 20;
    const R = this.worldRadius;
    const rng = mulberry32(0x5eed);
    const all = range({ q: 0, r: 0 }, R);
    const T = new Map();
    const isGrass = (k) => { const t = T.get(k); return t === 'grass' || t === 'grassB'; };

    // Base: a checkered grass field.
    for (const h of all) T.set(axialKey(h.q, h.r), (h.q + h.r) % 2 ? 'grassB' : 'grass');

    // River: a winding water course sweeping across the map (impassable, but shoot over it).
    for (let q = -R + 2; q <= R - 2; q++) {
      const r = Math.round(7 * Math.sin(q * 0.26) + 3 * Math.sin(q * 0.11));
      for (const dr of [0, 1]) { const k = axialKey(q, r + dr); if (T.has(k)) T.set(k, 'water'); }
    }

    // Forest clusters scattered across the field (seed + organic neighbour growth) — cover.
    for (let i = 0; i < Math.round(R * 2.2); i++) {
      const c = all[Math.floor(rng() * all.length)];
      const k0 = axialKey(c.q, c.r);
      if (!isGrass(k0)) continue;
      T.set(k0, 'forest');
      for (const n of neighbors(c.q, c.r)) {
        const k = axialKey(n.q, n.r);
        if (isGrass(k) && rng() < 0.6) T.set(k, 'forest');
      }
    }

    // A few industrial outposts (building clusters) — hard cover.
    for (let i = 0; i < 4; i++) {
      const c = all[Math.floor(rng() * all.length)];
      for (const h of [c, ...neighbors(c.q, c.r).filter(() => rng() < 0.55)]) {
        const k = axialKey(h.q, h.r); if (T.has(k)) T.set(k, 'building');
      }
    }

    // Clear the centre (spawns + line of fire) back to open grass.
    for (const h of range({ q: 0, r: 0 }, 3)) T.set(axialKey(h.q, h.r), (h.q + h.r) % 2 ? 'grassB' : 'grass');
    T.set('0,0', 'grass');
    T.set(axialKey(DUMMY_HEX.q, DUMMY_HEX.r), 'grass');

    this.terrain = T;
    for (const [k, id] of T) {
      const [q, r] = k.split(',').map(Number);
      const { x, y } = hexToPixel(q, r);
      this.add.image(x, y, getTerrain(id).tex).setScale(1 / ART_SCALE);
    }
  }

  // Terrain id at a world point (undefined = outside the arena disc).
  _terrainAt(x, y) {
    const h = pixelToHex(x, y);
    return this.terrain.get(axialKey(h.q, h.r));
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

    // ── Soft-lock targeting (#31): a default, always-on aid. Locks the enemy nearest the
    // aim line and nudges shots toward it. ──
    this._updateAimAssist();

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
    if (this.assistTarget) this._drawLockReticle(this.lockEnemy.x, this.lockEnemy.y, this.assistTarget.centred);

    // Bubble shield bubble, drawn over the player while active.
    if (this.time.now < this.shieldUntil) {
      this.projFx.lineStyle(2, 0x5ec8e0, 0.7).strokeCircle(this.px, this.py, 34);
      this.projFx.fillStyle(0x5ec8e0, 0.10).fillCircle(this.px, this.py, 34);
    }

    // ── Ammo regen ── every magazine tops back up over time.
    this.mech.regenAmmo(dt);
  }

  // Soft-lock (#31): lock the enemy nearest the aim line, instantly. The lock is sticky — kept
  // until it leaves the (wider) RELEASE cone or range, swapped only when another enemy is
  // clearly more centred — so it doesn't flicker. `fireWeapon` nudges shots toward it scaled by
  // centredness (capped, never a perfect snap), and `_drawLockReticle` shows it. Baseline
  // mechanic — no item, no hold-to-lock.
  _updateAimAssist() {
    this.assistTarget = null;
    this.registry.set('assistOn', this.assistOn);
    if (!this.assistOn) { this.lockEnemy = null; return; }

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
    if (keep && (!cand || cand === this.lockEnemy || aimOff(this.lockEnemy) - candOff < 0.12)) {
      // hold existing lock
    } else {
      this.lockEnemy = cand;
    }

    if (!this.lockEnemy) return;

    // Instant soft-lock: the nudge applies as soon as a target is locked, scaled only by how
    // centred it is (no hold-to-charge). Still soft — capped at ASSIST_STRENGTH.
    const centred = 1 - Math.min(1, aimOff(this.lockEnemy) / RELEASE_CONE);
    const strength = ASSIST_STRENGTH * centred;
    this.assistTarget = { x: this.lockEnemy.x, y: this.lockEnemy.y, strength, centred };
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

  // ── Enemy lifecycle (#39 debug controls) ──────────────────────────────────────────
  // Build a fresh enemy with its own textures + view + AI state and track it.
  _spawnEnemy(x, y) {
    const key = `enemy${this._enemySeq++}`;
    const mech = new Mech({ chassisId: 'light', name: 'Raider', mounts: { rightArm: ['autocannon'], leftTorso: ['clusterRocket'] } });
    mech.repairAll();
    buildMechTextures(this, key, mech, { theme: 'enemy' });
    const angle = Math.PI / 2;
    const view = this._makeMechView(key, x, y, angle);
    const e = { key, mech, view, x, y, vx: 0, vy: 0, angle, turret: angle, fireCd: {}, strafeDir: 1, spawnX: x, spawnY: y };
    this.enemies.push(e);
    this.registry.set('dummyMech', this.enemies[0].mech);
    return e;
  }

  // Drop an extra enemy onto a clear, in-bounds spot away from the player.
  _spawnEnemyDebug() {
    const spots = range({ q: 0, r: 0 }, this.worldRadius - 1)
      .map((h) => hexToPixel(h.q, h.r))
      .filter((p) => !this._blocked(p.x, p.y) && Math.hypot(p.x - this.px, p.y - this.py) > 160);
    const p = spots.length ? spots[Math.floor(Math.random() * spots.length)] : { x: 0, y: -200 };
    this._spawnEnemy(p.x, p.y);
    this._floatText(p.x, p.y - 34, 'ENEMY +1', '#efc14a');
  }

  // Restore every enemy to full health at its spawn point (in place, no re-deploy).
  _resetEnemies() {
    for (const e of this.enemies) {
      e.mech.repairAll();
      e.x = e.spawnX; e.y = e.spawnY; e.vx = 0; e.vy = 0;
      e.angle = Math.PI / 2; e.turret = Math.PI / 2; e.fireCd = {};
      e.view.setAlpha(1).setPosition(e.x, e.y);
      reskinMech(this, e.key, e.mech, { theme: 'enemy' });
    }
    this._floatText(this.px, this.py - 40, 'ENEMIES RESET', '#5ec8e0');
  }

  // Soft-lock reticle (#31): corner brackets that close in and brighten from amber→red as the
  // enemy centres on the aim (`p` is 0→1 centredness). Dead-centre adds a ring to read "locked"
  // — though the firing nudge stays soft. Drawn each frame on the live enemy position.
  _drawLockReticle(x, y, p) {
    const locked = p >= 0.95;
    const col = locked ? 0xe2533a : 0xefc14a;
    const r = 34 - 14 * p;              // brackets draw inward as the aim centres
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

  // Debug (#28): flip enemy movement or firing on/off and toast the new state.
  _toggleAi(which) {
    if (which === 'move') this.enemyMove = !this.enemyMove;
    else this.enemyFire = !this.enemyFire;
    const label = which === 'move' ? `AI MOVE ${this.enemyMove ? 'ON' : 'OFF'}` : `AI FIRE ${this.enemyFire ? 'ON' : 'OFF'}`;
    this._floatText(this.px, this.py - 40, label, '#efc14a');
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

  // Does a world point block line-of-sight (cover / projectile blocker)? Forest + buildings
  // do; open grass + water do not (you can shoot over a river).
  _isWall(x, y) {
    const t = this._terrainAt(x, y);
    return !!t && getTerrain(t).blocksLOS;
  }

  // Is a world point impassable for the mech — non-passable terrain, or off the arena disc?
  _blocked(x, y) {
    const t = this._terrainAt(x, y);
    return !t || !getTerrain(t).passable;
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

  // The direction a weapon fires: straight along the turret facing (#40 — shots follow the
  // slewing turret exactly, parallel to where it visually points, not converging on the
  // reticle), with an optional soft nudge toward a tracked enemy by aim-assist (melee
  // ignores assist).
  _fireAngle(w, m) {
    let a = this.turretAngle;
    if (this.assistTarget && w.weapon.delivery.hit !== 'contact') {
      const toTarget = Math.atan2(this.assistTarget.y - m.y, this.assistTarget.x - m.x);
      a = Phaser.Math.Angle.RotateTo(a, toTarget, Math.abs(Phaser.Math.Angle.Wrap(toTarget - a)) * this.assistTarget.strength);
    }
    return a;
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
    const maxRange = (w.weapon.range?.max ?? 400) + 40;
    // The arena's own targeting: an arcing round lobs to where its target actually is
    // (else to optimal range); straight rounds just run out at max range. This travel
    // budget is what the shared kinematic round flies.
    let maxDist = maxRange;
    if (d.path === 'arcing') {
      let tgt;
      if (owner === 'player') { const e = this._nearestEnemy(x, y); tgt = e ? { x: e.x, y: e.y } : { x, y }; }
      else tgt = { x: this.px, y: this.py };
      const ex = tgt.x - x, ey = tgt.y - y;
      const fwd = ex * Math.cos(angle) + ey * Math.sin(angle);
      const perp = Math.abs(ex * Math.sin(angle) - ey * Math.cos(angle));
      maxDist = (fwd > 0 && fwd < maxRange && perp < 80) ? fwd : (w.weapon.range?.opt ?? 160);
    }
    // Homing is intrinsic to guided weapons now (#31): they track their target on their
    // own when fired, no equipped lock needed.
    this.projectiles.push({
      ...makeProjectile(w.weapon, x, y, angle, { maxDist }),
      owner, trail: [],
    });
  }

  _updateProjectiles(dt) {
    this.projFx.clear();
    for (const p of this.projectiles) {
      // Resolve this round's target: enemy rounds chase the player; player rounds chase
      // (and damage) the nearest living enemy, re-evaluated each frame so homing retargets.
      const enemyShot = p.owner === 'enemy';
      const hitEnemy = enemyShot ? null : this._nearestEnemy(p.x, p.y);
      const targetGone = enemyShot ? this.mech.isDestroyed() : !hitEnemy;
      const tx = enemyShot ? this.px : (hitEnemy ? hitEnemy.x : p.x);
      const ty = enemyShot ? this.py : (hitEnemy ? hitEnemy.y : p.y);

      // Advance via the shared kinematics — guided rounds steer toward the live target
      // (capped by turn rate); ballistic rounds just integrate velocity.
      stepProjectile(p, dt, p.homing && !targetGone ? Math.atan2(ty - p.y, tx - p.x) : null);
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
          if (enemyShot) this._damagePlayerAt(dmg);
          else if (hitEnemy) this._damageEnemyAt(hitEnemy, p.x, p.y, dmg, p.color);
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
    // The round body itself is shared art (so the garage icon matches); `p.dist` drives
    // the flame flicker.
    drawProjectileBody(g, p.x, p.y - lift, p.angle, p.kind, p.color, 1, p.dist);
  }

  // Burning ground patches (napalm): tick damage to mechs standing in them, with a
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
  }

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
  }

  // ── Enemy AI ── each enemy maintains a range band, faces the player, fires with LOS. ──
  _updateEnemies(dt, delta) {
    this.registry.set('aiMove', this.enemyMove);
    this.registry.set('aiFire', this.enemyFire);
    for (const e of this.enemies) this._updateEnemy(e, dt, delta);
    const alive = this.enemies.filter((e) => !e.mech.isDestroyed()).length;
    this.registry.set('enemyCount', this.enemies.length);
    this.registry.set('enemiesAlive', alive);
  }

  _updateEnemy(e, dt, delta) {
    if (e.mech.isDestroyed()) { e.view.setAlpha(0.5); return; }
    const mv = e.mech.movement;
    const dxp = this.px - e.x, dyp = this.py - e.y;
    const dist = Math.hypot(dxp, dyp) || 1;
    const ux = dxp / dist, uy = dyp / dist;

    // Movement (gated by the #28 debug toggle): close if far, back off if close, else strafe.
    if (this.enemyMove) {
      let mx = 0, my = 0;
      if (dist > 260) { mx = ux; my = uy; }
      else if (dist < 150) { mx = -ux; my = -uy; }
      else { mx = -uy * e.strafeDir; my = ux * e.strafeDir; if (Math.random() < 0.01) e.strafeDir *= -1; }

      const spd = mv.maxSpeed * 0.8;
      e.vx = approach(e.vx, mx * spd, mv.accel * dt);
      e.vy = approach(e.vy, my * spd, mv.accel * dt);
      let nx = e.x + e.vx * dt, ny = e.y + e.vy * dt;
      if (this._blocked(nx, ny)) { if (!this._blocked(e.x + e.vx * dt, e.y)) { ny = e.y; e.vy = 0; } else if (!this._blocked(e.x, e.y + e.vy * dt)) { nx = e.x; e.vx = 0; } else { nx = e.x; ny = e.y; e.vx = e.vy = 0; } }
      e.x = nx; e.y = ny;
    } else {
      e.vx = approach(e.vx, 0, mv.accel * dt); e.vy = approach(e.vy, 0, mv.accel * dt);
    }

    // Aim turret + face travel (turret still tracks even when stationary, for testing).
    e.turret = Phaser.Math.Angle.RotateTo(e.turret, Math.atan2(dyp, dxp), mv.turretSlew * dt);
    if (Math.hypot(e.vx, e.vy) > 5) e.angle = Phaser.Math.Angle.RotateTo(e.angle, Math.atan2(e.vy, e.vx), mv.turnRate * dt);

    // Fire ready weapons at the player when in range with line of sight (gated by #28).
    if (this.enemyFire) for (const w of e.mech.readyWeapons()) {
      let cd = (e.fireCd[w.location] ?? 0) - delta;
      const inRange = dist < (w.weapon.range.max || 300) * 1.05;
      const los = this._wallDistance(e.x, e.y, Math.atan2(dyp, dxp), dist) === Infinity;
      if (cd <= 0 && inRange && los) {
        e.mech.consumeAmmo(w.location, w.index, 1);
        const aimErr = (Math.random() - 0.5) * 0.12;
        const mx2 = e.x + Math.cos(e.turret) * 16, my2 = e.y + Math.sin(e.turret) * 16;
        this._spawnProjectile(w, mx2, my2, Math.atan2(dyp, dxp) + aimErr, 'enemy');
        cd = this._fireInterval(w.weapon);
      }
      e.fireCd[w.location] = Math.max(0, cd);
    }
    e.mech.regenAmmo(dt);

    e.view.setPosition(e.x, e.y);
    e.view.hull.rotation = e.angle + Math.PI / 2;
    e.view.turret.rotation = e.turret + Math.PI / 2;
  }

  // Enemy round hits the player: damage a (torso-weighted) random part through the shield.
  _damagePlayerAt(dmg) {
    const parts = ['centerTorso', 'centerTorso', 'leftTorso', 'rightTorso', 'leftArm', 'rightArm', 'head'];
    const loc = parts[Math.floor(Math.random() * parts.length)];
    const res = this.damagePlayer(loc, dmg);
    if (res.shielded) { this._floatText(this.px, this.py - 24, 'shielded', '#5ec8e0'); return; }
    reskinMech(this, 'playerMech', this.mech);
    this._floatText(this.px, this.py - 20, `-${dmg}`, '#e2533a');
    if (res.destroyed) Audio.explosion(0.6);   // a part broke off (#36)
    if (this.mech.isDestroyed() && !this._playerDead) {
      this._playerDead = true;
      this._floatText(this.px, this.py - 36, 'MECH DOWN', '#e2533a');
      Audio.explosion(1.2);
      this.time.delayedCall(1600, () => this.toGarage());
    }
  }

  // Impact effect, animated per ordnance type: a bright core flash plus a kind-specific
  // burst (ballistic spark, missile/splash explosion, plasma splatter, laser scorch).
  _impactFx(x, y, color, kind, splash) {
    Audio.impact(kind);
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

  // Apply `damage` to enemy `e`'s part nearest the world point (x, y).
  _damageEnemyAt(e, x, y, damage, color) {
    if (e.mech.isDestroyed()) return;
    const dispUnit = ARENA_MECH_SCALE * ART_SCALE;
    const lx = x - e.x, ly = y - e.y;
    const lay = mechLayout(e.mech);
    let best = null, bestD = Infinity;
    for (const loc of DAMAGEABLE) {
      const a = lay[loc];
      const d = Math.hypot(lx - a.x * dispUnit, ly - a.y * dispUnit);
      if (d < bestD) { bestD = d; best = loc; }
    }
    const res = e.mech.applyDamage(best, damage);
    reskinMech(this, e.key, e.mech, { theme: 'enemy' });
    this._floatText(x, y, `${damage}`, res.destroyed ? '#e2533a' : '#ffd56b');
    if (res.destroyed) Audio.explosion(0.6);   // a part broke off (#36)
    if (e.mech.isDestroyed()) {
      e.view.setAlpha(0.5);
      this._floatText(e.x, e.y - 30, 'DESTROYED', '#e2533a');
      Audio.explosion(1.15);                   // catastrophic kill
    }
  }

  _floatText(x, y, s, color) {
    const t = this.add.text(x, y, s, { fontFamily: 'monospace', fontSize: '14px', color }).setOrigin(0.5);
    this.tweens.add({ targets: t, y: y - 26, alpha: 0, duration: 700, onComplete: () => t.destroy() });
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

// Small seeded PRNG (mulberry32) so the generated map is deterministic.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Move `cur` toward `target` by at most `maxStep`.
function approach(cur, target, maxStep) {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}
