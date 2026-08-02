import Phaser from 'phaser';
import { buildMechTextures, reskinMech, HULL_FRAMES } from '../art/index.js';
import { playerMechArt } from '../art/playerMechLook.js';
import { makeMechParts, poseMechParts } from '../art/mechView.js';
import {
  SHIELD_MECH_PART_KEYS, SHIELD_COLOR, SHIELD_PLAYER_BLEND,
  makeShieldOutline, updateShowroomShieldOutline,
} from './arena/shieldOutline.js';
import { mechColorFor, cycleSwatch, MECH_SWATCHES, MECH_SWATCH_NAMES, isSwatch } from '../data/mechColors.js';
import { PLAYER_CHASSIS_IDS, CHASSIS } from '../data/chassis/index.js';
import { Mech } from '../data/Mech.js';
import { saveAllMechs, loadUnlocked, saveUnlocked, saveRunCurrency } from '../data/save.js';
import { WEAPON_IDS } from '../data/weapons.js';
import { ABILITIES } from '../data/abilities.js';
import { isWeapon, getItem } from '../data/items.js';
import { costOf } from '../data/shop.js';
import {
  ABILITY_SLOTS, MOUNT_LOCATIONS, LOCATION_INFO, slotKind,
} from '../data/anatomy.js';
import { RUN_CURRENCY_KEY } from '../data/events.js';
import { PadEdges, PAD, SKILL_BINDS, ABILITY_BINDS } from '../input/Controls.js';
import { TILE_ORDER, drawSkillTile, updateSkillTile, paintTilePlate } from '../ui/skillTiles.js';
import { stepIndex, dominantDir, DirRepeater } from '../ui/padNav.js';
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
// weaponCardList.js, the same component the standalone Weapon Lab tab uses), at FULL size:
// rows of weapons, each with its own live-firing shot/beam preview, scrolled inside the
// column's own catalog rect rather than a fixed-size no-scroll grid. (These rows ran in
// `compact` mode from #505 until 2026-08-01 — see _buildColumn's own note.)
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

// Every slot a column can bind into: the four weapon slots + the two ability slots.
const ALL_SLOTS = [...TILE_ORDER, ...ABILITY_SLOTS];

// #607 (supersedes #529's tab system, #532's tabs-in-the-Ready-row, #533's select-then-place and
// #540's A-bind/B-unbind + D-pad destination-slot cursor; restores the spirit of #539). The
// per-column TAB STRIP is gone entirely — `ui/labTabs.js` is deleted and `col.labTab` with it.
// In its place each column has ONE continuous scrolling catalog, in this fixed order top to
// bottom. The first two sections are bands inside the shared WeaponCardList (its #607 `sections`
// support); the last two are the column's own chassis/color row lists, parked below the cards in
// the SAME scroll space (WeaponCardList's `setExtraHeight`/`onScroll` seams).
//
// Nav: D-pad up/down runs ONE cursor continuously down all four sections; D-pad left/right jumps
// section to section. Binding: with a catalog row focused you press the BUTTON OF THE SLOT you
// want it in — LT/LB/RB/RT for the four weapons and X/Y for the two abilities, exactly their
// in-arena fire binds (SKILL_BINDS/ABILITY_BINDS). LB/RB are free precisely because tab-cycling
// is gone. A confirms a CHASSIS or COLOR row only — deliberately no A-bind fallback in the item
// sections. There is no unbind gesture at all: you replace a slot by binding something else
// there (Ready already demands a full loadout, #532).
const CATALOG_SECTIONS = ['ability', 'weapon', 'chassis', 'color'];

// #607: which slot each pad button binds into — derived from the SAME tables the arena fires
// from, so "press the button you'd shoot it with" can't drift out of sync with the arena binds.
const PAD_BIND_SLOTS = [...Object.entries(SKILL_BINDS), ...Object.entries(ABILITY_BINDS)]
  .map(([loc, bind]) => ({ loc, button: PAD[bind.pad] }))
  .filter((b) => b.button != null);

// #607: the keyboard half of the same table. SKILL_BINDS/ABILITY_BINDS carry the arena's own key
// labels; this maps each one onto its Phaser `keydown-*` event name. The two ARMS are bound to
// MOUSE buttons in the arena (LMB/RMB), not keys — they have no entry here, and the mouse path
// for them is clicking the arm's own loadout tile (see _drawColTile).
const KEY_EVENT_NAMES = { Q: 'Q', E: 'E', 1: 'ONE', 4: 'FOUR' };

// Chassis + color row geometry — both render below the cards in the one continuous catalog,
// chassis rows first, color rows below (#607; the geometry itself is #532's, unchanged).
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
    // #607: UP/DOWN run the one continuous catalog cursor (_navRow, now crossing section
    // boundaries); LEFT/RIGHT jump section to section (_navSection) — they no longer move a
    // destination-slot cursor, because #540's slot cursor is gone (the button you press IS the
    // slot). ENTER/SPACE mirror the pad's A: confirm a chassis/color row, nothing in the item
    // sections.
    this.input.keyboard.on('keydown-LEFT', () => this._navSection(this.cols[0], -1));
    this.input.keyboard.on('keydown-RIGHT', () => this._navSection(this.cols[0], 1));
    this.input.keyboard.on('keydown-UP', () => this._navRow(this.cols[0], -1));
    this.input.keyboard.on('keydown-DOWN', () => this._navRow(this.cols[0], 1));
    this.input.keyboard.on('keydown-ENTER', () => this._confirm(this.cols[0]));
    // #607: the keyboard mirror of the pad's bind buttons — press the key you'd FIRE that slot
    // with to mount the focused catalog row into it. Driven straight off SKILL_BINDS/
    // ABILITY_BINDS (see KEY_EVENT_NAMES) so the two can't drift; '['/']' (the #529 tab cycle)
    // are gone with the tabs themselves.
    for (const [loc, bind] of [...Object.entries(SKILL_BINDS), ...Object.entries(ABILITY_BINDS)]) {
      const ev = KEY_EVENT_NAMES[bind.key];
      if (!ev) continue;   // LMB/RMB (the arms) — mouse buttons, not keys; click the arm's tile
      this.input.keyboard.on(`keydown-${ev}`, () => this._bindFocused(this.cols[0], loc));
    }

    // #607 follow-up: the live `inputMode` sources for THIS scene, so the loadout tiles' bind
    // glyphs follow whatever the player is actually holding (see `_noteInputMode`/`_colMode`).
    // Any key, any mouse press and any real mouse MOVEMENT count as keyboard+mouse; any button on
    // pad 0 counts as pad. Deliberately Phaser's own gamepad event and not this scene's PadEdges:
    // `PadEdges.pressed()` consumes the edge it reports, so a second scan for "did anything
    // happen" would eat the presses the bind/nav handlers below are waiting for. The left stick's
    // own contribution rides along in update(), where it's already being polled past a deadzone.
    this.input.keyboard.on('keydown', () => this._noteInputMode('kbm'));
    this.input.on('pointermove', () => this._noteInputMode('kbm'));
    this.input.on('pointerdown', () => this._noteInputMode('kbm'));
    this.input.gamepad?.on('down', (pad) => { if ((pad?.index ?? 0) === 0) this._noteInputMode('pad'); });
    this.registry.events.on('changedata-inputMode', this._onInputModeChanged, this);
    this.events.once('shutdown', () => this.registry.events.off('changedata-inputMode', this._onInputModeChanged, this));

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
    // catalogList is its own top-level container (see _buildColumn — it does not live inside
    // col.layer), so destroying col.layer alone would leak it along with the wheel/pointer
    // listeners it registers on the scene's input plugin. chassisColorMaskG (#532) is likewise
    // never added to col.layer — it's an unparented mask source (see _buildChassisColorMask) — so
    // it needs its own destroy too. (#607: the per-column tab strip container that also needed
    // one here is gone with the tab system.)
    for (const col of this.cols) {
      col?.catalogList?.destroy();
      col?.chassisColorMaskG?.destroy();
      col?.layer?.destroy(true);
    }
    this.cols = [];
    this.colW = Math.floor(this.W / this.session.count);
    this.colH = this.H - this.colTop;
    for (const i of activeIndices(this.session)) this._buildColumn(i);
  }

  // Build every element of column `i` from its own persistent mech slot. All coordinates are
  // LOCAL to `col.layer`, whose position IS the column's screen offset. (#607: the separate
  // `col.tabBarLayer` that used to sit up in the shared top bar's own row is gone with the tab
  // system it drew.)
  _buildColumn(i) {
    const layer = this.add.container(i * this.colW, this.colTop);
    // #607: ONE cursor runs the whole catalog, and it lives in one of two places — `focusZone`
    // says which. 'catalog' means the WeaponCardList owns it (its own internal `_focus`, spanning
    // the ABILITIES and WEAPONS bands); 'list' means it's down in this column's own CHASSIS/COLOR
    // rows, at `listFocus` (a single index across both: chassis rows first, color rows after).
    // Per-column, not scene-global — same as every other piece of per-player state here, so each
    // joined player keeps their own scroll position and own focused row (#505).
    // The #529 `labTab` and #540 `selectedSlot` destination-slot cursor are both gone.
    const col = { index: i, layer, focusZone: 'catalog', listFocus: 0 };
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

    // #607: the tab strip that #532 moved up into the shared top bar's row is GONE, along with
    // `col.tabBarLayer` — there is nothing above the catalog any more, so it owns the FULL
    // `gl.catalog` rect and the whole thing scrolls as one list.
    const catalogRect = gl.catalog;

    // The catalog — the shared WeaponCardList (ui/weaponCardList.js), the SAME component the
    // standalone Weapon Lab tab uses, at FULL size (`compact: false`). It owns its own top-level
    // container rather than living inside col.layer, so it's positioned in WORLD coordinates
    // (this column's own screen offset + the local catalog rect below).
    // Jackson, 2026-08-01: "somewhere a LONG time ago, the garage weapon preview rows got
    // smaller/shorter/not so tall; I hate it." #505 (5304539, 2026-07-25) introduced `compact`
    // and shrank these rows from CARD_H 96 to COMPACT_CARD_H 60 — along with the fonts, label
    // width, live-preview emitter size and spacing — so up to four columns could fit side by
    // side. He asked for the full non-compact row back, and chose that over a height-only
    // restore having been told it will crowd at 3-4 player co-op. If that crowding turns out to
    // be worse than the taller rows are better, per-player-count sizing is the fallback.
    // #607: built ONCE with BOTH item bands (ABILITIES then WEAPONS) as sections — it is never
    // refiltered per slot again, because there is no selected slot any more. That also settles
    // #541 by construction: setIds/setSections (the only things that reset scroll) simply never
    // run again for the life of the column, so browsing position survives everything.
    // The highlighted cards are now every item mounted ANYWHERE in this column's build.
    col.catalogList = new WeaponCardList(this, {
      x: col.layer.x + catalogRect.x, y: col.layer.y + catalogRect.y, w: catalogRect.w, h: catalogRect.h, compact: false,
      sections: [
        { id: 'ability', label: 'ABILITIES', ids: Object.keys(ABILITIES) },
        { id: 'weapon', label: 'WEAPONS', ids: this.catalogIds },
      ],
      onSelect: (id) => this._clickCatalogItem(col, id),
      onHover: (_id, index) => this._focusCatalogRow(col, index, { scroll: false }),
      onScroll: () => this._syncExtraScroll(col),
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

    // The CHASSIS and COLOR sections — a plain clickable row per PLAYER_CHASSIS_IDS entry (with a
    // small live art preview, #532 change 5), then a plain clickable row per MECH_SWATCHES entry
    // (with its name, #532 change 4). Both live INSIDE col.layer (unlike catalogList, which needs
    // its own container for WeaponCardList's scroll/mask machinery) since they're simple,
    // custom-drawn lists; a shared clip mask keeps them inside the catalog rect.
    // #607: they are no longer a TAB that swaps places with the card list — they are the LAST TWO
    // SECTIONS of the one continuous catalog, parked directly below the cards in the same scroll
    // space. Their rows are laid out in that block's OWN coordinates (0 = the CHASSIS header) and
    // the two containers are then translated as a unit by _syncExtraScroll, which the card list
    // calls on every scroll change.
    const colorStartY = this._buildChassisList(col, catalogRect);
    const extraH = this._buildColorList(col, catalogRect, colorStartY);
    this._buildChassisColorMask(col, catalogRect);
    col.catalogList.setExtraHeight(extraH + CHASSIS_ROW_GAP);
    this._syncExtraScroll(col);
    // Start the cursor at the top of the list, and light up whatever this build already carries.
    col.catalogList.setFocus(0);
    this._refreshCatalogSelection(col);

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
    // 2026-07-31 live-chat ask ("add shield visual glow or whatever to the mech preview in garage").
    // The SAME shield shell the arena draws — same construction call, same colour, same NORMAL
    // blend, same baked `_shield` rasters (scenes/arena/shieldOutline.js is the one place that knows
    // how a shield is drawn, per #302), just driven by the showroom driver instead of a live pool:
    // every player mech gets the 100-point baseline unconditionally at deploy, so the lab shows what
    // it will look like wearing it. Only the MAIN lab preview gets one — the little chassis-picker
    // thumbnails (_buildChassisList) deliberately don't: at ~26px their whole job is comparing three
    // silhouettes, and a blue rim on each would blur exactly the difference the rows exist to show.
    //
    // The shells go into `col.layer` between the preview panel and the mech art, so the mech's own
    // parts still cover all of each duplicate except the rim — hence the three adds in this order
    // rather than one combined add.
    col.layer.add(col.previewPanel);
    col.previewShield = makeShieldOutline(this, col.preview, {
      keys: SHIELD_MECH_PART_KEYS, scale, color: SHIELD_COLOR, blend: SHIELD_PLAYER_BLEND,
      bakedShell: true, dilated: true,
      attach: (o) => col.layer.add(o),
    });
    col.layer.add(col.preview.children);
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

  // ── #607: the one continuous catalog's scroll glue ────────────────────────────────────────────
  // The CHASSIS/COLOR rows aren't inside WeaponCardList's own scroller (they're this scene's own
  // objects, in col.layer), so they have to be translated by hand to stay in the same scroll
  // space as the cards. Called on every scroll change, via the list's `onScroll`.
  _syncExtraScroll(col) {
    if (!col?.chassisListLayer) return;
    const rect = col.rects.catalog;
    const top = rect.y + col.catalogList.cardsHeight() - col.catalogList.scrollY();
    col.chassisListLayer.y = top;
    col.colorListLayer.y = top;
    // These rows scroll now, so a row scrolled out of the catalog rect lands somewhere else on
    // screen still input-live (the clip mask hides it but doesn't stop hit-testing — the same
    // trap `col.panelBlocker` exists for on the card side). Gate each row's hit area on actually
    // being inside the rect.
    for (const row of this._extraRows(col)) {
      const y0 = top + row.top;
      if (row.rect.input) row.rect.input.enabled = y0 + row.h > rect.y && y0 < rect.y + rect.h;
    }
  }

  // Every row below the cards, as ONE list: chassis rows first, then color rows — the order
  // `col.listFocus` indexes into.
  _extraRows(col) {
    return [...(col.chassisRows ?? []), ...(col.colorSwatchRefs ?? [])];
  }

  // ── CHASSIS + COLOR sections ─────────────────────────────────────────────────────────────────
  // A plain clickable row per PLAYER_CHASSIS_IDS entry (mediumPlayer/strikerPlayer/colossusPlayer
  // — cosmetic-only variants, identical stats, see data/chassis/player/*.js). Re-enables the
  // chassis switcher that #248 (commit 7a3893a) disabled, scoped to just these three cosmetic
  // picks rather than the old light/medium/heavy weight-class switch.
  //
  // #532 (change 5): each row now also shows a small RENDERED ART PREVIEW of that chassis, not
  // just its name — reusing the exact same sprite assembly the main mech-preview panel builds
  // from (art/mechView.js's makeMechParts/poseMechParts), just baked at a smaller scale from a
  // throwaway, unmounted Mech in that chassis, rather than inventing a new rendering approach.
  // Baked once per column (its own texture keys, `${col.textureKey}_chassisRow_<id>`) since the
  // three chassis shapes never change during a Garage visit.
  // #607: every y here is relative to the START OF THE CHASSIS/COLOR BLOCK (0 = the CHASSIS
  // header), not to the catalog rect — the block's screen position is whatever the shared scroll
  // puts it at, and _syncExtraScroll applies that by moving the two containers as a unit.
  // Returns the y just below the chassis rows (where the color section starts).
  _buildChassisList(col, rect) {
    const rowH = CHASSIS_ROW_H, gap = CHASSIS_ROW_GAP;
    col.chassisListLayer = this.add.container(0, 0);
    const header = this.add.text(rect.x, 0, 'CHASSIS', {
      fontFamily: 'monospace', fontSize: '10px', color: UI.dim,
    }).setOrigin(0, 0);
    col.chassisListLayer.add(header);
    const rowsY = LIST_SECTION_HEADER_H;
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
      // #607: `top`/`h` are what the shared cursor scrolls to and what _syncExtraScroll gates the
      // row's hit area on.
      return { id, rect: r, text: t, top: y, h: rowH };
    });
    col.layer.add(col.chassisListLayer);
    return rowsY + PLAYER_CHASSIS_IDS.length * (rowH + gap) + LIST_SECTION_GAP;
  }

  // A static clip mask over the catalog rect (#532). #607: it is now load-bearing rather than a
  // safeguard — these rows genuinely scroll (they're the last two sections of the one continuous
  // catalog), so this is what keeps them from drawing outside the catalog area, exactly like
  // WeaponCardList's own mask does for the cards. Built once per column; the rect is fixed at
  // column-build time, so unlike the card list's mask this never needs repainting.
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

  // `idx` is this row's position in the COMBINED chassis+color row list (chassis rows first,
  // color rows after — see _extraRows/_navRow); chassis rows occupy [0, chassisRows.length).
  // #607: the cursor only counts as being HERE when `focusZone` says so — it's one cursor shared
  // with the card list above, so a focused card must leave these rows unhighlighted.
  _refreshChassisList(col) {
    col.chassisRows.forEach((row, idx) => {
      const on = col.mech.chassisId === row.id;
      const focused = col.focusZone === 'list' && col.listFocus === idx;
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

  // ── The COLOR section ───────────────────────────────────────────────────────────────────────
  // #532 (change 4): the swatch GRID is gone — this is now a navigable list of ROWS, each showing
  // the color's NAME (data/mechColors.js MECH_SWATCH_NAMES) alongside its swatch, so the picker is
  // identifiable at a glance instead of a bare grid of colour tiles. Same cycleSwatch model the
  // D-pad/arrow-key path already drives (_cycleColor, unchanged below) backs a direct row click too.
  // `startY` is where _buildChassisList's own rows ended (plus its section gap), in the same
  // block-relative coordinates (#607). Returns the block's TOTAL height, which the card list
  // needs to size the shared scroll range (`setExtraHeight`).
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
      return { hex, rect: r, text: t, top: y, h: rowH };
    });
    col.layer.add(col.colorListLayer);
    return rowsY + MECH_SWATCHES.length * (rowH + gap);
  }

  // Color rows sit AFTER every chassis row in the combined list — index `col.chassisRows.length +
  // idx` — see _refreshChassisList's own note.
  _refreshColorList(col) {
    const current = mechColorFor(col.mech, col.index);
    const focusBase = col.chassisRows.length;
    col.colorSwatchRefs.forEach((swatch, idx) => {
      const on = swatch.hex === current;
      const focused = col.focusZone === 'list' && col.listFocus === focusBase + idx;
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
  // #607: a tile no longer carries a `selected` (destination-slot cursor) highlight — that cursor
  // is gone, because the button you press IS the slot. In its place each tile now SHOWS THAT
  // BUTTON: the same pad glyph it fires with in the arena, straight out of SKILL_BINDS/
  // ABILITY_BINDS, so "press LB to put this in that slot" is readable off the tile itself.
  // Clicking a tile is the mouse's version of pressing its button — it binds whatever catalog row
  // is currently focused (hovering a card is how the mouse focuses one).
  //
  // #607 playtest follow-up (Jackson: "in the garage, current bindings should be visible on the
  // weapon/ability row (towards the right side of the preview row)"): `bindEdge` moves the glyph
  // off the top of the tile and onto its right edge at mid-height, on all six tiles. Garage-only —
  // the arena HUD's tiles keep that edge for the live ammo/cooldown column (see skillTiles.js).
  // The glyph also MATCHES THE INPUT DEVICE now (`_colMode`) instead of always showing the pad's.
  _tileOpts(col, loc) {
    const id = this._mountedIn(col, loc);
    const bind = SKILL_BINDS[loc] ?? ABILITY_BINDS[loc];
    const pad = this._colMode(col) === 'pad';
    return {
      loc, itemId: id, selected: false, bindEdge: true,
      bindGlyph: (pad ? bind?.pad : bind?.key) ?? '',
      emptyLabel: slotKind(loc) === 'weapon' ? 'weapon' : 'ability',
      subtitle: id ? getItem(id).name : '',
    };
  }

  // #607 follow-up: which glyph set a column's tiles show — the exact rule HudScene's `_panelMode`
  // applies to an arena panel. Column 0 is the keyboard+mouse player and follows the live
  // `inputMode`; every later column is a gamepad-only player by construction (input/Controls.js
  // only ever gives player 0 the keyboard), so showing them Q/E/LMB would be showing them keys
  // they cannot press.
  _colMode(col) {
    if (col.index > 0) return 'pad';
    return this.registry.get('inputMode') === 'pad' ? 'pad' : 'kbm';
  }

  // #607 follow-up: keep `inputMode` live while the player is standing IN the Garage. Until now
  // only the arena wrote it (scenes/arena/locomotion.js, off the primary player's per-frame
  // intent), so someone who picked up a controller — or put one down — between sorties kept
  // seeing the other device's glyphs until they deployed. Guarded on an actual CHANGE: Phaser's
  // registry fires `changedata` on every set, equal value or not, and the mouse-move source below
  // fires constantly.
  _noteInputMode(mode) {
    if (this.registry.get('inputMode') !== mode) this.registry.set('inputMode', mode);
  }

  // Repaint every column's glyphs when the mode flips. Hung off the registry's own change event
  // rather than called from `_noteInputMode` directly, so a write from anywhere else (a scene
  // still running underneath, a future caller) repaints too.
  _onInputModeChanged() {
    for (const col of this.cols) if (col) this._refreshAllTiles(col);
  }

  _drawColTile(col, rect) {
    const loc = rect.loc;
    const refs = drawSkillTile(this, col.layer, rect, this._tileOpts(col, loc));
    refs.bg.setInteractive({ useHandCursor: true }).on('pointerdown', () => this._bindFocused(col, loc));
    col.tileRefs[loc] = refs;
  }

  _refreshTile(col, loc) {
    const refs = col.tileRefs[loc];
    if (!refs) return;
    updateSkillTile(refs, this._tileOpts(col, loc));
  }

  _refreshAllTiles(col) {
    for (const loc of ALL_SLOTS) this._refreshTile(col, loc);
  }

  // ── The catalog (WeaponCardList, compact) ────────────────────────────────────────────────────
  // #607: the catalog is no longer FILTERED to a selected slot — it's the whole set, always, in
  // two labelled bands, built once (see _buildColumn). The gold "you have this" highlight is now
  // every item mounted anywhere in this column's build, rather than the one item in the one
  // selected slot. Nothing here ever rebuilds the card list, so nothing here can reset scroll —
  // which is #541's guarantee, now structural instead of conditional.
  _refreshCatalogSelection(col) {
    const mounted = new Set();
    for (const loc of ALL_SLOTS) {
      const id = this._mountedIn(col, loc);
      if (id) mounted.add(id);
    }
    col.catalogList.setSelected(mounted);
  }

  // ── #607: ONE cursor, four sections, bind-by-slot-button ──────────────────────────────────────
  // Supersedes #533's select-then-place and #540's two-axis slot-cursor model wholesale. D-pad
  // up/down (_navRow) runs a single cursor straight down ABILITIES → WEAPONS → CHASSIS → COLOR,
  // crossing every boundary; D-pad left/right (_navSection) jumps section to section. There is no
  // destination-slot cursor at all — a bind names its slot by WHICH BUTTON was pressed
  // (_bindFocused), and A only confirms a chassis/color row (_confirm).

  // Move the cursor to a card, wherever it currently is. Also what a mouse hover does.
  _focusCatalogRow(col, idx, opts = {}) {
    if (!col || idx < 0) return;
    col.focusZone = 'catalog';
    col.catalogList.setFocus(idx, opts);
    this._refreshExtraFocus(col);
  }

  _refreshExtraFocus(col) {
    if (!col.chassisRows || !col.colorSwatchRefs) return;   // called before the block exists yet
    this._refreshChassisList(col);
    this._refreshColorList(col);
  }

  // Move the cursor onto chassis/color row `idx` (index across BOTH, chassis first), taking it
  // off the card list and scrolling it into view.
  _focusExtraRow(col, idx) {
    col.focusZone = 'list';
    col.listFocus = idx;
    col.catalogList.clearFocus();
    Audio.ui('menuNav');
    this._refreshExtraFocus(col);
    const row = this._extraRows(col)[idx];
    if (row) col.catalogList.scrollToContent(col.catalogList.cardsHeight() + row.top, row.h);
  }

  // Up/down — one continuous run through every row in the column, cards and chassis/color rows
  // alike. Clamped at both ends (it's a list, not a carousel), same as the card list's own
  // moveFocus has always been.
  _navRow(col, dir) {
    if (!col) return;
    const n = col.catalogList.cardCount();
    const rows = this._extraRows(col);
    if (col.focusZone === 'catalog') {
      // Stepping off the LAST card is what crosses into the chassis/color rows below.
      if (dir > 0 && col.catalogList.focusIndex() >= n - 1 && rows.length) { this._focusExtraRow(col, 0); return; }
      col.catalogList.moveFocus(dir);
      return;
    }
    const j = col.listFocus + dir;
    if (j < 0) {   // back up off the first chassis row into the last card
      col.focusZone = 'catalog';
      Audio.ui('menuNav');
      col.catalogList.setFocus(n - 1);
      this._refreshExtraFocus(col);
      return;
    }
    if (j >= rows.length) return;
    this._focusExtraRow(col, j);
  }

  // Which of CATALOG_SECTIONS the cursor is sitting in right now.
  _currentSection(col) {
    if (col.focusZone === 'list') {
      return col.listFocus < col.chassisRows.length
        ? CATALOG_SECTIONS.indexOf('chassis') : CATALOG_SECTIONS.indexOf('color');
    }
    const id = col.catalogList.sectionIdOf(Math.max(0, col.catalogList.focusIndex()));
    const at = CATALOG_SECTIONS.indexOf(id);
    return at >= 0 ? at : 0;
  }

  // Left/right — jump to the next/previous section's first row, wrapping.
  _navSection(col, dir) {
    if (!col) return;
    const next = stepIndex(this._currentSection(col), dir, CATALOG_SECTIONS.length);
    const id = CATALOG_SECTIONS[next];
    if (id === 'chassis') { this._focusExtraRow(col, 0); return; }
    if (id === 'color') { this._focusExtraRow(col, col.chassisRows.length); return; }
    Audio.ui('menuNav');
    this._focusCatalogRow(col, col.catalogList.sectionFirstIndex(id));
  }

  // A — confirms the focused CHASSIS or COLOR row, and ONLY that. Deliberately does nothing in
  // the ABILITIES/WEAPONS bands: there is no A-bind fallback (#607), those bind off their slot's
  // own button instead.
  _confirm(col) {
    if (!col || col.focusZone !== 'list') return;
    if (col.listFocus < col.chassisRows.length) {
      this._selectChassis(col, col.chassisRows[col.listFocus].id);
      return;
    }
    const swatch = col.colorSwatchRefs[col.listFocus - col.chassisRows.length];
    if (swatch) this._selectColor(col, swatch.hex);
  }

  // #607: THE bind. `loc` came from whichever slot button was pressed (pad LT/LB/RB/RT/X/Y, the
  // keyboard mirror, or a click on that slot's own tile) — so a weapon button pressed while an
  // ability row is focused (or the reverse) does NOTHING rather than mis-mounting, and a
  // chassis/color row can't be bound into a slot at all. A locked weapon buys instead of mounting,
  // the same gate a card click used to carry.
  _bindFocused(col, loc) {
    if (!col || col.focusZone !== 'catalog') return;
    const id = col.catalogList.focusedId();
    if (id == null) return;
    if ((isWeapon(id) ? 'weapon' : 'ability') !== slotKind(loc)) return;
    if (isWeapon(id) && !this.unlocked.has(id)) { this._purchase(id); return; }
    this._mountInto(col, loc, id);
  }

  _mountedIn(col, loc) {
    const kind = slotKind(loc);
    if (kind === 'ability') return col.mech.abilityMounts[loc] ?? null;
    return col.mech.usedSlots(loc) >= 1 ? col.mech.mounts[loc][0] : null;
  }

  // #607: clicking a card no longer mounts anything — it just moves the cursor there (the mouse's
  // equivalent of D-pad-ing onto the row). The bind then comes from pressing that slot's button,
  // or clicking that slot's tile.
  _clickCatalogItem(col, id) {
    this._focusCatalogRow(col, col.catalogList.indexOfId(id), { scroll: false });
  }

  // Mount/replace whatever is in `loc`. #607: re-binding the item already in an ability slot is
  // now a plain no-op — it used to UNMOUNT (the #506-era "abilities are optional" toggle), and
  // this issue's confirmed scheme has no unbind gesture at all: you replace a slot's contents by
  // binding something else there, and Ready already demands a full loadout (#532).
  _mountInto(col, loc, itemId) {
    const mech = col.mech, kind = slotKind(loc);
    if (kind === 'ability') {
      const prevItem = this._mountedIn(col, loc);
      if (prevItem === itemId) return;
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

  _onMechChanged(col) {
    reskinMech(this, col.textureKey, col.mech, this._artFor(col));
    saveAllMechs(this.allMechs);
    this._refreshAllTiles(col);
    // Just the highlighted cards, never a rebuild — a rebuild would reset the list's scroll
    // position and interrupt every card's live-fire preview loop for no reason.
    this._refreshCatalogSelection(col);
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
    // Keep the COLOR section's own row highlight in sync — it's always on screen now (#607).
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
  // every other player's.
  //
  // #607 rework (supersedes #540's, which superseded #533's; restores #539's spirit):
  //   LT / LB / RB / RT  BIND the focused catalog row into that slot — the exact button that
  //                      FIRES that slot in the arena (SKILL_BINDS). LB/RB are available because
  //                      tab-cycling is gone with the tabs themselves.
  //   X / Y              the same, for the two ability slots (ABILITY_BINDS).
  //   D-pad up/down      ONE cursor down the whole catalog, across section boundaries (_navRow).
  //   D-pad left/right   jump to the next/previous SECTION (_navSection). No slot cursor: #540's
  //                      D-pad destination-slot cursor is gone, made redundant by the binds above.
  //   A                  confirms a CHASSIS or COLOR row only (_confirm) — no A-bind fallback.
  //   B                  nothing. There is no unbind gesture (#607): you replace a slot by
  //                      binding something else into it.
  // SELECT and START both toggle ready — START is freed up for this in the Garage specifically
  // (padStart: false on wirePauseMenu, above) rather than opening the shared pause menu the way it
  // does everywhere else (see PauseMenuScene.js); ESC (keyboard) still reaches the pause menu here
  // for STATS/AUDIO/ART/settings access.
  update(time, delta) {
    this._updateJoin();
    // Ticks every column's catalog — the live shot/beam preview loop each card runs — regardless
    // of whether that column's pad is connected (a mouse/keyboard-only player still needs their
    // catalog animating).
    for (const col of this.cols) col?.catalogList?.update(time, delta);
    // The preview's shield shell (2026-07-31 ask — see _buildColumn): re-registers onto the mech's
    // live part transforms and breathes with the arena's own ambient hum. Same "regardless of pad"
    // reasoning as the catalog tick above.
    for (const col of this.cols) updateShowroomShieldOutline(col?.previewShield, col?.preview, delta);
    for (const i of activeIndices(this.session)) {
      const col = this.cols[i];
      const e = this.padEdges[i];
      if (!col || !e.pad()) continue;
      if (e.pressed(PAD.SELECT) || e.pressed(PAD.START)) { this._toggleReady(i); continue; }
      // #607: the six BIND buttons, straight off the arena's own bind tables. Every one is polled
      // every frame (PadEdges only baselines an index on the frames it's actually read, so
      // short-circuiting out of this loop would leave the unread ones able to fire a stale edge
      // later) and only the first match acts.
      let bindLoc = null;
      for (const b of PAD_BIND_SLOTS) if (e.pressed(b.button) && !bindLoc) bindLoc = b.loc;
      if (bindLoc) { this._bindFocused(col, bindLoc); continue; }
      if (e.pressed(PAD.DPAD_LEFT)) { this._navSection(col, -1); continue; }
      if (e.pressed(PAD.DPAD_RIGHT)) { this._navSection(col, 1); continue; }
      if (e.pressed(PAD.DPAD_UP)) { this._navRow(col, -1); continue; }
      if (e.pressed(PAD.DPAD_DOWN)) { this._navRow(col, 1); continue; }
      if (e.pressed(PAD.A)) { this._confirm(col); continue; }
      // The left stick mirrors the D-pad exactly (up/down row-nav, left/right section jump), with
      // the same auto-repeat cadence padNav.js's DirRepeater already gives every other held-
      // direction control in this scene.
      const ls = e.pad()?.leftStick;
      const dir = ls ? dominantDir(ls.x, ls.y) : null;
      // #607 follow-up: the stick half of this column's `inputMode` signal (the button half is the
      // gamepad `down` listener in create()). Already past `dominantDir`'s deadzone, so idle
      // stick drift can't flip the tiles' glyphs to the pad's.
      if (i === 0 && dir) this._noteInputMode('pad');
      const step = this.stickRepeat[i].step(dir, time);
      if (step === 'left') this._navSection(col, -1);
      else if (step === 'right') this._navSection(col, 1);
      else if (step === 'up') this._navRow(col, -1);
      else if (step === 'down') this._navRow(col, 1);
    }
  }
}
