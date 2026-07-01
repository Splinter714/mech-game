import Phaser from 'phaser';
import { buildMechTextures } from '../art/index.js';
import { buildHexTextures } from '../art/hexArt.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { range } from '../data/hexgrid.js';
import { Controls, PadEdges, PAD } from '../input/Controls.js';
import { Audio } from '../audio/index.js';
import { WorldMixin } from './arena/world.js';
import { CombatMixin } from './arena/combat.js';
import { EnemiesMixin } from './arena/enemies.js';
import { ProjectilesMixin } from './arena/projectiles.js';
import { TargetingMixin } from './arena/targeting.js';
import { FiringMixin } from './arena/firing.js';
import { LocomotionMixin } from './arena/locomotion.js';

// The battlefield. Top-down hex world with one drivable mech. Locomotion is tank-style
// (forward/back + rotate) with weight-driven inertia; the turret slews toward the aim
// within a limited arc and PUSHES the chassis to turn when you aim past it; the gait is
// a stompy stepped walk. A list of mobile enemies (start: one Raider) drives the combat
// loop — they move, aim, shoot back, and take per-part damage; debug controls spawn/reset
// them. The scene is a thin orchestrator; behaviour lives in the arena/ mixins composed
// onto the prototype below.

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

    // Enemies — armed, mobile, shoot back. Each is a self-contained object with its own mech,
    // textures, view, and per-mech AI state, so the arena handles N enemies. The default opening
    // squad (one of each type) is spawned below, AFTER the player + camera are set, so the
    // enemies can be dropped just off-screen (relative to the viewport) and walk into view.
    this.enemies = [];
    this._enemySeq = 0;

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

    // Default opening squad (#44): one of each mech type — brawler, skirmisher, sniper, and the
    // cover-camping bombardier — dropped OFF-SCREEN so they march into view and engage per their
    // AI. Spawned here (after px/py + camera follow) so off-screen positions are computed right.
    this._spawnSquad();

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
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scene.stop('HudScene');
      Audio.stopAllHeld();   // #53: don't leave a flamethrower/beam-laser loop running into the garage
      // #56: any in-flight rounds still looping their trajectory cue (didn't get to impact
      // before the scene tore down) need their loops stopped too, or they'd run forever.
      for (const p of this.projectiles) p.stopTrajectorySfx?.();
    });
  }

  // The per-frame loop is a thin orchestrator: each step is a mixin method (drive, gait,
  // firing, abilities, enemy AI, projectiles/beams/ground-fire), called in the original
  // order. The few lines of overlay drawing + ammo regen stay inline.
  update(_time, delta) {
    const dt = Math.min(0.05, delta / 1000);
    const intent = this.controls.read();

    this._drive(intent, dt);

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
    this._stepGait(dt);
    this._handleFiring(intent, delta);
    this._handleAbilities(intent, delta);
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

  toGarage() {
    this.scene.stop('HudScene');
    this.scene.start('GarageScene');
  }
}

// The scene's behaviour is split into per-concern mixins under ./arena/; each is a plain
// object of methods using `this`, composed onto the prototype here. Adding a concern = a new
// mixin file + one entry in this list (the scene stays a thin orchestrator).
Object.assign(
  ArenaScene.prototype,
  WorldMixin, LocomotionMixin, TargetingMixin, FiringMixin, ProjectilesMixin, EnemiesMixin, CombatMixin,
);
