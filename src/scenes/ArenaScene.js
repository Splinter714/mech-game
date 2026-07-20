import Phaser from 'phaser';
import { buildMechTextures } from '../art/index.js';
import { buildHexTextures } from '../art/hexArt.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { range } from '../data/hexgrid.js';
import { Controls, PadEdges, PAD } from '../input/Controls.js';
import { TouchStickHud } from '../input/TouchStickHud.js';
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
import { TerrainLabelsMixin } from './arena/terrainLabels.js';
import { VisibilityMixin } from './arena/visibility.js';
import { DEPTH, GAMEPLAY_ZOOM } from './arena/shared.js';

// #246: the player's native full-mech shield baseline — a real trait present from the start of
// every sortie, not something that only exists once a Shield powerup is picked up (most enemy
// mechs get NONE at all — see data/enemies.js/enemyKinds.js for which enemy kinds opt in).
// `max`/`regenPerSec` are deliberately modest (a slow trickle, not a second health bar) so it
// reads as "a little breathing room" rather than eclipsing armor/hp as the real defense layer;
// the Shield POWERUP (data/powerups.js) is what makes the shield feel powerful for a while.
// `pauseMs` is the brief (not shooter-style multi-second) regen interrupt on any hit that
// reaches the shield, per the #246 decision.
// #299: `max` raised 50 -> 100 as part of the owner-set balance table. (#324: the armor/structure
// half of that table was being multiplied by 7 at deploy and now reads honestly as 2100/1400 in
// chassis/mediumPlayer.js — the shield is separate, unaffected, and stays 100.)
// Regen behaviour deliberately unchanged (2/sec, 1200ms pause):
// the pool got bigger, the trickle did not, so it still reads as breathing room rather than a
// second health bar — it just now takes 50s rather than 25s to refill from empty.
const PLAYER_SHIELD = { max: 100, regenPerSec: 2, pauseMs: 1200 };

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
    // Refs #281: reset the player-corpse flag fresh every deploy. Phaser reuses the SAME
    // ArenaScene instance across scene.start('ArenaScene') calls, so a `this.*` property set by
    // a previous sortie (here, combat.js `_damagePlayerAt` flipping this true on death) survives
    // into the next one unless explicitly reset here — same "reset per-deploy scene state in
    // create()" pattern as `_initRun`/`_initMission` above. Without this, the first death of a
    // session permanently disabled movement/firing (update()'s `!this._playerDead` gate) on
    // every subsequent deploy, with no way to recover short of reloading the page.
    this._playerDead = false;
    // Refs #304: same reason, for the enemy-side stand-down clock stamped off that flag
    // (enemies.js `_standDownActive`). Without this reset a redeploy after a death would find
    // an already-elapsed deadline still sitting on the reused scene instance and every enemy
    // would spawn permanently disengaged — the enemy-side twin of #281's bug.
    this._standDownAt = null;

    // Player mech (repaired fresh for the sortie).
    this.allMechs = this.registry.get('allMechs');
    this.mech = this.allMechs[ACTIVE_MECH_KEY];
    this.mech.repairAll();
    // #324: the player's survivability buffer used to be applied HERE as `boostHealth(7)`, which
    // meant the chassis data said 600 while the mech on the field was 3500 — and several balance
    // passes were reasoned against the wrong figure. It now lives in the chassis totals
    // (data/chassis/mediumPlayer.js: 2100 armor + 1400 hp = the same 3500). repairAll() above is
    // all the deploy path needs.
    // #246: (re)establish the player's native shield baseline fresh each sortie — redeploy-safe
    // and idempotent (never compounds, always starts this deploy at full charge with no
    // lingering powerup boost from a prior run).
    this.mech.configureShield(PLAYER_SHIELD);
    this.registry.set('playerMech', this.mech);
    buildMechTextures(this, 'playerMech', this.mech);

    // #76 concentrated-fire hit-feedback state — reset per run so a fresh arena never reuses a
    // stale (destroyed) impact-circle pool or a last-burst/sound timestamp from a prior fight.
    // #254: moved here (was previously reset much later in create(), after `_spawnSquad()`
    // below) — a spawn-time FX flourish (called from `_spawnKind` for every gunship in the
    // opening squad, #251-era; the helipad terrain that flourish was themed around has since
    // been removed, #275) calls `_burst`/`_acquireImpactCircle` DURING `_spawnSquad()`,
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
    // #269 (spawn rear-pad fix): spawn at the spine's own rear-pad starting point
    // (`this._spawnPoint`, set by `_buildWorld()` above from `spineSpawnHex`) instead of world
    // origin — real corridor terrain is already carved back to there, so the player now walks
    // FORWARD through that stretch instead of it sitting unused behind them.
    this.px = this._spawnPoint.x; this.py = this._spawnPoint.y;
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
    // #269/#270 playtest follow-up (hex legibility), dev-only: both hex-labelling systems —
    // bases.js's persistent red text tags over every dock/alertTower/objective hex, and
    // terrainLabels.js's camera-culled/pooled labels for every OTHER hex's real terrain id — were
    // always meant as a playtest legibility aid, never a shipped HUD feature, so they're gated to
    // `npm run dev` and never run in a production build. `import.meta.env.DEV` is Vite's
    // build-time flag (stripped to `false`/dead-code-eliminated in `npm run build`; see
    // GarageScene.js's own `import.meta.env.DEV` use for the same pattern). The underlying
    // methods (`_spawnHexLabels`, `_initTerrainLabels`, `_updateTerrainLabels` below) stay
    // directly callable/testable — only this ArenaScene auto-invocation is gated.
    // #270 playtest follow-up: also a live L keybind (dev-only, see below) to hide/show both
    // systems at once without restarting — on by default (matches the old always-on-in-dev
    // behavior), `_hexLabelsVisible` is the single source of truth both systems read.
    this._hexLabelsVisible = true;
    if (import.meta.env.DEV) {
      this._spawnHexLabels();
      this._initTerrainLabels();
    }

    this.controls = new Controls(this);
    // #346: screen-space overlay for the on-screen sticks. Only created on a touch-capable
    // device, and it draws nothing until a finger actually lands — desktop sees no change.
    this.touchStickHud = this.controls.touch ? new TouchStickHud(this) : null;
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
    // THE target (#62, rework #252, unified #341): `convergeTarget` (shared.js `pickConvergeTarget`
    // — #322: the nearest in-cone candidate of any kind, enemy/hex/wall span, or null) is the single
    // source of truth. Direct fire converges on it, homing/arcing weapons seek it, the reticle draws
    // at it — there is no separate lock record mirroring it any more. `aimEnemy` is that same pick
    // when it's a live enemy. Both set each frame in `_updateLock` (targeting.js). `_reticlePos` is
    // the reticle's eased (sliding) drawn position — presentation only.
    this.aimEnemy = null;
    this.convergeTarget = null;
    this._reticlePos = null;
    // #322 removed #262's enemy-vs-building focus toggle entirely (Jackson: "we don't want to need
    // enemy vs terrain mode anymore"). One rule now scores both pools, so there is nothing to flip;
    // F and R3 are unbound.

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
    // #270 playtest follow-up: L toggles both hex-label systems on/off live — dev-only, same as
    // the systems themselves (see `_hexLabelsVisible` init above and `_toggleHexLabels` below).
    if (import.meta.env.DEV) {
      this.input.keyboard.on('keydown-L', () => this._toggleHexLabels());
    }
    // #99: explicit depths (DEPTH.* — shared.js) instead of relying on scene add-order, which
    // is what let napalm's burning-ground decal (drawn into `projFx`, below) paint over the
    // player/enemy views created earlier in create(). `groundFx` is its own low, ground-hugging
    // layer so a ground decal can never out-rank a unit no matter what else gets added later.
    // #337: the REGION FOG OF WAR overlay, plus the lit set that targeting gates on (this replaced
    // #306's per-frame raycast dimming). Called here — before the unit views, and after
    // `_buildWorld()` has populated `this.bases`, which the region map is built from — so the
    // overlay's Graphics exists for the first `_updateVisibility` tick. Its DEPTH.LOS_DIM (2.9)
    // tier is what puts the fog under the player/flyers and over everything on the ground.
    this._initVisibility();
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
    this.touchStickHud?.draw(this.controls.touch);   // #346, presentation only

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
    // #306: refresh the line-of-sight dimming. Reuses the SAME view rect; internally gated so the
    // field-of-view pass and overlay redraw only happen when the player crosses a hex boundary or
    // terrain collapses — see arena/visibility.js for the cost reasoning.
    this._updateVisibility(view);
    // #270: general terrain-id hex labels — same view rect, own coarse recompute cadence (see
    // terrainLabels.js for the interval/margin reasoning). Dev-only, see the `_initTerrainLabels`
    // gate in create() above — `this._terrainLabelPool` only exists when that ran.
    if (import.meta.env.DEV) this._updateTerrainLabels(view, dt);

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
    // ── Indirect-fire lock (#62, rework #252): mirrors direct-fire convergence's live pick
    // instantly (no charge-up, no maintain timer) — blind fire onto the target's last-known/
    // predicted position when convergence is aimed at a currently-hidden enemy. Homing/arcing
    // weapons seek it; direct weapons converge on the same live pick directly. ──
    this._updateLock(dt);
    // #260: live target's world position (or null), republished each frame so HudScene can
    // draw a matching off-screen arrow for the CURRENT target — same channel pattern as
    // `objectiveWorld` above. Reuses `_lockAimPoint()` (targeting.js), the same query the
    // homing/reticle code already reads, so the arrow can never disagree with what's actually
    // targeted (hides itself the instant the target dies or there's no target, same as that query).
    const lockPt = this._lockAimPoint();
    this.registry.set('lockWorld', lockPt ? { x: lockPt.x, y: lockPt.y } : null);
    this._stepGait(dt);
    if (!this._playerDead) this._handleFiring(intent, delta);
    this._updateEnemies(dt, delta);
    // #269 §5: tick every standing alert tower's wake-countdown sensor.
    this._updateAlertTowers(dt);
    // #269 §3 "rare multi-spawn exception": tick every dock's occasional-resupply cooldown.
    this._updateDockResupply(dt);
    // #269 Part 2 ("dock open/closed states"): detect a dock hex being vacated (its own units
    // walked away or died) and seal it — see bases.js `_updateDockOpenClose` for the state
    // machine (open ⇄ closed ⇄ reopened-for-resupply).
    this._updateDockOpenClose();
    // #309: tick each base's wall GATES — a woken base cracks its sally ports open a beat after
    // the alarm, holds them open long enough for its garrison to pour out, then shuts them again.
    this._updateGates(dt);

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

    // Target reticle (#62, rework #252, #341), drawn after projFx is cleared above so it isn't wiped, at
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
    // Refs #281: unconditionally clear the run-over banner and cancel any still-pending
    // RUN_OVER_DELAY auto-return timer (run.js `_endRun`) — this is the single funnel every
    // return-to-garage path goes through (see the comment above), so it's the right place to
    // guarantee both regardless of WHY the player is leaving. Previously the banner was only
    // cleared inside that delayed callback, so a manual return (G key / Select-B) before the
    // 3.2s timer fired left the stale banner in the registry and it re-displayed instantly on
    // the next deploy; leaving the timer alive also meant it could fire later — after a new run
    // had already started — and clobber that fresh state with a second, unwanted toGarage() call.
    this._runOverTimer?.remove(false);
    this._runOverTimer = null;
    this.registry.set('runOverBanner', null);
    Audio.ui('returnToGarage');
    this.scene.stop('HudScene');
    this.scene.start('GarageScene');
  }

  // #270 playtest follow-up: live on/off toggle for both hex-label systems (bases.js's
  // dock/alertTower/objective tags + terrainLabels.js's per-terrain pool), bound to L
  // (dev-only, see create()). `_hexLabelsVisible` is the single flag both systems read: bases.js
  // stamps it onto every label as it's created (`_addHexLabel`) and terrainLabels.js does the
  // same for every newly pooled label (`_updateTerrainLabels`) — so a hex that enters view AFTER
  // a toggle still comes in hidden/shown correctly. This method just flips the flag and re-applies
  // it to whatever's alive right now.
  _toggleHexLabels() {
    this._hexLabelsVisible = !this._hexLabelsVisible;
    for (const label of this._hexLabels ?? []) label.setVisible(this._hexLabelsVisible);
    for (const label of this._terrainLabelPool?.values() ?? []) label.setVisible(this._hexLabelsVisible);
    this._floatText(this.px, this.py - 30, this._hexLabelsVisible ? 'HEX LABELS: ON' : 'HEX LABELS: OFF', '#7c8794');
  }
}

// The scene's behaviour is split into per-concern mixins under ./arena/; each is a plain
// object of methods using `this`, composed onto the prototype here. Adding a concern = a new
// mixin file + one entry in this list (the scene stays a thin orchestrator).
Object.assign(
  ArenaScene.prototype,
  WorldMixin, LocomotionMixin, VisibilityMixin, TargetingMixin, FiringMixin, ProjectilesMixin, EnemiesMixin, CombatMixin, PowerupsMixin, MissionMixin, RunMixin, SalvageMixin, BasesMixin, TerrainLabelsMixin,
);
