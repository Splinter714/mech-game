import Phaser from 'phaser';
import { buildMechTextures, reskinMech } from '../art/index.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs } from '../data/save.js';
import { MOUNT_LOCATIONS, LOCATION_INFO } from '../data/anatomy.js';
import { WEAPON_IDS } from '../data/weapons.js';
import { EQUIPMENT_IDS } from '../data/equipment.js';
import { isWeapon, getItem } from '../data/items.js';
import { CATEGORIES } from '../data/categories.js';
import { MECH_DEPLOYED } from '../data/events.js';

// The mech lab. A paper-doll of the chassis: each body location is a card laid out in
// a humanoid arrangement, and its slots are rendered *on the part* as a stack of cells.
// You select a location, click a catalog item to drop it into the next free slots, and
// click a mounted chip to pull it back out — no separate "mounted items" list. "Deploy"
// saves and drops you into the arena.
const UI = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0',
  good: '#7bd17b', bad: '#e2533a', sel: '#efc14a',
  panel: 0x161b22, panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744,
  card: 0x131820, cardSel: 0x1b2430, slotEmpty: 0x0e1218, slotEdge: 0x323c49,
};

// Card sizing (design px, pre-DPR). A card is a header + one cell per slot of capacity.
const CARD_W = 100;
const CELL_H = 24;
const HEADER_H = 24;
const CARD_PAD = 6;

// Humanoid placement of each location within the doll region, as fractions of its
// width/height (these are card *centres*; cards grow downward by slot count).
const DOLL_POS = {
  head:        { fx: 0.50, fy: 0.02 },
  leftArm:     { fx: 0.10, fy: 0.22 },
  leftTorso:   { fx: 0.30, fy: 0.22 },
  centerTorso: { fx: 0.50, fy: 0.22 },
  rightTorso:  { fx: 0.70, fy: 0.22 },
  rightArm:    { fx: 0.90, fy: 0.22 },
  leftLeg:     { fx: 0.40, fy: 0.54 },
  rightLeg:    { fx: 0.60, fy: 0.54 },
};

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
    this.selected = null;   // last-touched location (for a subtle highlight)
    this.armed = null;      // catalog item id picked up, waiting to be placed

    // Doll region: the left ~56% of the screen, below the header, above the footer.
    this.dollX = 20;
    this.dollY = 70;
    this.dollW = Math.round(this.W * 0.66) - 20;
    this.dollH = this.H - this.dollY - 64;

    buildMechTextures(this, 'garageMech', this.mech);

    this._buildHeader();
    this._buildCatalog();
    this._buildPreview();
    this.doll = this.add.container(0, 0);
    this.footer = this.add.container(0, 0);
    this.refresh();

    this.input.keyboard.on('keydown-D', () => this.deploy());
    this.input.keyboard.on('keydown-ESC', () => this.arm(null));
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
    this.hintText = this.txt(120, 22, '', { fontSize: '11px', color: UI.dim });
    this.button(this.W - 150, 20, 130, 34, '▶ DEPLOY  (D)', () => this.deploy(), UI.sel);
    this._updateHint();
  }

  _updateHint() {
    if (!this.hintText) return;
    if (this.armed) {
      this.hintText.setText(`placing ${getItem(this.armed).name} — click a body section · Esc to cancel`)
        .setColor(UI.sel);
    } else {
      this.hintText.setText('click a catalog item, then a body section to mount it · click a chip to remove')
        .setColor(UI.dim);
    }
  }

  _buildCatalog() {
    const x = Math.round(this.W * 0.70);
    const w = this.W - x - 20;
    this.panel(x, 70, w, this.H - 134);
    this.txt(x + 12, 80, 'CATALOG', { fontSize: '14px', color: UI.accent });

    this.catalogRows = {};
    let y = 106;
    const row = (id) => {
      const item = getItem(id);
      const r = this.add.rectangle(x + 8, y, w - 16, 30, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
      const catColor = isWeapon(id) ? CATEGORIES[item.category].color : 0x7bd17b;
      this.add.rectangle(x + 16, y + 15, 10, 10, catColor).setOrigin(0.5);
      this.add.text(x + 28, y + 6, item.name, { fontFamily: 'monospace', fontSize: '13px', color: UI.text });
      this.add.text(x + w - 20, y + 8, `${item.slots} slot${item.slots > 1 ? 's' : ''}`, {
        fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
      }).setOrigin(1, 0);
      r.on('pointerover', () => { if (this.armed !== id) r.setFillStyle(UI.btnHover); });
      r.on('pointerout', () => { if (this.armed !== id) r.setFillStyle(UI.btn); });
      r.on('pointerdown', () => this.arm(id));
      this.catalogRows[id] = r;
      y += 34;
    };
    for (const id of [...WEAPON_IDS, ...EQUIPMENT_IDS]) row(id);
    this._updateCatalogHighlight();
  }

  // Highlight the armed catalog row (the piece waiting to be placed).
  _updateCatalogHighlight() {
    if (!this.catalogRows) return;
    for (const [id, r] of Object.entries(this.catalogRows)) {
      const on = id === this.armed;
      r.setFillStyle(on ? UI.cardSel : UI.btn).setStrokeStyle(on ? 2 : 1, on ? 0xefc14a : UI.panelEdge);
    }
  }

  // A live, top-down render of the actual mech (hull + turret) in the open space below
  // the doll, so you see weapons appear/vanish on the real model as you build. The
  // sprites reference fixed texture keys; onChange re-skins those textures in place.
  _buildPreview() {
    const px = Math.round(this.dollX + this.dollW * 0.5);
    const py = this.H - 176;
    this.previewPanel = this.add.rectangle(px, py, 220, 220, 0x10151c)
      .setStrokeStyle(1, UI.panelEdge);
    this.add.text(px, py - 100, 'LIVE PREVIEW', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    }).setOrigin(0.5, 0);
    this.previewHull = this.add.sprite(px, py + 10, 'garageMech_hull_0').setScale(0.7);
    this.previewTurret = this.add.sprite(px, py + 10, 'garageMech_turret').setScale(0.7);
  }

  // Where a location's card sits (top-left + size). Height grows with slot capacity so
  // every slot has a visible cell on the body.
  cardRect(loc) {
    const cap = this.mech.slotCapacity(loc);
    const h = HEADER_H + cap * CELL_H + CARD_PAD;
    const pos = DOLL_POS[loc];
    const cx = this.dollX + pos.fx * this.dollW;
    const top = this.dollY + pos.fy * this.dollH;
    return { x: Math.round(cx - CARD_W / 2), y: Math.round(top), w: CARD_W, h };
  }

  // Rebuild the whole doll: one card per mountable location, slots drawn in place.
  refresh() {
    this.doll.removeAll(true);
    this.footer.removeAll(true);

    for (const loc of MOUNT_LOCATIONS) this._drawCard(loc);
    this._drawConnectors();
    this._drawFooter();
  }

  _drawCard(loc) {
    const rect = this.cardRect(loc);
    const isSel = loc === this.selected;
    const used = this.mech.usedSlots(loc), cap = this.mech.slotCapacity(loc);

    // When a piece is armed, every card reads as a drop target.
    const isTarget = this.armed && loc === this.selected;
    const bg = this.add.rectangle(rect.x, rect.y, rect.w, rect.h, (isSel || isTarget) ? UI.cardSel : UI.card)
      .setOrigin(0, 0).setStrokeStyle(isSel ? 2 : 1, isSel ? 0xefc14a : UI.panelEdge)
      .setInteractive({ useHandCursor: true });
    if (this.armed) {
      bg.on('pointerover', () => bg.setStrokeStyle(2, 0x7bd17b));
      bg.on('pointerout', () => bg.setStrokeStyle(isSel ? 2 : 1, isSel ? 0xefc14a : UI.panelEdge));
    }
    bg.on('pointerdown', () => this.placeOn(loc));
    this.doll.add(bg);

    // Header: location code (full label doesn't fit a 100px card) + slot usage.
    this.doll.add(this.add.text(rect.x + 8, rect.y + 6, LOCATION_INFO[loc].short, {
      fontFamily: 'monospace', fontSize: '13px', color: isSel ? UI.sel : UI.text,
    }));
    this.doll.add(this.add.text(rect.x + rect.w - 8, rect.y + 6, `${used}/${cap}`, {
      fontFamily: 'monospace', fontSize: '12px', color: used > 0 ? UI.accent : UI.dim,
    }).setOrigin(1, 0));

    // Slot cells. Walk the mounted items; each occupies `slots` consecutive cells and
    // renders as one chip. Remaining cells are empty "+" mount targets.
    const cellX = rect.x + CARD_PAD;
    const cellW = rect.w - CARD_PAD * 2;
    const cellTop = rect.y + HEADER_H;
    let cell = 0;
    this.mech.mounts[loc].forEach((id, index) => {
      const item = getItem(id);
      const span = Math.max(1, item.slots);
      const y = cellTop + cell * CELL_H;
      const h = span * CELL_H - 4;
      const color = isWeapon(id) ? CATEGORIES[item.category].color : 0x7bd17b;
      const chip = this.add.rectangle(cellX, y + 2, cellW, h, 0x1f2730)
        .setOrigin(0, 0).setStrokeStyle(1, color).setInteractive({ useHandCursor: true });
      chip.on('pointerover', () => chip.setFillStyle(0x29333f));
      chip.on('pointerout', () => chip.setFillStyle(0x1f2730));
      chip.on('pointerdown', () => this.unmount(loc, index));
      this.doll.add(chip);
      this.doll.add(this.add.rectangle(cellX + 8, y + 2 + h / 2, 8, 8, color).setOrigin(0.5));
      this.doll.add(this.add.text(cellX + 18, y + 2 + h / 2, item.name, {
        fontFamily: 'monospace', fontSize: '11px', color: UI.text,
      }).setOrigin(0, 0.5));
      this.doll.add(this.add.text(cellX + cellW - 6, y + 2 + h / 2, '✕', {
        fontFamily: 'monospace', fontSize: '11px', color: UI.bad,
      }).setOrigin(1, 0.5));
      cell += span;
    });

    for (; cell < cap; cell++) {
      const y = cellTop + cell * CELL_H;
      const empty = this.add.rectangle(cellX, y + 2, cellW, CELL_H - 4, UI.slotEmpty)
        .setOrigin(0, 0).setStrokeStyle(1, UI.slotEdge).setInteractive({ useHandCursor: true });
      empty.on('pointerover', () => empty.setFillStyle(0x16202a));
      empty.on('pointerout', () => empty.setFillStyle(UI.slotEmpty));
      empty.on('pointerdown', () => this.placeOn(loc));
      this.doll.add(empty);
      this.doll.add(this.add.text(cellX + cellW / 2, y + 2 + (CELL_H - 4) / 2, '+', {
        fontFamily: 'monospace', fontSize: '13px', color: UI.dim,
      }).setOrigin(0.5));
    }
  }

  // Faint lines tying the limbs to the center torso so the doll reads as one body.
  _drawConnectors() {
    const g = this.add.graphics();
    g.lineStyle(2, 0x222b35, 1);
    const c = this._cardCenter('centerTorso');
    for (const loc of ['head', 'leftTorso', 'rightTorso']) {
      const p = this._cardCenter(loc);
      g.lineBetween(c.x, c.y, p.x, p.y);
    }
    for (const [arm, torso] of [['leftArm', 'leftTorso'], ['rightArm', 'rightTorso']]) {
      const a = this._cardCenter(arm), t = this._cardCenter(torso);
      g.lineBetween(t.x, t.y, a.x, a.y);
    }
    for (const loc of ['leftLeg', 'rightLeg']) {
      const p = this._cardCenter(loc);
      g.lineBetween(c.x, c.y, p.x, p.y);
    }
    this.doll.add(g);
    this.doll.sendToBack(g);
  }

  _cardCenter(loc) {
    const r = this.cardRect(loc);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  _drawFooter() {
    const v = this.mech.validate();
    const y = this.H - 56;
    this.footer.add(this.panel(20, y, Math.round(this.W * 0.66) - 20, 44));
    this.footer.add(this.txt(34, y + 6, `${this.mech.name}  ·  ${this.mech.chassis.name} (${this.mech.weightClass})`, {
      fontSize: '13px', color: UI.accent,
    }));
    let used = 0, cap = 0;
    for (const loc of MOUNT_LOCATIONS) { used += this.mech.usedSlots(loc); cap += this.mech.slotCapacity(loc); }
    this.footer.add(this.txt(34, y + 24, `slots ${used}/${cap} used`, {
      fontSize: '12px', color: UI.dim,
    }));
    this.footer.add(this.txt(Math.round(this.W * 0.66) - 36, y + 14, v.ok ? '✓ valid build' : `✗ ${v.errors[0]}`, {
      color: v.ok ? UI.good : UI.bad,
    }).setOrigin(1, 0));
  }

  // Pick up (or drop) a catalog piece. Clicking the armed item again clears it.
  arm(itemId) {
    this.armed = this.armed === itemId ? null : itemId;
    this._updateCatalogHighlight();
    this._updateHint();
    this.refresh();
  }

  // Place the armed piece into a body section. Stays armed so you can mount several of
  // the same in a row; a failed mount (no room) just toasts why.
  placeOn(loc) {
    this.selected = loc;
    if (!this.armed) return this.refresh();
    const res = this.mech.mount(loc, this.armed);
    if (!res.ok) { this.refresh(); return this.toast(res.reason); }
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
