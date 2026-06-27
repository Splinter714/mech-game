import Phaser from 'phaser';
import { buildMechTextures, reskinMech } from '../art/index.js';
import { Mech } from '../data/Mech.js';
import { CHASSIS_IDS } from '../data/chassis/index.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs } from '../data/save.js';
import { MOUNT_LOCATIONS, LOCATION_INFO, ABILITY_SLOTS } from '../data/anatomy.js';
import { WEAPON_IDS } from '../data/weapons.js';
import { EQUIPMENT_IDS } from '../data/equipment.js';
import { isWeapon, getItem } from '../data/items.js';
import { CATEGORIES } from '../data/categories.js';
import { MECH_DEPLOYED } from '../data/events.js';
import { SKILL_BINDS, PadEdges, PAD } from '../input/Controls.js';

// The mech lab. The build is exactly five skill slots, so the body is shown as a row of
// five square "skill button" tiles (#26) — one per slot — each showing the mounted item's
// procedural icon (or an empty state) plus its fire bind. Click a catalog item to arm it,
// then click a tile to mount (replacing whatever was there); click a filled tile to clear
// it. A live mech preview + the catalog sit alongside. "Deploy" saves and enters the arena.
const UI = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0',
  good: '#7bd17b', bad: '#e2533a', sel: '#efc14a',
  panel: 0x161b22, panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744,
  card: 0x131820, cardSel: 0x1b2430, slotEmpty: 0x0e1218, slotEdge: 0x323c49,
  ability: 0x7bd17b,
};

// Left-to-right tile order, mirroring the mech's body so the row reads like a chassis:
// left arm · left torso · centre torso · right torso · right arm.
const TILE_ORDER = ['leftArm', 'leftTorso', 'centerTorso', 'rightTorso', 'rightArm'];
const TILE_MAX = 150;
const TILE_GAP = 14;

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

    // Controller deploy (#29): Start / A drops you into the arena, no keyboard needed.
    this.padEdges = new PadEdges(this);
  }

  update() {
    if (this.padEdges.pressed(PAD.START) || this.padEdges.pressed(PAD.A)) this.deploy();
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
    this.button(this.W - 300, 20, 130, 34, '⟳ CHASSIS', () => this.cycleChassis(), UI.accent);
    this.button(this.W - 150, 20, 130, 34, '▶ DEPLOY  (D)', () => this.deploy(), UI.sel);
    this._updateHint();
  }

  // Swap to the next chassis, carrying the loadout over (all chassis share the six skill
  // slots, so mounts stay valid).
  cycleChassis() {
    const i = CHASSIS_IDS.indexOf(this.mech.chassisId);
    const next = CHASSIS_IDS[(i + 1) % CHASSIS_IDS.length];
    const data = this.mech.toJSON();
    data.chassisId = next;
    this.mech = new Mech(data);
    this.allMechs[ACTIVE_MECH_KEY] = this.mech;
    buildMechTextures(this, 'garageMech', this.mech);
    saveAllMechs(this.allMechs);
    this.refresh();
  }

  _updateHint() {
    if (!this.hintText) return;
    if (this.armed) {
      this.hintText.setText(`placing ${getItem(this.armed).name} — click a tile · Esc to cancel`)
        .setColor(UI.sel);
    } else {
      this.hintText.setText('click a catalog item, then a tile to mount it · click a filled tile to clear it')
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
      const tag = isWeapon(id) ? (item.category === 'melee' ? 'melee · arms' : item.category) : 'ability';
      this.add.text(x + w - 20, y + 8, tag, {
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

  // The square tile for a slot (top-left + size). Five tiles share a centred row across
  // the top of the doll region, sized to fit the width (capped at TILE_MAX).
  tileRect(loc) {
    const n = TILE_ORDER.length;
    const size = Math.min(TILE_MAX, Math.floor((this.dollW - TILE_GAP * (n - 1)) / n));
    const totalW = size * n + TILE_GAP * (n - 1);
    const x0 = Math.round(this.dollX + (this.dollW - totalW) / 2);
    const i = TILE_ORDER.indexOf(loc);
    return { x: x0 + i * (size + TILE_GAP), y: this.dollY + 10, w: size, h: size };
  }

  // Rebuild the doll: a row of five square skill tiles, each showing its fire bind and
  // the mounted item's icon (or an empty state).
  refresh() {
    this.doll.removeAll(true);
    this.footer.removeAll(true);
    for (const loc of TILE_ORDER) this._drawTile(loc);
    this._drawFooter();
  }

  _drawTile(loc) {
    const rect = this.tileRect(loc);
    const cx = rect.x + rect.w / 2;
    const isSel = loc === this.selected;
    const id = this.mech.mounts[loc][0];   // one skill per slot
    const isAbility = ABILITY_SLOTS.includes(loc);

    const bg = this.add.rectangle(rect.x, rect.y, rect.w, rect.h, isSel ? UI.cardSel : UI.card)
      .setOrigin(0, 0).setStrokeStyle(isSel ? 2 : 1, isSel ? 0xefc14a : UI.panelEdge)
      .setInteractive({ useHandCursor: true });
    if (this.armed) {
      bg.on('pointerover', () => bg.setStrokeStyle(2, UI.ability));
      bg.on('pointerout', () => bg.setStrokeStyle(isSel ? 2 : 1, isSel ? 0xefc14a : UI.panelEdge));
    }
    // Armed → mount here (replacing). Filled & unarmed → clear. Empty & unarmed → select.
    bg.on('pointerdown', () => (this.armed ? this.placeOn(loc) : id ? this.unmount(loc, 0) : this.placeOn(loc)));
    this.doll.add(bg);

    // Header: slot code (left) + fire bind (right).
    this.doll.add(this.add.text(rect.x + 8, rect.y + 6, LOCATION_INFO[loc].short, {
      fontFamily: 'monospace', fontSize: '13px', color: isSel ? UI.sel : UI.text,
    }));
    const bind = SKILL_BINDS[loc];
    this.doll.add(this.add.text(rect.x + rect.w - 8, rect.y + 7, `${bind.pad}·${bind.key}`, {
      fontFamily: 'monospace', fontSize: '10px', color: UI.dim,
    }).setOrigin(1, 0));

    const iconY = rect.y + rect.h * 0.46;
    if (id) {
      const item = getItem(id);
      const weapon = isWeapon(id);
      const color = weapon ? CATEGORIES[item.category].color : UI.ability;
      if (weapon) {
        // The procedural category icon (same art language as the catalog), scaled to fit.
        const icon = this.add.image(cx, iconY, `icon_${item.category}`).setDisplaySize(rect.w * 0.42, rect.w * 0.42);
        this.doll.add(icon);
      } else {
        // Abilities have no weapon glyph: draw a small diamond emblem in ability green.
        const d = rect.w * 0.17;
        this.doll.add(this.add.rectangle(cx, iconY, d, d, 0x152018).setStrokeStyle(2, color).setAngle(45));
        this.doll.add(this.add.rectangle(cx, iconY, d * 0.45, d * 0.45, color).setAngle(45));
      }
      this.doll.add(this.add.text(cx, rect.y + rect.h - 24, item.name, {
        fontFamily: 'monospace', fontSize: '11px', color: UI.text, align: 'center',
        wordWrap: { width: rect.w - 10 },
      }).setOrigin(0.5, 0));
      this.doll.add(this.add.text(cx, rect.y + rect.h - 10, weapon ? (item.category === 'melee' ? 'melee' : item.category) : 'ability', {
        fontFamily: 'monospace', fontSize: '9px', color: UI.dim,
      }).setOrigin(0.5));
    } else {
      this.doll.add(this.add.text(cx, iconY, '+', {
        fontFamily: 'monospace', fontSize: '28px', color: UI.slotEdge,
      }).setOrigin(0.5));
      this.doll.add(this.add.text(cx, rect.y + rect.h - 16, isAbility ? 'ability slot' : 'weapon slot', {
        fontFamily: 'monospace', fontSize: '10px', color: UI.dim,
      }).setOrigin(0.5));
    }
  }

  _drawFooter() {
    const v = this.mech.validate();
    const y = this.H - 56;
    this.footer.add(this.panel(20, y, Math.round(this.W * 0.66) - 20, 44));
    this.footer.add(this.txt(34, y + 6, `${this.mech.name}  ·  ${this.mech.chassis.name} (${this.mech.weightClass})`, {
      fontSize: '13px', color: UI.accent,
    }));
    let filled = 0;
    for (const loc of MOUNT_LOCATIONS) filled += this.mech.usedSlots(loc);
    this.footer.add(this.txt(34, y + 24, `skills ${filled}/${MOUNT_LOCATIONS.length}  ·  one per slot, melee in arms`, {
      fontSize: '12px', color: filled >= MOUNT_LOCATIONS.length ? UI.sel : UI.dim,
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

  // Place the armed piece into a tile, replacing whatever was there. Stays armed so you
  // can mount several in a row; an invalid mount (e.g. melee outside an arm) is rejected
  // with a toast and the displaced item restored.
  placeOn(loc) {
    this.selected = loc;
    if (!this.armed) return this.refresh();
    const prev = this.mech.usedSlots(loc) >= 1 ? this.mech.mounts[loc][0] : null;
    if (prev) this.mech.unmount(loc, 0);
    const res = this.mech.mount(loc, this.armed);
    if (!res.ok) {
      if (prev) this.mech.mount(loc, prev);   // restore the displaced item
      this.refresh();
      return this.toast(res.reason);
    }
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
