import Phaser from 'phaser';
import { buildMechTextures, reskinMech, HULL_FRAMES, itemFxKey } from '../art/index.js';
import { playerMechArt } from '../art/playerMechLook.js';
import { makeMechParts, poseMechParts } from '../art/mechView.js';
import { mechColorFor, swatchName, cycleSwatch } from '../data/mechColors.js';
import { saveAllMechs, loadUnlocked, saveUnlocked, saveRunCurrency } from '../data/save.js';
import { WEAPON_IDS } from '../data/weapons.js';
import { ABILITIES } from '../data/abilities.js';
import { CORE_ITEMS } from '../data/coreItems.js';
import { isWeapon, getItem } from '../data/items.js';
import { costOf } from '../data/shop.js';
import {
  WEAPON_SLOTS, MELEE_LOCATIONS, ABILITY_SLOTS, CORE_SLOTS, MOUNT_LOCATIONS, LOCATION_INFO, slotKind,
} from '../data/anatomy.js';
import { RUN_CURRENCY_KEY } from '../data/events.js';
import { PadEdges, PAD } from '../input/Controls.js';
import { TILE_ORDER, tileRow, drawSkillTile, updateSkillTile, diamondLayout, coreTileRect } from '../ui/skillTiles.js';
import { stepIndex, cycleListId } from '../ui/padNav.js';
import { PLAYER_MECH_KEYS, MAX_GARAGE_PLAYERS, canJoin } from '../data/coopGarage.js';
import { makeSimulSession, joinSimulPlayer, toggleReady, allReady, activeIndices } from '../data/simulGarage.js';
import { buildTabBar, TAB_BAR_H } from '../ui/tabBar.js';
import { Audio } from '../audio/index.js';
import { StatsOverlay } from './garage/statsOverlay.js';
import { wirePauseMenu } from './PauseMenuScene.js';

// The mech lab (#505 rework — this scene absorbed the SIMULTANEOUS multi-cursor build layout
// that used to live as a separate SimulGarageScene, per Jackson's playtest feedback: "the
// separate 'simul' menu is weird... it should just BECOME that way when/if you add a second
// player," and — the follow-up correction — "the 1p garage should be basically identical to the
// 2-4p garage, just less horizontally squished." So there is now exactly ONE layout: every
// joined player (1..MAX_GARAGE_PLAYERS) gets its own vertical COLUMN, all built/edited at the
// same time, no handoff, no separate scene to navigate to. A solo player's column simply spans
// the full width; a join reflows every column to the new, narrower width. There is deliberately
// no reserved placeholder column for an unjoined player — that was the exact "squished next to
// 3 empty columns" complaint — the join affordance is just a hint line in the header band, and
// pressing START on an unclaimed pad grows the column count (mirrors the arena's mid-sortie join,
// scenes/arena/coop.js).
//
// Readiness replaces the old sequential "P1 READY" handoff: each column has its own READY pill
// (mouse-clickable, or its pad's START). The scene deploys the instant every joined column is
// ready — which for a lone player just means "press ready, go," identical in feel to the old
// single-player Deploy button.
//
// The condensed square-icon catalog (one column-sized grid, no scrolling, no live per-card fx
// preview) replaces the old full-width animated WeaponCardList — that catalog assumed exactly one
// editing surface on screen; a layout that can show up to four at once needs a much smaller
// footprint per column, and it is now what every player count sees, including solo.
//
// This still deploys onto the same four persistent build slots (data/rosters.js's mech1..mech4,
// PLAYER_MECH_KEYS) and publishes the same registry keys (`coopMechKeys`/`coopPlayerCount`) the
// arena reads.
const UI = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', bad: '#e2533a', good: '#7bd17b',
  panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744,
};

// Pad up/down cycle order through a column's seven slots (four weapon + two ability + core).
const ALL_SLOTS = [...TILE_ORDER, ...ABILITY_SLOTS, ...CORE_SLOTS];

// The header band under the shared tab bar: SCRAP/last-run readout + the "another controller can
// join" hint. Columns start below this.
const HEADER_BAND_H = 34;

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
    this.cameras.main.fadeIn(400, 13, 16, 20);   // ~0x0d1014, matches the background color above

    this.allMechs = this.registry.get('allMechs');
    // #249/#349: every entry into the Garage (fresh boot, ESC from another tab, or returning from
    // Arena after a run ends in a win OR a loss) must show every joined player's mech healthy —
    // there is no second create() to heal a column once it's on screen. Idempotent, so doing it
    // unconditionally here (before any column bakes its textures) is safe on every path.
    for (const key of PLAYER_MECH_KEYS) this.allMechs[key]?.repairAll();
    saveAllMechs(this.allMechs);

    this.catalogIds = [...WEAPON_IDS];
    // #65: the permanently-unlocked catalog (meta-progression, persists across runs).
    this.unlocked = loadUnlocked();
    // #124: dev builds skip the unlock grind entirely.
    if (import.meta.env.DEV) {
      for (const id of this.catalogIds) this.unlocked.add(id);
    }

    // The co-op session `{ count, ready }` (data/simulGarage.js). `count` survives a return from
    // the arena (so a squad coming back from a run finds every column still there); `ready`
    // always resets — a fresh garage visit re-declares readiness rather than remembering it.
    this.session = makeSimulSession({ count: this.registry.get('coopPlayerCount') || 1 });

    this.colTop = TAB_BAR_H + HEADER_BAND_H;
    this.cols = [];

    // #445: the dev-only run-stats overlay, opened from the tab bar's STATS action.
    if (import.meta.env.DEV) this._statsOverlay = new StatsOverlay(this);

    this._refreshHeader();
    this.currencyText = this.add.text(this.W - 16, TAB_BAR_H + 6, '', {
      fontFamily: 'monospace', fontSize: '13px', color: UI.accent,
    }).setOrigin(1, 0);
    this.lastRunText = this.add.text(this.W - 16, TAB_BAR_H + 21, '', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    }).setOrigin(1, 0);
    this.joinHint = this.add.text(16, TAB_BAR_H + 12, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#efc14a',
    }).setOrigin(0, 0.5);
    this._refreshCurrency();
    this._refreshJoinHint();

    this._relayoutColumns();

    // One PadEdges per pad index 0..MAX-1, reused whether that index is claimed or not — an
    // unclaimed one is only ever polled for START (join); a claimed one drives its own column.
    this.padEdges = [];
    for (let i = 0; i < MAX_GARAGE_PLAYERS; i++) this.padEdges[i] = new PadEdges(this, i);

    // The keyboard/mouse player is always column 0 (mirrors input/Controls.js — only player 0
    // ever owns the keyboard). 'D' readies/unreadies them, '.'/',' cycle their colour, 'B' bails
    // back to base without deploying.
    this.input.keyboard.on('keydown-D', () => this._toggleReady(0));
    this.input.keyboard.on('keydown-B', () => this.scene.start('BaseScene'));
    this.input.keyboard.on('keydown-PERIOD', () => this._cycleColor(this.cols[0], +1));
    this.input.keyboard.on('keydown-COMMA', () => this._cycleColor(this.cols[0], -1));

    // #523: ESC always opens the shared pause menu.
    wirePauseMenu(this);
  }

  // ── Header chrome (tab bar + SCRAP/last-run + join hint) ─────────────────────────────────────
  _refreshHeader() {
    this.tabBar?.layer.destroy();
    const ready0 = !!this.session.ready[0];
    this.tabBar = buildTabBar(this, {
      active: 'GarageScene',
      canDeploy: true,
      onDeploy: () => this._toggleReady(0),
      deployLabel: ready0 ? '✓ READY' : '▶ READY',
      actions: [
        ...(import.meta.env.DEV ? [{ key: 'STATS', onClick: () => this._statsOverlay.open() }] : []),
      ],
    });
  }

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

  _refreshJoinHint() {
    this.joinHint.setText(canJoin(this.session) ? 'START ON ANOTHER CONTROLLER ADDS A PLAYER' : '');
  }

  // ── Column layout ─────────────────────────────────────────────────────────────────────────────
  // Rebuild every joined column at the CURRENT column width (W / count) — called at create() and
  // again on every join, so an existing column reflows wider→narrower as the squad grows, and a
  // solo column always fills the whole width rather than sitting squished next to empty ones.
  _relayoutColumns() {
    for (const col of this.cols) col?.layer?.destroy(true);
    this.cols = [];
    this.colW = Math.floor(this.W / this.session.count);
    this.colH = this.H - this.colTop;
    for (const i of activeIndices(this.session)) this._buildColumn(i);
  }

  // Build every element of column `i` from its own persistent mech slot. All coordinates are
  // LOCAL to `col.layer` (whose position IS the column's screen offset).
  _buildColumn(i) {
    const layer = this.add.container(i * this.colW, this.colTop);
    const col = { index: i, layer, selectedSlot: TILE_ORDER[0] };
    this.cols[i] = col;
    col.mech = this.allMechs[PLAYER_MECH_KEYS[i]];
    col.textureKey = `garageMech${i}`;
    buildMechTextures(this, col.textureKey, col.mech, this._artFor(col));

    const w = this.colW, h = this.colH;
    const pad = 8;
    const innerW = w - pad * 2;

    // Section heights, top to bottom: header, catalog, weapon row, ability row, preview, colour.
    const HEADER_H = 30, WEAPON_ROW_H = 66, ABILITY_ROW_H = 56, PREVIEW_BOX = Math.min(150, innerW), COLOR_H = 30, GAP = 8;
    const catalogY = HEADER_H + GAP;
    const catalogH = Math.max(70, h - HEADER_H - WEAPON_ROW_H - ABILITY_ROW_H - PREVIEW_BOX - COLOR_H - GAP * 5);
    const weaponY = catalogY + catalogH + GAP;
    const abilityY = weaponY + WEAPON_ROW_H + GAP;
    const previewY = abilityY + ABILITY_ROW_H + GAP;
    const colorY = previewY + PREVIEW_BOX + GAP;

    col.rects = { catalog: { x: pad, y: catalogY, w: innerW, h: catalogH }, weaponY, abilityY, previewY, colorY, pad, innerW };

    // Header: player number (in their colour) + a clickable READY pill.
    col.headerColor = this.add.rectangle(pad, 6, 12, 12, mechColorFor(col.mech, i)).setOrigin(0, 0);
    col.headerLabel = this.add.text(pad + 18, 12, `PLAYER ${i + 1}`, {
      fontFamily: 'monospace', fontSize: '13px', color: UI.text,
    }).setOrigin(0, 0.5);
    col.readyBg = this.add.rectangle(w - pad - 70, 4, 70, 20, UI.btn).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this._toggleReady(i));
    col.readyText = this.add.text(w - pad - 35, 14, 'READY?', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    }).setOrigin(0.5);
    col.layer.add([col.headerColor, col.headerLabel, col.readyBg, col.readyText]);

    // The weapon-tile row (shared layout with the arena HUD) + the ability diamond + core tile.
    col.tileRefs = {};
    for (const rect of tileRow(pad, innerW, { y: weaponY, maxSize: 60 })) this._drawColTile(col, rect);
    const abilCx = pad + innerW / 2, abilCy = abilityY + ABILITY_ROW_H / 2;
    for (const rect of diamondLayout(abilCx, abilCy, { size: 40 })) this._drawColTile(col, rect);
    this._drawColTile(col, coreTileRect(abilCx, abilCy, 28));

    // The condensed catalog grid — rebuilt whenever the selected slot (or a mount) changes.
    col.catalogIcons = [];
    this._refreshCatalog(col);

    // The live mech preview — built ONCE; every later mount/colour change re-bakes the SAME
    // texture key in place (buildMechTextures/reskinMech), so these sprites never need rebuilding.
    const previewCx = pad + innerW / 2, previewCy = previewY + PREVIEW_BOX / 2;
    col.previewPanel = this.add.rectangle(previewCx, previewCy, PREVIEW_BOX, PREVIEW_BOX, 0x10151c)
      .setStrokeStyle(1, UI.panelEdge);
    const scale = (PREVIEW_BOX - 24) / 230;
    col.previewScale = scale; col.previewCx = previewCx; col.previewCy = previewCy;
    col.preview = makeMechParts(this, col.textureKey, { x: previewCx, y: previewCy, scale, isPlayer: true });
    col.layer.add([col.previewPanel, ...col.preview.children]);
    poseMechParts(col.preview, col.mech, -Math.PI / 2, scale, previewCx, previewCy, {});

    // The colour cycle — bottom of the column. Click either half to cycle forward; the pad's
    // d-pad left/right (see update()) is the primary control.
    const cy = colorY + COLOR_H / 2;
    col.colorSwatch = this.add.rectangle(pad + 10, cy, 14, 14, 0xffffff).setOrigin(0.5)
      .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this._cycleColor(col, 1));
    col.colorName = this.add.text(pad + 22, cy, '', {
      fontFamily: 'monospace', fontSize: '10px', color: UI.text,
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true }).on('pointerdown', () => this._cycleColor(col, 1));
    col.colorHint = this.add.text(w - pad, cy, '◀ ▶ D-PAD', {
      fontFamily: 'monospace', fontSize: '9px', color: UI.dim,
    }).setOrigin(1, 0.5);
    col.layer.add([col.colorSwatch, col.colorName, col.colorHint]);
    this._refreshColorControl(col);
    this._refreshReady(col);
  }

  _artFor(col) {
    return playerMechArt(col.index, { hullFrames: HULL_FRAMES, accent: mechColorFor(col.mech, col.index) });
  }

  // ── Tiles (weapon/ability/core) ──────────────────────────────────────────────────────────────
  _drawColTile(col, rect) {
    const loc = rect.loc;
    const id = this._mountedIn(col, loc);
    const kind = slotKind(loc);
    const refs = drawSkillTile(this, col.layer, rect, {
      loc, itemId: id, selected: loc === col.selectedSlot, bindGlyph: '',
      emptyLabel: kind === 'weapon' ? 'weapon' : kind === 'ability' ? 'ability' : 'core',
      subtitle: id ? getItem(id).name : '',
    });
    refs.bg.setInteractive({ useHandCursor: true }).on('pointerdown', () => this._selectSlot(col, loc));
    col.tileRefs[loc] = refs;
  }

  _refreshTile(col, loc) {
    const refs = col.tileRefs[loc];
    if (!refs) return;
    const id = this._mountedIn(col, loc);
    const kind = slotKind(loc);
    updateSkillTile(refs, {
      loc, itemId: id, selected: loc === col.selectedSlot, bindGlyph: '',
      emptyLabel: kind === 'weapon' ? 'weapon' : kind === 'ability' ? 'ability' : 'core',
      subtitle: id ? getItem(id).name : '',
    });
  }

  _refreshAllTiles(col) {
    for (const loc of ALL_SLOTS) this._refreshTile(col, loc);
  }

  // ── The condensed catalog grid ───────────────────────────────────────────────────────────────
  _eligibleIds(loc) {
    const kind = slotKind(loc);
    if (kind === 'ability') return Object.keys(ABILITIES);
    if (kind === 'core') return Object.keys(CORE_ITEMS);
    return this.catalogIds.filter((id) => {
      if (!WEAPON_SLOTS.includes(loc)) return false;
      if (getItem(id).category === 'melee' && !MELEE_LOCATIONS.includes(loc)) return false;
      return true;
    });
  }

  // Auto-fit a square grid of `n` icons into `w`x`h` with no scrolling — shrink the square size
  // (down to a hard floor) until every row fits, rather than a fixed size that might overflow.
  _fitGrid(n, w, h, { gap = 4, min = 20, max = 34 } = {}) {
    for (let size = max; size >= min; size--) {
      const cols = Math.max(1, Math.floor((w + gap) / (size + gap)));
      const rows = Math.ceil(n / cols);
      if (rows * (size + gap) - gap <= h) return { size, cols };
    }
    const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
    return { size: min, cols };
  }

  _refreshCatalog(col) {
    for (const o of col.catalogIcons) o.destroy();
    col.catalogIcons = [];
    const ids = this._eligibleIds(col.selectedSlot);
    const { x, y, w, h } = col.rects.catalog;
    const gap = 4;
    const { size, cols } = this._fitGrid(ids.length, w, h, { gap });
    const mountedId = this._mountedIn(col, col.selectedSlot);
    ids.forEach((id, idx) => {
      const cx = x + (idx % cols) * (size + gap);
      const cy = y + Math.floor(idx / cols) * (size + gap);
      const locked = isWeapon(id) && !this.unlocked.has(id);
      const mounted = id === mountedId;
      const bg = this.add.rectangle(cx, cy, size, size, 0x131820, 1).setOrigin(0, 0)
        .setStrokeStyle(mounted ? 2 : 1, mounted ? 0xefc14a : 0x2a333f, mounted ? 1 : 0.7)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._clickCatalogItem(col, id));
      const icon = this.add.image(cx + size / 2, cy + size / 2, itemFxKey(id))
        .setDisplaySize(size * 0.62, size * 0.62).setAlpha(locked ? 0.35 : 1);
      col.layer.add([bg, icon]);
      col.catalogIcons.push(bg, icon);
      if (locked) {
        const lock = this.add.text(cx + size / 2, cy + size / 2, '🔒', {
          fontFamily: 'monospace', fontSize: `${Math.max(9, Math.floor(size * 0.4))}px`,
        }).setOrigin(0.5);
        col.layer.add(lock);
        col.catalogIcons.push(lock);
      }
    });
    if (!ids.length) {
      const empty = this.add.text(x + w / 2, y + 12, 'nothing eligible', {
        fontFamily: 'monospace', fontSize: '10px', color: UI.dim,
      }).setOrigin(0.5, 0);
      col.layer.add(empty);
      col.catalogIcons.push(empty);
    }
  }

  _selectSlot(col, loc) {
    Audio.ui('menuNav');
    col.selectedSlot = loc;
    this._refreshAllTiles(col);
    this._refreshCatalog(col);
  }

  _mountedIn(col, loc) {
    const kind = slotKind(loc);
    if (kind === 'ability') return col.mech.abilityMounts[loc] ?? null;
    if (kind === 'core') return col.mech.coreMounts[loc] ?? null;
    return col.mech.usedSlots(loc) >= 1 ? col.mech.mounts[loc][0] : null;
  }

  _clickCatalogItem(col, id) {
    if (isWeapon(id) && !this.unlocked.has(id)) { this._purchase(id); return; }
    this._mountInto(col, col.selectedSlot, id);
  }

  // A weapon slot always mounts/replaces (re-picking the mounted item is a no-op, and there's no
  // unmount — a weapon slot must stay filled to deploy); an ability/core slot is optional, so
  // re-picking the mounted item UNMOUNTS it instead.
  _mountInto(col, loc, itemId) {
    const mech = col.mech, kind = slotKind(loc);
    if (kind === 'ability' || kind === 'core') {
      const prevItem = this._mountedIn(col, loc);
      if (prevItem === itemId) { this._unmountFrom(col, loc); return; }
      if (prevItem) (kind === 'ability' ? mech.unmountAbility(loc) : mech.unmountCore(loc));
      const res = kind === 'ability' ? mech.mountAbility(loc, itemId) : mech.mountCore(loc, itemId);
      if (!res.ok) {
        if (prevItem) (kind === 'ability' ? mech.mountAbility(loc, prevItem) : mech.mountCore(loc, prevItem));
        this.toast(res.reason); return;
      }
    } else {
      if (this._mountedIn(col, loc) === itemId) return;
      const prev = mech.usedSlots(loc) >= 1 ? mech.mounts[loc][0] : null;
      if (prev) mech.unmount(loc, 0);
      const res = mech.mount(loc, itemId);
      if (!res.ok) {
        if (prev) mech.mount(loc, prev);
        this.toast(res.reason); return;
      }
    }
    Audio.ui('equip');
    this._onMechChanged(col);
  }

  // Pad B / the ability-core "clear" path — weapon slots have no unmount at all (see above).
  _unmountFrom(col, loc) {
    const kind = slotKind(loc);
    if (kind === 'ability') col.mech.unmountAbility(loc);
    else if (kind === 'core') col.mech.unmountCore(loc);
    else return;
    Audio.ui('equip');
    this._onMechChanged(col);
  }

  _onMechChanged(col) {
    reskinMech(this, col.textureKey, col.mech, this._artFor(col));
    saveAllMechs(this.allMechs);
    this._refreshAllTiles(col);
    this._refreshCatalog(col);
  }

  // Pad A/X: cycle the focused slot's mount forward/back through its own eligible list, reusing
  // the same mount path (and so the same lock/purchase gate) a direct catalog click would.
  _cycleMount(col, dir) {
    const ids = this._eligibleIds(col.selectedSlot);
    const next = cycleListId(ids, this._mountedIn(col, col.selectedSlot), dir);
    if (next != null) this._clickCatalogItem(col, next);
  }

  // #65: spend banked SCRAP to permanently unlock `id` — one shared unlock set/currency every
  // column's catalog reads from (one wallet, same as every persistent build slot always shared).
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
    for (const col of this.cols) if (col) this._refreshCatalog(col);
    this.toast(`UNLOCKED ${getItem(id).name}`, UI.accent);
  }

  // ── Colour cycle ─────────────────────────────────────────────────────────────────────────────
  _cycleColor(col, dir) {
    if (!col) return;
    const builds = activeIndices(this.session).map((i) => this.cols[i]?.mech).filter(Boolean);
    const current = mechColorFor(col.mech, col.index);
    const next = cycleSwatch(builds, col.index, current, dir);
    if (next === col.mech.color) return;
    col.mech.color = next;
    Audio.ui('menuNav');
    buildMechTextures(this, col.textureKey, col.mech, this._artFor(col));
    saveAllMechs(this.allMechs);
    poseMechParts(col.preview, col.mech, -Math.PI / 2, col.previewScale, col.previewCx, col.previewCy, {});
    this._refreshColorControl(col);
    // The header swatch shows the same colour — cheap enough to just repaint it too.
    col.headerColor?.setFillStyle(next, 1);
  }

  _refreshColorControl(col) {
    const current = mechColorFor(col.mech, col.index);
    col.colorSwatch.setFillStyle(current, 1);
    col.colorName.setText(swatchName(current));
  }

  // ── Ready / deploy ───────────────────────────────────────────────────────────────────────────
  _refreshReady(col) {
    const ready = this.session.ready[col.index];
    col.readyBg.setFillStyle(ready ? 0x1c3a24 : UI.btn).setStrokeStyle(1, ready ? 0x7bd17b : UI.panelEdge);
    col.readyText.setText(ready ? '✓ READY' : 'READY?').setColor(ready ? UI.good : UI.dim);
  }

  // Toggling a player TO ready is gated on their build being complete (every weapon slot filled —
  // ability/core stay optional, #506); toggling back off is always allowed. In practice a weapon
  // slot can never be left empty through this UI (mounting always replaces, there is no weapon
  // unmount), so this only ever fires for a slot that somehow still starts incomplete.
  _toggleReady(i) {
    const col = this.cols[i];
    if (!col) return;
    const goingReady = !this.session.ready[i];
    if (goingReady && !col.mech.isComplete()) {
      const empty = MOUNT_LOCATIONS.filter((loc) => col.mech.usedSlots(loc) === 0);
      const names = empty.map((loc) => LOCATION_INFO[loc].short).join(', ') || 'all weapon slots';
      this.toast(`P${i + 1} BUILD INCOMPLETE — fill ${names}`);
      return;
    }
    this.session = toggleReady(this.session, i);
    Audio.ui('menuNav');
    this._refreshReady(col);
    if (i === 0) this._refreshHeader();
    if (allReady(this.session)) this._deploy();
  }

  _deploy() {
    for (const i of activeIndices(this.session)) this.allMechs[PLAYER_MECH_KEYS[i]]?.repairAll();
    saveAllMechs(this.allMechs);
    this.registry.set('coopMechKeys', PLAYER_MECH_KEYS.slice(0, this.session.count));
    this.registry.set('coopPlayerCount', this.session.count);
    Audio.ui('equip');
    this.toast('ALL READY — DEPLOYING', UI.accent);
    this.time.delayedCall(650, () => this.scene.start('BaseScene'));
  }

  // ── Join ─────────────────────────────────────────────────────────────────────────────────────
  _joinPlayer() {
    if (!canJoin(this.session)) return;
    Audio.ui('deploy');
    this.session = joinSimulPlayer(this.session);
    this.registry.set('coopPlayerCount', this.session.count);
    this._relayoutColumns();
    this._refreshJoinHint();
    this._refreshHeader();
    this.toast(`PLAYER ${this.session.count} JOINED`, UI.accent);
  }

  _updateJoin() {
    if (!canJoin(this.session)) return;
    for (let pad = this.session.count; pad < MAX_GARAGE_PLAYERS; pad++) {
      if (this.padEdges[pad]?.pressed(PAD.START)) { this._joinPlayer(); return; }
    }
  }

  toast(msg, color = UI.bad) {
    if (this._toastText) this._toastText.destroy();
    this._toastText = this.add.text(this.W / 2, this.H - 24, msg, {
      fontFamily: 'monospace', fontSize: '14px', color, backgroundColor: '#161b22', padding: { x: 8, y: 4 },
    }).setOrigin(0.5);
    this.tweens.add({ targets: this._toastText, alpha: 0, delay: 1100, duration: 500, onComplete: () => this._toastText?.destroy() });
  }

  // ── Per-player pad controls ──────────────────────────────────────────────────────────────────
  // Every joined player's OWN pad (index i) drives ONLY their own column, entirely independent of
  // every other player's: d-pad left/right cycles colour, up/down moves which of the seven slots
  // is focused, A/X cycle that slot's mount forward/back, B clears an ability/core slot (weapon
  // slots can't be cleared), START toggles ready.
  update() {
    this._updateJoin();
    for (const i of activeIndices(this.session)) {
      const col = this.cols[i];
      const e = this.padEdges[i];
      if (!col || !e.pad()) continue;
      if (e.pressed(PAD.START)) { this._toggleReady(i); continue; }
      if (e.pressed(PAD.DPAD_LEFT)) { this._cycleColor(col, -1); continue; }
      if (e.pressed(PAD.DPAD_RIGHT)) { this._cycleColor(col, 1); continue; }
      if (e.pressed(PAD.DPAD_UP)) { this._selectSlot(col, ALL_SLOTS[stepIndex(ALL_SLOTS.indexOf(col.selectedSlot), -1, ALL_SLOTS.length)]); continue; }
      if (e.pressed(PAD.DPAD_DOWN)) { this._selectSlot(col, ALL_SLOTS[stepIndex(ALL_SLOTS.indexOf(col.selectedSlot), 1, ALL_SLOTS.length)]); continue; }
      if (e.pressed(PAD.A)) { this._cycleMount(col, 1); continue; }
      if (e.pressed(PAD.X)) { this._cycleMount(col, -1); continue; }
      if (e.pressed(PAD.B)) { this._unmountFrom(col, col.selectedSlot); continue; }
    }
  }
}
