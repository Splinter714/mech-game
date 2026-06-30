import Phaser from 'phaser';
import { WEAPON_IDS } from '../data/weapons.js';
import { Mech } from '../data/Mech.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs } from '../data/save.js';
import { MECH_DEPLOYED } from '../data/events.js';
import { buildTabBar, TAB_BAR_H } from '../ui/tabBar.js';
import { WeaponCardList } from '../ui/weaponCardList.js';
import { WeaponSfxPanel } from '../ui/weaponSfxPanel.js';
import { Slider } from '../ui/slider.js';

// ── Weapon Lab tab ───────────────────────────────────────────────────────────
// A full catalog of every weapon, each card auto-firing a live shot/beam preview. It's
// now a thin host around the shared WeaponCardList component (ui/weaponCardList.js) — the
// SAME list the garage embeds in its catalog, so the two can never diverge. Reached from
// the tab bar or by booting with ?lab. Selecting a card also opens the sound panel
// (ui/weaponSfxPanel.js) on the right, so picking a weapon doubles as "tune its SFX."
const UI = { bg: '#0d1014', edge: 0x2a333f };
const MARGIN = 20;
const PANEL_W = 300;
const PANEL_GAP = 14;

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

    Slider.attachDrag(this);
    this.selectedId = null;
    const r = this._region();
    this.list = new WeaponCardList(this, { ...r.list, ids: WEAPON_IDS, onSelect: (id) => this._select(id), selectedId: this.selectedId });
    this.panel = new WeaponSfxPanel(this, r.panel);
    this.panelEdge = this.add.rectangle(r.panel.x - PANEL_GAP / 2, r.panel.y, 1, r.panel.h, UI.edge).setOrigin(0.5, 0);

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('GarageScene'));
    this.scale.on('resize', this._relayout, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this._relayout, this);
      this.list.destroy();
      this.panel.destroy();
    });
  }

  // Selecting a card both highlights it and opens its sound panel — every id in this
  // scene's list is a weapon (ids: WEAPON_IDS), so the selected id IS the panel's weapon.
  _select(id) {
    this.selectedId = id;
    this.list.setSelected(id);
    this.panel.setWeapon(id);
  }

  _region() {
    this.W = Math.round(this.scale.width / (this.registry.get('dpr') || 1));
    this.H = Math.round(this.scale.height / (this.registry.get('dpr') || 1));
    const top = TAB_BAR_H + 12;
    const listW = Math.max(280, this.W - MARGIN * 2 - PANEL_W - PANEL_GAP);
    return {
      list: { x: MARGIN, y: top, w: listW, h: this.H - top - 8 },
      panel: { x: MARGIN + listW + PANEL_GAP, y: top, w: PANEL_W - PANEL_GAP, h: this.H - top - 8 },
    };
  }

  _relayout() {
    const r = this._region();
    this.list.setRegion(r.list.x, r.list.y, r.list.w, r.list.h);
    this.panel.setRegion(r.panel.x, r.panel.y, r.panel.w, r.panel.h);
    this.panelEdge.setPosition(r.panel.x - PANEL_GAP / 2, r.panel.y).setSize(1, r.panel.h);
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
