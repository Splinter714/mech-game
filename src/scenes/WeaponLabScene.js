import Phaser from 'phaser';
import { WEAPON_IDS } from '../data/weapons.js';
import { Mech } from '../data/Mech.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs } from '../data/save.js';
import { MECH_DEPLOYED } from '../data/events.js';
import { buildTabBar, attachPadTabCycle, TAB_BAR_H } from '../ui/tabBar.js';
import { WeaponCardList } from '../ui/weaponCardList.js';
import { WeaponSfxPanel } from '../ui/weaponSfxPanel.js';
import { Slider } from '../ui/slider.js';
import { EXPLOSION_CATEGORIES, EXPLOSION_CATEGORY_LABEL, explosionSfxId } from '../audio/sfxParams.js';

// ── Weapon Lab tab ───────────────────────────────────────────────────────────
// A full catalog of every weapon, each card auto-firing a live shot/beam preview. It's
// now a thin host around the shared WeaponCardList component (ui/weaponCardList.js) — the
// SAME list the garage embeds in its catalog, so the two can never diverge. Reached from
// the tab bar or by booting with ?lab. Selecting a card also opens the sound panel
// (ui/weaponSfxPanel.js) on the right, so picking a weapon doubles as "tune its SFX."
//
// #107: a small fixed row above the weapon list picks one of the destruction-explosion size
// categories (small/medium/large/massive) instead of a weapon — clicking one feeds its
// sfxParams id (explosionSfxId) into the SAME sound panel on the right, so tuning an
// explosion category is the identical slider/preview/reset flow as tuning a weapon's sound.
const UI = {
  bg: '#0d1014', edge: 0x2a333f, text: '#c8d2dd', dim: '#7c8794',
  btn: 0x1a212b, btnHover: 0x232c38, sel: 0xefc14a,
};
const MARGIN = 20;
const PANEL_W = 300;
const PANEL_GAP = 14;
const EXPLOSION_ROW_H = 46;   // header line + one row of category buttons
const EXPLOSION_GAP = 10;     // gap below the row before the weapon list starts

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
    attachPadTabCycle(this, 'WeaponLabScene');   // SELECT cycles the top tabs (#70)

    Slider.attachDrag(this);
    this.selectedId = null;
    this.selectedExplosion = null;
    const r = this._region();
    this.list = new WeaponCardList(this, { ...r.list, ids: WEAPON_IDS, onSelect: (id) => this._select(id), selectedId: this.selectedId });
    this.panel = new WeaponSfxPanel(this, r.panel);
    this.panelEdge = this.add.rectangle(r.panel.x - PANEL_GAP / 2, r.panel.y, 1, r.panel.h, UI.edge).setOrigin(0.5, 0);
    this._buildExplosionRow(r.explosion);

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('GarageScene'));
    this.scale.on('resize', this._relayout, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this._relayout, this);
      this.list.destroy();
      this.panel.destroy();
      this.explosionHeader.destroy();
      for (const b of this.explosionButtons) { b.rect.destroy(); b.text.destroy(); }
    });
  }

  // Selecting a card both highlights it and opens its sound panel — every id in this
  // scene's list is a weapon (ids: WEAPON_IDS), so the selected id IS the panel's weapon.
  _select(id) {
    this.selectedId = id;
    this.selectedExplosion = null;
    this.list.setSelected(id);
    this.panel.setWeapon(id);
    this._paintExplosionRow();
  }

  // #107: the destruction-explosion size-category row — a fixed strip of 4 buttons (small/
  // medium/large/massive) ABOVE the weapon list. Picking one feeds its sfxParams id
  // (explosionSfxId) into the SAME WeaponSfxPanel a weapon card would, with a friendly label
  // instead of the raw id, so tuning an explosion category is the identical slider/preview/
  // reset flow the weapon-sound cards already use — just a different id going into the panel.
  _buildExplosionRow(region) {
    this.explosionHeader = this.add.text(region.x, region.y, 'DESTRUCTION EXPLOSION — size category', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    });
    this.explosionButtons = EXPLOSION_CATEGORIES.map((category, i) => {
      const rect = this.add.rectangle(0, 0, 10, 22, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.edge).setInteractive({ useHandCursor: true });
      const text = this.add.text(0, 0, category[0].toUpperCase() + category.slice(1), {
        fontFamily: 'monospace', fontSize: '11px', color: UI.text,
      }).setOrigin(0.5);
      rect.on('pointerover', () => { if (this.selectedExplosion !== category) rect.setFillStyle(UI.btnHover); });
      rect.on('pointerout', () => this._paintExplosionRow());
      rect.on('pointerdown', () => this._selectExplosion(category));
      return { category, rect, text, i };
    });
    this._layoutExplosionRow(region);
  }

  _layoutExplosionRow(region) {
    this.explosionHeader.setPosition(region.x, region.y);
    const gap = 6;
    const bw = Math.floor((region.w - gap * (this.explosionButtons.length - 1)) / this.explosionButtons.length);
    const by = region.y + 18;
    for (const b of this.explosionButtons) {
      const bx = region.x + b.i * (bw + gap);
      b.rect.setPosition(bx, by).setSize(bw, 22);
      b.text.setPosition(bx + bw / 2, by + 11);
    }
  }

  _selectExplosion(category) {
    this.selectedExplosion = category;
    this.selectedId = null;
    this.list.setSelected(null);
    this.panel.setWeapon(explosionSfxId(category), EXPLOSION_CATEGORY_LABEL[category]);
    this._paintExplosionRow();
  }

  _paintExplosionRow() {
    for (const b of this.explosionButtons) {
      const on = b.category === this.selectedExplosion;
      b.rect.setFillStyle(on ? 0x1b2430 : UI.btn).setStrokeStyle(on ? 2 : 1, on ? UI.sel : UI.edge);
    }
  }

  _region() {
    this.W = Math.round(this.scale.width / (this.registry.get('dpr') || 1));
    this.H = Math.round(this.scale.height / (this.registry.get('dpr') || 1));
    const top = TAB_BAR_H + 12;
    const listW = Math.max(280, this.W - MARGIN * 2 - PANEL_W - PANEL_GAP);
    const listTop = top + EXPLOSION_ROW_H + EXPLOSION_GAP;
    return {
      explosion: { x: MARGIN, y: top, w: listW, h: EXPLOSION_ROW_H },
      list: { x: MARGIN, y: listTop, w: listW, h: this.H - listTop - 8 },
      panel: { x: MARGIN + listW + PANEL_GAP, y: top, w: PANEL_W - PANEL_GAP, h: this.H - top - 8 },
    };
  }

  _relayout() {
    const r = this._region();
    this.list.setRegion(r.list.x, r.list.y, r.list.w, r.list.h);
    this.panel.setRegion(r.panel.x, r.panel.y, r.panel.w, r.panel.h);
    this.panelEdge.setPosition(r.panel.x - PANEL_GAP / 2, r.panel.y).setSize(1, r.panel.h);
    this._layoutExplosionRow(r.explosion);
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
