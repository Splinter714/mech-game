import Phaser from 'phaser';
import { buildMechTextures } from '../art/index.js';
import { buildHexTextures } from '../art/hexArt.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { range } from '../data/hexgrid.js';
import { Controls, PadEdges, PAD } from '../input/Controls.js';
import { makeLock } from '../data/targetlock.js';
import { Audio } from '../audio/index.js';
import { WorldMixin } from './arena/world.js';
import { CombatMixin } from './arena/combat.js';
import { EnemiesMixin } from './arena/enemies.js';
import { ProjectilesMixin } from './arena/projectiles.js';
import { TargetingMixin } from './arena/targeting.js';
import { FiringMixin } from './arena/firing.js';
import { LocomotionMixin } from './arena/locomotion.js';
import { PowerupsMixin } from './arena/powerups.js';
import { MissionMixin } from './arena/mission.js';
import { RunMixin } from './arena/run.js';
import { SalvageMixin } from './arena/salvage.js';
import { DEPTH } from './arena/shared.js';

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
    // Biome for this sortie (#67) — chosen by the garage per deploy; defaults to grassland.
    this.biomeId = this.registry.get('arenaBiome');
    this._buildWorld();
    // #66: designate the mission objective (one of the world's outposts) now that
    // `buildingHp` exists, and mark it in the world.
    this._initMission();
    // #64: continue the in-progress run (set by a prior stage advance) or start a fresh one.
    this._initRun();

    // Player mech (repaired fresh for the sortie).
    this.allMechs = this.registry.get('allMechs');
    this.mech = this.allMechs[ACTIVE_MECH_KEY];
    this.mech.repairAll();
    // Player-only survivability buffer: ~7x the chassis' per-location armor + structure.
    // Applied here (deploy time), not in the shared chassis data, so enemies are unaffected.
    // #64: tuned down from the old 100x (near-invincible sandbox) to a moderate value in the
    // 5-10x band — real damage across a run should threaten death (the run loop now ends the
    // run on player destruction), but a single bad opening shouldn't be instant-death.
    this.mech.boostHealth(7);
    this.registry.set('playerMech', this.mech);
    buildMechTextures(this, 'playerMech', this.mech);

    // Enemies — armed, mobile, shoot back. Each is a self-contained object with its own mech,
    // textures, view, and per-mech AI state, so the arena handles N enemies. The default opening
    // squad (one of each type) is spawned below, AFTER the player + camera are set, so the
    // enemies can be dropped just off-screen (relative to the viewport) and walk into view.
    this.enemies = [];
    this._enemySeq = 0;
    // #87: total spawned THIS stage, separate from `this.enemies.length` — dead enemies are now
    // pruned out of `this.enemies` shortly after death (see _removeEnemy) instead of lingering
    // until stage advance, so the array length alone no longer means "squad size."
    this._enemiesSpawnedThisStage = 0;

    // Player state.
    this.px = 0; this.py = 0;
    this.angle = -Math.PI / 2;     // legs facing up
    this.turretAngle = -Math.PI / 2;
    this.aimX = 0; this.aimY = -200;   // world aim point weapons converge on
    this.vx = 0; this.vy = 0;      // world-space velocity (twin-stick movement)
    this.speed = 0;
    this.stepMs = 0; this.hullFrame = 0;
    // #113: the player is the one unit that stays at DEPTH.UNITS — every ground enemy renders
    // below it (DEPTH.GROUND_UNITS) so it's never visually obscured.
    this.playerView = this._makeMechView('playerMech', this.px, this.py, this.angle, true);

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
    // Indirect-fire lock (#62): the always-available acquire-and-hold targeting for homing/arcing
    // weapons. `this.lock` is the pure state record (data/targetlock.js); `aimEnemy` is the live
    // most-aimed enemy used only by direct-fire convergence (kept separate so a blind lock behind
    // cover never drags laser convergence). `lockEnemy`/`lockProgress` mirror the lock for readers.
    this.lock = makeLock();
    this.aimEnemy = null;
    this.lockEnemy = null;
    this.lockProgress = 0;
    this._lockBlindAge = 0;

    // Debug toggles (#28): stop/start the enemy's movement and firing for testing.
    this.enemyMove = true;
    this.enemyFire = true;

    this.input.keyboard.on('keydown-G', () => this.toGarage());
    this.input.keyboard.on('keydown-T', () => this._dropLock());   // #62: drop the current lock
    this.input.keyboard.on('keydown-M', () => {
      const muted = Audio.toggleMute();
      this._floatText(this.px, this.py - 30, muted ? 'MUTED' : 'SOUND ON', '#7c8794');
    });
    this.input.keyboard.on('keydown-OPEN_BRACKET', () => this._toggleAi('move'));
    this.input.keyboard.on('keydown-CLOSED_BRACKET', () => this._toggleAi('fire'));
    this.input.keyboard.on('keydown-R', () => this._resetEnemies());   // #39
    this.input.keyboard.on('keydown-N', () => this._spawnEnemyDebug()); // #39

    // #99: explicit depths (DEPTH.* — shared.js) instead of relying on scene add-order, which
    // is what let napalm's burning-ground decal (drawn into `projFx`, below) paint over the
    // player/enemy views created earlier in create(). `groundFx` is its own low, ground-hugging
    // layer so a ground decal can never out-rank a unit no matter what else gets added later.
    this.groundFx = this.add.graphics().setDepth(DEPTH.GROUND_FX);   // burning-ground patches (napalm)
    this.fx = this.add.graphics().setDepth(DEPTH.PROJECTILES);        // instant beams / muzzle flash / slash (timed clear)
    this.beamFx = this.add.graphics().setDepth(DEPTH.PROJECTILES);   // persistent beams + dying sparks (redrawn each frame)
    this.projFx = this.add.graphics().setDepth(DEPTH.PROJECTILES);    // travelling projectiles (redrawn each frame)
    this.projectiles = [];
    this.beams = [];
    this.dyingBeams = [];
    this.firePatches = [];                // burning ground (napalm)
    // #76 concentrated-fire hit-feedback state — reset per run so a fresh arena never reuses a
    // stale (destroyed) impact-circle pool or a last-burst/sound timestamp from a prior fight.
    this._impactPool = [];
    this._impactRR = 0;
    this._impactSoundAt = {};
    this._lastBurst = null;
    this._initPowerups();                 // #60: timed-buff collectibles + active-buff overlay
    this._initSalvage();                  // #65: SCRAP pickups dropped by destroyed enemies
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

    // #80: the camera's world-space view rect, republished each frame so HudScene's edge-
    // direction arrow can tell whether the objective is on-screen and, if not, where to point.
    // Copied to a plain object rather than handing out the live Phaser Rectangle, so the HUD
    // reads a stable snapshot instead of an object the camera keeps mutating in place.
    const wv = this.cameras.main.worldView;
    this.registry.set('cameraView', { x: wv.x, y: wv.y, width: wv.width, height: wv.height });

    // #60: recompute the active-buff overlay once per frame; firing/movement/turret read it.
    this._refreshBuffMods();

    this._drive(intent, dt);

    // ── One-shot pad buttons (#28 AI toggles, #29 return to garage, #62 drop-lock). ──
    if (this.padEdges.pressed(PAD.R3)) this._dropLock();   // #62: R3 drops the current lock (was assist)
    if (this.padEdges.pressed(PAD.SELECT) || this.padEdges.pressed(PAD.B)) this.toGarage();
    if (this.padEdges.pressed(PAD.DPAD_UP)) this._spawnEnemyDebug();    // ↑ add enemy (#39)
    if (this.padEdges.pressed(PAD.DPAD_DOWN)) this._resetEnemies();     // ↓ reset enemies (#39)
    if (this.padEdges.pressed(PAD.DPAD_LEFT)) this._toggleAi('move');   // ← toggle move (#28)
    if (this.padEdges.pressed(PAD.DPAD_RIGHT)) this._toggleAi('fire');  // → toggle fire (#28)

    // ── Indirect-fire lock (#62): acquire amber→red on the enemy nearest the aim line, then
    // maintain it through cover (blind fire onto its last-known/predicted position). Homing/arcing
    // weapons seek it; direct weapons converge on the live most-aimed enemy, no lock needed. ──
    this._updateLock(dt);
    this._stepGait(dt);
    this._handleFiring(intent, delta);
    this._handleAbilities(intent, delta);
    this._updateEnemies(dt, delta);

    // ── Projectiles + burning ground ──
    this._updateProjectiles(dt);
    this._updateFirePatches();
    this._updateBeams(delta);

    // #60: bob/expire dropped collectibles, grab any the player touches, tick active buffs.
    this._updatePowerups(delta);
    // #65: bob/expire dropped SCRAP pickups, grab any the player touches.
    this._updateSalvage(delta);

    // #66: has the objective been destroyed? Evaluate + publish the mission each frame.
    this._updateMission();
    // #64: real player-death signal now reachable (survivability buffer tuned down) — advance
    // the run on mission-complete, or end it on player destruction.
    this._updateRun();

    // Lock reticle, drawn after projFx is cleared above so it isn't wiped. A maintained-but-blind
    // lock (#62) draws at the last-known/predicted position in a distinct "firing blind" colour so
    // the player sees they're lobbing from memory; otherwise it tracks the live locked enemy.
    if (this.lock.enemy) {
      const blind = this.lock.blind;
      const pt = blind ? this._lockAimPoint() : { x: this.lock.enemy.x, y: this.lock.enemy.y };
      if (pt) this._drawLockReticle(pt.x, pt.y, this.lock.progress, blind);
    }

    // Bubble shield bubble, drawn over the player while active.
    if (this.time.now < this.shieldUntil) {
      this.projFx.lineStyle(2, 0x5ec8e0, 0.7).strokeCircle(this.px, this.py, 34);
      this.projFx.fillStyle(0x5ec8e0, 0.10).fillCircle(this.px, this.py, 34);
    }

    // ── Ammo regen ── every magazine tops back up over time. #60 Surge multiplies the regen
    // rate (applied as a scaled dt, since regen is linear in dt) for its duration.
    this.mech.regenAmmo(dt * this._buffMods().ammoRegenMult);
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
  WorldMixin, LocomotionMixin, TargetingMixin, FiringMixin, ProjectilesMixin, EnemiesMixin, CombatMixin, PowerupsMixin, MissionMixin, RunMixin, SalvageMixin,
);
