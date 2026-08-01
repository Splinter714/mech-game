import Phaser from 'phaser';
import { buildHexTextures } from '../art/hexArt.js';
import { buildMechTextures } from '../art/index.js';
import { playerMechArt } from '../art/playerMechLook.js';
import { mechColorFor } from '../data/mechColors.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { hexToPixel } from '../data/hexgrid.js';
import { Controls } from '../input/Controls.js';
import { OUTPOSTS_KEY } from '../data/events.js';
import { outpostsByType } from '../data/outposts.js';
import { LocomotionMixin } from './arena/locomotion.js';
import { FiringMixin } from './arena/firing.js';
import { ProjectilesMixin } from './arena/projectiles.js';
import { AmmoIndicatorsMixin } from './arena/ammoIndicators.js';
import { CombatMixin } from './arena/combat.js';
import { TargetingMixin } from './arena/targeting.js';
import { PowerupsMixin } from './arena/powerups.js';
import { GAMEPLAY_ZOOM } from './arena/shared.js';
import { BaseWorldMixin } from './base/world.js';
import { BaseLocomotionMixin } from './base/locomotion.js';
import { BaseFiringSeams, createBaseFiringState, updateBaseFiring } from './base/firing.js';
import { BASE_TRIGGERS } from './base/layout.js';
import { wirePauseMenu } from './PauseMenuScene.js';

// #509/#510: the central base — a small, physical hex space the player walks their mech
// around, replacing GarageScene as the game's entry point. Different hexes trigger different
// actions (see base/layout.js): the customization hex opens GarageScene, the scanner hex opens
// MissionSelectScene. Deliberately minimal — this proves the walk-around-and-trigger-a-hex
// mechanism works; it is not the full base experience (#511/#512/#513/#514 build outward from
// here).
//
// Movement reuses the arena's `_blockedAlongSegment`-swept collision approach via
// base/world.js and a TRIMMED copy of its drive/gait (base/locomotion.js) — but the mech
// VIEW itself (`_makeMechView`) and the shared gait helpers (`_syncTilts`/`_syncPivots`/
// `_footImpactFx`/`_footShake`/`_shakeCamera`) are reused directly from LocomotionMixin: none
// of those six have any combat/weapon coupling, so there is nothing to trim. `_shakeCamera` is
// `_footShake`'s own camera-jolt helper (#564) — omitting it here threw "this._shakeCamera is
// not a function" on BaseScene's first footstep, the same failure class as the #522 fix noted
// below for `_movementFor`.
// #597 adds two more: `_muzzle` (where a weapon's round actually leaves the mech) and
// `_partTilt` (how far an arm/shoulder cants toward its weapon's convergence) — both are pure
// geometry off the live loadout, and both are now load-bearing because the base fires for real.
const {
  _makeMechView, _syncTilts, _syncPivots, _footImpactFx, _footShake, _shakeCamera,
  _muzzle, _partTilt,
} = LocomotionMixin;

// #597, part 3 — FIRING WITH FULL ARENA RULES. The trigger→shot chain is the arena's own, not a
// copy: `FiringMixin` (cadence, ammo, charge/release, hitscan + melee + wave), `ProjectilesMixin`
// (in-flight rounds, beams, hazards, burning ground) and `AmmoIndicatorsMixin` (#595's per-slot
// muzzle-glow readiness glow — the base's ONLY ammo/cooldown readout, since there's no HudScene
// over this scene). See base/firing.js for the world seams those need and for what was
// deliberately left out.
//
// From the two arena mixins that are mostly NOT wanted here, only the pieces with no arena-only
// state are cherry-picked, same pattern as LocomotionMixin above:
//   • CombatMixin → the impact-FX half (`_impactFx` + its pooled burst primitives). Its damage
//     half (`_damagePlayerAt`/`_damageEnemyAt`/`_killEnemy`/salvage/powerup drops/run stats) is
//     left out entirely — nothing in the base can be damaged.
//   • TargetingMixin → `_fireAngle` + `_lockAimPoint`, the two the fire path itself calls; the
//     lock/reticle machinery that WOULD set a target (`_updateLock`, the aim line, the
//     destructible-target pool) is left out, since there is nothing here to lock onto. With
//     `player.convergeTarget` therefore never set, direct-fire weapons converge at the default
//     distance and homing weapons simply don't fire — which is exactly what the arena does when
//     nothing is locked, not a base-specific rule.
//   • PowerupsMixin → the shield-shell pair (#597, part 2). The LIVE arena drive, not the
//     garage's showroom steady-state: the base mech is a real Mech with a real shield pool, so
//     the shell should be driven by that pool (fading with its fraction, early-exiting when
//     empty) rather than force-shown at full the way a static showroom preview has to.
const { _impactFx, _burst, _acquireImpactCircle, _freeImpactCircle } = CombatMixin;
const { _fireAngle, _lockAimPoint } = TargetingMixin;
const { _ensureShieldVisualFor, _updateShieldVisual } = PowerupsMixin;

export default class BaseScene extends Phaser.Scene {
  constructor() {
    super('BaseScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    // #597, part 1: the base framed the world at bare `dpr` while the arena layered
    // GAMEPLAY_ZOOM (1.3) on top, so walking out of a sortie visibly zoomed the camera back out
    // and the base read as a different, roomier space than the game it leads into. Set as an
    // instance property for the same reason ArenaScene does (#149): main.js's resize handler
    // re-derives `dpr * (s.zoomFactor || 1)` per scene, so this follows a window resize for free
    // instead of being stomped back to bare dpr.
    this.zoomFactor = GAMEPLAY_ZOOM;
    this.cameras.main.setZoom(dpr * this.zoomFactor);
    this.cameras.main.setBackgroundColor('#232629');   // dark concrete, matches the baseYard floor
    this.cameras.main.fadeIn(400, 13, 16, 20);

    buildHexTextures(this);
    this._buildBaseWorld();

    this.allMechs = this.registry.get('allMechs');
    const mech = this.allMechs[ACTIVE_MECH_KEY];
    mech.repairAll();

    const textureKey = 'baseMech';
    buildMechTextures(this, textureKey, mech, playerMechArt(0, { accent: mechColorFor(mech, 0) }));
    const spawn = hexToPixel(0, 0);
    this.player = {
      // #597: `id` is the same player-0 identity `playerMechArt(0, …)` above already assumes —
      // now declared, because the composed arena code keys per-player audio/beam state off it.
      id: 0,
      mech, textureKey,
      x: spawn.x, y: spawn.y, vx: 0, vy: 0,
      angle: -Math.PI / 2, turretAngle: -Math.PI / 2,
      speed: 0, stepMs: 0, hullFrame: 0,
      // #597: the per-player firing state the arena's FiringMixin owns — per-slot cycle
      // cooldowns, per-slot charge accumulators, which slots are actively firing (read by #595's
      // muzzle-glow readout), and the held-loop bookkeeping for continuous weapons. The mixin
      // lazily `??=`s all four, but seeding them here keeps the player object's real shape honest.
      fireCooldowns: {}, chargeState: {}, firingNow: {}, heldAudio: {},
      // The base mounts no abilities, but `isPlayerStealthed` (called on every trigger pull to
      // decide whether the shot makes noise) indexes this map whenever a Cloak ability IS mounted
      // on the saved build — an absent map would throw there rather than answering "not cloaked".
      abilityStates: {},
    };
    this.player.view = this._makeMechView(textureKey, this.player.x, this.player.y, this.player.angle, true);
    // #347's players collection. The base has exactly one player and no co-op join, but the
    // composed arena mixins ask their player questions through `playersOf(scene)` — giving them
    // the real collection is what lets them run here unmodified.
    this.players = [this.player];
    // #597, part 2: the shield shell, built once behind the mech (the same baked/dilated shell
    // the arena and the garage preview both use) and then driven live from the mech's own pool
    // each frame in update().
    this._ensureShieldVisualFor(this.player);
    createBaseFiringState(this);
    // #455: roundPixels=false explicitly — startFollow's 2nd arg assigns straight onto the
    // camera and would otherwise re-introduce the per-part pixel-snap jitter (see locomotion.js
    // ARENA_MECH_SCALE / the #455 comment in main.js for the full story).
    this.cameras.main.startFollow(this.player.view, false, 0.12, 0.12);

    this.controls = new Controls(this, { padIndex: 0, keyboard: true });
    this._lastTriggerHex = null;

    this.input.keyboard.on('keydown-G', () => this.scene.start('GarageScene'));
    // #523: the shared pause menu. BaseScene has one player and no overlay scene to pause
    // alongside it.
    wirePauseMenu(this, { getPlayers: () => [this.player] });

    this._buildOutpostReadout();
  }

  // #511/#512: a plain readout of what's held so far — screen-fixed (setScrollFactor(0)), not
  // world-space, since it's base-wide status rather than a marker tied to any one hex. No UI to
  // manage/upgrade outposts yet (that's later work); this just makes claiming visible.
  _buildOutpostReadout() {
    const outposts = this.registry.get(OUTPOSTS_KEY) ?? [];
    const resourceCount = outpostsByType(outposts, 'resource').length;
    const repairCount = outpostsByType(outposts, 'repair').length;
    this.add.text(16, 16, `OUTPOSTS HELD — RESOURCE ${resourceCount}  REPAIR ${repairCount}`, {
      fontFamily: 'monospace', fontSize: '13px', color: '#c8d2dd',
    }).setScrollFactor(0);
  }

  update(_time, delta) {
    const dt = Math.min(0.05, delta / 1000);
    const intent = this.controls.read();
    this._driveBase(intent, dt);
    this._stepGaitBase(dt);
    // #597: firing runs AFTER the gait, matching ArenaScene.update()'s order — `_muzzle` reads
    // the part tilts `_stepGaitBase` just eased, so a shot leaves the barrel where it is actually
    // drawn this frame rather than where it was last frame.
    updateBaseFiring(this, intent, delta, dt);
    this._updateShieldVisual(delta);
    this._checkTriggers();
  }

  // Dispatch on the hex the player is CURRENTLY standing on, once per hex entered (not every
  // frame while standing still) — same shape as the arena's own bespoke per-frame hex checks
  // (dock open/close, mission objective), since the codebase has no generic on-enter registry.
  _checkTriggers() {
    const key = this._hexKeyAt(this.player.x, this.player.y);
    if (key === this._lastTriggerHex) return;
    this._lastTriggerHex = key;
    const action = BASE_TRIGGERS.get(key);
    if (action === 'customization') this.scene.start('GarageScene');
    else if (action === 'scanner') this.scene.start('MissionSelectScene');
  }
}

// Order matters in exactly one place: `BaseFiringSeams` is assigned LAST so its terrain-only
// answers (`_wallDistance`/`_isWallForRound`/`_muzzleWallBlocked`) and its no-op damage sinks
// win over anything of the same name the arena mixins carry. Everything else here is disjoint.
Object.assign(BaseScene.prototype,
  BaseWorldMixin, BaseLocomotionMixin,
  FiringMixin, ProjectilesMixin, AmmoIndicatorsMixin,
  {
    _makeMechView, _syncTilts, _syncPivots, _footImpactFx, _footShake, _shakeCamera,
    _muzzle, _partTilt,
    _impactFx, _burst, _acquireImpactCircle, _freeImpactCircle,
    _fireAngle, _lockAimPoint,
    _ensureShieldVisualFor, _updateShieldVisual,
  },
  BaseFiringSeams,
);
