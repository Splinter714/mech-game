import Phaser from 'phaser';
import { buildTabBar, TAB_BAR_H } from '../ui/tabBar.js';
import { Mech } from '../data/Mech.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs } from '../data/save.js';
import { MECH_DEPLOYED } from '../data/events.js';

// Music tab — a full-screen home for the soundtrack tuning UI (#2). Scaffolded here with the
// shared tab bar; the section columns are built out in a later stage. Until then the existing
// DOM tuning panel (toggle `P`) still drives the music, so nothing is lost.
const UI = { bg: '#0d1014', text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0' };

export default class MusicScene extends Phaser.Scene {
  constructor() {
    super('MusicScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);
    this.cameras.main.setBackgroundColor(UI.bg);

    this.allMechs = this.registry.get('allMechs');
    const mech = this.allMechs?.[ACTIVE_MECH_KEY];
    const canDeploy = mech instanceof Mech ? mech.validate().ok : false;
    buildTabBar(this, { active: 'MusicScene', canDeploy, onDeploy: () => this._deploy() });

    this.add.text(this.W / 2, TAB_BAR_H + (this.H - TAB_BAR_H) / 2, 'MUSIC\n\nfull-screen tuning coming here\n(press P for the current panel)', {
      fontFamily: 'monospace', fontSize: '15px', color: UI.dim, align: 'center', lineSpacing: 6,
    }).setOrigin(0.5);
  }

  _deploy() {
    const mech = this.allMechs?.[ACTIVE_MECH_KEY];
    if (mech) { mech.repairAll(); saveAllMechs(this.allMechs); }
    this.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
    this.scene.start('ArenaScene');
  }
}
