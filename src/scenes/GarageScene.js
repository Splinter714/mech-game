import Phaser from 'phaser';
import { buildMechTextures, reskinMech, HULL_FRAMES } from '../art/index.js';
import { playerMechArt } from '../art/playerMechLook.js';
import { makeMechParts, poseMechParts } from '../art/mechView.js';
import { mechColorFor, cycleSwatch, MECH_SWATCHES, MECH_SWATCH_NAMES, isSwatch } from '../data/mechColors.js';
import { PLAYER_CHASSIS_IDS, CHASSIS } from '../data/chassis/index.js';
import { Mech } from '../data/Mech.js';
import { saveAllMechs, loadUnlocked, saveUnlocked, saveRunCurrency } from '../data/save.js';
import { WEAPON_IDS } from '../data/weapons.js';
import { ABILITIES } from '../data/abilities.js';
import { isWeapon, getItem } from '../data/items.js';
import { costOf } from '../data/shop.js';
import {
  WEAPON_SLOTS, MELEE_LOCATIONS, ABILITY_SLOTS, MOUNT_LOCATIONS, LOCATION_INFO, slotKind,
} from '../data/anatomy.js';
import { RUN_CURRENCY_KEY } from '../data/events.js';
import { PadEdges, PAD } from '../input/Controls.js';
import { TILE_ORDER, HUD_ABILITY_ORDER, drawSkillTile, updateSkillTile, paintTilePlate } from '../ui/skillTiles.js';
import { stepIndex, dominantDir, DirRepeater } from '../ui/padNav.js';
import { LAB_TABS, nextLabTab, labTabForSlotKind, TAB_DEFAULT_SLOT } from '../ui/labTabs.js';
import { PLAYER_MECH_KEYS, MAX_GARAGE_PLAYERS, canJoin } from '../data/coopGarage.js';
import { makeSimulSession, joinSimulPlayer, toggleReady, allReady, activeIndices } from '../data/simulGarage.js';
import { buildTabBar, TAB_BAR_H, DEPLOY_W, DEPLOY_MARGIN } from '../ui/tabBar.js';
import { Audio } from '../audio/index.js';
import { StatsOverlay } from './garage/statsOverlay.js';
import { garageColumnLayout } from './garage/columnLayout.js';
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
// 3 empty columns" complaint — pressing START on an unclaimed pad grows the column count (mirrors
// the arena's mid-sortie join, scenes/arena/coop.js). #505 fifth rework dropped the on-screen
// "another controller can join" hint text entirely — the join mechanic itself is unchanged, it's
// just no longer advertised on screen (Jackson's playtest note).
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
  // #533: the pad/keyboard row-navigation cursor on the merged chassis+color tab's list rows —
  // gold, matching the loadout tiles' own `selected` (pad-cursor) highlight in skillTiles.js's
  // TILE_UI.sel, so "gold ring = the D-pad cursor is here" reads the same across both surfaces.
  // Deliberately distinct from `accent` (cyan), which this list already uses for "this IS the
  // equipped chassis/color" — the two states (cursor vs. equipped) can now coincide or differ.
  focus: 0xefc14a,
};

// A Phaser text `color` style wants a CSS string; mechColorFor (and the rest of the identity-
// colour machinery) works in numeric hex, same conversion arena/coop.js uses for its respawn readout.
function hexColor(n) {
  return '#' + n.toString(16).padStart(6, '0');
}

// Pad up/down cycle order through a column's six slots (four weapon + two ability).
const ALL_SLOTS = [...TILE_ORDER, ...ABILITY_SLOTS];

// #529: the per-column tab strip (chassis+color/weapon/ability/passive) that replaced the old
// scene-level "MECH LAB" tab-bar button.
// #532 (quick-wins batch, first change): moved from sitting above each column's own catalog area
// up into the SAME row the pinned Deploy/Ready button lives in (ui/tabBar.js's shared top bar,
// `TAB_BAR_H` tall) — Jackson's Garage feedback: "the 5 tab buttons should sit in the same row/
// position as the Ready button, not wherever they currently are." Each column gets its own tab
// strip container (`col.tabBarLayer`), positioned at that column's own x offset but at the bar's
// y (not `col.layer`'s, which starts BELOW the bar) and depth-sorted above the bar's own
// background/Deploy button so it reads as part of that row. The catalog area below regains the
// full height the tab row used to carve out of it.
const TAB_ROW_H = 34; // the per-column tab button height within the shared bar row
// The shared bar's SCRAP/last-run readout + pinned Deploy/Ready button sit at the screen's
// absolute right regardless of column count — the RIGHTMOST column's own tab row has to stop
// short of them rather than run underneath. Sized generously: the button + its margins, plus a
// buffer for the SCRAP text that sits just to its left.
const TAB_ROW_RIGHT_RESERVE = DEPLOY_W + DEPLOY_MARGIN * 2 + 150;

// Chassis+color merged tab (#532) row geometry — both sections render into the same catalog-area
// rect, chassis rows first, color rows below.
const CHASSIS_ROW_H = 40, CHASSIS_ROW_GAP = 4;
const COLOR_ROW_H = 22, COLOR_ROW_GAP = 3;
const LIST_SECTION_HEADER_H = 14, LIST_SECTION_GAP = 10;

// #505 (fifth rework, playtest): the standalone header band that used to sit under the shared tab
// bar (SCRAP/last-run readout + the "another controller can join" hint) is gone as its own block.
// The join hint is removed entirely (no replacement); SCRAP now rides in the tab bar's own top row
// (see create(), just left of its Deploy/Ready button); columns start right below the tab bar.

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

    this.colTop = TAB_BAR_H;
    this.cols = [];

    // #445: the dev-only run-stats overlay, opened from the tab bar's STATS action.
    if (import.meta.env.DEV) this._statsOverlay = new StatsOverlay(this);

    this._refreshHeader();
    // SCRAP (+ last-run readout) rides in the tab bar's own top row now, just left of its pinned
    // Deploy/Ready button, rather than in a separate header band below it.
    const scrapX = this.W - DEPLOY_MARGIN - DEPLOY_W - 16;
    this.currencyText = this.add.text(scrapX, TAB_BAR_H / 2, '', {
      fontFamily: 'monospace', fontSize: '13px', color: UI.accent,
    }).setOrigin(1, 0.5);
    this.lastRunText = this.add.text(scrapX, TAB_BAR_H + 4, '', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    }).setOrigin(1, 0);
    this._refreshCurrency();

    this._relayoutColumns();
    // Column 0 didn't exist yet when _refreshHeader() first ran above — repaint the pinned Deploy/
    // Ready button now that col.mech is real, so an incomplete starting build greys it out from
    // the first frame rather than only after the next mount/join (#532 change 2).
    this._refreshHeader();

    // One PadEdges per pad index 0..MAX-1, reused whether that index is claimed or not — an
    // unclaimed one is only ever polled for START (join); a claimed one drives its own column.
    this.padEdges = [];
    for (let i = 0; i < MAX_GARAGE_PLAYERS; i++) this.padEdges[i] = new PadEdges(this, i);
    // One DirRepeater per pad index, so the left stick's held-direction auto-repeat is tracked
    // independently per player, same reasoning as padEdges above.
    this.stickRepeat = [];
    for (let i = 0; i < MAX_GARAGE_PLAYERS; i++) this.stickRepeat[i] = new DirRepeater();

    // The keyboard/mouse player is always column 0 (mirrors input/Controls.js — only player 0
    // ever owns the keyboard). 'D' readies/unreadies them, '.'/',' cycle their colour, 'B' bails
    // back to base without deploying.
    this.input.keyboard.on('keydown-D', () => this._toggleReady(0));
    this.input.keyboard.on('keydown-B', () => this.scene.start('BaseScene'));
    this.input.keyboard.on('keydown-PERIOD', () => this._cycleColor(this.cols[0], +1));
    this.input.keyboard.on('keydown-COMMA', () => this._cycleColor(this.cols[0], -1));
    // #505 THIRD rework (playtest, Jackson: "arrow keys should function the same as d-pad in the
    // garage") — the exact same actions column 0's own PadEdges drives off DPAD_LEFT/RIGHT/UP/
    // DOWN in update() below, just off keyboard events instead of a per-frame pad poll.
    // #540: LEFT/RIGHT mirror the D-pad's live slot-cursor role (_navSlot) and UP/DOWN mirror its
    // row-navigate role (_navRow) — see update()'s own D-pad dispatch for the full nav model.
    this.input.keyboard.on('keydown-LEFT', () => this._navSlot(this.cols[0], -1));
    this.input.keyboard.on('keydown-RIGHT', () => this._navSlot(this.cols[0], 1));
    this.input.keyboard.on('keydown-UP', () => this._navRow(this.cols[0], -1));
    this.input.keyboard.on('keydown-DOWN', () => this._navRow(this.cols[0], 1));
    // #529: '['/']' cycle column 0's own Mech Lab tab (chassis/weapon/ability/passive/color) —
    // the keyboard mirror of the pad's LB/RB (see update(), below), same mapping either device.
    this.input.keyboard.on('keydown-OPEN_BRACKET', () => this._cycleLabTab(this.cols[0], -1));
    this.input.keyboard.on('keydown-CLOSED_BRACKET', () => this._cycleLabTab(this.cols[0], 1));

    // #523: ESC always opens the shared pause menu. #529: openStats lets the pause menu's
    // dev-only STATS row reach back into THIS scene's StatsOverlay instance (outside dev,
    // this._statsOverlay is undefined and the optional chain just no-ops).
    // padStart: false — gamepad START is the Garage's own ready-up trigger (see the per-pad
    // update loop below), not the pause menu's open button here. ESC still reaches it.
    wirePauseMenu(this, { openStats: () => this._statsOverlay?.open(), padStart: false });

    // Every column's catalogList registers its own wheel/pointer listeners on the scene's input
    // plugin (WeaponCardList's constructor) — clean them up on the way out, mirroring the old
    // single-editor garage's `this.events.once('shutdown', () => this.list.destroy())`.
    this.events.once('shutdown', () => { for (const col of this.cols) col?.catalogList?.destroy(); });
  }

  // ── Header chrome (tab bar + SCRAP/last-run + join hint) ─────────────────────────────────────
  // #529: AUDIO/ART/STATS access moved to the shared pause menu (see wirePauseMenu's openStats
  // opt in create(), below) — the tab bar itself is now just the pinned Deploy/Ready button.
  // That button's own visual now reflects READY state (see ui/tabBar.js's `deployReady`), not
  // just its label text — it doubles as the per-column ready checkmark icon this rework removed.
  // #532 (change 2): the button also greys out/disables (`canDeploy: false`) whenever column 0's
  // build isn't FULLY equipped yet (all 4 weapons + both abilities, Mech.isFullyEquipped) and
  // isn't already ready — so it's not just silently impossible to ready up with a gap (see
  // _toggleReady's own hard gate below), it visibly can't be clicked either.
  // Once already READY the button stays clickable (to un-ready), regardless of what changes after.
  _refreshHeader() {
    this.tabBar?.layer.destroy();
    const ready0 = !!this.session.ready[0];
    const col0 = this.cols[0];
    const canDeploy0 = ready0 || !col0 || col0.mech.isFullyEquipped();
    this.tabBar = buildTabBar(this, {
      active: 'GarageScene',
      canDeploy: canDeploy0,
      onDeploy: () => this._toggleReady(0),
      deployLabel: ready0 ? '✓ READY' : '▶ READY',
      deployReady: ready0,
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

  // ── Column layout ─────────────────────────────────────────────────────────────────────────────
  // Rebuild every joined column at the CURRENT column width (W / count) — called at create() and
  // again on every join, so an existing column reflows wider→narrower as the squad grows, and a
  // solo column always fills the whole width rather than sitting squished next to empty ones.
  _relayoutColumns() {
    // catalogList and tabBarLayer are their own top-level containers (see _buildColumn — neither
    // lives inside col.layer), so destroying col.layer alone would leak them (tabBarLayer sits at
    // the shared bar's y, not colTop, and catalogList registers its own wheel/pointer listeners on
    // the scene's input plugin). chassisColorMaskG (#532) is likewise never added to col.layer —
    // it's an unparented mask source (see _buildChassisColorMask) — so it needs its own destroy too.
    for (const col of this.cols) {
      col?.catalogList?.destroy();
      col?.tabBarLayer?.destroy(true);
      col?.chassisColorMaskG?.destroy();
      col?.layer?.destroy(true);
    }
    this.cols = [];
    this.colW = Math.floor(this.W / this.session.count);
    this.colH = this.H - this.colTop;
    const idxs = activeIndices(this.session);
    idxs.forEach((i, pos) => this._buildColumn(i, pos === idxs.length - 1));
  }

  // Build every element of column `i` from its own persistent mech slot. All coordinates are
  // LOCAL to `col.layer` (whose position IS the column's screen offset) — EXCEPT `col.tabBarLayer`
  // (#532), which sits at the shared top bar's own y (0) instead, since it renders IN that bar's
  // row rather than below it. `isLast` says whether this is the rightmost active column, so its
  // tab row knows to leave room for the bar's pinned SCRAP/Deploy chrome (see _buildLabTabRow).
  _buildColumn(i, isLast) {
    const layer = this.add.container(i * this.colW, this.colTop);
    // #529: `labTab` is this column's OWN active Mech Lab tab (chassis+color/weapon/ability/
    // passive) — per-column, not scene-global, consistent with everything else in the
    // simultaneous multi-cursor Garage being per-player. Starts on the weapon tab, matching the
    // pre-#529 default (a weapon slot selected, its catalog showing).
    const col = {
      index: i, layer, selectedSlot: TILE_ORDER[0], labTab: LAB_TABS.findIndex((t) => t.id === 'weapon'),
      // #540: D-pad up/down navigates the current tab's own catalog/list (item focus); D-pad
      // left/right moves `selectedSlot` — the live "destination slot" cursor — among the current
      // tab's own slot family (weapon: TILE_ORDER, ability: HUD_ABILITY_ORDER). Both axes are
      // always live, no placement sub-mode. `listFocus` is the pad-cursor row index for the merged
      // chassis+color tab's own combined row list (chassis rows then color rows) — the
      // WeaponCardList catalog tracks its own focus internally (`col.catalogList`'s `_focus`), so
      // this is only needed for the one tab that isn't a WeaponCardList.
      listFocus: 0,
    };
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

    // #505 sixth rework (playtest, folds in #528): a thin top-edge border on the panel — a visible
    // dividing line between it and the scrollable weapon catalog above — plus an invisible click-
    // blocker sized to the panel's FULL extent (`gl.panel`, flush with the column's own bottom
    // padding now that the old footer dead-space is gone). WeaponCardList masks its scrolled-out
    // cards visually (see weaponCardList.js's geometry mask) but a mask doesn't stop them from
    // still being INPUT-live wherever they're positioned in world space — without this blocker, a
    // card scrolled far enough down sits invisibly underneath the panel and still catches the
    // click. Added FIRST (before any tile), so within `col.layer` every tile still renders — and
    // hit-tests — on TOP of it; only the gaps between tiles (and the halo/dead space around them)
    // fall through to the blocker instead of whatever's behind it. The old header band (the
    // passive-slot avatar + "READY?" pill) is gone entirely — see the compact ready indicator next
    // to the PLAYER # label for where that piece moved.
    col.panelTopBorder = this.add.rectangle(gl.panel.x, gl.panel.y, gl.panel.w, 2, UI.panelEdge)
      .setOrigin(0, 0).setAlpha(0.9);
    col.panelBlocker = this.add.rectangle(gl.panel.x, gl.panel.y, gl.panel.w, gl.panel.h, 0x000000, 0)
      .setOrigin(0, 0).setInteractive();
    col.layer.add([col.panelTopBorder, col.panelBlocker]);

    // The loadout tiles — weapon row + ability row, drawn with the SAME shared tile-drawing code
    // (drawSkillTile) the arena HUD uses, just with no HP/shield/armor panel chrome around them
    // (HudScene.js draws those separately, alongside its own call into the same tile rects).
    col.tileRefs = {};
    for (const rect of [...gl.tiles.weapons, ...gl.tiles.abilities]) this._drawColTile(col, rect);

    // #532: the tab strip (chassis+color/weapon/ability/passive) used to sit ABOVE the catalog
    // region, carved out of the top of `gl.catalog`'s own rect — it now lives up in the shared top
    // bar's row instead (see `col.tabBarLayer`, built below), so the catalog area gets the FULL
    // `gl.catalog` rect back rather than losing its top slice to the tab row.
    const catalogRect = gl.catalog;
    // `col.tabBarLayer` is a SEPARATE top-level container from `col.layer` (which starts at
    // `colTop`, i.e. below the shared bar) — it sits at this column's own x offset but y=0, and is
    // depth-sorted above the bar's own background/Deploy button (see ui/tabBar.js) so the tab
    // buttons read as part of that same row instead of floating behind it.
    col.tabBarLayer = this.add.container(i * this.colW, 0).setDepth(51);
    const tabY = (TAB_BAR_H - TAB_ROW_H) / 2;
    const rightReserve = isLast ? TAB_ROW_RIGHT_RESERVE : 0;
    const tabRowRect = {
      x: 10, y: tabY, w: Math.max(140, this.colW - 20 - rightReserve), h: TAB_ROW_H,
    };
    this._buildLabTabRow(col, tabRowRect);

    // The catalog — the shared WeaponCardList (ui/weaponCardList.js), the SAME component the
    // standalone Weapon Lab tab uses, in its `compact` mode so a row of cards (name/category/
    // stats + a live-firing shot/beam preview per card) fits this column's width. It owns its
    // own top-level container rather than living inside col.layer, so it's positioned in WORLD
    // coordinates (this column's own screen offset + the local catalog rect below). Refiltered/
    // reselected whenever the selected slot or a mount changes, via _refreshCatalogList. Backs the
    // WEAPON/ABILITY tabs (#529) — the same slot-filtered catalog mechanism as before, just now
    // only shown while one of those two tabs is active (see _refreshLabTabUI). (A third PASSIVE
    // tab existed briefly for #496's core-slot system; it's gone along with that system.)
    col.catalogList = new WeaponCardList(this, {
      x: col.layer.x + catalogRect.x, y: col.layer.y + catalogRect.y, w: catalogRect.w, h: catalogRect.h, compact: true,
      ids: this._eligibleIds(col.selectedSlot),
      onSelect: (id) => this._clickCatalogItem(col, id),
      selectedId: this._mountedIn(col, col.selectedSlot),
      // #506: abilities have no SCRAP-unlock data at all (shop.js's catalog is weapon-only) —
      // always unlocked and free to mount, so only a weapon id is ever gated here.
      isLocked: (id) => isWeapon(id) && !this.unlocked.has(id),
      costOf: (id) => (isWeapon(id) ? costOf(id) : 0),
    });
    // #505 sixth rework: catalogList owns its own top-level container (see the comment above), a
    // SIBLING of col.layer at the scene root rather than a child of it — so col.layer's default
    // depth (0) doesn't automatically out-rank it. Nudge the catalog just below that default so
    // col.layer's panel/blocker/tiles reliably win input priority wherever they overlap a
    // scrolled-out (masked but still input-live) card, regardless of which was constructed first.
    col.catalogList.root.setDepth(-1);

    // #532: the merged CHASSIS+COLOR tab's own selection lists — a plain clickable row per
    // PLAYER_CHASSIS_IDS entry (with a small live art preview, change 5), then a plain clickable
    // row per MECH_SWATCHES entry (with its name, change 4) — both built into the SAME
    // `catalogRect` (same rect the WeaponCardList catalog occupies), chassis rows first and color
    // rows below, so switching tabs simply swaps which of the two catalog-area surfaces is
    // visible. Both live INSIDE col.layer (unlike catalogList, which needs its own container for
    // WeaponCardList's scroll/mask machinery) since they're simple, non-scrolling, fully
    // custom-drawn lists. A shared clip mask keeps either section's overflow (if the column is too
    // short to fit both in full) from bleeding into the loadout tile panel below.
    const colorStartY = this._buildChassisList(col, catalogRect);
    this._buildColorList(col, catalogRect, colorStartY);
    this._buildChassisColorMask(col, catalogRect);
    this._refreshLabTabUI(col);

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

    // The player-number label — sits INSIDE the preview box, at its bottom (#505 playtest
    // follow-up on top of the earlier "just below the mech preview art" placement). #505 seventh
    // rework (playtest follow-up): the separate identity-colour dot that used to sit to its left
    // is gone — the label text itself is now painted in the player's identity colour, so there's
    // one element carrying that information instead of two.
    // #529: the compact checkmark-style READY indicator that used to sit to this label's right is
    // GONE — the single pinned top-right Deploy/Ready button (tab bar, column 0 only) now carries
    // that visual for the keyboard/mouse player (see ui/tabBar.js's `deployReady`). For every
    // OTHER joined column (no pinned button of their own), ready state instead folds into THIS
    // label's own text (a trailing "✓", see _refreshReady) rather than a separate icon element.
    col.headerLabel = this.add.text(gl.label.cx, gl.label.y, `PLAYER ${i + 1}`, {
      fontFamily: 'monospace', fontSize: '12px', color: hexColor(mechColorFor(col.mech, i)),
    }).setOrigin(0.5, 0);
    col.layer.add([col.headerLabel]);

    // #528 fix: WeaponCardList (col.catalogList, built above) owns its own top-level container
    // added to the scene AFTER col.layer, so by default it — and every card inside it — renders
    // (and, per Phaser's topOnly input hit-test, wins clicks) ON TOP of col.layer's own content,
    // including the panelBlocker/tiles/preview just built. Bringing the whole layer back to the
    // top of the scene's display list — once, after the catalog exists — restores the intended
    // stacking (the loadout panel visually sits in front of the catalog, matching the design) and
    // makes panelBlocker (and every tile's own hit area) win the input hit-test against any
    // catalog card that geometrically coincides with this column's loadout panel.
    this.children.bringToTop(col.layer);

    this._refreshReady(col);
  }

  // ── Mech Lab tab system (#529) — chassis+color/weapon/ability/passive, per column ──────────────
  // #532: the tab strip now lives in `col.tabBarLayer` (the shared top bar's own row — see
  // _buildColumn), not `col.layer`. Mouse click + LB/RB (gamepad) + '['/']' (column 0 keyboard)
  // all drive the same _setLabTab.
  _buildLabTabRow(col, rect) {
    col.labTabRefs = [];
    const n = LAB_TABS.length;
    const tabW = rect.w / n;
    LAB_TABS.forEach((tab, idx) => {
      const x = rect.x + idx * tabW;
      const r = this.add.rectangle(x, rect.y, tabW - 2, rect.h, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
      const t = this.add.text(x + (tabW - 2) / 2, rect.y + rect.h / 2, tab.label, {
        fontFamily: 'monospace', fontSize: '10px', color: UI.dim,
      }).setOrigin(0.5);
      r.on('pointerover', () => { if (col.labTab !== idx) r.setFillStyle(UI.btnHover); });
      r.on('pointerout', () => this._refreshLabTabUI(col));
      r.on('pointerdown', () => this._setLabTab(col, idx));
      col.tabBarLayer.add([r, t]);
      col.labTabRefs.push({ rect: r, text: t });
    });
  }

  // Repaint the tab row's highlight and swap which catalog-area surface (WeaponCardList /
  // chassis list / color list) is visible for the column's current labTab. Called after every
  // tab switch, and once at column build time.
  _refreshLabTabUI(col) {
    const tabId = LAB_TABS[col.labTab].id;
    col.labTabRefs.forEach((ref, idx) => {
      const on = idx === col.labTab;
      ref.rect.setFillStyle(on ? UI.btnHover : UI.btn).setStrokeStyle(1, on ? UI.accent : UI.panelEdge);
      ref.text.setColor(on ? UI.accent : UI.dim);
    });
    col.catalogList.root.setVisible(tabId === 'weapon' || tabId === 'ability');
    // #532: chassis + color are now ONE merged tab — both lists show/hide together.
    const showChassisColor = tabId === 'chassis';
    col.chassisListLayer.setVisible(showChassisColor);
    col.colorListLayer.setVisible(showChassisColor);
    if (showChassisColor) { this._refreshChassisList(col); this._refreshColorList(col); }
  }

  // Switch column `col`'s active tab. Landing on a slot-kind tab (weapon/ability/passive) whose
  // kind doesn't match the currently-selected slot re-focuses a real slot of that kind (e.g.
  // switching from ability→weapon lands on the first weapon slot, not an ability catalog under a
  // weapon-slot highlight) — see ui/labTabs.js's TAB_DEFAULT_SLOT.
  _setLabTab(col, tabIndex) {
    const n = LAB_TABS.length;
    col.labTab = ((tabIndex % n) + n) % n;
    const tabId = LAB_TABS[col.labTab].id;
    const defaultSlot = TAB_DEFAULT_SLOT[tabId];
    if (defaultSlot && slotKind(col.selectedSlot) !== slotKind(defaultSlot)) col.selectedSlot = defaultSlot;
    // #533: landing ON the merged chassis+color tab seeds its row cursor at the currently
    // equipped chassis, so the very first A press (with no prior up/down) does something sane
    // rather than acting on an arbitrary row 0.
    if (tabId === 'chassis') this._syncListFocus(col);
    this._refreshAllTiles(col);
    this._refreshCatalogList(col);
    this._refreshLabTabUI(col);
  }

  // LB/RB (gamepad) and '['/']' (column 0 keyboard) — cycle the column's own active tab.
  _cycleLabTab(col, dir) {
    if (!col) return;
    Audio.ui('menuNav');
    this._setLabTab(col, nextLabTab(col.labTab, dir));
  }

  // ── Merged CHASSIS+COLOR tab (#532) ──────────────────────────────────────────────────────────
  // A plain clickable row per PLAYER_CHASSIS_IDS entry (mediumPlayer/strikerPlayer/colossusPlayer
  // — cosmetic-only variants, identical stats, see data/chassis/*Player.js). Re-enables the
  // chassis switcher that #248 (commit 7a3893a) disabled, scoped to just these three cosmetic
  // picks rather than the old light/medium/heavy weight-class switch.
  //
  // #532 (change 5): each row now also shows a small RENDERED ART PREVIEW of that chassis, not
  // just its name — reusing the exact same sprite assembly the main mech-preview panel builds
  // from (art/mechView.js's makeMechParts/poseMechParts), just baked at a smaller scale from a
  // throwaway, unmounted Mech in that chassis, rather than inventing a new rendering approach.
  // Baked once per column (its own texture keys, `${col.textureKey}_chassisRow_<id>`) since the
  // three chassis shapes never change during a Garage visit.
  // Returns the y just below the chassis rows (where the color section starts).
  _buildChassisList(col, rect) {
    const rowH = CHASSIS_ROW_H, gap = CHASSIS_ROW_GAP;
    col.chassisListLayer = this.add.container(0, 0);
    const header = this.add.text(rect.x, rect.y, 'CHASSIS', {
      fontFamily: 'monospace', fontSize: '10px', color: UI.dim,
    }).setOrigin(0, 0);
    col.chassisListLayer.add(header);
    const rowsY = rect.y + LIST_SECTION_HEADER_H;
    const previewScale = (rowH - 8) / 230;
    col.chassisRows = PLAYER_CHASSIS_IDS.map((id, idx) => {
      const y = rowsY + idx * (rowH + gap);
      const r = this.add.rectangle(rect.x, y, rect.w, rowH, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
      const previewMech = new Mech({ chassisId: id, color: col.mech.color });
      const previewKey = `${col.textureKey}_chassisRow_${id}`;
      buildMechTextures(this, previewKey, previewMech,
        playerMechArt(col.index, { hullFrames: HULL_FRAMES, accent: mechColorFor(previewMech, col.index) }));
      const previewX = rect.x + 22, previewY = y + rowH / 2;
      const preview = makeMechParts(this, previewKey, { x: previewX, y: previewY, scale: previewScale, isPlayer: true });
      poseMechParts(preview, previewMech, -Math.PI / 2, previewScale, previewX, previewY, {});
      const t = this.add.text(rect.x + 46, y + rowH / 2, CHASSIS[id].name, {
        fontFamily: 'monospace', fontSize: '13px', color: UI.text,
      }).setOrigin(0, 0.5);
      r.on('pointerover', () => { if (col.mech.chassisId !== id) r.setFillStyle(UI.btnHover); });
      r.on('pointerout', () => this._refreshChassisList(col));
      r.on('pointerdown', () => this._selectChassis(col, id));
      col.chassisListLayer.add([r, ...preview.children, t]);
      return { id, rect: r, text: t };
    });
    col.layer.add(col.chassisListLayer);
    return rowsY + PLAYER_CHASSIS_IDS.length * (rowH + gap) + LIST_SECTION_GAP;
  }

  // A static clip mask over the merged chassis+color tab's own rect (#532) — a safeguard against
  // either section's rows spilling visually past the catalog area into the loadout tile panel
  // below on a short column, since neither list scrolls (scrolling/D-pad list navigation for this
  // tab is explicitly out of scope here — see #533). Built once per column; the rect is fixed at
  // column-build time so, unlike WeaponCardList's scroll-driven mask, this never needs repainting.
  _buildChassisColorMask(col, rect) {
    // Not added to the display list (scene.make, not scene.add) — a mask source only needs its
    // rendered pixels, never its own visible copy. Kept on `col` so _relayoutColumns can destroy
    // it along with everything else this column owns, same as WeaponCardList's own maskG.
    col.chassisColorMaskG = this.make.graphics();
    col.chassisColorMaskG.fillStyle(0xffffff)
      .fillRect(col.layer.x + rect.x, col.layer.y + rect.y, rect.w, rect.h);
    const mask = col.chassisColorMaskG.createGeometryMask();
    col.chassisListLayer.setMask(mask);
    col.colorListLayer.setMask(mask);
  }

  // #533: `idx` is this row's position in the COMBINED chassis+color row list (chassis rows
  // first, color rows after — see _syncListFocus/_navRow) — chassis rows occupy indices
  // [0, chassisRows.length).
  _refreshChassisList(col) {
    col.chassisRows.forEach((row, idx) => {
      const on = col.mech.chassisId === row.id;
      const focused = col.listFocus === idx;
      row.rect.setFillStyle(on || focused ? UI.btnHover : UI.btn)
        .setStrokeStyle(focused ? 2 : 1, focused ? UI.focus : on ? UI.accent : UI.panelEdge);
      row.text.setColor(on ? UI.accent : UI.text);
    });
  }

  // Directly pick chassis `id` (chassis-list row click).
  _selectChassis(col, id) {
    if (col.mech.chassisId === id) return;
    col.mech.setChassis(id);
    Audio.ui('equip');
    saveAllMechs(this.allMechs);
    buildMechTextures(this, col.textureKey, col.mech, this._artFor(col));
    poseMechParts(col.preview, col.mech, -Math.PI / 2, col.previewScale, col.previewCx, col.previewCy, {});
    this._refreshChassisList(col);
  }

  // #533: seed the merged chassis+color tab's row-nav cursor at the currently equipped chassis
  // row (index into the COMBINED chassis+color list — see _refreshChassisList) — called when a
  // column's tab lands ON 'chassis' (_setLabTab). Doesn't touch the color rows: the chassis pick
  // is the more likely thing to want to change next, and the cursor is only ONE index either way.
  _syncListFocus(col) {
    const idx = col.chassisRows.findIndex((row) => row.id === col.mech.chassisId);
    col.listFocus = idx >= 0 ? idx : 0;
  }

  // ── The color section of the merged CHASSIS+COLOR tab (#532) ────────────────────────────────
  // #532 (change 4): the swatch GRID is gone — this is now a navigable list of ROWS, each showing
  // the color's NAME (data/mechColors.js MECH_SWATCH_NAMES) alongside its swatch, so the picker is
  // identifiable at a glance instead of a bare grid of colour tiles. Same cycleSwatch model the
  // D-pad/arrow-key path already drives (_cycleColor, unchanged below) backs a direct row click too.
  // `startY` is where _buildChassisList's own rows ended (plus its section gap).
  _buildColorList(col, rect, startY) {
    col.colorListLayer = this.add.container(0, 0);
    const header = this.add.text(rect.x, startY, 'COLOR', {
      fontFamily: 'monospace', fontSize: '10px', color: UI.dim,
    }).setOrigin(0, 0);
    col.colorListLayer.add(header);
    const rowsY = startY + LIST_SECTION_HEADER_H;
    const rowH = COLOR_ROW_H, gap = COLOR_ROW_GAP;
    col.colorSwatchRefs = MECH_SWATCHES.map((hex, idx) => {
      const y = rowsY + idx * (rowH + gap);
      const r = this.add.rectangle(rect.x, y, rect.w, rowH, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
      const sw = this.add.rectangle(rect.x + 6, y + rowH / 2, rowH - 6, rowH - 6, hex).setOrigin(0, 0.5)
        .setStrokeStyle(1, UI.panelEdge);
      const t = this.add.text(rect.x + rowH + 14, y + rowH / 2, MECH_SWATCH_NAMES[idx], {
        fontFamily: 'monospace', fontSize: '12px', color: UI.text,
      }).setOrigin(0, 0.5);
      r.on('pointerover', () => { if (col.mech.color !== hex) r.setFillStyle(UI.btnHover); });
      r.on('pointerout', () => this._refreshColorList(col));
      r.on('pointerdown', () => this._selectColor(col, hex));
      col.colorListLayer.add([r, sw, t]);
      return { hex, rect: r, text: t };
    });
    col.layer.add(col.colorListLayer);
  }

  // #533: color rows sit AFTER every chassis row in the combined list — index `col.chassisRows.
  // length + idx` — see _refreshChassisList's own note.
  _refreshColorList(col) {
    const current = mechColorFor(col.mech, col.index);
    const focusBase = col.chassisRows.length;
    col.colorSwatchRefs.forEach((swatch, idx) => {
      const on = swatch.hex === current;
      const focused = col.listFocus === focusBase + idx;
      swatch.rect.setFillStyle(on || focused ? UI.btnHover : UI.btn)
        .setStrokeStyle(focused ? 2 : 1, focused ? UI.focus : on ? UI.accent : UI.panelEdge);
      swatch.text.setColor(on ? UI.accent : UI.text);
    });
  }

  // Directly pick a swatch (color-list click) — same distinctness rules as _cycleColor (no two
  // live co-op players may hold the same colour) via cycleSwatch's own canPickSwatch gate; a
  // colour already held by another joined player is simply not offered a real switch to (the
  // click no-ops, mirroring cycleSwatch landing back on `current` when nothing else is free).
  _selectColor(col, hex) {
    if (!isSwatch(hex) || col.mech.color === hex) return;
    const builds = activeIndices(this.session).map((i) => this.cols[i]?.mech).filter(Boolean);
    const taken = builds.some((m, bi) => bi !== col.index && mechColorFor(m, bi) === hex);
    if (taken) return;
    col.mech.color = hex;
    Audio.ui('menuNav');
    buildMechTextures(this, col.textureKey, col.mech, this._artFor(col));
    saveAllMechs(this.allMechs);
    poseMechParts(col.preview, col.mech, -Math.PI / 2, col.previewScale, col.previewCx, col.previewCy, {});
    col.headerLabel?.setColor(hexColor(hex));
    this._refreshColorList(col);
  }

  _artFor(col) {
    return playerMechArt(col.index, { hullFrames: HULL_FRAMES, accent: mechColorFor(col.mech, col.index) });
  }

  // ── Tiles (weapon/ability) ───────────────────────────────────────────────────────────────────
  _drawColTile(col, rect) {
    const loc = rect.loc;
    const id = this._mountedIn(col, loc);
    const kind = slotKind(loc);
    const refs = drawSkillTile(this, col.layer, rect, {
      loc, itemId: id, selected: loc === col.selectedSlot, bindGlyph: '',
      emptyLabel: kind === 'weapon' ? 'weapon' : 'ability',
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
      emptyLabel: kind === 'weapon' ? 'weapon' : 'ability',
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
    return this.catalogIds.filter((id) => {
      if (!WEAPON_SLOTS.includes(loc)) return false;
      if (getItem(id).category === 'melee' && !MELEE_LOCATIONS.includes(loc)) return false;
      return true;
    });
  }

  // Refilter the column's catalog to the currently-selected slot's eligible items and highlight
  // whatever's mounted there — called on a slot change (mouse or pad/keyboard), a tab switch,
  // and after any mount/unmount.
  // #541: only actually REBUILDS the card list (setIds — which resets scroll to the top) when
  // the eligible set genuinely changed content (e.g. crossing from a melee-only arm slot into a
  // non-melee slot, or switching tabs entirely — weapon/ability catalogs are disjoint id sets).
  // Switching between two slots that share the same eligible catalog (the common case:
  // two ordinary weapon slots, or the two ability slots) is the SAME list, just a different
  // "what's mounted here" highlight — so it now only repaints the selection/focus highlight in
  // place, leaving scroll exactly where the player left it. A genuine list-content change still
  // resets scroll to the top; that's a materially different list, not a browsing position worth
  // preserving.
  _refreshCatalogList(col) {
    const ids = this._eligibleIds(col.selectedSlot);
    const changed = !col.catalogList.sameIds(ids);
    if (changed) col.catalogList.setIds(ids);
    const mountedId = this._mountedIn(col, col.selectedSlot);
    col.catalogList.setSelected(mountedId);
    // #533: seed the pad-nav focus cursor on whatever's currently mounted (or the first row, if
    // the slot's empty) so the very first D-pad/arrow-key A-press has a real row to act on
    // without requiring an up/down press first. Only do this when the list was actually rebuilt
    // (setIds always resets focus to -1) — when it wasn't, the player is still looking at the
    // same list at the same scroll position, and a slot switch is not itself a reason to also
    // relocate their focus cursor onto whatever happens to be mounted in the new slot (#541
    // follow-up: this used to still snap the cursor even after scroll-snapping was fixed).
    if (changed) {
      const idx = col.catalogList.indexOfId(mountedId);
      col.catalogList.setFocus(idx >= 0 ? idx : 0);
    }
  }

  // #529: a tile click also flips the column's active tab to whichever tab that slot's kind
  // belongs to (weapon/ability/passive) — so clicking, say, an ability tile while the weapon
  // catalog is showing switches straight to the ability tab/catalog, keeping the always-visible
  // tile row and the catalog beneath it in sync no matter which one you interact with first.
  _selectSlot(col, loc) {
    Audio.ui('menuNav');
    col.selectedSlot = loc;
    const tab = labTabForSlotKind(slotKind(loc));
    if (tab != null) col.labTab = tab;
    this._refreshAllTiles(col);
    this._refreshCatalogList(col);
    this._refreshLabTabUI(col);
  }

  // ── #533: D-pad/keyboard nav — tab-cycle, row-navigate, select-then-place ──────────────────
  // #540: two always-live, independent axes — up/down (_navRow) picks WHICH ITEM in the current
  // tab's own list, left/right (_navSlot) picks WHICH SLOT `col.selectedSlot` — the destination a
  // bind (A) or clear (B) acts on. No mode-switching, no two-step placement (that was #533's
  // flow, dropped here). Reuses the loadout tile row's existing `selected` (gold) highlight —
  // driven by `col.selectedSlot`, the same visual a mouse-selected tile has always shown — as the
  // always-on slot cursor, rather than inventing a new one.

  // Left/right: move the live slot cursor within the current tab's own slot family. Weapon tab has
  // 4 slots (TILE_ORDER), ability tab has 2 (HUD_ABILITY_ORDER). Chassis+color and passive tabs
  // have exactly one conceptual "slot" each (a single dedicated pick) — nothing to cycle, so this
  // is a no-op there, consistent with how #533 already treated those tabs as direct-select only.
  _navSlot(col, dir) {
    if (!col) return;
    const tabId = LAB_TABS[col.labTab].id;
    const family = tabId === 'weapon' ? TILE_ORDER : tabId === 'ability' ? HUD_ABILITY_ORDER : null;
    if (!family || family.length < 2) return;
    const idx = family.indexOf(col.selectedSlot);
    this._selectSlot(col, family[stepIndex(idx >= 0 ? idx : 0, dir, family.length)]);
  }

  _navRow(col, dir) {
    if (!col) return;
    const tabId = LAB_TABS[col.labTab].id;
    if (tabId === 'chassis') {
      const total = col.chassisRows.length + col.colorSwatchRefs.length;
      col.listFocus = stepIndex(col.listFocus, dir, total, { wrap: false });
      Audio.ui('menuNav');
      this._refreshChassisList(col);
      this._refreshColorList(col);
    } else {
      col.catalogList.moveFocus(dir);   // weapon/ability/passive — the shared WeaponCardList cursor
    }
  }

  // The associated select button (A). Chassis/color rows equip directly off the list cursor —
  // there's only one place either can go. Weapon/ability/passive tabs bind the list-focused
  // catalog item straight into the currently slot-selected destination, one press.
  _confirmOrSelect(col) {
    if (!col) return;
    const tabId = LAB_TABS[col.labTab].id;
    if (tabId === 'chassis') { this._activateListFocus(col); return; }
    this._activateCatalogFocus(col);
  }

  // Direct-select whichever row the merged chassis+color tab's cursor is on.
  _activateListFocus(col) {
    if (col.listFocus < col.chassisRows.length) {
      this._selectChassis(col, col.chassisRows[col.listFocus].id);
      return;
    }
    const swatch = col.colorSwatchRefs[col.listFocus - col.chassisRows.length];
    if (swatch) this._selectColor(col, swatch.hex);
  }

  // The catalog's own pad-focused row — same purchase gate + mount call a direct mouse click on
  // that card already uses (_clickCatalogItem).
  _activateCatalogFocus(col) {
    const id = col.catalogList.focusedId();
    if (id == null) return;
    this._clickCatalogItem(col, id);
  }

  _mountedIn(col, loc) {
    const kind = slotKind(loc);
    if (kind === 'ability') return col.mech.abilityMounts[loc] ?? null;
    return col.mech.usedSlots(loc) >= 1 ? col.mech.mounts[loc][0] : null;
  }

  _clickCatalogItem(col, id) {
    if (isWeapon(id) && !this.unlocked.has(id)) { this._purchase(id); return; }
    this._mountInto(col, col.selectedSlot, id);
  }

  // A weapon slot always mounts/replaces (re-picking the mounted item is a no-op, and there's no
  // unmount — a weapon slot must stay filled to deploy); an ability slot is optional, so
  // re-picking the mounted item UNMOUNTS it instead.
  _mountInto(col, loc, itemId) {
    const mech = col.mech, kind = slotKind(loc);
    if (kind === 'ability') {
      const prevItem = this._mountedIn(col, loc);
      if (prevItem === itemId) { this._unmountFrom(col, loc); return; }
      if (prevItem) mech.unmountAbility(loc);
      const res = mech.mountAbility(loc, itemId);
      if (!res.ok) {
        if (prevItem) mech.mountAbility(loc, prevItem);
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

  // Pad B / the ability "clear" path — weapon slots have no unmount at all (see above).
  _unmountFrom(col, loc) {
    const kind = slotKind(loc);
    if (kind === 'ability') col.mech.unmountAbility(loc);
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
    // #532: a mount/unmount can flip column 0's full-loadout completeness, which the pinned
    // Deploy/Ready button's greyed-out state depends on (_refreshHeader) — repaint it live rather
    // than only on the next ready-toggle/join.
    if (col.index === 0) this._refreshHeader();
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
  // handlers). The mech re-baking its own texture + the PLAYER # label's own text colour (both
  // still repainted below) ARE the colour's visible feedback now — #505 seventh rework folded
  // the old separate identity dot into the label itself, so there's one thing left to repaint.
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
    // The PLAYER # label is painted in the identity colour — repaint it in place.
    col.headerLabel?.setColor(hexColor(next));
    // #529: keep the color tab's own swatch-grid highlight in sync, in case it's the active tab.
    this._refreshColorList(col);
  }

  // ── Ready / deploy ───────────────────────────────────────────────────────────────────────────
  // #529: the old compact checkmark-style indicator next to the PLAYER # label is gone (replaced,
  // for column 0/the keyboard-mouse player, by the pinned top-right Deploy/Ready button's own
  // visual — see ui/tabBar.js's `deployReady` + _refreshHeader). Every column's own ready state
  // still needs SOME visible signal for co-op (columns 1-3 have no pinned button of their own), so
  // it folds into the PLAYER # label's own text — a trailing "✓" — rather than a separate element.
  _refreshReady(col) {
    const ready = this.session.ready[col.index];
    col.headerLabel?.setText(`PLAYER ${col.index + 1}${ready ? ' ✓' : ''}`);
  }

  // Toggling a player TO ready is gated on their build being FULLY equipped (#532 change 2: every
  // weapon slot AND both ability slots — not just weapons, #506's older "ability stays optional"
  // rule); toggling back off is always allowed. Ability slots CAN be left empty through this UI
  // (unlike weapon slots, which always mount/replace and have no unmount), so this is a real,
  // reachable gate now, not just a defensive one. The old third clause — the passive/core slot
  // (#496) — is gone with the core-slot system itself: shield is an unconditional baseline with
  // nothing to fill, so there's nothing left to gate on there.
  _toggleReady(i) {
    const col = this.cols[i];
    if (!col) return;
    const goingReady = !this.session.ready[i];
    if (goingReady && !col.mech.isFullyEquipped()) {
      const emptyWeapons = MOUNT_LOCATIONS.filter((loc) => col.mech.usedSlots(loc) === 0)
        .map((loc) => LOCATION_INFO[loc].short);
      const emptyAbilities = ABILITY_SLOTS.filter((slot) => !col.mech.abilityMounts[slot]).map(() => 'ability');
      const names = [...emptyWeapons, ...emptyAbilities].join(', ') || 'all slots';
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
  // every other player's. #540 rework (supersedes #533's placement flow and #539's trigger
  // quick-mount): LB/RB cycle the column's own Mech Lab tab (chassis+color/weapon/ability/passive
  // — column 0's keyboard '['/']' does the same, see _cycleLabTab); LT/RT do nothing in the
  // Garage. D-pad up/down navigates the current tab's own list — which ITEM is focused (_navRow,
  // unchanged from #533). D-pad left/right moves `col.selectedSlot` — which SLOT a bind targets —
  // always live, no sub-mode to enter first (_navSlot). A binds the list-focused item into the
  // slot-selected destination in one press (_confirmOrSelect → _activateCatalogFocus); B unbinds
  // whatever's in the selected slot (_unmountFrom — a no-op on weapon slots, which always
  // mount/replace and have no unmount). SELECT and START both toggle ready — START is freed up
  // for this in the Garage specifically (padStart: false on wirePauseMenu, above) rather than
  // opening the shared pause menu the way it does everywhere else (see PauseMenuScene.js); ESC
  // (keyboard) still reaches the pause menu here for STATS/AUDIO/ART/settings access.
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
      if (e.pressed(PAD.SELECT) || e.pressed(PAD.START)) { this._toggleReady(i); continue; }
      // Bumpers cycle tabs; triggers move the live slot cursor (weapon/ability sub-items). D-pad
      // left/right is one more way to move the slot cursor, same as the triggers.
      if (e.pressed(PAD.LB)) { this._cycleLabTab(col, -1); continue; }
      if (e.pressed(PAD.RB)) { this._cycleLabTab(col, 1); continue; }
      if (e.pressed(PAD.DPAD_LEFT)) { this._navSlot(col, -1); continue; }
      if (e.pressed(PAD.DPAD_RIGHT)) { this._navSlot(col, 1); continue; }
      if (e.pressed(PAD.DPAD_UP)) { this._navRow(col, -1); continue; }
      if (e.pressed(PAD.DPAD_DOWN)) { this._navRow(col, 1); continue; }
      if (e.pressed(PAD.LT)) { this._navSlot(col, -1); continue; }
      if (e.pressed(PAD.RT)) { this._navSlot(col, 1); continue; }
      if (e.pressed(PAD.A)) { this._confirmOrSelect(col); continue; }
      if (e.pressed(PAD.B)) { this._unmountFrom(col, col.selectedSlot); continue; }
      // The left stick mirrors the D-pad exactly (up/down row-nav, left/right slot-nav), with
      // the same auto-repeat cadence padNav.js's DirRepeater already gives every other held-
      // direction control in this scene.
      const ls = e.pad()?.leftStick;
      const dir = ls ? dominantDir(ls.x, ls.y) : null;
      const step = this.stickRepeat[i].step(dir, time);
      if (step === 'left') this._navSlot(col, -1);
      else if (step === 'right') this._navSlot(col, 1);
      else if (step === 'up') this._navRow(col, -1);
      else if (step === 'down') this._navRow(col, 1);
    }
  }
}
