import Phaser from 'phaser';
import { buildMechTextures, reskinMech, partSpriteTransform } from '../art/index.js';
import { Mech } from '../data/Mech.js';
import { CHASSIS_IDS } from '../data/chassis/index.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs, loadUnlocked, saveUnlocked, saveRunCurrency } from '../data/save.js';
import { WEAPON_IDS } from '../data/weapons.js';
import { isWeapon, getItem } from '../data/items.js';
import { costOf } from '../data/shop.js';
import { WEAPON_SLOTS, MELEE_LOCATIONS, MOUNT_LOCATIONS, LOCATION_INFO } from '../data/anatomy.js';
import { MECH_DEPLOYED, RUN_CURRENCY_KEY } from '../data/events.js';
import { RECENCY_WINDOW, pickNextBiome } from '../data/biomes.js';
import { PadEdges, PAD } from '../input/Controls.js';
import { TILE_ORDER, tileRow, drawSkillTile, TILE_UI } from '../ui/skillTiles.js';
import { buildTabBar, attachPadTabCycle, TAB_BAR_H } from '../ui/tabBar.js';
import { WeaponCardList } from '../ui/weaponCardList.js';
import { WeaponSfxPanel } from '../ui/weaponSfxPanel.js';
import { Slider } from '../ui/slider.js';
import { EXPLOSION_CATEGORIES, EXPLOSION_CATEGORY_LABEL, explosionSfxId } from '../audio/sfxParams.js';
import { DirRepeater, dominantDir, slotBindAction } from '../ui/padNav.js';
import { SFX_DOMAINS } from '../audio/sfxDomains.js';
import { Audio } from '../audio/index.js';

// The mech lab. The build is four weapon skill slots (#188: the old fifth "ability" slot —
// centerTorso, jumpJet/bubbleShield — is gone; Sprint is a hardcoded L3/Space toggle, never
// mounted), shown as a row of square "skill button" tiles
// (#26) along the bottom-left — one per slot, each showing its mounted item + fire bind. Click
// a tile to edit that slot: the catalog (the SHARED WeaponCardList, formerly also hosted by the
// now-retired Weapon Lab tab) filters to the items that fit it, each card running its live
// shot/fx preview. Click a card to mount it (or to unmount if it's already there) AND to open
// its sound-tuning sliders in the persistent right-side WeaponSfxPanel (#121) — the two aren't
// mutually exclusive, one click does both. A small strip above the catalog picks one of the
// #107 destruction-explosion size categories instead of a weapon, feeding the SAME panel. A
// small live mech preview + a chassis label sit bottom-right (#248: the chassis switch is
// disabled for now — light/heavy are off, every mech is locked to medium). "Deploy" (greyed
// until every slot is filled) enters the arena.
const UI = {
  text: '#c8d2dd', accent: '#5ec8e0', bad: '#e2533a', dim: '#7c8794',
  panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744, sel: 0xefc14a,
};
const PANEL_W = 300;
const PANEL_GAP = 14;
const EXPLOSION_ROW_H = 46;   // header line + one row of category buttons
const EXPLOSION_GAP = 10;     // gap below the row before the weapon catalog starts
// #178/#196/#207/#210: a small strip of buttons for the `ui` sfxDomains entries (equip/deploy/
// returnToGarage/menuNav/scrapPickup/the 5 per-powerup powerupPickup* cues/sprint on-off/the
// death-and-loss cues) — mirrors the #107 explosion-category row immediately above it, feeding the
// SAME WeaponSfxPanel via setTarget() so the owner can preview/trim/bake a real file over
// each new UI/pickup cue exactly like a weapon or explosion category. #207: 13 buttons
// crammed under one "UI / PICKUP SOUNDS" header read as a wall of tiny text, so the row is
// split into a few labeled subsections (UI_GROUPS below) — same button chrome/positioning
// per subsection, just narrower (fewer buttons per row) and stacked with their own headers.
const UI_ROW_H = 40;      // one subsection: its header line + one row of buttons
const UI_ROW_GAP = 8;     // gap between stacked subsection rows
const UI_GAP = 10;        // gap below the whole UI block before the autofire row
// Purely a display grouping over SFX_DOMAINS.ui — ids/labels/stages there are unchanged.
// Order within a group follows the id order below, not SFX_DOMAINS.ui's own order.
const UI_GROUPS = [
  { header: 'GENERAL UI', ids: ['equip', 'deploy', 'returnToGarage', 'menuNav'] },
  { header: 'PICKUPS', ids: ['scrapPickup', 'powerupPickupOvercharge', 'powerupPickupOverdrive', 'powerupPickupOverclock', 'powerupPickupArmorPatch', 'powerupPickupShield', 'powerupPickupBarrage'] },
  { header: 'SPRINT', ids: ['sprintOn', 'sprintOff'] },
  { header: 'DEATH / LOSS', ids: ['partDestroyed', 'mechDestroyed'] },
];
// #197: a small toggle button for the weapon catalog's auto-fire demo SOUND (each card's
// continuous live shot/beam animation always runs; this only mutes/unmutes the automatic
// fire/trajectory/impact sound it would otherwise play) — sits in its own thin row between
// the UI/pickup row and the catalog list, mirroring their button chrome.
const AUTOFIRE_ROW_H = 24;
const AUTOFIRE_GAP = 8;

// The skill-tile row (order, layout, drawing) is shared with the arena HUD via
// ../ui/skillTiles.js, so the two read identically. TILE_ORDER comes from there.

// Each slot's controller button, so pressing a slot's own bind quick-mounts the highlighted
// catalog item straight into it (#30). Mirrors SKILL_BINDS' pad labels: RT/LT triggers,
// RB/LB bumpers. #188: L3 dropped out — it's Sprint's fixed toggle now, not a mountable slot.
const SLOT_BUTTON = {
  leftArm: PAD.LT, rightArm: PAD.RT,
  leftTorso: PAD.LB, rightTorso: PAD.RB,
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
    this.cameras.main.fadeIn(400, 13, 16, 20);   // ~0x0d1014, matches the background color above (#215, mirrors #202's Arena fade)

    // Wire the shared pointermove/pointerup listeners that Slider._applyPointer needs to
    // track an in-progress drag (see slider.js) — the SFX panel's sliders live in this scene
    // since #121 folded WeaponSfxPanel in, so this scene must call it (mirrors MusicScene).
    Slider.attachDrag(this);

    this.allMechs = this.registry.get('allMechs');
    this.mech = this.allMechs[ACTIVE_MECH_KEY];
    // #249: every entry into the Garage (fresh boot, ESC from the Music tab, or — the bug —
    // returning from Arena after a run ends in a win OR a loss) must show a healthy mech. Damage
    // used to only get healed at the START of the NEXT deploy (see deploy() below), so the
    // bottom-right preview + paper-doll kept reading as destroyed for the whole time the player
    // was back in the Garage after a loss. repairAll() is idempotent (a no-op on an already-healthy
    // mech), so doing it unconditionally here — before textures are built below — is safe on every
    // path, not just the post-run one; deploy()'s own repairAll() stays as a harmless belt-and-braces.
    this.mech.repairAll();
    saveAllMechs(this.allMechs);
    this.selected = null;   // the slot currently being edited (filters the catalog)
    this.catalogIds = [...WEAPON_IDS];
    // #65: the permanently-unlocked catalog (meta-progression, persists across runs). Loaded
    // before the WeaponCardList so its isLocked/costOf callbacks see real data from frame one.
    this.unlocked = loadUnlocked();
    // #124: dev builds skip the unlock grind entirely — every weapon/equipment id starts
    // unlocked so playtesting isn't gated behind the shop. `import.meta.env.DEV` is Vite's
    // build-time flag (true under `npm run dev`, stripped to `false` — and dead-code-eliminated
    // — in `npm run build`/`vite build`), so this can never leak into a production bundle. Kept
    // here (a Phaser scene) rather than in data/save.js or data/shop.js: those are pure `data/`
    // modules with no Vite/browser dependency today, and Vitest doesn't run through Vite's env
    // injection the same way, so importing `import.meta.env` there risks breaking `npm test`.
    if (import.meta.env.DEV) {
      for (const id of this.catalogIds) this.unlocked.add(id);
    }

    // Layout: the top region holds the weapon catalog (shared WeaponCardList) + a persistent
    // SFX panel on the right (#121, see _topRegion); a bottom strip holds the skill tiles
    // (left) and the small live mech preview + chassis switch (right).
    this.bottomH = 200;                             // bottom strip height (tiles + preview)
    this.previewW = 210;                            // right slice of the strip for the preview
    this.dollX = 20;
    this.dollW = this.W - this.previewW - 60;
    this._rowBottom = this.H - 22;                  // tile-row bottom edge

    buildMechTextures(this, 'garageMech', this.mech);

    // #121 follow-up: the SCRAP/last-run readout (below) is right-anchored to the raw screen
    // edge, independent of the SFX panel — at narrow widths the panel's left-aligned header
    // text ("Select a weapon" / a weapon name) and that right-anchored readout end up in the
    // same row with no gap between them and visibly collide. Starting the WHOLE catalog region
    // (list/panel/explosion row) below the two-line readout instead of right under the tab bar
    // keeps them on separate rows at every width, so there's no shared horizontal band to
    // collide in. CATALOG_TOP_GAP clears currencyText + lastRunText (2 lines, see below).
    const CATALOG_TOP_GAP = 54;
    const catalogTop = TAB_BAR_H + CATALOG_TOP_GAP;
    // #121: the top catalog region is split list+panel (mirrors the retired Weapon Lab's
    // _region()) — the catalog gets the remaining width after the fixed-width SFX panel, with
    // the #107 explosion-category row sitting above the catalog, feeding the same panel.
    const r = this._topRegion(catalogTop);
    this.selectedExplosion = null;
    this.selectedUi = null;
    // Picking a card both mounts it into the selected slot (unchanged Garage behavior) AND
    // opens its sound-tuning sliders in the panel (formerly the Weapon Lab's job) — see
    // _onCardSelect.
    this.list = new WeaponCardList(this, {
      x: r.list.x, y: r.list.y, w: r.list.w, h: r.list.h,
      ids: this.catalogIds, onSelect: (id) => this._onCardSelect(id),
      isLocked: (id) => !this.unlocked.has(id),
      costOf: (id) => costOf(id),
    });
    // #296: the whole sound-authoring surface — the WeaponSfxPanel (per-weapon SFX sliders/
    // preview/bake) plus the explosion-category / UI-sound / catalog-demo-sound trigger rows that
    // feed it — is a dev-only tool. Built only under `import.meta.env.DEV` (Vite's build-time flag,
    // stripped/dead-code-eliminated in `npm run build`), so a production garage shows none of it and
    // the weapon catalog takes the whole region (see _topRegion). Every call site that touches
    // `this.panel` / the row state (_onCardSelect, shutdown) is guarded to match. The catalog cards'
    // own auto-fire demo SOUND stays silent in prod for free: its toggle (the gated autofire row)
    // never turns on, and WeaponCardList defaults `autoFireEnabled` to false.
    if (import.meta.env.DEV) {
      this.panel = new WeaponSfxPanel(this, r.panel);
      this.panelEdge = this.add.rectangle(r.panel.x - PANEL_GAP / 2, r.panel.y, 1, r.panel.h, UI.panelEdge).setOrigin(0.5, 0);
      this._buildExplosionRow(r.explosion);
      this._buildUiRow(r.ui);
      this._buildAutofireRow(r.autofire);
    }

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

    // Controller support (#29 deploy + #30 + #70): CATALOG-FIRST. The pad focus lives in the
    // catalog from the first pad press — the whole unfiltered weapon set, never a per-slot
    // filter. D-pad/left-stick up-down browse it with auto-scroll; a slot's own fire bind
    // (RT/LT/RB/LB) ASSIGNS the highlighted item into that slot, or CLEARS it if the slot
    // already holds exactly that item. There is no tile-first gate: the tile row still renders
    // (mounts + binds) but is not a pad focus zone. Focus visuals + the button legend only
    // appear once a pad button is used (`padActive`), so mouse/keyboard users see no cursor.
    this.padEdges = new PadEdges(this);
    this.inputMode = 'kbm';       // which scheme the tile bind labels reflect (#26)
    this.padActive = false;       // pad in use → show the catalog cursor + legend
    this.dirRepeat = new DirRepeater();   // shared d-pad/stick step auto-repeat
    attachPadTabCycle(this, 'GarageScene');   // SELECT cycles the top tabs
    // The pad button legend, along the very bottom under the tile row. Text set per-zone.
    this.legend = this.add.text(this.dollX + this.dollW / 2, this.H - 11, '', {
      fontFamily: 'monospace', fontSize: '10px', color: '#7c8794',
    }).setOrigin(0.5).setVisible(false);

    this.refresh();

    this.input.keyboard.on('keydown-D', () => this.deploy());
    // #248: the keyboard 'C' cycle-chassis shortcut is disabled along with the rest of the
    // chassis switcher (see cycleChassis + _buildPreview below) — light/heavy are off for now.
    this.input.keyboard.on('keydown-ESC', () => this._selectSlot(null));
    this.events.once('shutdown', () => {
      this.list.destroy();
      // #296: the SFX panel + explosion row only exist in dev builds — guard their teardown.
      if (import.meta.env.DEV) {
        this.panel.destroy();
        this.explosionHeader.destroy();
        for (const b of this.explosionButtons) { b.rect.destroy(); b.text.destroy(); }
      }
    });

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

  // Switch the displayed control scheme (and focus-cursor/legend visibility), redrawing once.
  // Waking the pad drops focus into the full catalog (catalog-first, #70); dropping back to
  // kbm restores the mouse's slot-filtered view so no stale pad state lingers under the mouse.
  _setInputMode(mode) {
    if (this.inputMode === mode) return;
    this.inputMode = mode;
    this.padActive = mode === 'pad';
    if (mode === 'pad') this._enterCatalogFull();
    else this._restoreMouseCatalog();
    this.refresh();
  }

  // Catalog-first pad entry: show the whole unfiltered catalog, clear any mouse slot
  // selection, and put the focus cursor on the first card. Never calls the slot-filtering
  // _selectSlot — the pad path always browses the full id set.
  _enterCatalogFull() {
    this.selected = null;
    this.list.setIds(this.catalogIds);
    this.list.setSelected(null);
    this.list.setFocus(0);
  }

  // Return to the mouse's expected state: the slot-filtered catalog (or the full set when no
  // slot is selected), the mounted item highlighted, and no pad focus cursor.
  _restoreMouseCatalog() {
    this.list.setIds(this._eligibleIds(this.selected));
    this.list.setSelected(this.selected ? this.mech.mounts[this.selected][0] ?? null : null);
    this.list.setFocus(null);
  }

  // Per-frame: tick the live catalog previews, then handle the gamepad (#70, catalog-first).
  // D-pad/left-stick up-down browse the full catalog with auto-scroll. A slot's own fire bind
  // (RT/LT/RB/LB) ASSIGNS the highlighted item into that slot, or CLEARS it if the slot
  // already holds exactly that item; a locked item routes to purchase instead. Start deploys,
  // Select cycles tabs (attachPadTabCycle). (#248: the X/Y chassis-cycle shortcut is disabled
  // for now — see cycleChassis.) The first pad press of a session just wakes the cursor
  // (reveals it at the top of the catalog).
  update(time, delta) {
    this.list.update(time, delta);

    const e = this.padEdges;
    const pad = e.pad();
    if (!pad) return;

    if (e.pressed(PAD.START)) { this.deploy(); return; }
    // #248: X/Y chassis-cycle pad shortcut disabled along with the rest of the switcher.

    for (const loc of TILE_ORDER) {
      if (e.pressed(SLOT_BUTTON[loc])) {
        if (this._wakePad()) return;   // first pad press just reveals the catalog cursor
        this._slotBind(loc);
        return;
      }
    }

    const step = this.dirRepeat.step(this._padDir(pad), this.time.now);
    if (!step) return;
    if (this._wakePad()) return;       // first pad press just reveals the catalog cursor at 0
    if (step === 'up') this.list.moveFocus(-1);
    else if (step === 'down') this.list.moveFocus(+1);
  }

  // Reveal the pad cursor on the first pad use. Returns true when this call was that first
  // wake, so the caller treats the press as "show me the cursor" rather than an action.
  _wakePad() {
    if (this.padActive) return false;
    this._setInputMode('pad');
    return true;
  }

  // The held 4-way direction this frame — d-pad first, else the left stick's dominant axis.
  _padDir(pad) {
    const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    if (btn(PAD.DPAD_UP)) return 'up';
    if (btn(PAD.DPAD_DOWN)) return 'down';
    if (btn(PAD.DPAD_LEFT)) return 'left';
    if (btn(PAD.DPAD_RIGHT)) return 'right';
    const s = pad.leftStick;
    return s ? dominantDir(s.x, s.y) : null;
  }

  // A slot's fire bind (RT/LT/RB/LB): assign the highlighted catalog item straight into
  // that slot — "highlight the autocannon, pull RT to put it in the right arm." A bind
  // always mounts/replaces and never removes; re-pressing a bind while the slot already
  // holds that exact item is a no-op (it stays mounted, #70). An invalid target (melee
  // outside an arm) toasts via _mountInto; a locked item routes to purchase.
  _slotBind(loc) {
    const id = this.list.focusedId();
    if (id) this._quickMount(loc, id);
  }

  _quickMount(loc, id) {
    if (!this.unlocked.has(id)) { this._purchase(id); return; }
    // A slot bind always mounts / replaces; re-pressing the same item is a no-op (#70). A
    // slot bind never removes a weapon — there's no toggle-off, and no separate pad clear.
    if (slotBindAction(this.mech.mounts[loc][0] ?? null, id) === 'mount') this._mountInto(loc, id);
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

  // Swap to the next chassis, carrying the loadout over (all chassis share the same four
  // weapon skill slots, so mounts stay valid).
  // #248: unreachable from the UI for now — the keyboard/pad shortcuts and the chassis-switch
  // button are all disabled (light/heavy chassis are off; every mech is locked to medium via
  // rosters.js's `migrate` hook). Left in place, untouched, so re-wiring a control back to it
  // is the entire job of re-enabling the switcher later.
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
  // selected, the whole catalog shows. #188: every catalog id is a weapon now (no more
  // ability branch) — a slot just filters by weapon-slot / melee-arm legality.
  _eligibleIds(loc) {
    if (!loc) return this.catalogIds;
    return this.catalogIds.filter((id) => {
      if (!isWeapon(id) || !WEAPON_SLOTS.includes(loc)) return false;
      if (getItem(id).category === 'melee' && !MELEE_LOCATIONS.includes(loc)) return false;
      return true;
    });
  }

  // Select a slot to edit: filter the catalog to what fits it and highlight the mounted item.
  _selectSlot(loc) {
    Audio.ui('menuNav');   // #178: short quiet blip — skill-tile focus change
    this.selected = this.selected === loc ? null : loc;
    this.list.setIds(this._eligibleIds(this.selected));
    this.list.setSelected(this.selected ? this.mech.mounts[this.selected][0] ?? null : null);
    this.refresh();
  }

  // #121: split the top catalog area into a list region (remaining width) and a fixed-width
  // SFX panel + explosion-category row above it, mirroring the retired Weapon Lab's _region().
  _topRegion(top) {
    const bottom = this.H - this.bottomH - 16;
    // #296: production has no SFX panel or sound-trigger rows (see create()), so the weapon
    // catalog spans the whole region — full width, starting right at `top`. Only the dev build
    // reserves space for the panel/rows below.
    if (!import.meta.env.DEV) {
      return { list: { x: 20, y: top, w: this.W - 40, h: bottom - top } };
    }
    const listW = Math.max(280, this.W - 40 - PANEL_W - PANEL_GAP);
    // #207: the UI/pickup strip is now UI_GROUPS.length stacked subsection rows instead of
    // one, so its total height is the sum of those rows plus the gaps between them.
    const uiH = UI_GROUPS.length * UI_ROW_H + (UI_GROUPS.length - 1) * UI_ROW_GAP;
    const uiTop = top + EXPLOSION_ROW_H + EXPLOSION_GAP;
    const autofireTop = uiTop + uiH + UI_GAP;
    const listTop = autofireTop + AUTOFIRE_ROW_H + AUTOFIRE_GAP;
    return {
      explosion: { x: 20, y: top, w: listW, h: EXPLOSION_ROW_H },
      ui: { x: 20, y: uiTop, w: listW, h: uiH },
      autofire: { x: 20, y: autofireTop, w: listW, h: AUTOFIRE_ROW_H },
      list: { x: 20, y: listTop, w: listW, h: bottom - listTop },
      panel: { x: 20 + listW + PANEL_GAP, y: top, w: PANEL_W - PANEL_GAP, h: bottom - top },
    };
  }

  // Selecting a catalog card does both of its jobs at once (#121): mount it into the selected
  // slot (Garage's existing behavior, _pickItem) AND populate the SFX panel with it (formerly
  // the Weapon Lab's _select) — the two don't conflict, since mounting doesn't need exclusive
  // control of "which card is selected for tuning."
  _onCardSelect(id) {
    this.selectedExplosion = null;
    this.selectedUi = null;
    // #296: the SFX panel + its category/UI trigger rows only exist in dev builds — in production
    // a card click just mounts the item (below). Guarded so a null panel/absent rows can't throw.
    if (import.meta.env.DEV) {
      this.panel.setWeapon(id);
      this._paintExplosionRow();
      this._paintUiRow();
    }
    this._pickItem(id);
  }

  // #107: the destruction-explosion size-category row — a fixed strip of 4 buttons (small/
  // medium/large/massive) above the catalog. Picking one feeds its sfxParams id
  // (explosionSfxId) into the SAME WeaponSfxPanel a weapon card would, with a friendly label
  // instead of the raw id, so tuning an explosion category is the identical slider/preview/
  // reset flow the weapon-sound cards already use — just a different id going into the panel.
  _buildExplosionRow(region) {
    this.explosionHeader = this.add.text(region.x, region.y, 'DESTRUCTION EXPLOSION — size category', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    });
    this.explosionButtons = EXPLOSION_CATEGORIES.map((category, i) => {
      const rect = this.add.rectangle(0, 0, 10, 22, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
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

  // Explosion-category selection is independent of the catalog's mount-highlight state (unlike
  // the retired Weapon Lab, where selecting a card and selecting a category were mutually
  // exclusive) — it only drives the SFX panel + its own row's highlight.
  _selectExplosion(category) {
    this.selectedExplosion = category;
    this.selectedUi = null;
    this.panel.setWeapon(explosionSfxId(category), EXPLOSION_CATEGORY_LABEL[category]);
    this._paintExplosionRow();
    this._paintUiRow();
  }

  _paintExplosionRow() {
    for (const b of this.explosionButtons) {
      const on = b.category === this.selectedExplosion;
      b.rect.setFillStyle(on ? 0x1b2430 : UI.btn).setStrokeStyle(on ? 2 : 1, on ? UI.sel : UI.panelEdge);
    }
  }

  // #178/#196: the `ui` sfxDomains buttons (equip/deploy/menuNav/scrapPickup/5x
  // powerupPickup*/sprint on-off/3x death-and-loss) — one per registered UI/pickup sound,
  // mirroring the #107 explosion row directly above it. Picking one feeds its (id, stages)
  // into the SAME WeaponSfxPanel a weapon card or explosion category would, so the owner
  // gets the identical slider/preview/reset/bake flow for these new stub cues.
  // #207: one header + button row per UI_GROUPS entry, stacked top to bottom. this.uiButtons
  // stays a single flat array (across all groups) since _paintUiRow/_selectUi/shutdown just
  // need "every button", but each entry also remembers which group row it belongs to (`row`)
  // and its index within that row (`i`) for layout.
  _buildUiRow(region) {
    const byId = new Map(SFX_DOMAINS.ui.map((entry) => [entry.id, entry]));
    this.uiHeaders = UI_GROUPS.map((group) => this.add.text(region.x, region.y, group.header, {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    }));
    this.uiButtons = [];
    UI_GROUPS.forEach((group, row) => {
      group.ids.forEach((id, i) => {
        const entry = byId.get(id);
        const rect = this.add.rectangle(0, 0, 10, 22, UI.btn).setOrigin(0, 0)
          .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
        const text = this.add.text(0, 0, entry.label, {
          fontFamily: 'monospace', fontSize: '10px', color: UI.text,
        }).setOrigin(0.5);
        rect.on('pointerover', () => { if (this.selectedUi !== entry.id) rect.setFillStyle(UI.btnHover); });
        rect.on('pointerout', () => this._paintUiRow());
        rect.on('pointerdown', () => this._selectUi(entry));
        this.uiButtons.push({ entry, rect, text, row, i });
      });
    });
    this._layoutUiRow(region);
  }

  _layoutUiRow(region) {
    const gap = 6;
    this.uiHeaders.forEach((header, row) => {
      header.setPosition(region.x, region.y + row * (UI_ROW_H + UI_ROW_GAP));
    });
    for (const group of UI_GROUPS) {
      const row = UI_GROUPS.indexOf(group);
      const buttons = this.uiButtons.filter((b) => b.row === row);
      const bw = Math.floor((region.w - gap * (buttons.length - 1)) / buttons.length);
      const by = region.y + row * (UI_ROW_H + UI_ROW_GAP) + 18;
      for (const b of buttons) {
        const bx = region.x + b.i * (bw + gap);
        b.rect.setPosition(bx, by).setSize(bw, 22);
        b.text.setPosition(bx + bw / 2, by + 11);
      }
    }
  }

  // Selecting a UI/pickup sound is independent of the catalog + explosion-row state (same as
  // explosion categories) — it only drives the SFX panel + its own row's highlight. Also plays
  // the cue immediately so clicking the row is itself a quick preview.
  _selectUi(entry) {
    this.selectedUi = entry.id;
    this.selectedExplosion = null;
    this.panel.setTarget(entry.id, { label: entry.label, stages: entry.stages });
    this._paintExplosionRow();
    this._paintUiRow();
    Audio.ui(entry.id, entry.stages[0][0]);
  }

  _paintUiRow() {
    for (const b of this.uiButtons) {
      const on = b.entry.id === this.selectedUi;
      b.rect.setFillStyle(on ? 0x1b2430 : UI.btn).setStrokeStyle(on ? 2 : 1, on ? UI.sel : UI.panelEdge);
    }
  }

  // #197: the catalog's auto-fire demo SOUND toggle — each weapon card auto-fires a live
  // shot/beam preview on a loop regardless (that visual animation is unaffected), but it also
  // plays its real fire/trajectory/impact sound automatically, which is noisy/distracting
  // just browsing the catalog or tuning sounds in the adjacent panel. Defaults OFF (see
  // WeaponCardList.loadAutoFireEnabled); this button flips it on the shared list instance,
  // which owns both persistence and the actual audio gate (_isAudible).
  _buildAutofireRow(region) {
    this.autofireBtn = this.add.rectangle(region.x, region.y, region.w, region.h, UI.btn)
      .setOrigin(0, 0).setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
    this.autofireText = this.add.text(region.x + region.w / 2, region.y + region.h / 2, '', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.text,
    }).setOrigin(0.5);
    this.autofireBtn.on('pointerover', () => { if (!this.list.autoFireEnabled) this.autofireBtn.setFillStyle(UI.btnHover); });
    this.autofireBtn.on('pointerout', () => this._paintAutofireRow());
    this.autofireBtn.on('pointerdown', () => {
      this.list.setAutoFireEnabled(!this.list.autoFireEnabled);
      this._paintAutofireRow();
    });
    this._paintAutofireRow();
  }

  _paintAutofireRow() {
    const on = this.list.autoFireEnabled;
    this.autofireText.setText(on ? 'CATALOG DEMO SOUND: ON (click to mute)' : 'CATALOG DEMO SOUND: OFF (click to unmute)');
    this.autofireBtn.setFillStyle(on ? 0x1b2430 : UI.btn).setStrokeStyle(on ? 2 : 1, on ? UI.sel : UI.panelEdge);
  }

  // Pick a catalog item: mount it into the selected slot. With no slot selected, picking a card
  // selects the first slot it fits. Selecting a weapon never removes it — re-clicking the item
  // already mounted in the selected slot is a no-op (#70); only choosing a DIFFERENT item
  // replaces. #65: a LOCKED item can't be mounted at all — clicking it attempts to buy it
  // instead (spends SCRAP, permanent).
  _pickItem(id) {
    if (!this.unlocked.has(id)) { this._purchase(id); return; }
    if (!this.selected) {
      const loc = this._eligibleSlotFor(id);
      if (loc) this._selectSlot(loc);
      return;
    }
    const cur = this.mech.mounts[this.selected][0];
    if (cur !== id) this._mountInto(this.selected, id);   // same item → no-op, stays mounted
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
  // right slice with a chassis label beneath it. The sprites reference fixed texture keys;
  // onChange re-skins those textures in place.
  // #248: light/heavy chassis are disabled for now, so the clickable chassis-switch button is
  // replaced with a plain, non-interactive label (no rect, no hover, no onClick) — just enough
  // to still show which chassis is mounted. Swap this back to a `this.button(...)` call (see
  // cycleChassis) to re-enable switching.
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
    this.add.text(cx, this.H - 34 + 13, this.mech.chassis.name.toUpperCase(), {
      fontFamily: 'monospace', fontSize: '13px', color: UI.dim,
    }).setOrigin(0.5);
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
  // Also rebuilds the tab bar so Deploy reflects the current build validity, and repaints
  // the pad legend (the catalog-first button map; hidden entirely under mouse/keyboard).
  refresh() {
    this._buildHeader();
    this.doll.removeAll(true);
    for (const rect of this._tileRow()) this._drawTile(rect);
    this.legend?.setText(this._legendText()).setVisible(this.padActive);
  }

  _legendText() {
    // #248: 'X/Y CHASSIS' dropped — the chassis switcher is disabled for now.
    return '▲▼ BROWSE   RT/LT/RB/LB ASSIGN   RE-PRESS CLEARS   SELECT TABS   START DEPLOY';
  }

  _drawTile(rect) {
    const loc = rect.loc;
    const id = this.mech.mounts[loc][0];   // one skill per slot
    const selected = loc === this.selected;
    const refs = drawSkillTile(this, this.doll, rect, {
      loc, itemId: id, mode: this.inputMode, selected,
      subtitle: id ? getItem(id).name : '', subtitleColor: TILE_UI.text,
    });
    // Catalog-first pad flow (#70): the pad cursor lives on a catalog card, not the tile row,
    // so tiles carry no pad focus ring — they just render the current mounts + fire binds.
    // Click a tile to edit that slot — the catalog filters to what fits it (mouse path).
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
    Audio.ui('equip');   // #178: confident mechanical clunk-click — fresh mount or a swap
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
    Audio.ui('deploy');   // #178: weightier rising anticipation whoosh — committing to the run
    this.mech.repairAll();
    saveAllMechs(this.allMechs);
    // Pick the battlefield biome per deployment (#67, reworked #217). The FIRST deploy of a
    // session is uniformly random across every biome (no fixed grassland); every deploy after
    // that weights AWAY from recently-seen biomes without ever making one impossible — the
    // actual weighting/pick math is pure and unit-tested in data/biomes.js (`pickNextBiome`).
    // `biomeHistory` is a short in-memory rolling log of the last few picks, purely used to
    // compute those weights (reset every session, same as `deployCount`).
    //
    // Test hook (#217): `scripts/smoke.mjs` needs a DETERMINISTIC first biome (grassland) so its
    // origin/DUMMY-hex terrain assumptions hold across runs. Rather than branching gameplay code
    // on "are we in test mode," the smoke script can set `debugForceBiome` on the registry before
    // calling deploy() to pin the very next pick; it's consumed once here and cleared, so it
    // never affects any deploy after the one it was set for.
    const n = this.registry.get('deployCount') || 0;
    this.registry.set('deployCount', n + 1);
    const forced = this.registry.get('debugForceBiome');
    const history = this.registry.get('biomeHistory') || [];
    const biome = forced || pickNextBiome(history, Math.random);
    if (forced) this.registry.set('debugForceBiome', null);
    this.registry.set('biomeHistory', [...history, biome].slice(-RECENCY_WINDOW));
    this.registry.set('arenaBiome', biome);
    // #64: a fresh deploy always starts a NEW run at stage 0 — clear any leftover run state
    // (a prior run's `run` registry value would otherwise look "in progress" to
    // ArenaScene._initRun, which continues an existing run rather than starting fresh).
    this.registry.set('run', null);
    this.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
    this.scene.start('ArenaScene');
  }
}
