import Phaser from 'phaser';
import { buildMechTextures } from '../art/index.js';
import { buildHexTextures } from '../art/hexArt.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { range } from '../data/hexgrid.js';
import { Controls, PadEdges, PAD } from '../input/Controls.js';
import { makeLock } from '../data/targetlock.js';
import { initialSprintState } from '../data/sprint.js';
import { initialDashState } from '../data/dash.js';
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
import { BasesMixin } from './arena/bases.js';
import { SalvageMixin } from './arena/salvage.js';
import { DEPTH, GAMEPLAY_ZOOM } from './arena/shared.js';

// #246: the player's native full-mech shield baseline — a real trait present from the start of
// every sortie, not something that only exists once a Shield powerup is picked up (most enemy
// mechs get NONE at all — see data/enemies.js/enemyKinds.js for which enemy kinds opt in).
// `max`/`regenPerSec` are deliberately modest (a slow trickle, not a second health bar) so it
// reads as "a little breathing room" rather than eclipsing armor/hp as the real defense layer;
// the Shield POWERUP (data/powerups.js) is what makes the shield feel powerful for a while.
// `pauseMs` is the brief (not shooter-style multi-second) regen interrupt on any hit that
// reaches the shield, per the #246 decision.
const PLAYER_SHIELD = { max: 50, regenPerSec: 2, pauseMs: 1200 };

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
    // #149: `zoomFactor` (read by main.js's resize handler, alongside every other scene's plain
    // dpr) is the arena's own gameplay-framing zoom ON TOP OF the dpr-neutralizing zoom every
    // scene applies — see GAMEPLAY_ZOOM's comment (arena/shared.js) for why. Set as an instance
    // property (not a one-off local) so a window resize re-derives `dpr * zoomFactor` instead of
    // reverting to the bare `dpr` every other scene uses.
    this.zoomFactor = GAMEPLAY_ZOOM;
    this.cameras.main.setZoom(dpr * this.zoomFactor);
    this.cameras.main.setBackgroundColor('#0d1014');
    // #202: brief cosmetic fade-in on deploy, to match the deploy sfx cue (#194) instead of
    // cutting straight into gameplay. Phaser's camera fade is a pure post-effect overlay on
    // the render — it does not pause the scene, update loop, or input, so movement/firing/AI
    // all start immediately underneath it exactly as before.
    this.cameras.main.fadeIn(400, 13, 16, 20);   // ~0x0d1014, matches the background color above

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
    // #246: (re)establish the player's native shield baseline fresh each sortie — same
    // redeploy-safe, idempotent spirit as boostHealth above (never compounds, always starts
    // this deploy at full charge with no lingering powerup boost from a prior run).
    this.mech.configureShield(PLAYER_SHIELD);
    this.registry.set('playerMech', this.mech);
    buildMechTextures(this, 'playerMech', this.mech);

    // #76 concentrated-fire hit-feedback state — reset per run so a fresh arena never reuses a
    // stale (destroyed) impact-circle pool or a last-burst/sound timestamp from a prior fight.
    // #254: moved here (was previously reset much later in create(), after `_spawnSquad()`
    // below) — #251's helipad flourish (`_spawnHelipadFx`, called from `_spawnKind` for every
    // gunship in the opening squad) calls `_burst`/`_acquireImpactCircle` DURING `_spawnSquad()`,
    // so on a Garage->Arena->Garage->Arena second deploy (ArenaScene is the same reused Scene
    // instance — see the #190 comment on `_debrisPool` below) that first burst was still reading
    // the FIRST session's stale `_impactPool`, recycling one of its destroyed Arc/Circle game
    // objects and throwing "Cannot set properties of null (setting 'radius')" the moment
    // `.setRadius()` touched its nulled-out internals. The reset must happen before anything in
    // create() can call `_burst`, and `_spawnSquad()` is the earliest such call.
    this._impactPool = [];
    this._impactRR = 0;
    this._impactSoundAt = {};
    this._lastBurst = null;
    // #100/#190: the death-explosion debris pool (combat.js `_acquireDebrisChunk`) is the same
    // kind of lazily-created, capped/recycled pool as `_impactPool` above, but was missed when
    // that reset block was written — it stayed lazily-initialized via `??=` only, so ArenaScene
    // being the SAME reused Scene instance across a Garage->Arena->Garage->Arena cycle meant a
    // second (or later) arena session inherited the FIRST session's pool of `Rectangle` game
    // objects. Those were destroyed along with everything else on the first Arena's shutdown, so
    // the moment a kill in the second session recycled one of them, `_acquireDebrisChunk` called
    // `.setSize()` on a destroyed (nulled-out) GameObject and threw ("Cannot read properties of
    // null (reading 'setSize')") — reproducibly, the first death after the second deploy. Reset
    // both here so every fresh arena session starts with its own live pool.
    this._debrisPool = [];
    this._debrisRR = 0;

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

    // #269: the old off-screen opening squad (#44) is retired — every base's docked units are
    // placed HERE, at deploy time, dormant, at their fixed dock positions (no camera/player-
    // relative placement needed, unlike the old off-screen spawn). Alert-tower countdown state
    // is initialized alongside so `_updateAlertTowers` (update(), below) can start ticking
    // immediately.
    this._spawnDormantUnits();
    // #269 playtest follow-up: a light, already-active roaming patrol presence stationed near
    // each alert tower — independent of the dormant/wake system above (see bases.js
    // `_spawnTowerPatrols` for why). Spawned after the dormant docks so both draw from the same
    // freshly-built `this.terrain`/`this.bases`/`this.alertTowerHexes`.
    this._spawnTowerPatrols();
    this._initAlertTowers();

    this.controls = new Controls(this);
    this.padEdges = new PadEdges(this);   // rising-edge pad buttons for one-shot actions
    this.fireCooldowns = {};   // `${loc}:${index}` → ms until this weapon can fire again
    this.sprint = initialSprintState();   // #188: Overclock-only now (#261), see data/sprint.js
    // #189: whether the CURRENT sprint-active state is because Overclock is forcing it, and
    // last frame's Overclock-active reading (so activation is detected as a true rising edge)
    // — see arena/firing.js `_handleSprint` for the full force/handoff state machine. #261:
    // there's no more player-manual sprint state to reclaim it, only Overclock ever sets this.
    this._sprintForcedByOverclock = false;
    this._overclockWasActive = false;
    this.dash = initialDashState();   // #261: hardcoded L3/Space burst + cooldown, see data/dash.js
    // Indirect-fire lock (#62, rework #252): `this.lock` (data/targetlock.js) is the pure state
    // record — it mirrors `this.convergeTarget` every frame, instantly, so homing/arcing weapons
    // simply fire at whatever direct-fire convergence is currently aimed at. `aimEnemy` is the live
    // most-aimed enemy; `convergeTarget` (shared.js `pickConvergeTarget`) is the ranked pick fed to
    // convergence — aimEnemy, or, #250, a fallback destructible hex, or null. Both set each frame
    // in `_updateLock` (targeting.js). `_reticlePos` is the reticle's eased (sliding) drawn position.
    this.lock = makeLock();
    this.aimEnemy = null;
    this.convergeTarget = null;
    this._reticlePos = null;
    // #262: convergence/lock's enemy-vs-destructible-terrain preference (shared.js
    // `pickConvergeTarget`'s `focusMode` param) — 'enemy' is the #250 default (an enemy always
    // wins over a hex); 'building' inverts it so the player can intentionally target terrain even
    // with an enemy in view. Toggled by R3 (pad) / F (keyboard), see update()/`_toggleFocusMode`.
    this.focusMode = 'enemy';

    // Debug toggles (#28): stop/start the enemy's movement and firing for testing.
    this.enemyMove = true;
    this.enemyFire = true;

    this.input.keyboard.on('keydown-G', () => this.toGarage());
    this.input.keyboard.on('keydown-M', () => {
      const muted = Audio.toggleMute();
      this._floatText(this.px, this.py - 30, muted ? 'MUTED' : 'SOUND ON', '#7c8794');
    });
    this.input.keyboard.on('keydown-OPEN_BRACKET', () => this._toggleAi('move'));
    this.input.keyboard.on('keydown-CLOSED_BRACKET', () => this._toggleAi('fire'));
    this.input.keyboard.on('keydown-R', () => this._resetEnemies());   // #39
    this.input.keyboard.on('keydown-N', () => this._spawnEnemyDebug()); // #39
    // #262: F toggles convergence/lock's enemy-vs-building targeting focus (see this.focusMode
    // above). Phaser's `keydown-*` events already fire once per physical press, so no separate
    // edge-detector is needed here (unlike the pad side, which polls raw button state and needs
    // PadEdges — see the R3 check in update()).
    this.input.keyboard.on('keydown-F', () => this._toggleFocusMode());

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
    // #254: the `_impactPool`/`_debrisPool` reset moved up above (before `_spawnSquad()`) — see
    // the comment there for why. Nothing left to reset in this spot.
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
  // firing, sprint, enemy AI, projectiles/beams/ground-fire), called in the original
  // order. The few lines of overlay drawing + ammo regen stay inline.
  update(_time, delta) {
    const dt = Math.min(0.05, delta / 1000);
    const intent = this.controls.read();

    // #80: the camera's world-space view rect, republished each frame so HudScene's edge-
    // direction arrow can tell whether the objective is on-screen and, if not, where to point.
    // Copied to a plain object rather than handing out the live Phaser Rectangle, so the HUD
    // reads a stable snapshot instead of an object the camera keeps mutating in place.
    const wv = this.cameras.main.worldView;
    const view = { x: wv.x, y: wv.y, width: wv.width, height: wv.height };
    this.registry.set('cameraView', view);
    // #116: live player pose + enemy positions for the HUD corner minimap. Same "publish a plain
    // snapshot each frame" pattern as cameraView above — the HUD reads these to place the player
    // marker. `angle` is the turret/aim heading (`this.turretAngle`, the same source of truth used
    // for weapon convergence/firing), not the hull's movement heading (Refs #116 playtest feedback:
    // the arrow should point where you're aiming, not where you're driving), objective (from
    // objectiveWorld), and enemy dots on the map.
    this.registry.set('playerWorld', { x: this.px, y: this.py, angle: this.turretAngle });
    const enemyPos = [];
    for (const e of this.enemies) if (!e.mech.isDestroyed()) enemyPos.push({ x: e.x, y: e.y });
    this.registry.set('enemyPositions', enemyPos);
    // #155: hide map tiles outside the camera's view (+ margin) — see world.js for why this is
    // the single biggest FPS cost in the game. Reuses this same view rect, not a second camera-
    // bounds computation.
    this._updateTileCulling(view);

    // #60: recompute the active-buff overlay once per frame; firing/movement/turret read it.
    this._refreshBuffMods();

    // #225: once the player's own mech is destroyed, it's a corpse, not a controllable husk —
    // stop reading input for movement/aim/firing the instant `_playerDead` flips true (set by
    // combat.js `_damagePlayerAt`). This is the single choke point for player control: every
    // per-frame input consumer below (sprint, drive/turret-aim, per-slot firing) is gated here
    // rather than each mixin re-checking the flag itself. `_updateRun` (run.js, still called
    // unconditionally below) is what owns the delayed return-to-garage transition; this only
    // freezes the player's own agency, not the run's bookkeeping.
    if (!this._playerDead) {
      // #188/#261: resolve Sprint (Overclock-only now) and Dash's burst/cooldown BEFORE _drive
      // so a same-frame press is reflected in this frame's speed multiplier, not delayed a frame.
      this._handleSprint(intent, delta);
      this._handleDash(intent, delta);
      this._drive(intent, dt);
    }

    // ── One-shot pad buttons (#28 AI toggles, #29 return to garage). #252: the manual R3/T
    // drop-lock action is retired — the lock has no maintained state to escape any more, it
    // simply follows convergence's live pick every frame, so there's nothing left to "drop." ──
    if (this.padEdges.pressed(PAD.SELECT) || this.padEdges.pressed(PAD.B)) this.toGarage();
    if (this.padEdges.pressed(PAD.DPAD_UP)) this._spawnEnemyDebug();    // ↑ add enemy (#39)
    if (this.padEdges.pressed(PAD.DPAD_DOWN)) this._resetEnemies();     // ↓ reset enemies (#39)
    if (this.padEdges.pressed(PAD.DPAD_LEFT)) this._toggleAi('move');   // ← toggle move (#28)
    if (this.padEdges.pressed(PAD.DPAD_RIGHT)) this._toggleAi('fire');  // → toggle fire (#28)
    // #262: R3 toggles convergence/lock's enemy-vs-building targeting focus (keyboard equivalent:
    // F, wired via a keydown listener in create()). R3 was freed up by #252, which removed the
    // old manual drop-lock action entirely — nothing else reads it.
    if (this.padEdges.pressed(PAD.R3)) this._toggleFocusMode();

    // ── Indirect-fire lock (#62, rework #252): mirrors direct-fire convergence's live pick
    // instantly (no charge-up, no maintain timer) — blind fire onto the target's last-known/
    // predicted position when convergence is aimed at a currently-hidden enemy. Homing/arcing
    // weapons seek it; direct weapons converge on the same live pick directly. ──
    this._updateLock(dt);
    // #260: live lock-target world position (or null), republished each frame so HudScene can
    // draw a matching off-screen arrow for the CURRENT lock target — same channel pattern as
    // `objectiveWorld` above. Reuses `_lockAimPoint()` (targeting.js), the same query the
    // homing/reticle code already reads, so the arrow can never disagree with what's actually
    // locked (hides itself the instant the target dies or there's no lock, same as that query).
    const lockPt = this._lockAimPoint();
    this.registry.set('lockWorld', lockPt ? { x: lockPt.x, y: lockPt.y } : null);
    this._stepGait(dt);
    if (!this._playerDead) this._handleFiring(intent, delta);
    this._updateEnemies(dt, delta);
    // #269 §5: tick every standing alert tower's wake-countdown sensor.
    this._updateAlertTowers(dt);
    // #269 §3 "rare multi-spawn exception": tick every dock's occasional-resupply cooldown.
    this._updateDockResupply(dt);

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

    // #136: subtle facing line (shared wayfinding highlight colour) — always drawn (no lock
    // needed) so the mouse/stick-vs-turret slew gap is visible at a glance. Drawn before the
    // lock reticle, same graphics layer.
    this._drawAimLine();

    // Lock reticle (#62, rework #252), drawn after projFx is cleared above so it isn't wiped, at
    // `_reticlePos` — the position eased toward the live aim point, so switching convergence
    // targets reads as a slide rather than a jump cut (`_updateLock`, targeting.js). Playtest
    // follow-up (#252): indirect fire now always tracks the live target through cover, so there's
    // no more distinct "firing blind" state/colour — always drawn "locked."
    if (this._reticlePos) {
      this._drawLockReticle(this._reticlePos.x, this._reticlePos.y);
    }

    // ── Ammo regen ── every magazine tops back up over time at its own base rate. (#187:
    // Surge, which used to multiply this rate, was removed as redundant with Overcharge.)
    this.mech.regenAmmo(dt);
    // #246: passive shield regen (with its brief post-hit pause) + counting down any active
    // Shield-powerup boost — see Mech.tickShield/boostShield (data/Mech.js).
    this.mech.tickShield(dt);
  }

  // #216: the sound cue lives HERE, not in any of the call sites, because this is the one
  // method every return-to-garage path funnels through — the run-over transition (run.js's
  // RUN_OVER_DELAY delayedCall), the G key, and the Select/B pad buttons. Firing it from a
  // wrapper around toGarage() (as #210 originally did) missed the two manual early-exit paths
  // entirely, since they call toGarage() directly.
  toGarage() {
    Audio.ui('returnToGarage');
    this.scene.stop('HudScene');
    this.scene.start('GarageScene');
  }

  // #262: flip convergence/lock's enemy-vs-building targeting preference (see `this.focusMode`
  // above, and shared.js `pickConvergeTarget`'s `focusMode` param). A toggle, not a hold — one
  // press/press-equivalent flips it, fired from both the R3 pad edge (update()) and the F keydown
  // listener (create()). Floating text mirrors the M mute toggle's feedback pattern.
  _toggleFocusMode() {
    this.focusMode = this.focusMode === 'enemy' ? 'building' : 'enemy';
    const label = this.focusMode === 'building' ? 'FOCUS: BUILDING' : 'FOCUS: ENEMY';
    this._floatText(this.px, this.py - 30, label, '#7c8794');
  }
}

// The scene's behaviour is split into per-concern mixins under ./arena/; each is a plain
// object of methods using `this`, composed onto the prototype here. Adding a concern = a new
// mixin file + one entry in this list (the scene stays a thin orchestrator).
Object.assign(
  ArenaScene.prototype,
  WorldMixin, LocomotionMixin, TargetingMixin, FiringMixin, ProjectilesMixin, EnemiesMixin, CombatMixin, PowerupsMixin, MissionMixin, RunMixin, SalvageMixin, BasesMixin,
);
