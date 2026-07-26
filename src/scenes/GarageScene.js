import Phaser from 'phaser';
import { buildMechTextures, reskinMech, HULL_FRAMES } from '../art/index.js';
import { playerMechArt } from '../art/playerMechLook.js';
import { makeMechParts, poseMechParts } from '../art/mechView.js';
import { mechColorFor, cycleSwatch } from '../data/mechColors.js';
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
import { TILE_ORDER, drawSkillTile, updateSkillTile, coreTileRect, paintTilePlate } from '../ui/skillTiles.js';
import { stepIndex, cycleListId } from '../ui/padNav.js';
import { PLAYER_MECH_KEYS, MAX_GARAGE_PLAYERS, canJoin } from '../data/coopGarage.js';
import { makeSimulSession, joinSimulPlayer, toggleReady, allReady, activeIndices } from '../data/simulGarage.js';
import { buildTabBar, TAB_BAR_H } from '../ui/tabBar.js';
import { Audio } from '../audio/index.js';
import { StatsOverlay } from './garage/statsOverlay.js';
import { garageColumnLayout, HEADER_H as COL_HEADER_H } from './garage/columnLayout.js';
import { wirePauseMenu } from './PauseMenuScene.js';
import { WeaponCardList } from '../ui/weaponCardList.js';

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
// #505 (second correction — Jackson, after playtesting the merged scene): "bring back the
// simulgaragescene, we wanted THAT to be the main garage scene, but not save space for players
// that haven't joined yet" — clarified further, the per-column layout above IS the wanted
// direction; the actual complaint was narrower: "the square-only weapon selection (it should
// still be the rows of weapon firing live preview." So the condensed square-icon grid this scene
// shipped with is gone again — each column's catalog is the real WeaponCardList (ui/
// weaponCardList.js, the same component the standalone Weapon Lab tab uses), in its `compact`
// mode: rows of weapons, each with its own live-firing shot/beam preview, scrolled inside the
// column's own catalog rect rather than a fixed-size no-scroll grid.
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
    // #505 THIRD rework (playtest, Jackson: "arrow keys should function the same as d-pad in the
    // garage") — the exact same actions column 0's own PadEdges drives off DPAD_LEFT/RIGHT/UP/
    // DOWN in update() below, just off keyboard events instead of a per-frame pad poll. Shares
    // _cycleColor/_stepSlot with the pad path rather than duplicating the mapping.
    this.input.keyboard.on('keydown-LEFT', () => this._cycleColor(this.cols[0], -1));
    this.input.keyboard.on('keydown-RIGHT', () => this._cycleColor(this.cols[0], 1));
    this.input.keyboard.on('keydown-UP', () => this._stepSlot(this.cols[0], -1));
    this.input.keyboard.on('keydown-DOWN', () => this._stepSlot(this.cols[0], 1));

    // #523: ESC always opens the shared pause menu.
    wirePauseMenu(this);

    // Every column's catalogList registers its own wheel/pointer listeners on the scene's input
    // plugin (WeaponCardList's constructor) — clean them up on the way out, mirroring the old
    // single-editor garage's `this.events.once('shutdown', () => this.list.destroy())`.
    this.events.once('shutdown', () => { for (const col of this.cols) col?.catalogList?.destroy(); });
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
    // catalogList is its own top-level container (WeaponCardList doesn't live inside col.layer —
    // see _buildColumn), so destroying col.layer alone would leak it (and its wheel/pointer
    // listeners on the scene's input plugin).
    for (const col of this.cols) { col?.catalogList?.destroy(); col?.layer?.destroy(true); }
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

    const w = this.colW, h = this.colH, pad = 8;
    // #505 FOURTH rework (a fresh layout correction from Jackson on top of the THIRD rework): the
    // loadout tile block below reuses the REAL shared HUD layout code (skillTiles.js
    // `weaponAbilityRows`, the exact function HudScene.js's arena console calls) via
    // garageColumnLayout, rendered at the arena's own FULL tile size (not scaled down to fit the
    // column). The mech preview is now SQUARE, sized to that block's height, and the two sit side
    // by side as ONE unit, centered together in the column — see columnLayout.js for the pixel
    // math and the narrow-column note. The player-number label sits just under the preview art.
    // The colour-select swatch+label are gone from the visual layout entirely (still functional —
    // see the D-pad/arrow-key handling below).
    const gl = garageColumnLayout(w, h, { pad });
    col.rects = { catalog: gl.catalog, pad, innerW: gl.innerW };

    // Header band: just the passive core slot (left) and the clickable READY pill (right).
    col.readyBg = this.add.rectangle(w - pad - 70, 4, 70, 20, UI.btn).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this._toggleReady(i));
    col.readyText = this.add.text(w - pad - 35, 14, 'READY?', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    }).setOrigin(0.5);
    col.layer.add([col.readyBg, col.readyText]);

    // The loadout tiles — weapon row + ability row, drawn with the SAME shared tile-drawing code
    // (drawSkillTile) the arena HUD uses, just with no HP/shield/armor panel chrome around them
    // (HudScene.js draws those separately, alongside its own call into the same tile rects). The
    // passive core slot isn't part of that shared HUD layout at all (HudScene deliberately omits
    // it — it's Garage-only chrome), so it keeps its own small tile up in the header band.
    col.tileRefs = {};
    for (const rect of [...gl.tiles.weapons, ...gl.tiles.abilities]) this._drawColTile(col, rect);
    this._drawColTile(col, coreTileRect(pad + 12, COL_HEADER_H / 2, 24));

    // The catalog — the shared WeaponCardList (ui/weaponCardList.js), the SAME component the
    // standalone Weapon Lab tab uses, in its `compact` mode so a row of cards (name/category/
    // stats + a live-firing shot/beam preview per card) fits this column's width. It owns its
    // own top-level container rather than living inside col.layer, so it's positioned in WORLD
    // coordinates (this column's own screen offset + the local catalog rect below). Refiltered/
    // reselected whenever the selected slot or a mount changes, via _refreshCatalogList.
    const cat = gl.catalog;
    col.catalogList = new WeaponCardList(this, {
      x: col.layer.x + cat.x, y: col.layer.y + cat.y, w: cat.w, h: cat.h, compact: true,
      ids: this._eligibleIds(col.selectedSlot),
      onSelect: (id) => this._clickCatalogItem(col, id),
      selectedId: this._mountedIn(col, col.selectedSlot),
      // #506: abilities/core items have no SCRAP-unlock data at all (shop.js's catalog is
      // weapon-only) — always unlocked and free to mount, so only a weapon id is ever gated here.
      isLocked: (id) => isWeapon(id) && !this.unlocked.has(id),
      costOf: (id) => (isWeapon(id) ? costOf(id) : 0),
    });

    // The live mech preview — SQUARE, sized to the tile block's own height (both rows together),
    // sitting immediately LEFT of it as one centered pair (see garageColumnLayout). Built ONCE;
    // every later mount/colour change re-bakes the SAME texture key in place
    // (buildMechTextures/reskinMech), so these sprites never need rebuilding.
    // #505 playtest follow-up ("round the mech preview box, matching the weapon/ability tile
    // style"): the panel is now a Graphics painted with the SAME `paintTilePlate` the skill tiles
    // themselves use (rounded corners, crisp edge, outside halo) rather than a plain squared-off
    // Rectangle — so the preview box reads as one more plate in the same button/panel language.
    const { cx: previewCx, cy: previewCy, w: previewW, h: previewH } = gl.preview;
    col.previewPanel = this.add.graphics();
    paintTilePlate(col.previewPanel, { x: previewCx - previewW / 2, y: previewCy - previewH / 2, w: previewW, h: previewH });
    const scale = (Math.min(previewW, previewH) - 24) / 230;
    col.previewScale = scale; col.previewCx = previewCx; col.previewCy = previewCy;
    col.preview = makeMechParts(this, col.textureKey, { x: previewCx, y: previewCy, scale, isPlayer: true });
    col.layer.add([col.previewPanel, ...col.preview.children]);
    poseMechParts(col.preview, col.mech, -Math.PI / 2, scale, previewCx, previewCy, {});

    // The player-number label — now sits INSIDE the preview box, at its bottom (#505 playtest
    // follow-up on top of the earlier "just below the mech preview art" placement), with the
    // identity-colour dot right beside it.
    col.headerLabel = this.add.text(gl.label.cx, gl.label.y, `PLAYER ${i + 1}`, {
      fontFamily: 'monospace', fontSize: '12px', color: UI.text,
    }).setOrigin(0.5, 0);
    col.headerColor = this.add.rectangle(
      col.headerLabel.x - col.headerLabel.width / 2 - 10, gl.label.y + col.headerLabel.height / 2,
      9, 9, mechColorFor(col.mech, i),
    ).setOrigin(0.5);
    col.layer.add([col.headerLabel, col.headerColor]);

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

  // ── The catalog (WeaponCardList, compact) ────────────────────────────────────────────────────
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

  // Refilter the column's catalog to the currently-selected slot's eligible items and highlight
  // whatever's mounted there — called on a slot change and after any mount/unmount. The list's
  // own scroll/lock overlay/live-fire state is otherwise untouched (setIds rebuilds cards;
  // WeaponCardList.setIds resets scroll to the top, matching the old single-editor garage).
  _refreshCatalogList(col) {
    col.catalogList.setIds(this._eligibleIds(col.selectedSlot));
    col.catalogList.setSelected(this._mountedIn(col, col.selectedSlot));
  }

  _selectSlot(col, loc) {
    Audio.ui('menuNav');
    col.selectedSlot = loc;
    this._refreshAllTiles(col);
    this._refreshCatalogList(col);
  }

  // Step the focused slot forward/back through the seven-slot cycle (ALL_SLOTS) — shared by the
  // pad's d-pad up/down (update(), below) and column 0's keyboard up/down arrows (create()), so
  // the two devices are always driving the identical mapping rather than two copies of it.
  _stepSlot(col, dir) {
    if (!col) return;
    this._selectSlot(col, ALL_SLOTS[stepIndex(ALL_SLOTS.indexOf(col.selectedSlot), dir, ALL_SLOTS.length)]);
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
    // Just the highlighted card, not a full setIds() rebuild — the eligible set for the
    // currently-selected slot doesn't change on a mount/unmount, and rebuilding would reset the
    // list's scroll position and interrupt every card's live-fire preview loop for no reason.
    col.catalogList.setSelected(this._mountedIn(col, col.selectedSlot));
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
    // Every column shares the one unlock set/wallet — refresh each column's lock overlays in
    // place (no rebuild, no scroll reset), same as the old single-editor garage's _purchase.
    for (const col of this.cols) col?.catalogList?.refreshLocks();
    this.toast(`UNLOCKED ${getItem(id).name}`, UI.accent);
  }

  // ── Colour cycle ─────────────────────────────────────────────────────────────────────────────
  // #505 THIRD rework: the dedicated colour-select SWATCH + NAME LABEL (and their "◀ ▶ D-PAD"
  // hint) are gone from the visual layout — Jackson: "it's taking unnecessary space." The
  // cycling itself is untouched: pad d-pad left/right (update(), below) and, new this rework,
  // keyboard LEFT/RIGHT for column 0 (create(), mirroring the pad exactly — see the arrow-key
  // handlers). The mech re-baking its own texture + the small identity dot next to the player
  // label (both still repainted below) ARE the colour's visible feedback now.
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
    // The identity dot beside the player label shows the same colour — repaint it in place.
    col.headerColor?.setFillStyle(next, 1);
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
  update(time, delta) {
    this._updateJoin();
    // Ticks every column's catalog — the live shot/beam preview loop each card runs — regardless
    // of whether that column's pad is connected (a mouse/keyboard-only player still needs their
    // catalog animating).
    for (const col of this.cols) col?.catalogList?.update(time, delta);
    for (const i of activeIndices(this.session)) {
      const col = this.cols[i];
      const e = this.padEdges[i];
      if (!col || !e.pad()) continue;
      if (e.pressed(PAD.START)) { this._toggleReady(i); continue; }
      if (e.pressed(PAD.DPAD_LEFT)) { this._cycleColor(col, -1); continue; }
      if (e.pressed(PAD.DPAD_RIGHT)) { this._cycleColor(col, 1); continue; }
      if (e.pressed(PAD.DPAD_UP)) { this._stepSlot(col, -1); continue; }
      if (e.pressed(PAD.DPAD_DOWN)) { this._stepSlot(col, 1); continue; }
      if (e.pressed(PAD.A)) { this._cycleMount(col, 1); continue; }
      if (e.pressed(PAD.X)) { this._cycleMount(col, -1); continue; }
      if (e.pressed(PAD.B)) { this._unmountFrom(col, col.selectedSlot); continue; }
    }
  }
}
