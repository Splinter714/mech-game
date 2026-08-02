import Phaser from 'phaser';
import { buildMechTextures, reskinMech, HULL_FRAMES } from '../art/index.js';
import { playerMechArt } from '../art/playerMechLook.js';
import { makeMechParts, poseMechParts } from '../art/mechView.js';
import {
  SHIELD_MECH_PART_KEYS, SHIELD_COLOR, SHIELD_PLAYER_BLEND,
  makeShieldOutline, updateShowroomShieldOutline,
} from './arena/shieldOutline.js';
import {
  mechColorFor, cycleSwatch, MECH_SWATCHES, MECH_SWATCH_NAMES, isSwatch,
  canPickSwatch, swatchHolder, legibleColor,
} from '../data/mechColors.js';
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
import { dominantDir, DirRepeater } from '../ui/padNav.js';
import { PLAYER_MECH_KEYS, MAX_GARAGE_PLAYERS, canJoin } from '../data/coopGarage.js';
import { makeSimulSession, joinSimulPlayer, toggleReady, allReady, activeIndices } from '../data/simulGarage.js';
import { buildTabBar, TAB_BAR_H, DEPLOY_MARGIN } from '../ui/tabBar.js';
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
// Readiness replaces the old sequential "P1 READY" handoff: each column has its own READY BUTTON
// (mouse-clickable, or its pad's START/SELECT — column 0 also has the 'D' key). The scene deploys
// the instant every joined column is ready — which for a lone player just means "press ready, go,"
// identical in feel to the old single-player Deploy button.
// #609 restores that per-column button after #529 had collapsed it into ONE pinned top-right
// Deploy/Ready button wired to column 0 only — which left players 2+ able to ready up from their
// pad but with nothing on screen showing it and nothing to click. Jackson: "each player should
// have their own ready button visible." The pinned button is gone entirely; player 1's is just
// their own column's button like everybody else's, and single player is simply the n=1 case.
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
// #611 dropped `focus` (gold) from here: it was the cursor colour on the hand-drawn chassis/colour
// ROWS, the exact inverse of what the catalog cards next to them meant by the same two colours.
// Those rows are cards now and the card list owns the one state painter — cyan is the cursor,
// everywhere. Gold survives in this scene only where it isn't a selection state: the READY button's
// palette below, and the locked-card cost label the card list draws.
const UI = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', bad: '#e2533a', good: '#7bd17b',
  panelEdge: 0x2a333f,
};

// #609: the per-column READY button's own palette — deliberately the SAME green/gold/grey language
// the pinned tab-bar button used (ui/tabBar.js's goodBg/good/sel/off), so the control reads
// identically to the one it replaces; only its position and its count (one per player) changed.
// #615: the per-column FRAME — Jackson asked for "a MUCH more clear vertical boundary separator
// thing between garage panels for multiple players," and chose a full border in that player's own
// mech colour over a neutral thick rule or a coloured edge-bar: the point is not only "where is the
// split" but "whose panel is this", reusing the identity colour the PLAYER N label already carries.
// Two frames can never match — data/mechColors.js's takenSwatches guarantees no two live players
// hold the same swatch (and #614 now surfaces that rule in the picker itself). Drawn in the RAW
// swatch, not the brightened cursor variant: a frame is a big shape on a dark background and reads
// fine dark, where a 2px ring does not.
const COLUMN_FRAME = { width: 2, alpha: 0.9, radius: 10 };

const READY_UI = {
  bg: 0x222b35, bgHover: 0x2c3744, readyBg: 0x1c3a24,
  edge: 0x2a333f, sel: 0xefc14a, good: 0x7bd17b,
  text: '#efc14a', textReady: '#7bd17b', textOff: '#4a525c',
  radius: 8,
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
// In its place each column has ONE continuous scrolling catalog: ABILITIES, WEAPONS, CHASSIS,
// COLOR, in that fixed order top to bottom. #611 made all FOUR of them ordinary sections of the
// shared WeaponCardList (#607's `sections` support, plus that issue's custom-kind sections) — the
// last two used to be this scene's own hand-drawn row lists, hung below the cards in the same
// scroll space on seams that no longer exist.
//
// Nav: D-pad up/down runs ONE cursor continuously down all four sections; D-pad left/right moves
// across the catalog's own grid row (#610 — it used to jump section to section, and that snap is
// gone entirely along with the tabs it stood in for). Binding: with a catalog card focused you press the BUTTON OF THE SLOT you
// want it in — LT/LB/RB/RT for the four weapons and X/Y for the two abilities, exactly their
// in-arena fire binds (SKILL_BINDS/ABILITY_BINDS). LB/RB are free precisely because tab-cycling
// is gone. A confirms a CHASSIS or COLOR card only — deliberately no A-bind fallback in the item
// sections. There is no unbind gesture at all: you replace a slot by binding something else
// there (Ready already demands a full loadout, #532).
// (#610 removed `CATALOG_SECTIONS` — nothing addresses the catalog by section any more now that
// left/right walks a grid row instead of snapping between sections.)

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

// #611: CHASSIS and COLOR are CARDS in the shared catalog grid now, not this scene's own rows
// parked below it — so their old row geometry (CHASSIS_ROW_H/COLOR_ROW_H/LIST_SECTION_*) is gone
// along with _buildChassisList/_buildColorList/_syncExtraScroll and WeaponCardList's
// setExtraHeight/onScroll seams. A card's shape comes from the card list; all this scene supplies
// is each card's CONTENT (see _chassisCards/_colorCards).
//
// A colour has no natural string id the way a weapon or a chassis does — it's a raw hex number —
// so these two give it one, stable both ways, for the card list's id-keyed selection/focus model.
const COLOR_CARD_PREFIX = 'color:';
const colorCardId = (hex) => `${COLOR_CARD_PREFIX}${hex.toString(16).padStart(6, '0')}`;
const colorOfCardId = (id) => parseInt(String(id).slice(COLOR_CARD_PREFIX.length), 16);

// The two stat lines a CHASSIS card shows, mirroring a weapon card's own two: what it's made of,
// then how it moves. Armor/HP are summed from the built per-location table (data/chassis/index.js
// distributes a whole-chassis total across the locations), so these are the real numbers the arena
// fields rather than a hand-copied figure.
function chassisStatLines(def) {
  const sum = (field) => Object.values(def.locations).reduce((a, l) => a + (l[field] || 0), 0);
  const m = def.movement;
  return [
    `armor ${sum('maxArmor')} · hp ${sum('maxHp')}`,
    `spd ${m.maxSpeed} · turn ${m.turnRate} · slew ${m.turretSlew}`,
  ].join('\n');
}

// #505 (fifth rework, playtest): the standalone header band that used to sit under the shared tab
// bar (SCRAP/last-run readout + the "another controller can join" hint) is gone as its own block.
// The join hint is removed entirely (no replacement); SCRAP now rides in the tab bar's own top row
// (see create() — hugging its right margin since #609 took the pinned Deploy/Ready button out of
// that row); columns start right below the tab bar.

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

    // #609: no `onDeploy` — the shared top bar draws NO pinned Deploy/Ready button here any more
    // (ui/tabBar.js makes it opt-in), because ready/deploy is a per-column control now. The bar is
    // just its background band plus the SCRAP readout below, and it no longer depends on any state
    // that changes while the Garage is open, so it is built once here rather than rebuilt.
    this.tabBar = buildTabBar(this, { active: 'GarageScene' });
    // SCRAP (+ last-run readout) rides in the tab bar's own top row, hugging its right margin —
    // the pinned Deploy/Ready button that used to sit to its right is gone (#609).
    const scrapX = this.W - DEPLOY_MARGIN;
    this.currencyText = this.add.text(scrapX, TAB_BAR_H / 2, '', {
      fontFamily: 'monospace', fontSize: '13px', color: UI.accent,
    }).setOrigin(1, 0.5);
    this.lastRunText = this.add.text(scrapX, TAB_BAR_H + 4, '', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    }).setOrigin(1, 0);
    this._refreshCurrency();

    this._relayoutColumns();

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
    // boundaries); they no longer move a destination-slot cursor, because #540's slot cursor is
    // gone (the button you press IS the slot). ENTER/SPACE mirror the pad's A: confirm a
    // chassis/color row, nothing in the item sections.
    // #610: LEFT/RIGHT move ACROSS the catalog's grid row (_navCatalogCol); #607's section snap is
    // gone with the single-column layout that needed it.
    this.input.keyboard.on('keydown-LEFT', () => this._navCatalogCol(this.cols[0], -1));
    this.input.keyboard.on('keydown-RIGHT', () => this._navCatalogCol(this.cols[0], 1));
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
    // listeners it registers on the scene's input plugin. (#607: the per-column tab strip container
    // that also needed one here is gone with the tab system. #611: so is the chassis/color clip
    // mask — those rows are cards inside catalogList's own scroller and mask now, and go with it.)
    for (const col of this.cols) {
      col?.catalogList?.destroy();
      col?.layer?.destroy(true);
    }
    this.cols = [];
    this.colW = Math.floor(this.W / this.session.count);
    this.colH = this.H - this.colTop;
    for (const i of activeIndices(this.session)) this._buildColumn(i);
    // #614: each column's colour cards paint themselves as they're built, but a column built
    // BEFORE its neighbours can't yet see the colours they hold — so re-scrim once the whole set
    // exists. This is also what makes a JOIN update the existing columns' pickers live.
    this._refreshColorAvailability();
  }

  // Build every element of column `i` from its own persistent mech slot. All coordinates are
  // LOCAL to `col.layer`, whose position IS the column's screen offset. (#607: the separate
  // `col.tabBarLayer` that used to sit up in the shared top bar's own row is gone with the tab
  // system it drew.)
  _buildColumn(i) {
    const layer = this.add.container(i * this.colW, this.colTop);
    // #611: ONE cursor runs the whole catalog and the WeaponCardList owns it outright — all four
    // sections (ABILITIES, WEAPONS, CHASSIS, COLOR) are bands of cards in its own grid, so #607's
    // `focusZone`/`listFocus` pair (which tracked whether the cursor had stepped out of the card
    // list into this scene's own trailing rows) is gone with the rows it existed for.
    // Per-column, not scene-global — same as every other piece of per-player state here, so each
    // joined player keeps their own scroll position and own focused card (#505).
    // The #529 `labTab` and #540 `selectedSlot` destination-slot cursor are both gone.
    const col = { index: i, layer };
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

    // #615: this column's own frame, added FIRST so every other element in the layer draws over it.
    // It wraps the whole column (catalog + loadout panel), inset from the column's edges by the
    // layout's own gutter — see columnLayout.js for what that gutter costs.
    col.frameRect = gl.frame;
    col.frame = this.add.graphics();
    col.layer.add(col.frame);
    this._paintColumnFrame(col);

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
    // passive-slot avatar + "READY?" pill) is gone entirely — that piece is now this column's own
    // READY button, down at the bottom-right of the panel next to the tiles (#609).
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

    // #609: THIS player's own READY button, immediately right of the tile row they just built and
    // flush with its bottom (see columnLayout.js's `ready` rect). Added after the tiles, so like
    // them it renders — and hit-tests — on top of `col.panelBlocker`.
    this._buildReadyButton(col, gl.ready);

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
    // #611: CHASSIS and COLOR join as two more sections of that same one-time build, in that fixed
    // order last (each starting a fresh grid row, #610). They are custom-kind sections — this scene
    // supplies their card CONTENT (a posed mech, a big swatch) and the card list supplies
    // everything else, so they get the identical card shape, state painting, hover-moves-cursor
    // and grid navigation the item cards have instead of their own parallel implementations.
    col.catalogList = new WeaponCardList(this, {
      x: col.layer.x + catalogRect.x, y: col.layer.y + catalogRect.y, w: catalogRect.w, h: catalogRect.h, compact: false,
      sections: [
        { id: 'ability', label: 'ABILITIES', ids: Object.keys(ABILITIES) },
        { id: 'weapon', label: 'WEAPONS', ids: this.catalogIds },
        { id: 'chassis', label: 'CHASSIS', kind: 'chassis', cards: this._chassisCards(col) },
        { id: 'color', label: 'COLOR', kind: 'color', cards: this._colorCards(col) },
      ],
      // #612: every ABILITY card draws THIS column's live mech as the thing casting it — real
      // chassis, real mounted weapons, this player's colour — instead of the generic accent chip.
      // A live handle, not a snapshot: `col.mech` is mutated in place by every mount/chassis/colour
      // path below, and `col.textureKey`'s textures are re-baked in place under the same keys, so
      // each of those paths only has to call `refreshCaster()` to re-pose (see _onMechChanged).
      caster: { mech: col.mech, textureKey: col.textureKey },
      onSelect: (id) => this._clickCatalogCard(col, id),
      onHover: (_id, index) => this._focusCatalogRow(col, index, { scroll: false }),
      // #506: abilities have no SCRAP-unlock data at all (shop.js's catalog is weapon-only) —
      // always unlocked and free to mount, so only a weapon id is ever gated here. (Chassis/colour
      // cards never reach this at all — the card list only asks about item-kind cards.)
      isLocked: (id) => isWeapon(id) && !this.unlocked.has(id),
      costOf: (id) => (isWeapon(id) ? costOf(id) : 0),
      // #614: the general "you can't pick this" hook — here, a COLOUR another joined player is
      // already wearing. The rule itself is old (canPickSwatch/_selectColor have always refused
      // the pick); until now it was refused SILENTLY, with the card looking exactly as pickable as
      // any other. It reads `this.cols` live, so it re-evaluates correctly on every repaint.
      unavailable: (id, kind) => (kind === 'color' ? this._colorUnavailable(col, colorOfCardId(id)) : null),
      // #615: this column's cursor is THIS player's colour, not the shared cyan — solo included
      // ("the cursor is always your colour"). Brightened for legibility rather than used raw; see
      // _cursorColor. Every card in the column is covered by this one option, which is exactly what
      // #611 folding the chassis/colour rows into this list bought.
      focusColor: this._cursorColor(col),
    });
    // #505 sixth rework: catalogList owns its own top-level container (see the comment above), a
    // SIBLING of col.layer at the scene root rather than a child of it — so col.layer's default
    // depth (0) doesn't automatically out-rank it. Nudge the catalog just below that default so
    // col.layer's panel/blocker/tiles reliably win input priority wherever they overlap a
    // scrolled-out (masked but still input-live) card, regardless of which was constructed first.
    col.catalogList.root.setDepth(-1);

    // Start the cursor at the top of the list, and light up whatever this build already carries
    // (mounted items, the current chassis, the current colour — all one selection set since #611).
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
    // it will look like wearing it. Only the MAIN lab preview gets one — the chassis-card previews
    // (_chassisCards) deliberately don't: their whole job is comparing three silhouettes, and a blue
    // rim on each would blur exactly the difference those cards exist to show.
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
    // #529 removed the compact checkmark-style READY indicator that used to sit to this label's
    // right, folding ready state into the label's own text instead (a trailing "✓"). That stays,
    // but it is no longer the only signal: #609 gives every column its own READY button, which
    // carries the primary visual (see _buildReadyButton/_refreshReady).
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

  // ── CHASSIS + COLOR cards (#611) ─────────────────────────────────────────────────────────────
  // These two used to be hand-drawn ROW LISTS this scene owned, parked below the card grid in the
  // catalog's scroll space via WeaponCardList's `setExtraHeight`/`onScroll` seams — with their own
  // clip mask, their own hit-area gating, their own hover paint, their own focus model
  // (`focusZone`/`listFocus`) and their own selected/focused colour convention, which happened to
  // be the exact INVERSE of the cards'. All of that is gone. They are ordinary cards in the one
  // grid now, so every one of those concerns is answered once, by the card list, for all four
  // sections at once. What is left here is only what genuinely differs: each card's CONTENT.
  //
  // Both builders run BEFORE the WeaponCardList is constructed (see _buildColumn) and hand it the
  // display objects; the list reparents them into the card containers, and calls each `place`
  // with the card's preview-stage rect on every layout.

  // One card per PLAYER_CHASSIS_IDS entry (mediumPlayer/strikerPlayer/colossusPlayer — cosmetic-
  // only variants, identical stats, see data/chassis/player/*.js). Re-enables the chassis switcher
  // that #248 (commit 7a3893a) disabled, scoped to just these three cosmetic picks rather than the
  // old light/medium/heavy weight-class switch.
  //
  // #532 (change 5), carried over intact: the preview is a REAL rendered mech, from the exact same
  // sprite assembly the main mech-preview panel builds from (art/mechView.js's makeMechParts/
  // poseMechParts), baked from a throwaway unmounted Mech in that chassis. It sits in the card's
  // preview stage — the same place a weapon card fires its live shot into — so the card's anatomy
  // (name + stats left, preview right) is the weapon card's. Baked once per column (its own texture
  // keys) since the three chassis shapes never change during a Garage visit.
  _chassisCards(col) {
    return PLAYER_CHASSIS_IDS.map((id) => {
      const def = CHASSIS[id];
      const previewMech = new Mech({ chassisId: id, color: col.mech.color });
      const key = `${col.textureKey}_chassisCard_${id}`;
      buildMechTextures(this, key, previewMech,
        playerMechArt(col.index, { hullFrames: HULL_FRAMES, accent: mechColorFor(previewMech, col.index) }));
      const parts = makeMechParts(this, key, { x: 0, y: 0, scale: 1, isPlayer: true });
      return {
        id,
        name: def.name,
        sub: `${def.weightClass} chassis`,
        stats: chassisStatLines(def),
        accent: mechColorFor(col.mech, col.index),
        art: {
          objects: parts.children,
          // Centred in the stage and scaled to fit its short side, the same shape of math the main
          // lab preview uses. makeMechParts positions the hull/turret directly; poseMechParts owns
          // the four pivoting parts (and their muzzle-glow overlays), so both are re-applied here.
          place: ({ x, y, w, h }) => {
            const scale = Math.max(0.02, (Math.min(w, h) - 12) / 230);
            const cx = x + w / 2, cy = y + h / 2;
            for (const s of parts.children) s.setScale(scale);
            parts.hull.setPosition(cx, cy);
            parts.turret.setPosition(cx, cy);
            poseMechParts(parts, previewMech, -Math.PI / 2, scale, cx, cy, {});
          },
        },
      };
    });
  }

  // One card per MECH_SWATCHES entry: a LARGE swatch filling the preview stage, plus the colour's
  // name (data/mechColors.js MECH_SWATCH_NAMES) — deliberately NOT a tinted mech preview, which was
  // offered and declined (#611). Same cycleSwatch model the D-pad/arrow-key path already drives
  // (_cycleColor, unchanged below) backs a direct card click too.
  _colorCards(col) {
    return MECH_SWATCHES.map((hex, idx) => {
      const sw = this.add.rectangle(0, 0, 10, 10, hex).setOrigin(0, 0).setStrokeStyle(1, UI.panelEdge);
      return {
        id: colorCardId(hex),
        name: MECH_SWATCH_NAMES[idx],
        sub: '', stats: '',
        accent: hex,
        art: {
          objects: [sw],
          place: ({ x, y, w, h }) => sw.setPosition(x + 6, y + 6).setSize(Math.max(4, w - 12), Math.max(4, h - 12)),
        },
      };
    });
  }

  // Directly pick chassis `id` (chassis-card click, or A on the focused chassis card).
  _selectChassis(col, id) {
    if (col.mech.chassisId === id) return;
    col.mech.setChassis(id);
    Audio.ui('equip');
    saveAllMechs(this.allMechs);
    buildMechTextures(this, col.textureKey, col.mech, this._artFor(col));
    poseMechParts(col.preview, col.mech, -Math.PI / 2, col.previewScale, col.previewCx, col.previewCy, {});
    col.catalogList?.refreshCaster();   // #612: a chassis swap moves the joints every caster poses on
    this._refreshCatalogSelection(col);
  }

  // ── Player identity paint (#615) ─────────────────────────────────────────────────────────────
  // Three surfaces carry a column's player colour: the PLAYER N label (since #505), the column
  // FRAME and the catalog CURSOR (both new here). All three are repainted together by
  // _refreshColumnIdentity, which is what every colour-change path calls.
  //
  // Deliberately NOT included: the loadout tiles. They have a `selected` cursor state in the shared
  // skillTiles code, but the Garage has passed `selected: false` on every tile since #607 removed
  // the destination-slot cursor — there is no tile cursor left to colour. If one ever comes back,
  // it should take `_cursorColor(col)` too. (#613's mounted-card bind glyph is left alone on
  // purpose: whether it goes gold or cyan is still an open question, and freeing cyan here is the
  // very thing that reopened it.)

  // The cursor ring's colour for a column: this player's mech colour, brightened. A raw swatch is
  // tuned to read as PAINT on a mech in the arena, which is a different job from reading as a thin
  // ring on a near-black card — CHARCOAL and NAVY both vanish. legibleColor (data/mechColors.js)
  // keeps the hue and floors the brightness, so identity survives and visibility is guaranteed.
  _cursorColor(col) {
    return legibleColor(mechColorFor(col.mech, col.index));
  }

  // Jackson, 2026-08-01: "single player doesn't need the colored outline around the whole
  // garage" — there's nothing to distinguish it FROM with only one column. Solo just clears
  // whatever was drawn (covers dropping from 2 players back to 1) and returns.
  _paintColumnFrame(col) {
    if (!col?.frame || !col.frameRect) return;
    if (this.session.count < 2) { col.frame.clear(); return; }
    const { x, y, w, h } = col.frameRect;
    col.frame.clear()
      .lineStyle(COLUMN_FRAME.width, mechColorFor(col.mech, col.index), COLUMN_FRAME.alpha)
      .strokeRoundedRect(x, y, w, h, COLUMN_FRAME.radius);
  }

  // Every surface that shows WHOSE column this is, repainted in place from the live mech colour.
  _refreshColumnIdentity(col) {
    if (!col) return;
    col.headerLabel?.setColor(hexColor(mechColorFor(col.mech, col.index)));
    this._paintColumnFrame(col);
    col.catalogList?.setFocusColor(this._cursorColor(col));
  }

  // ── Colour availability (#614) ───────────────────────────────────────────────────────────────
  // The joined columns' builds in PLAYER ORDER — the `builds` argument every data/mechColors.js
  // distinctness query takes. activeIndices is contiguous 0..count-1, so an entry's array position
  // IS its player index, which is what `editingIndex`/`swatchHolder`'s return value mean.
  _colorBuilds() {
    return activeIndices(this.session).map((i) => this.cols[i]?.mech).filter(Boolean);
  }

  // Why (if at all) `hex` is not available to `col` — the shape WeaponCardList's `unavailable` hook
  // wants. Driven off canPickSwatch itself rather than a second hand-rolled `builds.some(...)`, so
  // the greyed-out card and the guard in _selectColor below cannot disagree about what's takeable
  // (mechColors.js says that one predicate is meant to back both). Solo is the n=1 case for free:
  // takenSwatches is empty, nothing is ever scrimmed. And the editing player's OWN colour is
  // excluded from that set by construction, so it never greys out in its own column.
  _colorUnavailable(col, hex) {
    const builds = this._colorBuilds();
    if (canPickSwatch(builds, col.index, hex)) return null;
    const holder = swatchHolder(builds, col.index, hex);
    if (holder < 0) return null;   // not a swatch at all — nothing useful to say about it
    // Named in the HOLDER's own colour so the card says not just "taken" but "taken by the player
    // wearing this", which is what you need to decide what to switch to. `legibleColor` because a
    // dark pick (CHARCOAL, NAVY) would otherwise be unreadable ink over the scrim it sits on.
    return { text: `🔒 TAKEN\nP${holder + 1}`, color: hexColor(legibleColor(mechColorFor(builds[holder], holder))) };
  }

  // Repaint every column's colour cards. A colour change in ONE column changes what is available in
  // EVERY OTHER one, so this is scene-wide rather than per column. (A join/drop goes through
  // _relayoutColumns, which rebuilds each catalog from scratch and so repaints for free.)
  _refreshColorAvailability() {
    for (const col of this.cols) col?.catalogList?.refreshAvailability();
  }

  // Directly pick a swatch (color-card click, or A on the focused colour card) — same distinctness
  // rules as _cycleColor (no two live co-op players may hold the same colour). #614 folded this
  // guard onto the shared canPickSwatch predicate that also paints the card, so a card that looks
  // pickable always is; a scrimmed one no-ops exactly as it did before, but now visibly says why.
  _selectColor(col, hex) {
    if (!isSwatch(hex) || col.mech.color === hex) return;
    if (!canPickSwatch(this._colorBuilds(), col.index, hex)) return;
    col.mech.color = hex;
    Audio.ui('menuNav');
    buildMechTextures(this, col.textureKey, col.mech, this._artFor(col));
    saveAllMechs(this.allMechs);
    poseMechParts(col.preview, col.mech, -Math.PI / 2, col.previewScale, col.previewCx, col.previewCy, {});
    col.catalogList?.refreshCaster();   // #612: Cloak's greyscale bake is derived from the new pixels
    this._refreshColumnIdentity(col);   // #615: label + frame + cursor all follow the new colour
    this._refreshCatalogSelection(col);
    // #614: this column just freed one colour and claimed another — every OTHER column's colour
    // cards have to re-scrim/un-scrim to match, live.
    this._refreshColorAvailability();
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
  // #610 (added scope): the catalog CARDS carry a device-matched bind glyph too now, so they
  // repaint on the same signal as the tiles.
  _onInputModeChanged() {
    for (const col of this.cols) {
      if (!col) continue;
      this._refreshAllTiles(col);
      this._refreshCatalogSelection(col);
    }
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
  //
  // #610 (added scope, Jackson: "current bindings should be visible ... towards the right side of
  // the preview row" — the CARDS, which is what he meant; the same ask was first read as the
  // loadout tiles and both now stay): the same walk that decides WHETHER a card is mounted also
  // yields WHICH SLOT, so the card can show that slot's own bind glyph on its preview stage.
  // Device-matched via `_colMode` exactly like the tiles, and per-column like the highlight — the
  // same weapon can read `RT` in one player's column and nothing in another's. An item somehow
  // mounted in two slots shows BOTH glyphs, space-separated in ALL_SLOTS order, rather than
  // silently picking one.
  //
  // #611: the selection set also carries this column's current CHASSIS and COLOUR, because those
  // are cards in the same list now — one "what this build already has" fact, one highlight, one
  // painter. Only weapon/ability cards get a bind glyph; a chassis or colour isn't in a slot.
  _refreshCatalogSelection(col) {
    if (!col?.catalogList) return;
    const mounted = new Set();
    const binds = {};
    const pad = this._colMode(col) === 'pad';
    for (const loc of ALL_SLOTS) {
      const id = this._mountedIn(col, loc);
      if (!id) continue;
      mounted.add(id);
      const bind = SKILL_BINDS[loc] ?? ABILITY_BINDS[loc];
      const glyph = (pad ? bind?.pad : bind?.key) ?? '';
      if (glyph) binds[id] = binds[id] ? `${binds[id]} ${glyph}` : glyph;
    }
    mounted.add(col.mech.chassisId);
    mounted.add(colorCardId(mechColorFor(col.mech, col.index)));
    col.catalogList.setSelected(mounted);
    col.catalogList.setBinds(binds);
  }

  // ── #607: ONE cursor, four sections, bind-by-slot-button ──────────────────────────────────────
  // Supersedes #533's select-then-place and #540's two-axis slot-cursor model wholesale. D-pad
  // up/down (_navRow) runs a single cursor straight down ABILITIES → WEAPONS → CHASSIS → COLOR,
  // crossing every boundary; D-pad left/right (_navCatalogCol, #610) moves across the catalog's own
  // grid row — #607's section snap is gone with the single-column layout it stood in for. There is no
  // destination-slot cursor at all — a bind names its slot by WHICH BUTTON was pressed
  // (_bindFocused), and A only confirms a chassis/color card (_confirm).
  //
  // #611: all four sections are card sections now, so the cursor is simply the card list's own —
  // the `focusZone`/`listFocus` bookkeeping, and _navRow's hand-written crossing from the last grid
  // row into a separate block below it, are gone. Up/down and left/right are one call each.

  // Move the cursor to a card, wherever it currently is. Also what a mouse hover does — on EVERY
  // card, chassis and colour included (#611: they used to only tint on hover, never move the
  // cursor, which meant a slot-bind button acted on some other card than the one under the mouse).
  _focusCatalogRow(col, idx, opts = {}) {
    if (!col || idx < 0) return;
    col.catalogList.setFocus(idx, opts);
  }

  // Up/down — one continuous run through every GRID ROW in the column, across all four section
  // bands (#610 — a row is several cards wide, so "down" is down a whole row, not one card).
  // Clamped at both ends by the card list itself (it's a list, not a carousel).
  _navRow(col, dir) {
    col?.catalogList.moveFocusRow(dir);
  }

  // #610: left/right — move across the catalog's own grid row, stopping at either edge (the card
  // list owns that rule; see moveFocusCol). In a one-card-wide co-op column that correctly does
  // nothing at all.
  _navCatalogCol(col, dir) {
    col?.catalogList.moveFocusCol(dir);
  }

  // A — confirms the focused CHASSIS or COLOR card, and ONLY that. Deliberately does nothing in
  // the ABILITIES/WEAPONS bands: there is no A-bind fallback (#607), those bind off their slot's
  // own button instead.
  _confirm(col) {
    if (!col) return;
    const kind = col.catalogList.focusedKind();
    const id = col.catalogList.focusedId();
    if (id == null) return;
    if (kind === 'chassis') this._selectChassis(col, id);
    else if (kind === 'color') this._selectColor(col, colorOfCardId(id));
  }

  // #607: THE bind. `loc` came from whichever slot button was pressed (pad LT/LB/RB/RT/X/Y, the
  // keyboard mirror, or a click on that slot's own tile) — so a weapon button pressed while an
  // ability card is focused (or the reverse) does NOTHING rather than mis-mounting. A locked weapon
  // buys instead of mounting, the same gate a card click used to carry.
  // #611: the focused card can now be a CHASSIS or COLOR one, and neither is mountable — the kind
  // check is what keeps a slot button from trying to mount a paint chip.
  _bindFocused(col, loc) {
    if (!col || col.catalogList.focusedKind() !== 'item') return;
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

  // #607: clicking an ITEM card no longer mounts anything — it just moves the cursor there (the
  // mouse's equivalent of D-pad-ing onto it). The bind then comes from pressing that slot's button,
  // or clicking that slot's tile.
  // #611: a CHASSIS or COLOR card has no such second step — there is no slot to name — so clicking
  // one is the pick itself, exactly as clicking its old row was. Same split A already makes
  // (_confirm), just from the mouse.
  _clickCatalogCard(col, id) {
    const idx = col.catalogList.indexOfId(id);
    if (idx < 0) return;
    this._focusCatalogRow(col, idx, { scroll: false });
    const kind = col.catalogList.focusedKind();
    if (kind === 'chassis') this._selectChassis(col, id);
    else if (kind === 'color') this._selectColor(col, colorOfCardId(id));
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
    // #612: the ability cards' caster mechs read the same textures, which `reskinMech` just redrew
    // in place — so this is a re-pose (and a Cloak re-bake), never a rebuild.
    col.catalogList?.refreshCaster();
    // Just the highlighted cards, never a rebuild — a rebuild would reset the list's scroll
    // position and interrupt every card's live-fire preview loop for no reason.
    this._refreshCatalogSelection(col);
    // #532: a mount/unmount can flip this column's full-loadout completeness, which its own READY
    // button's greyed-out state depends on — repaint it live rather than only on the next
    // ready-toggle/join. #609: per column, not just column 0's pinned button.
    this._refreshReady(col);
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
    for (const col of this.cols) col?.catalogList?.refreshAvailability();
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
    const builds = this._colorBuilds();
    const current = mechColorFor(col.mech, col.index);
    const next = cycleSwatch(builds, col.index, current, dir);
    if (next === col.mech.color) return;
    col.mech.color = next;
    Audio.ui('menuNav');
    buildMechTextures(this, col.textureKey, col.mech, this._artFor(col));
    saveAllMechs(this.allMechs);
    poseMechParts(col.preview, col.mech, -Math.PI / 2, col.previewScale, col.previewCx, col.previewCy, {});
    col.catalogList?.refreshCaster();   // #612: same re-pose/re-bake as the direct colour pick
    // The PLAYER # label, the column frame and the catalog cursor are all painted in the identity
    // colour (#505 / #615) — repaint them in place.
    this._refreshColumnIdentity(col);
    // Keep the COLOR section's own card highlight in sync — it's always in the catalog now (#607/#611).
    this._refreshCatalogSelection(col);
    this._refreshColorAvailability();   // #614: same cross-column re-scrim as the direct pick
  }

  // ── Ready / deploy ───────────────────────────────────────────────────────────────────────────
  // #609: one READY button PER COLUMN — every joined player gets their own, showing and toggling
  // only their own readiness. Built as a Graphics plate (Phaser's Rectangle can't round corners,
  // same reason skillTiles.js paints its own plates) plus a transparent hit rect, so the button
  // reads as one more plate in the loadout panel's own button language. All coordinates are LOCAL
  // to col.layer, like every other element in the column.
  _buildReadyButton(col, rect) {
    col.readyRect = rect;
    col.readyPlate = this.add.graphics();
    col.readyHit = this.add.rectangle(rect.x, rect.y, rect.w, rect.h, 0x000000, 0)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    col.readyText = this.add.text(rect.x + rect.w / 2, rect.y + rect.h / 2, '▶ READY', {
      fontFamily: 'monospace', fontSize: '14px', color: READY_UI.text,
    }).setOrigin(0.5);
    col.readyHit.on('pointerover', () => { col.readyHover = true; this._refreshReady(col); });
    col.readyHit.on('pointerout', () => { col.readyHover = false; this._refreshReady(col); });
    // Clicking a column's button toggles THAT column — `col.index`, never a hard-coded 0, which is
    // exactly what the single pinned button couldn't express.
    col.readyHit.on('pointerdown', () => { if (this._canReady(col)) this._toggleReady(col.index); });
    col.layer.add([col.readyPlate, col.readyHit, col.readyText]);
  }

  // Whether this column's button is live. The #532 gate, now applied PER COLUMN rather than only to
  // column 0: a player can't declare ready until their own build is fully equipped (all 4 weapons +
  // both abilities, Mech.isFullyEquipped) — but once ready the button stays live regardless, so it
  // can always be un-readied. _toggleReady keeps its own hard gate underneath this (the pad/keyboard
  // paths reach it without passing through here, and they toast the reason).
  _canReady(col) {
    return !!this.session.ready[col.index] || !!col.mech?.isFullyEquipped();
  }

  // Repaint one column's ready state — its own button, plus the trailing "✓" on the PLAYER # label
  // (kept from #529 as a second, glanceable signal now that the button carries the primary one).
  // Greyed + inert while the build is incomplete, so it's not just silently impossible to ready up
  // with a gap — it visibly can't be pressed either (#532 change 2's intent, per column now).
  _refreshReady(col) {
    if (!col) return;
    const ready = !!this.session.ready[col.index];
    col.headerLabel?.setText(`PLAYER ${col.index + 1}${ready ? ' ✓' : ''}`);
    if (!col.readyPlate) return;
    const enabled = this._canReady(col);
    const { x, y, w, h } = col.readyRect;
    const r = READY_UI.radius;
    const fill = !enabled ? READY_UI.bg
      : ready ? READY_UI.readyBg
        : col.readyHover ? READY_UI.bgHover : READY_UI.bg;
    const edge = !enabled ? READY_UI.edge : ready ? READY_UI.good : READY_UI.sel;
    col.readyPlate.clear();
    col.readyPlate.fillStyle(fill, 1).fillRoundedRect(x, y, w, h, r);
    col.readyPlate.lineStyle(enabled ? 2 : 1.25, edge, 1).strokeRoundedRect(x, y, w, h, r);
    col.readyText.setText(ready ? '✓ READY' : '▶ READY')
      .setColor(!enabled ? READY_UI.textOff : ready ? READY_UI.textReady : READY_UI.text);
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
    // Every column is rebuilt at the new width — including its own READY button, repainted from
    // the live session by _buildColumn's closing _refreshReady. Nothing in the shared top bar
    // depends on the session any more (#609), so there is no header to refresh here.
    this._relayoutColumns();
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
  //   D-pad up/down      ONE cursor down the whole catalog, across section boundaries (_navRow) —
  //                      a "row" being a whole GRID row of cards since #610.
  //   D-pad left/right   move across that grid row (_navCatalogCol). No slot cursor: #540's D-pad
  //                      destination-slot cursor is gone, made redundant by the binds above; and
  //                      #607's section snap is gone with #610's grid.
  //   A                  confirms a CHASSIS or COLOR card only (_confirm) — no A-bind fallback.
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
      if (e.pressed(PAD.DPAD_LEFT)) { this._navCatalogCol(col, -1); continue; }
      if (e.pressed(PAD.DPAD_RIGHT)) { this._navCatalogCol(col, 1); continue; }
      if (e.pressed(PAD.DPAD_UP)) { this._navRow(col, -1); continue; }
      if (e.pressed(PAD.DPAD_DOWN)) { this._navRow(col, 1); continue; }
      if (e.pressed(PAD.A)) { this._confirm(col); continue; }
      // The left stick mirrors the D-pad exactly (up/down row-nav, left/right across the grid row), with
      // the same auto-repeat cadence padNav.js's DirRepeater already gives every other held-
      // direction control in this scene.
      const ls = e.pad()?.leftStick;
      const dir = ls ? dominantDir(ls.x, ls.y) : null;
      // #607 follow-up: the stick half of this column's `inputMode` signal (the button half is the
      // gamepad `down` listener in create()). Already past `dominantDir`'s deadzone, so idle
      // stick drift can't flip the tiles' glyphs to the pad's.
      if (i === 0 && dir) this._noteInputMode('pad');
      const step = this.stickRepeat[i].step(dir, time);
      if (step === 'left') this._navCatalogCol(col, -1);
      else if (step === 'right') this._navCatalogCol(col, 1);
      else if (step === 'up') this._navRow(col, -1);
      else if (step === 'down') this._navRow(col, 1);
    }
  }
}
