import Phaser from 'phaser';
import { WEAPON_IDS } from '../data/weapons.js';
import { Mech } from '../data/Mech.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs } from '../data/save.js';
import { MECH_DEPLOYED } from '../data/events.js';
import { buildTabBar, TAB_BAR_H } from '../ui/tabBar.js';
import { WeaponCardList } from '../ui/weaponCardList.js';

// ── Weapon Lab tab ───────────────────────────────────────────────────────────
// A full catalog of every weapon, each card auto-firing a live shot/beam preview. It's
// now a thin host around the shared WeaponCardList component (ui/weaponCardList.js) — the
// SAME list the garage embeds in its catalog, so the two can never diverge. Reached from
// the tab bar or by booting with ?lab.
const UI = { bg: '#0d1014' };
const MARGIN = 20;

export default class WeaponLabScene extends Phaser.Scene {
  constructor() {
    super('WeaponLabScene');
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
    const canDeploy = mech instanceof Mech ? mech.isComplete() : false;
    buildTabBar(this, { active: 'WeaponLabScene', canDeploy, onDeploy: () => this._deploy() });

    this.list = new WeaponCardList(this, { ...this._region(), ids: WEAPON_IDS });

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('GarageScene'));
    this.scale.on('resize', this._relayout, this);
    this.events.once('shutdown', () => { this.scale.off('resize', this._relayout, this); this.list.destroy(); });
  }

  _region() {
    this.W = Math.round(this.scale.width / (this.registry.get('dpr') || 1));
    this.H = Math.round(this.scale.height / (this.registry.get('dpr') || 1));
    const top = TAB_BAR_H + 12;
    return { x: MARGIN, y: top, w: this.W - MARGIN * 2, h: this.H - top - 8 };
  }

  _relayout() {
    const r = this._region();
    this.list.setRegion(r.x, r.y, r.w, r.h);
  }

  update(time, delta) {
    this.list.update(time, delta);
  }

  _deploy() {
    const mech = this.allMechs?.[ACTIVE_MECH_KEY];
    if (mech) { mech.repairAll(); saveAllMechs(this.allMechs); }
    this.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
    this.scene.start('ArenaScene');
  }
}
