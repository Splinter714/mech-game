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
import { WEAPON_SLOTS, MELEE_LOCATIONS, ABILITY_SLOTS, CORE_SLOTS, slotKind } from '../data/anatomy.js';
import { RUN_CURRENCY_KEY } from '../data/events.js';
import { PadEdges, PAD } from '../input/Controls.js';
import { TILE_ORDER, tileRow, drawSkillTile, updateSkillTile, diamondLayout, coreTileRect } from '../ui/skillTiles.js';
import { stepIndex, cycleListId } from '../ui/padNav.js';
import { PLAYER_MECH_KEYS, MAX_GARAGE_PLAYERS, canJoin } from '../data/coopGarage.js';
import { makeSimulSession, joinSimulPlayer, toggleReady, allReady, activeIndices } from '../data/simulGarage.js';
import { Audio } from '../audio/index.js';

// PROTOTYPE (Jackson wants to evaluate this live, not a locked spec): the SIMULTANEOUS co-op
// garage. The shipped flow (GarageScene.js + data/coopGarage.js) is SEQUENTIAL — one editing
// surface, handed player-to-player, each pressing "▶ P1 READY" to pass control on. This scene is
// the alternative: every joined controller gets its own COLUMN and builds at the same time, no
// handoff at all. Reachable from GarageScene via the 'SIMUL' tab-bar action (or the 'P' key); 'S'
// (or the on-screen button) returns to the sequential scene. The two scenes are fully
// independent — this one is deliberately easy to delete wholesale (this file + data/simulGarage.js
// + the one entry point GarageScene.js adds) if the prototype doesn't stick.
//
// It still deploys onto the SAME four persistent build slots (data/rosters.js's mech1..mech4,
// PLAYER_MECH_KEYS) and publishes the same registry keys (`coopMechKeys`/`coopPlayerCount`) the
// arena and the sequential scene already read — so a squad built here fields identically to one
// built the old way.
//
// Layout is a FIXED MAX_GARAGE_PLAYERS-wide strip of columns (not resized as players join) — a
// column for a not-yet-joined player just shows a dashed "PRESS START TO JOIN" placeholder
// (mirrors the sequential flow's own ADD tab). Fixing the width up front means a join never
// reflows anyone else's column mid-build, and it's the simplification that made the rest of this
// scene tractable to build as a prototype: every already-built column's internal layout is fixed
// for the scene's lifetime, so nothing but that column's OWN texture/graphics ever needs to
// change after it's built.
//
// The "condensed to squares" catalog (confirmed design) is a compact auto-fitting icon grid — see
// `_fitGrid` — deliberately NOT the shared WeaponCardList (full-width animated cards; the design
// explicitly wants squares with no scrolling, and four live preview-sim card lists at once would
// also just be a lot of simultaneous audio/fx). Each column keeps its own `selectedSlot` (one of
// the seven weapon/ability/core slots) instead of a shared `this.selected`, which is the one true
// structural change simultaneity requires over GarageScene's single-selection model.
const UI = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', bad: '#e2533a', good: '#7bd17b',
  panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744,
};

const TOP_H = 40;                                    // scene-wide title strip
const ALL_SLOTS = [...TILE_ORDER, ...ABILITY_SLOTS, ...CORE_SLOTS];   // pad up/down cycle order

export default class SimulGarageScene extends Phaser.Scene {
  constructor() {
    super('SimulGarageScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);
    this.cameras.main.setBackgroundColor('#0d1014');
    this.cameras.main.fadeIn(300, 13, 16, 20);

    this.allMechs = this.registry.get('allMechs');
    // Repair every persistent slot on entry, exactly like GarageScene#create — a squad coming
    // back from a run (win OR loss) must not show a damaged preview.
    for (const key of PLAYER_MECH_KEYS) this.allMechs[key]?.repairAll();
    saveAllMechs(this.allMechs);

    this.catalogIds = [...WEAPON_IDS];
    this.unlocked = loadUnlocked();
    if (import.meta.env.DEV) for (const id of this.catalogIds) this.unlocked.add(id);

    // Best-effort seed: how many pads are ALREADY connected right now. Phaser's gamepad manager
    // only reliably reports a pad after some browsers have seen a button press on it, so this is
    // a nice-to-have, not a guarantee — a pad that isn't detected yet just joins the normal way
    // (press START on it, or click its column's placeholder), same as the sequential flow.
    const connected = this.input.gamepad?.getAll?.().filter((p) => p.connected).length ?? 0;
    this.session = makeSimulSession({ count: Math.max(1, Math.min(MAX_GARAGE_PLAYERS, connected)) });

    this.colW = Math.floor(this.W / MAX_GARAGE_PLAYERS);
    this.colH = this.H - TOP_H;
    this.cols = [];   // sparse — this.cols[i] exists only once player i has joined

    this._buildTopBar();
    for (let i = 0; i < MAX_GARAGE_PLAYERS; i++) {
      this._colLayer(i);   // placeholder or real column
    }

    // One PadEdges per pad index 0..MAX-1, reused whether that index is claimed or not — an
    // unclaimed one is only ever polled for START (join); a claimed one is polled for its full
    // in-column control set (see update()).
    this.padEdges = [];
    for (let i = 0; i < MAX_GARAGE_PLAYERS; i++) this.padEdges[i] = new PadEdges(this, i);

    this.input.keyboard.on('keydown-S', () => this.scene.start('GarageScene'));
  }

  // ── Scene chrome ──────────────────────────────────────────────────────────────────────────
  _buildTopBar() {
    this.add.rectangle(0, 0, this.W, TOP_H, 0x12161d).setOrigin(0, 0).setStrokeStyle(1, UI.panelEdge);
    this.add.text(16, TOP_H / 2, 'SIMULTANEOUS GARAGE — PROTOTYPE', {
      fontFamily: 'monospace', fontSize: '13px', color: UI.accent,
    }).setOrigin(0, 0.5);
    const back = this.add.rectangle(this.W - 190, 6, 174, TOP_H - 12, UI.btn).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
    this.add.text(this.W - 190 + 87, TOP_H / 2, '◀ SEQUENTIAL (S)', {
      fontFamily: 'monospace', fontSize: '12px', color: UI.text,
    }).setOrigin(0.5);
    back.on('pointerover', () => back.setFillStyle(UI.btnHover));
    back.on('pointerout', () => back.setFillStyle(UI.btn));
    back.on('pointerdown', () => this.scene.start('GarageScene'));
  }

  // ── Column construction ──────────────────────────────────────────────────────────────────────
  // Build (or replace) column `i`'s container. Joined players get the full build UI; everyone
  // else gets the dashed "press START to join" placeholder. Called once per index at create()
  // and again for a single index the moment that player joins.
  _colLayer(i) {
    this.cols[i]?.layer?.destroy(true);
    const layer = this.add.container(i * this.colW, TOP_H);
    const joined = i < this.session.count;
    if (!joined) {
      this._buildPlaceholder(layer, i);
      this.cols[i] = { index: i, layer, joined: false };
      return;
    }
    this.cols[i] = { index: i, layer, joined: true, selectedSlot: TILE_ORDER[0] };
    this._buildColumn(this.cols[i]);
  }

  _buildPlaceholder(layer, i) {
    const w = this.colW - 16, h = this.colH - 16, x = 8, y = 8;
    const g = this._dashedRect(x, y, w, h, 0x7c8794);
    const label = this.add.text(x + w / 2, y + h / 2 - 10, `P${i + 1}`, {
      fontFamily: 'monospace', fontSize: '20px', color: '#7c8794',
    }).setOrigin(0.5);
    const hint = this.add.text(x + w / 2, y + h / 2 + 16, 'PRESS START\n(or click here)\nTO JOIN', {
      fontFamily: 'monospace', fontSize: '11px', color: '#7c8794', align: 'center',
    }).setOrigin(0.5);
    const hit = this.add.rectangle(x, y, w, h, 0x000000, 0).setOrigin(0, 0)
      .setInteractive({ useHandCursor: true }).on('pointerdown', () => this._joinPlayer());
    layer.add([g, label, hint, hit]);
  }

  _dashedRect(x, y, w, h, color) {
    const g = this.add.graphics().lineStyle(1, color, 0.8);
    const dash = 5, gapLen = 4;
    const line = (x1, y1, x2, y2) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      for (let d = 0; d < len; d += dash + gapLen) {
        const e = Math.min(d + dash, len);
        g.beginPath(); g.moveTo(x1 + ux * d, y1 + uy * d); g.lineTo(x1 + ux * e, y1 + uy * e); g.strokePath();
      }
    };
    line(x, y, x + w, y); line(x + w, y, x + w, y + h);
    line(x + w, y + h, x, y + h); line(x, y + h, x, y);
    return g;
  }

  // Build every element of a JOINED column, from its own persistent mech slot. All coordinates
  // are LOCAL to `col.layer` (whose position IS the column's screen offset), so nothing here
  // needs to know its own x — that's the one thing that makes columns simple to build in a loop.
  _buildColumn(col) {
    const i = col.index;
    col.mech = this.allMechs[PLAYER_MECH_KEYS[i]];
    col.textureKey = `simulMech${i}`;
    buildMechTextures(this, col.textureKey, col.mech, this._artFor(col));

    const w = this.colW, h = this.colH;
    const pad = 8;
    const innerW = w - pad * 2;

    // Section heights, top to bottom (see file header for the confirmed bottom-to-top ordering:
    // colour cycle at the very bottom, preview above it, ability/weapon rows above that).
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

    // The weapon-tile row (shared layout with GarageScene/HUD) + the ability diamond + core tile.
    col.tileRefs = {};
    for (const rect of tileRow(pad, innerW, { y: weaponY, maxSize: 60 })) this._drawColTile(col, rect);
    const abilCx = pad + innerW / 2, abilCy = abilityY + ABILITY_ROW_H / 2;
    for (const rect of diamondLayout(abilCx, abilCy, { size: 40 })) this._drawColTile(col, rect);
    this._drawColTile(col, coreTileRect(abilCx, abilCy, 28));

    // The condensed catalog grid — built fresh whenever the selected slot (or a mount) changes.
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

    // The colour cycle — bottom of the column (confirmed design). Click either half to cycle
    // forward; the pad's d-pad left/right (below, in update()) is the primary control.
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

  // Mirrors GarageScene's own _mountInto/_pickItem dance: a weapon slot always mounts/replaces
  // (re-picking the mounted item is a no-op, and there's no unmount — a weapon slot must stay
  // filled to deploy); an ability/core slot is optional, so re-picking the mounted item UNMOUNTS
  // it instead.
  _mountInto(col, loc, itemId) {
    const mech = col.mech, kind = slotKind(loc);
    if (kind === 'ability' || kind === 'core') {
      const prevItem = this._mountedIn(col, loc);
      if (prevItem === itemId) { this._unmountFrom(col, loc); return; }
      if (prevItem) (kind === 'ability' ? mech.unmountAbility(loc) : mech.unmountCore(loc));
      const res = kind === 'ability' ? mech.mountAbility(loc, itemId) : mech.mountCore(loc, itemId);
      if (!res.ok) {
        if (prevItem) (kind === 'ability' ? mech.mountAbility(loc, prevItem) : mech.mountCore(loc, prevItem));
        this._toast(res.reason); return;
      }
    } else {
      if (this._mountedIn(col, loc) === itemId) return;
      const prev = mech.usedSlots(loc) >= 1 ? mech.mounts[loc][0] : null;
      if (prev) mech.unmount(loc, 0);
      const res = mech.mount(loc, itemId);
      if (!res.ok) {
        if (prev) mech.mount(loc, prev);
        this._toast(res.reason); return;
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

  // #65: spend banked SCRAP to permanently unlock `id` — the SAME shared unlock set/currency
  // every column's catalog reads from (one player's SCRAP economy, same as the sequential garage
  // already treats mech1..mech4 as sharing one wallet).
  _purchase(id) {
    const price = costOf(id);
    const balance = this.registry.get(RUN_CURRENCY_KEY) || 0;
    if (balance < price) { this._toast(`NOT ENOUGH SCRAP — need ${price}`); return; }
    this.unlocked.add(id);
    saveUnlocked(this.unlocked);
    const remaining = balance - price;
    this.registry.set(RUN_CURRENCY_KEY, remaining);
    saveRunCurrency(remaining);
    for (const col of this.cols) if (col?.joined) this._refreshCatalog(col);
    this._toast(`UNLOCKED ${getItem(id).name}`, UI.accent);
  }

  // ── Colour cycle ─────────────────────────────────────────────────────────────────────────────
  _cycleColor(col, dir) {
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

  _toggleReady(i) {
    this.session = toggleReady(this.session, i);
    Audio.ui('menuNav');
    this._refreshReady(this.cols[i]);
    if (allReady(this.session)) this._deploy();
  }

  _deploy() {
    for (const i of activeIndices(this.session)) this.allMechs[PLAYER_MECH_KEYS[i]]?.repairAll();
    saveAllMechs(this.allMechs);
    this.registry.set('coopMechKeys', PLAYER_MECH_KEYS.slice(0, this.session.count));
    this.registry.set('coopPlayerCount', this.session.count);
    Audio.ui('equip');
    this._toast('ALL READY — DEPLOYING', UI.accent);
    this.time.delayedCall(650, () => this.scene.start('BaseScene'));
  }

  // ── Join ─────────────────────────────────────────────────────────────────────────────────────
  _joinPlayer() {
    if (!canJoin(this.session)) return;
    const index = this.session.count;
    this.session = joinSimulPlayer(this.session);
    Audio.ui('deploy');
    this._colLayer(index);
  }

  _updateJoin() {
    if (!canJoin(this.session)) return;
    for (let pad = this.session.count; pad < MAX_GARAGE_PLAYERS; pad++) {
      if (this.padEdges[pad]?.pressed(PAD.START)) { this._joinPlayer(); return; }
    }
  }

  _toast(msg, color = UI.bad) {
    if (this._toastText) this._toastText.destroy();
    this._toastText = this.add.text(this.W / 2, this.H - 24, msg, {
      fontFamily: 'monospace', fontSize: '14px', color, backgroundColor: '#161b22', padding: { x: 8, y: 4 },
    }).setOrigin(0.5);
    this.tweens.add({ targets: this._toastText, alpha: 0, delay: 1100, duration: 500, onComplete: () => this._toastText?.destroy() });
  }

  // ── Per-player pad controls ──────────────────────────────────────────────────────────────────
  // Every joined player's OWN pad (index i) drives ONLY their own column, entirely independent of
  // every other player's: d-pad left/right cycles colour (confirmed design), up/down moves which
  // of the seven slots is focused, A/X cycle that slot's mount forward/back, B clears an
  // ability/core slot (weapon slots can't be cleared), START toggles ready. None of this reads or
  // writes any other column's state.
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
