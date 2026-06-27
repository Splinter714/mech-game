import Phaser from 'phaser';
import { buildMechTextures, reskinMech, mechLayout, ART_SCALE } from '../art/index.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs } from '../data/save.js';
import { MOUNT_LOCATIONS, LOCATION_INFO } from '../data/anatomy.js';
import { WEAPON_IDS, getWeapon } from '../data/weapons.js';
import { EQUIPMENT_IDS, getEquipment } from '../data/equipment.js';
import { isWeapon, getItem } from '../data/items.js';
import { CATEGORIES } from '../data/categories.js';
import { MECH_DEPLOYED } from '../data/events.js';

// The mech lab. Top-down view of the active build with clickable body parts; a catalog
// on the right mounts weapons/equipment into the selected part with live tonnage/slot
// validation. "Deploy" saves and drops you into the arena. Single-file stub for
// Milestone 1 — splits into garage/ mixins later.
const UI = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0',
  good: '#7bd17b', bad: '#e2533a', sel: '#efc14a',
  panel: 0x161b22, panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744,
};
const GARAGE_MECH_SCALE = 0.95;          // sprite scale; on-screen design-unit = scale × ART_SCALE
const DISP = GARAGE_MECH_SCALE * ART_SCALE;

export default class GarageScene extends Phaser.Scene {
  constructor() {
    super('GarageScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);
    this.cameras.main.setBackgroundColor('#0d1014');

    this.allMechs = this.registry.get('allMechs');
    this.mech = this.allMechs[ACTIVE_MECH_KEY];
    this.selected = 'rightArm';
    buildMechTextures(this, 'garageMech', this.mech);

    this.mechCx = Math.round(this.W * 0.30);
    this.mechCy = Math.round(this.H * 0.52);

    this._buildHeader();
    this._buildMechView();
    this._buildCatalog();
    this.hud = this.add.container(0, 0);
    this.refresh();

    this.input.keyboard.on('keydown-D', () => this.deploy());
  }

  txt(x, y, s, opts = {}) {
    return this.add.text(x, y, s, {
      fontFamily: 'monospace', fontSize: '14px', color: UI.text, ...opts,
    });
  }

  panel(x, y, w, h) {
    return this.add.rectangle(x, y, w, h, UI.panel).setOrigin(0, 0).setStrokeStyle(1, UI.panelEdge);
  }

  button(x, y, w, h, label, onClick, color = UI.text) {
    const r = this.add.rectangle(x, y, w, h, UI.btn).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
    const t = this.add.text(x + w / 2, y + h / 2, label, {
      fontFamily: 'monospace', fontSize: '14px', color,
    }).setOrigin(0.5);
    r.on('pointerover', () => r.setFillStyle(UI.btnHover));
    r.on('pointerout', () => r.setFillStyle(UI.btn));
    r.on('pointerdown', onClick);
    return { r, t };
  }

  _buildHeader() {
    this.txt(20, 16, 'MECH LAB', { fontSize: '20px', color: UI.accent });
    this.txt(20, 42, 'click a body part, then a catalog item to mount it', { fontSize: '12px', color: UI.dim });
    this.button(this.W - 150, 20, 130, 34, '▶ DEPLOY  (D)', () => this.deploy(), UI.sel);
  }

  // The mech sprite (hull + turret) plus an interactive outline over each mountable
  // location. Sprites persist; their textures are re-skinned on change.
  _buildMechView() {
    this.add.sprite(this.mechCx, this.mechCy, 'garageMech_hull_0').setScale(GARAGE_MECH_SCALE);
    this.add.sprite(this.mechCx, this.mechCy, 'garageMech_turret').setScale(GARAGE_MECH_SCALE);

    const lay = mechLayout(this.mech);
    this.partZones = {};
    for (const loc of MOUNT_LOCATIONS) {
      const p = lay[loc];
      const zx = this.mechCx + p.x * DISP;
      const zy = this.mechCy + p.y * DISP;
      const zone = this.add.rectangle(zx, zy, Math.max(18, p.w * DISP), Math.max(18, p.h * DISP), 0xffffff, 0.001)
        .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
      zone.on('pointerdown', () => { this.selected = loc; this.refresh(); });
      this.partZones[loc] = zone;
    }
  }

  _buildCatalog() {
    const x = Math.round(this.W * 0.58);
    const w = this.W - x - 20;
    this.catalogX = x; this.catalogW = w;
    this.panel(x, 70, w, this.H - 230);
    this.txt(x + 12, 80, 'CATALOG', { fontSize: '14px', color: UI.accent });

    let y = 106;
    const row = (id, kind) => {
      const item = getItem(id);
      const r = this.add.rectangle(x + 8, y, w - 16, 30, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
      const catColor = kind === 'weapon' ? CATEGORIES[item.category].color : 0x7bd17b;
      this.add.rectangle(x + 16, y + 15, 10, 10, catColor).setOrigin(0.5);
      this.add.text(x + 28, y + 6, item.name, { fontFamily: 'monospace', fontSize: '13px', color: UI.text });
      this.add.text(x + w - 20, y + 8, `${item.slots}s ${item.tonnage}t`, {
        fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
      }).setOrigin(1, 0);
      r.on('pointerover', () => r.setFillStyle(UI.btnHover));
      r.on('pointerout', () => r.setFillStyle(UI.btn));
      r.on('pointerdown', () => this.tryMount(id));
      y += 34;
    };
    for (const id of WEAPON_IDS) row(id, 'weapon');
    this.add.text(x + 12, y + 2, '— equipment —', { fontFamily: 'monospace', fontSize: '11px', color: UI.dim });
    y += 20;
    for (const id of EQUIPMENT_IDS) row(id, 'equip');
  }

  // Redraw everything that depends on mech state: part labels, selection highlight,
  // the selected part's mount list, and the tonnage/slot readout.
  refresh() {
    this.hud.removeAll(true);
    const lay = mechLayout(this.mech);

    for (const loc of MOUNT_LOCATIONS) {
      const p = lay[loc];
      const zone = this.partZones[loc];
      const isSel = loc === this.selected;
      zone.setStrokeStyle(isSel ? 2 : 1, isSel ? 0xefc14a : UI.panelEdge);
      const used = this.mech.usedSlots(loc), cap = this.mech.slotCapacity(loc);
      const label = this.add.text(zone.x, zone.y - Math.min(zone.height / 2, 16) - 4,
        `${LOCATION_INFO[loc].short} ${used}/${cap}`, {
          fontFamily: 'monospace', fontSize: '11px',
          color: isSel ? UI.sel : (used > 0 ? UI.text : UI.dim),
        }).setOrigin(0.5);
      this.hud.add(label);
    }

    // Tonnage / validity readout under the mech.
    const v = this.mech.validate();
    const ty = Math.round(this.H - 132);
    this.hud.add(this.panel(20, ty, Math.round(this.W * 0.5) - 30, 112));
    this.hud.add(this.txt(34, ty + 10, `${this.mech.name}  ·  ${this.mech.chassis.name} (${this.mech.weightClass})`, { fontSize: '13px', color: UI.accent }));
    this.hud.add(this.txt(34, ty + 32, `tonnage  ${this.mech.totalTonnage()} / ${this.mech.chassis.maxTonnage} t`, {
      color: v.usedTonnage > this.mech.chassis.maxTonnage ? UI.bad : UI.text,
    }));
    this.hud.add(this.txt(34, ty + 54, `free  ${this.mech.freeTonnage()} t`, { fontSize: '12px', color: UI.dim }));
    this.hud.add(this.txt(34, ty + 78, v.ok ? '✓ valid build' : `✗ ${v.errors[0]}`, {
      color: v.ok ? UI.good : UI.bad,
    }));

    // Mounted items in the selected part, each with an unmount button.
    const sx = 20, sy = ty - 8;
    const list = this.mech.mounts[this.selected];
    this.hud.add(this.txt(Math.round(this.W * 0.5), ty + 10,
      `${LOCATION_INFO[this.selected].label}`, { fontSize: '13px', color: UI.sel }));
    if (list.length === 0) {
      this.hud.add(this.txt(Math.round(this.W * 0.5), ty + 34, '(empty)', { fontSize: '12px', color: UI.dim }));
    }
    list.forEach((id, i) => {
      const item = getItem(id);
      const ry = ty + 32 + i * 22;
      this.hud.add(this.txt(Math.round(this.W * 0.5), ry, `• ${item.name}`, { fontSize: '12px' }));
      const btn = this.button(Math.round(this.W * 0.5) + 160, ry - 2, 22, 18, '✕', () => this.unmount(this.selected, i), UI.bad);
      this.hud.add(btn.r); this.hud.add(btn.t);
    });
  }

  tryMount(itemId) {
    if (!this.selected) return this.toast('select a body part first');
    const res = this.mech.mount(this.selected, itemId);
    if (!res.ok) return this.toast(res.reason);
    this.onChange();
  }

  unmount(loc, index) {
    this.mech.unmount(loc, index);
    this.onChange();
  }

  onChange() {
    reskinMech(this, 'garageMech', this.mech);
    saveAllMechs(this.allMechs);
    this.refresh();
  }

  toast(msg) {
    if (this._toast) this._toast.destroy();
    this._toast = this.add.text(this.W / 2, this.H - 28, msg, {
      fontFamily: 'monospace', fontSize: '14px', color: UI.bad, backgroundColor: '#161b22', padding: { x: 8, y: 4 },
    }).setOrigin(0.5);
    this.tweens.add({ targets: this._toast, alpha: 0, delay: 1100, duration: 500, onComplete: () => this._toast?.destroy() });
  }

  deploy() {
    this.mech.repairAll();
    saveAllMechs(this.allMechs);
    this.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
    this.scene.start('ArenaScene');
  }
}
