import Phaser from 'phaser';
import { buildHexTextures } from '../art/hexArt.js';
import { buildMechTextures } from '../art/index.js';
import { playerMechArt } from '../art/playerMechLook.js';
import { mechColorFor } from '../data/mechColors.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { hexToPixel } from '../data/hexgrid.js';
import { Controls } from '../input/Controls.js';
import { LocomotionMixin } from './arena/locomotion.js';
import { BaseWorldMixin } from './base/world.js';
import { BaseLocomotionMixin } from './base/locomotion.js';
import { BASE_TRIGGERS } from './base/layout.js';
import { quickDeploy } from './base/quickDeploy.js';

// #509 Stage 1: the central base — a small, physical hex space the player walks their mech
// around, replacing GarageScene as the game's entry point. Different hexes trigger different
// actions (see base/layout.js): the customization hex opens GarageScene, the scanner hex is a
// placeholder deploy straight into ArenaScene until #510 (Stage 2) adds a real mission-select
// surface. Deliberately minimal — this proves the walk-around-and-trigger-a-hex mechanism
// works; it is not the full base experience (#511/#512/#513/#514 build outward from here).
//
// Movement reuses the arena's `_blockedAlongSegment`-swept collision approach via
// base/world.js and a TRIMMED copy of its drive/gait (base/locomotion.js) — but the mech
// VIEW itself (`_makeMechView`) and the shared gait helpers (`_syncTilts`/`_syncPivots`/
// `_footImpactFx`/`_footShake`) are reused directly from LocomotionMixin: none of those five
// have any combat/weapon coupling, so there is nothing to trim.
const { _makeMechView, _syncTilts, _syncPivots, _footImpactFx, _footShake } = LocomotionMixin;

export default class BaseScene extends Phaser.Scene {
  constructor() {
    super('BaseScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setBackgroundColor('#171f18');
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
      mech, textureKey,
      x: spawn.x, y: spawn.y, vx: 0, vy: 0,
      angle: -Math.PI / 2, turretAngle: -Math.PI / 2,
      speed: 0, stepMs: 0, hullFrame: 0,
    };
    this.player.view = this._makeMechView(textureKey, this.player.x, this.player.y, this.player.angle, true);
    // #455: roundPixels=false explicitly — startFollow's 2nd arg assigns straight onto the
    // camera and would otherwise re-introduce the per-part pixel-snap jitter (see locomotion.js
    // ARENA_MECH_SCALE / the #455 comment in main.js for the full story).
    this.cameras.main.startFollow(this.player.view, false, 0.12, 0.12);

    this.controls = new Controls(this, { padIndex: 0, keyboard: true });
    this._lastTriggerHex = null;

    this.input.keyboard.on('keydown-G', () => this.scene.start('GarageScene'));
  }

  update(_time, delta) {
    const dt = Math.min(0.05, delta / 1000);
    const intent = this.controls.read();
    this._driveBase(intent, dt);
    this._stepGaitBase(dt);
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
    else if (action === 'scanner') quickDeploy(this);
  }
}

Object.assign(BaseScene.prototype, BaseWorldMixin, BaseLocomotionMixin, {
  _makeMechView, _syncTilts, _syncPivots, _footImpactFx, _footShake,
});
