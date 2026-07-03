import Phaser from 'phaser';
import { buildMechTextures, reskinMech, partSpriteTransform } from '../art/index.js';
import { Mech } from '../data/Mech.js';
import { CHASSIS_IDS } from '../data/chassis/index.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs, loadUnlocked, saveUnlocked, saveRunCurrency } from '../data/save.js';
import { WEAPON_IDS } from '../data/weapons.js';
import { EQUIPMENT_IDS } from '../data/equipment.js';
import { isWeapon, getItem } from '../data/items.js';
import { costOf } from '../data/shop.js';
import { WEAPON_SLOTS, MELEE_LOCATIONS, ABILITY_SLOTS, MOUNT_LOCATIONS, LOCATION_INFO } from '../data/anatomy.js';
import { MECH_DEPLOYED, RUN_CURRENCY_KEY } from '../data/events.js';
import { BIOME_IDS } from '../data/biomes.js';
import { PadEdges, PAD } from '../input/Controls.js';
import { TILE_ORDER, tileRow, drawSkillTile, TILE_UI } from '../ui/skillTiles.js';
import { buildTabBar, TAB_BAR_H } from '../ui/tabBar.js';
import { WeaponCardList } from '../ui/weaponCardList.js';

// The mech lab. The build is five skill slots, shown as a row of square "skill button" tiles
// (#26) along the bottom-left — one per slot, each showing its mounted item + fire bind. Click
// a tile to edit that slot: the right-hand catalog (the SHARED WeaponCardList, identical to the
// Weapon Lab) filters to the items that fit it, each card running its live shot/fx preview.
// Click a card to mount it (or to unmount if it's already there). A small live mech preview +
// the chassis switch sit bottom-right. "Deploy" (greyed until every slot is filled) enters the
// arena.
const UI = {
  text: '#c8d2dd', accent: '#5ec8e0', bad: '#e2533a',
  panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744,
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
    this.selected = null;   // the slot currently being edited (filters the catalog)
    this.catalogIds = [...WEAPON_IDS, ...EQUIPMENT_IDS];
    // #65: the permanently-unlocked catalog (meta-progression, persists across runs). Loaded
    // before the WeaponCardList so its isLocked/costOf callbacks see real data from frame one.
    this.unlocked = loadUnlocked();

    // Layout: the weapon catalog (shared WeaponCardList) spans the FULL width across the top so
    // each card's live preview is as wide as the Weapon Lab's; a bottom strip holds the skill
    // tiles (left) and the small live mech preview + chassis switch (right).
    const top = TAB_BAR_H + 14;
    this.bottomH = 200;                             // bottom strip height (tiles + preview)
    this.previewW = 210;                            // right slice of the strip for the preview
    this.dollX = 20;
    this.dollW = this.W - this.previewW - 60;
    this._rowBottom = this.H - 22;                  // tile-row bottom edge

    buildMechTextures(this, 'garageMech', this.mech);

    // Full-width catalog, reusing the exact Weapon Lab card list. Picking a card mounts it into
    // the selected slot (toggles off if it's already there).
    this.list = new WeaponCardList(this, {
      x: 20, y: top, w: this.W - 40, h: this.H - top - this.bottomH - 16,
      ids: this.catalogIds, onSelect: (id) => this._pickItem(id),
      isLocked: (id) => !this.unlocked.has(id),
      costOf: (id) => costOf(id),
    });

    this._buildPreview();
    this.doll = this.add.container(0, 0);

    // #64: the run-currency readout (banked total, meta-progression pool). Full spend/shop UI
    // is #65's job — this is just a visible, persisted number, top-right under the tab bar. Also
    // shows the last run's result (WON/DIED + its payout) as a one-line recap when present.
    this.currencyText = this.add.text(this.W - 16, TAB_BAR_H + 10, '', {
      fontFamily: 'monospace', fontSize: '14px', color: UI.accent,
    }).setOrigin(1, 0);
    this.lastRunText = this.add.text(this.W - 16, TAB_BAR_H + 30, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#7c8794',
    }).setOrigin(1, 0);
    this._refreshCurrency();

    this.refresh();

    this.input.keyboard.on('keydown-D', () => this.deploy());
    this.input.keyboard.on('keydown-C', () => this.cycleChassis());
    this.input.keyboard.on('keydown-ESC', () => this._selectSlot(null));
    this.events.once('shutdown', () => this.list.destroy());

    // Controller support (#29 deploy + #30): the left stick moves a slot focus across the
    // five tiles; A selects a slot, B clears it. Focus visuals only appear once a pad button
    // is used (`padActive`), so mouse/keyboard users see no cursor.
    this.padEdges = new PadEdges(this);
    this.inputMode = 'kbm';       // which scheme the tile bind labels reflect (#26)
    this.padActive = false;       // pad in use → show the focus cursor
    this.focusTile = 0;           // index into TILE_ORDER
    // Latch the displayed binds to the last-used device: any mouse/keyboard use → 'kbm'.
    this.input.on('pointermove', () => this._setInputMode('kbm'));
    this.input.on('pointerdown', () => this._setInputMode('kbm'));
    this.input.keyboard.on('keydown', () => this._setInputMode('kbm'));
  }

  // #64: read the banked run currency + last run's result (if any) from the registry and
  // paint them top-right. Called once from create() and again whenever they might have
  // changed (there's no live-updating source once in the garage, so a single paint suffices).
  _refreshCurrency() {
    const total = this.registry.get(RUN_CURRENCY_KEY) || 0;
    this.currencyText.setText(`⚙ ${total} SCRAP`);
    const last = this.registry.get('lastRunResult');
    if (last) {
      const label = last.status === 'won' ? 'LAST RUN: WON' : 'LAST RUN: MECH LOST';
      this.lastRunText.setText(`${label}  (+${last.currency})`);
    } else {
      this.lastRunText.setText('');
    }
  }

  // Switch the displayed control scheme (and focus-cursor visibility), redrawing once.
  _setInputMode(mode) {
    if (this.inputMode === mode) return;
    this.inputMode = mode;
    this.padActive = mode === 'pad';
    this.refresh();
  }

  // Per-frame: tick the live catalog previews, then handle the gamepad. The LEFT STICK moves
  // the slot focus, A selects that slot (filtering the catalog), B clears it, X/Y cycle
  // chassis, Start deploys, and a slot's own bind button (RT/LT/RB/LB/L3) selects it directly.
  update(time, delta) {
    this.list.update(time, delta);

    const e = this.padEdges;
    const pad = e.pad();
    if (!pad) return;

    if (e.pressed(PAD.START)) { this.deploy(); return; }
    if (e.pressed(PAD.Y)) { this._setInputMode('pad'); this.cycleChassis(+1); return; }
    if (e.pressed(PAD.X)) { this._setInputMode('pad'); this.cycleChassis(-1); return; }

    for (const loc of TILE_ORDER) {
      if (e.pressed(SLOT_BUTTON[loc])) { this._setInputMode('pad'); this._selectSlot(loc); return; }
    }

    const step = this._stickStep(pad.leftStick);
    const a = e.pressed(PAD.A), b = e.pressed(PAD.B);
    if (!step && !a && !b) return;
    this._setInputMode('pad');

    if (step === 'left') this.focusTile = (this.focusTile + TILE_ORDER.length - 1) % TILE_ORDER.length;
    else if (step === 'right') this.focusTile = (this.focusTile + 1) % TILE_ORDER.length;
    if (a) { this._selectSlot(TILE_ORDER[this.focusTile]); return; }
    if (b) { this.unmount(TILE_ORDER[this.focusTile], 0); return; }
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

  button(x, y, w, h, label, onClick, color = UI.text) {
    const r = this.add.rectangle(x, y, w, h, UI.btn).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
    const t = this.add.text(x + w / 2, y + h / 2, label, { fontFamily: 'monospace', fontSize: '13px', color }).setOrigin(0.5);
    r.on('pointerover', () => r.setFillStyle(UI.btnHover));
    r.on('pointerout', () => r.setFillStyle(UI.btn));
    r.on('pointerdown', onClick);
    return { r, t };
  }

  // Build (or rebuild) the shared tab bar. Rebuilt on refresh so Deploy greys/ungreys as the
  // build becomes valid/invalid.
  _buildHeader() {
    this.tabBar?.layer.destroy();
    this.tabBar = buildTabBar(this, {
      active: 'GarageScene',
      canDeploy: this.mech.isComplete(),
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
    this._positionPreviewParts();  // layout (side-torso/arm placement) changes with the chassis
    saveAllMechs(this.allMechs);
    this._chassisBtn?.t.setText(`⟳ ${this.mech.chassis.name}`);
    this.refresh();
  }

  // Catalog ids eligible for a slot (occupancy ignored — picking replaces). With no slot
  // selected, the whole catalog shows.
  _eligibleIds(loc) {
    if (!loc) return this.catalogIds;
    return this.catalogIds.filter((id) => {
      if (isWeapon(id)) {
        if (!WEAPON_SLOTS.includes(loc)) return false;
        if (getItem(id).category === 'melee' && !MELEE_LOCATIONS.includes(loc)) return false;
        return true;
      }
      return ABILITY_SLOTS.includes(loc);
    });
  }

  // Select a slot to edit: filter the catalog to what fits it and highlight the mounted item.
  _selectSlot(loc) {
    this.selected = this.selected === loc ? null : loc;
    this.list.setIds(this._eligibleIds(this.selected));
    this.list.setSelected(this.selected ? this.mech.mounts[this.selected][0] ?? null : null);
    this.refresh();
  }

  // Pick a catalog item: mount it into the selected slot (or unmount if it's already there).
  // With no slot selected, picking a card selects the first slot it fits. #65: a LOCKED item
  // can't be mounted at all — clicking it attempts to buy it instead (spends SCRAP, permanent).
  _pickItem(id) {
    if (!this.unlocked.has(id)) { this._purchase(id); return; }
    if (!this.selected) {
      const loc = this._eligibleSlotFor(id);
      if (loc) this._selectSlot(loc);
      return;
    }
    const cur = this.mech.mounts[this.selected][0];
    if (cur === id) this.unmount(this.selected, 0);
    else this._mountInto(this.selected, id);
    this.list.setSelected(this.mech.mounts[this.selected]?.[0] ?? null);
  }

  // #65: spend banked SCRAP to permanently unlock `id`. Insufficient funds just toasts —
  // no partial spend, no per-use cost once unlocked (a flat, one-time purchase).
  _purchase(id) {
    const price = costOf(id);
    const balance = this.registry.get(RUN_CURRENCY_KEY) || 0;
    if (balance < price) { this.toast(`NOT ENOUGH SCRAP — need ${price}`); return; }
    this.unlocked.add(id);
    saveUnlocked(this.unlocked);
    const remaining = balance - price;
    this.registry.set(RUN_CURRENCY_KEY, remaining);
    saveRunCurrency(remaining);
    this._refreshCurrency();
    this.list.refreshLocks();
    this.toast(`UNLOCKED ${getItem(id).name}`, UI.accent);
  }

  _eligibleSlotFor(id) {
    return TILE_ORDER.find((loc) => this._eligibleIds(loc).includes(id)) ?? null;
  }

  // A small live, top-down render of the actual mech (hull + turret), in the bottom strip's
  // right slice with the chassis-switch button beneath it. The sprites reference fixed texture
  // keys; onChange re-skins those textures in place.
  _buildPreview() {
    const box = this.bottomH - 56;                              // square preview size
    const cx = this.W - this.previewW / 2 - 20;                 // centred in the right slice
    const cy = this.H - this.bottomH + box / 2 + 6;
    this.previewPanel = this.add.rectangle(cx, cy, box, box, 0x10151c).setStrokeStyle(1, UI.panelEdge);
    const scale = (box - 30) / 230;
    this._previewScale = scale;
    this._previewCx = cx; this._previewCy = cy + 8;
    // Add in draw order back→front: hull → side torsos → arms → body, so the body occludes the
    // side torsos' inner edges and the arms occlude the side torsos (matches the arena layering).
    this.previewHull = this.add.sprite(cx, cy + 8, 'garageMech_hull_0').setScale(scale);
    this.previewTorL = this.add.sprite(cx, cy + 8, 'garageMech_leftTorso').setScale(scale);
    this.previewTorR = this.add.sprite(cx, cy + 8, 'garageMech_rightTorso').setScale(scale);
    this.previewArmL = this.add.sprite(cx, cy + 8, 'garageMech_leftArm').setScale(scale);
    this.previewArmR = this.add.sprite(cx, cy + 8, 'garageMech_rightArm').setScale(scale);
    this.previewTurret = this.add.sprite(cx, cy + 8, 'garageMech_turret').setScale(scale);
    this._positionPreviewParts();
    this._chassisBtn = this.button(cx - 80, this.H - 34, 160, 26,
      `⟳ ${this.mech.chassis.name}`, () => this.cycleChassis(), UI.accent);
  }

  // Place + pivot the static preview side-torso + arm sprites at their joints (tilt 0). The
  // preview faces "up" (turret rotation 0); passing angle = -π/2 gives rot = 0 (matching the
  // turret) and the right dx/dy. Called on build and after a chassis switch (which changes
  // mechLayout → part placement).
  _positionPreviewParts() {
    const parts = [
      [this.previewTorL, 'leftTorso'], [this.previewTorR, 'rightTorso'],
      [this.previewArmL, 'leftArm'], [this.previewArmR, 'rightArm'],
    ];
    for (const [sprite, loc] of parts) {
      const t = partSpriteTransform(this.mech, loc, -Math.PI / 2, this._previewScale);
      sprite.setOrigin(t.ox, t.oy);
      sprite.setPosition(this._previewCx + t.dx, this._previewCy + t.dy);
      sprite.rotation = t.rot;
    }
  }

  // The shared skill-tile row, along the bottom of the LEFT region.
  _tileRow() {
    return tileRow(this.dollX, this.dollW, { bottom: this._rowBottom, maxSize: 150 });
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
    const selected = loc === this.selected;
    const refs = drawSkillTile(this, this.doll, rect, {
      loc, itemId: id, mode: this.inputMode, selected,
      subtitle: id ? getItem(id).name : '', subtitleColor: TILE_UI.text,
    });
    // Click a tile to edit that slot — the catalog filters to what fits it.
    refs.bg.setInteractive({ useHandCursor: true }).on('pointerdown', () => this._selectSlot(loc));
  }

  // Mount `itemId` into `loc`, replacing whatever was there. An invalid mount (e.g. melee
  // outside an arm) is rejected with a toast and the displaced item restored.
  _mountInto(loc, itemId) {
    if (!itemId) return;
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

  unmount(loc, index) {
    this.mech.unmount(loc, index);
    this.onChange();
  }

  onChange() {
    reskinMech(this, 'garageMech', this.mech);
    saveAllMechs(this.allMechs);
    this.refresh();
  }

  toast(msg, color = UI.bad) {
    if (this._toast) this._toast.destroy();
    this._toast = this.add.text(this.W / 2, this.H - 28, msg, {
      fontFamily: 'monospace', fontSize: '14px', color, backgroundColor: '#161b22', padding: { x: 8, y: 4 },
    }).setOrigin(0.5);
    this.tweens.add({ targets: this._toast, alpha: 0, delay: 1100, duration: 500, onComplete: () => this._toast?.destroy() });
  }

  // Deploy is inert unless the build is valid (all slots filled, mounts legal) — the tab-bar
  // Deploy button is greyed to match. Pressing Deploy on an invalid build no longer fails
  // silently: it toasts what's wrong and focuses the first empty slot (filtering the catalog
  // to what fits it) so the fix is one click away.
  deploy() {
    if (!this.mech.isComplete()) {
      const empty = MOUNT_LOCATIONS.filter((loc) => this.mech.usedSlots(loc) === 0);
      if (empty.length) {
        const names = empty.map((loc) => LOCATION_INFO[loc].short).join(', ');
        this.toast(`BUILD INCOMPLETE — fill ${names}`);
        if (this.selected !== empty[0]) this._selectSlot(empty[0]);   // focus + filter to the empty slot
      } else {
        this.toast('BUILD INVALID — check your mounts');
      }
      return;
    }
    this.mech.repairAll();
    saveAllMechs(this.allMechs);
    // Pick the battlefield biome per deployment (#67). Deterministic: rotate through the roster
    // so successive sorties visit each terrain set; the FIRST deploy of a session is grassland
    // (BIOME_IDS[0]), which keeps the headless smoke test's origin/DUMMY-hex assumptions stable.
    const n = this.registry.get('deployCount') || 0;
    this.registry.set('deployCount', n + 1);
    this.registry.set('arenaBiome', BIOME_IDS[n % BIOME_IDS.length]);
    // #64: a fresh deploy always starts a NEW run at stage 0 — clear any leftover run state
    // (a prior run's `run` registry value would otherwise look "in progress" to
    // ArenaScene._initRun, which continues an existing run rather than starting fresh).
    this.registry.set('run', null);
    this.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
    this.scene.start('ArenaScene');
  }
}
