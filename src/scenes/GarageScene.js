import Phaser from 'phaser';
import { buildMechTextures, reskinMech } from '../art/index.js';
import { Mech } from '../data/Mech.js';
import { CHASSIS_IDS } from '../data/chassis/index.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs } from '../data/save.js';
import { WEAPON_IDS } from '../data/weapons.js';
import { EQUIPMENT_IDS } from '../data/equipment.js';
import { isWeapon, getItem } from '../data/items.js';
import { CATEGORIES } from '../data/categories.js';
import { MECH_DEPLOYED } from '../data/events.js';
import { PadEdges, PAD } from '../input/Controls.js';
import { TILE_ORDER, tileRow, drawSkillTile, TILE_UI } from '../ui/skillTiles.js';
import { buildTabBar, TAB_BAR_H } from '../ui/tabBar.js';

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

// The skill-tile row (order, layout, drawing) is shared with the arena HUD via
// ../ui/skillTiles.js, so the two read identically. TILE_ORDER comes from there.

// Each slot's controller button, so pressing a slot's own bind quick-mounts the highlighted
// catalog item straight into it (#30). Mirrors SKILL_BINDS' pad labels: RT/LT triggers,
// RB/LB bumpers, L3.
const SLOT_BUTTON = {
  leftArm: PAD.LT, rightArm: PAD.RT,
  leftTorso: PAD.LB, rightTorso: PAD.RB,
  centerTorso: PAD.L3,
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

    // Doll region: the left ~66% of the screen, below the header, above the footer. The
    // skill tiles sit in a row along the BOTTOM (just above the footer); the live preview
    // fills the space above them.
    this.dollX = 20;
    this.dollY = 70;
    this.dollW = Math.round(this.W * 0.66) - 20;
    this._rowBottom = this.H - 56 - 12;            // tile-row bottom edge (above the footer)
    this.tileTop = this._tileRow()[0].y;           // tile-row top, for placing the preview

    buildMechTextures(this, 'garageMech', this.mech);

    this._buildCatalog();
    this._buildPreview();
    this.doll = this.add.container(0, 0);
    this.refresh();

    this.input.keyboard.on('keydown-D', () => this.deploy());
    this.input.keyboard.on('keydown-C', () => this.cycleChassis());
    this.input.keyboard.on('keydown-ESC', () => this.arm(null));

    // Controller support (#29 deploy + #30 full navigation). A focus cursor moves between
    // the catalog list and the five skill tiles; focus visuals only appear once a pad
    // button is used (`padActive`), so mouse/keyboard users see no cursor.
    this.padEdges = new PadEdges(this);
    this.inputMode = 'kbm';       // which scheme the tile bind labels reflect (#26)
    this.padActive = false;       // pad in use → show the focus cursor
    this.focusZone = 'catalog';   // 'catalog' | 'tiles'
    this.focusRow = 0;            // index into catalogIds
    this.focusTile = 0;           // index into TILE_ORDER
    // Latch the displayed binds to the last-used device: any mouse/keyboard use → 'kbm'.
    this.input.on('pointermove', () => this._setInputMode('kbm'));
    this.input.on('pointerdown', () => this._setInputMode('kbm'));
    this.input.keyboard.on('keydown', () => this._setInputMode('kbm'));
  }

  // Switch the displayed control scheme (and focus-cursor visibility), redrawing once.
  _setInputMode(mode) {
    if (this.inputMode === mode) return;
    this.inputMode = mode;
    this.padActive = mode === 'pad';
    this._updateCatalogHighlight();
    this.refresh();
  }

  // Controller (#30): the LEFT STICK moves the focus (d-pad is left free for other uses),
  // A equips, B clears/cancels, X/Y cycle chassis, Start deploys. Plus quick-mount — a
  // slot's own bind button (RT/LT/RB/LB/L3) drops the highlighted catalog item into that
  // slot (or clears it). No-ops without a connected pad, so mouse/keyboard is untouched.
  update() {
    const e = this.padEdges;
    const pad = e.pad();
    if (!pad) return;

    if (e.pressed(PAD.START)) { this.deploy(); return; }
    if (e.pressed(PAD.Y)) { this._setInputMode('pad'); this.cycleChassis(+1); return; }
    if (e.pressed(PAD.X)) { this._setInputMode('pad'); this.cycleChassis(-1); return; }

    // Quick-mount: a slot's bind button sends the highlighted item straight into it.
    for (const loc of TILE_ORDER) {
      if (e.pressed(SLOT_BUTTON[loc])) {
        this._setInputMode('pad');
        const item = this.armed || (this.focusZone === 'catalog' ? this.catalogIds[this.focusRow] : null);
        if (item) this._mountInto(loc, item); else this.unmount(loc, 0);
        return;
      }
    }

    const step = this._stickStep(pad.leftStick);
    const a = e.pressed(PAD.A), b = e.pressed(PAD.B);
    if (!step && !a && !b) return;
    this._setInputMode('pad');

    if (step === 'left' || step === 'right' || step === 'up' || step === 'down') {
      if (this.focusZone === 'tiles') {
        if (step === 'left') this.focusTile = (this.focusTile + TILE_ORDER.length - 1) % TILE_ORDER.length;
        else if (step === 'right') { if (this.focusTile === TILE_ORDER.length - 1) this.focusZone = 'catalog'; else this.focusTile++; }
        else if (step === 'down') this.focusZone = 'catalog';
      } else {
        if (step === 'up') this.focusRow = Math.max(0, this.focusRow - 1);
        else if (step === 'down') this.focusRow = Math.min(this.catalogIds.length - 1, this.focusRow + 1);
        else if (step === 'left' || step === 'right') this.focusZone = 'tiles';
      }
    }

    if (a) {
      if (this.focusZone === 'catalog') this.arm(this.catalogIds[this.focusRow]);
      else this.placeOn(TILE_ORDER[this.focusTile]);
      return;
    }
    if (b) {
      if (this.focusZone === 'tiles') this.unmount(TILE_ORDER[this.focusTile], 0);
      else this.arm(null);
      return;
    }
    if (this.focusZone === 'tiles') this.selected = TILE_ORDER[this.focusTile];
    this._updateCatalogHighlight();
    this.refresh();
  }

  // Discrete steps from an analog stick: one per flick, with a slow auto-repeat when held;
  // returns 'up'|'down'|'left'|'right'|null.
  _stickStep(stick) {
    if (!stick || stick.length() < 0.55) { this._stickDir = null; return null; }
    const dir = Math.abs(stick.x) > Math.abs(stick.y)
      ? (stick.x > 0 ? 'right' : 'left')
      : (stick.y > 0 ? 'down' : 'up');
    const now = this.time.now;
    if (this._stickDir !== dir) { this._stickDir = dir; this._stickNext = now + 360; return dir; }
    if (now >= this._stickNext) { this._stickNext = now + 150; return dir; }
    return null;
  }

  txt(x, y, s, opts = {}) {
    return this.add.text(x, y, s, {
      fontFamily: 'monospace', fontSize: '14px', color: UI.text, ...opts,
    });
  }

  panel(x, y, w, h) {
    return this.add.rectangle(x, y, w, h, UI.panel).setOrigin(0, 0).setStrokeStyle(1, UI.panelEdge);
  }

  // Build (or rebuild) the shared tab bar. Rebuilt on refresh so Deploy greys/ungreys as the
  // build becomes valid/invalid.
  _buildHeader() {
    this.tabBar?.layer.destroy();
    this.tabBar = buildTabBar(this, {
      active: 'GarageScene',
      canDeploy: this.mech.validate().ok,
      onDeploy: () => this.deploy(),
    });
  }

  // Swap to the next chassis, carrying the loadout over (all chassis share the six skill
  // slots, so mounts stay valid).
  cycleChassis(dir = 1) {
    const i = CHASSIS_IDS.indexOf(this.mech.chassisId);
    const n = CHASSIS_IDS.length;
    const next = CHASSIS_IDS[(i + dir + n) % n];
    const data = this.mech.toJSON();
    data.chassisId = next;
    this.mech = new Mech(data);
    this.allMechs[ACTIVE_MECH_KEY] = this.mech;
    buildMechTextures(this, 'garageMech', this.mech);
    saveAllMechs(this.allMechs);
    this.refresh();
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
    this.catalogIds = [...WEAPON_IDS, ...EQUIPMENT_IDS];
    for (const id of this.catalogIds) row(id);
    this._updateCatalogHighlight();
  }

  // Highlight the armed catalog row (gold) and, under controller focus, the focused row
  // (accent outline).
  _updateCatalogHighlight() {
    if (!this.catalogRows) return;
    const focusedId = (this.padActive && this.focusZone === 'catalog') ? this.catalogIds[this.focusRow] : null;
    for (const [id, r] of Object.entries(this.catalogRows)) {
      const armed = id === this.armed;
      const focused = id === focusedId;
      r.setFillStyle(armed ? UI.cardSel : focused ? UI.btnHover : UI.btn)
        .setStrokeStyle(armed || focused ? 2 : 1, armed ? 0xefc14a : focused ? 0x5ec8e0 : UI.panelEdge);
    }
  }

  // A live, top-down render of the actual mech (hull + turret) in the open space below
  // the doll, so you see weapons appear/vanish on the real model as you build. The
  // sprites reference fixed texture keys; onChange re-skins those textures in place.
  _buildPreview() {
    const px = Math.round(this.dollX + this.dollW * 0.5);
    const py = Math.round((this.dollY + this.tileTop) / 2) + 8;   // centred above the tiles
    this.previewPanel = this.add.rectangle(px, py, 230, 230, 0x10151c)
      .setStrokeStyle(1, UI.panelEdge);
    this.add.text(px, py - 104, 'LIVE PREVIEW', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    }).setOrigin(0.5, 0);
    this.previewHull = this.add.sprite(px, py + 14, 'garageMech_hull_0').setScale(0.75);
    this.previewTurret = this.add.sprite(px, py + 14, 'garageMech_turret').setScale(0.75);
  }

  // The shared skill-tile row, along the bottom of the doll region (above the footer).
  _tileRow() {
    return tileRow(this.dollX, this.dollW, { bottom: this._rowBottom, maxSize: 132 });
  }

  // Rebuild the doll: the shared skill-tile row, each tile click-to-mount / click-to-clear.
  // Also rebuilds the tab bar so Deploy reflects the current build validity.
  refresh() {
    this._buildHeader();
    this.doll.removeAll(true);
    for (const rect of this._tileRow()) this._drawTile(rect);
  }

  _drawTile(rect) {
    const loc = rect.loc;
    const id = this.mech.mounts[loc][0];   // one skill per slot
    // Highlight when it's the (mouse) selection, or the controller focus is on it.
    const selected = loc === this.selected && (this.focusZone === 'tiles' || !this.padActive);
    const refs = drawSkillTile(this, this.doll, rect, {
      loc, itemId: id, mode: this.inputMode, selected,
      subtitle: id ? getItem(id).name : '', subtitleColor: TILE_UI.text,
    });

    const bg = refs.bg.setInteractive({ useHandCursor: true });
    if (this.armed) {
      bg.on('pointerover', () => bg.setStrokeStyle(2, UI.ability));
      bg.on('pointerout', () => bg.setStrokeStyle(selected ? 2 : 1, selected ? 0xefc14a : UI.panelEdge));
    }
    // Armed → mount here (replacing). Filled & unarmed → clear. Empty & unarmed → select.
    bg.on('pointerdown', () => (this.armed ? this.placeOn(loc) : id ? this.unmount(loc, 0) : this.placeOn(loc)));
  }

  // Pick up (or drop) a catalog piece. Clicking the armed item again clears it.
  arm(itemId) {
    this.armed = this.armed === itemId ? null : itemId;
    this._updateCatalogHighlight();
    this.refresh();
  }

  // Mount `itemId` into `loc`, replacing whatever was there. An invalid mount (e.g. melee
  // outside an arm) is rejected with a toast and the displaced item restored.
  _mountInto(loc, itemId) {
    if (!itemId) return;
    this.selected = loc;
    const prev = this.mech.usedSlots(loc) >= 1 ? this.mech.mounts[loc][0] : null;
    if (prev) this.mech.unmount(loc, 0);
    const res = this.mech.mount(loc, itemId);
    if (!res.ok) {
      if (prev) this.mech.mount(loc, prev);   // restore the displaced item
      this.refresh();
      return this.toast(res.reason);
    }
    this.onChange();
  }

  // Place the armed piece into a tile (stays armed so you can mount several in a row).
  placeOn(loc) {
    this.selected = loc;
    if (!this.armed) return this.refresh();
    this._mountInto(loc, this.armed);
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

  // Deploy is inert unless the build is valid (all slots filled, mounts legal) — the tab-bar
  // Deploy button is greyed to match.
  deploy() {
    if (!this.mech.validate().ok) return;
    this.mech.repairAll();
    saveAllMechs(this.allMechs);
    this.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
    this.scene.start('ArenaScene');
  }
}
