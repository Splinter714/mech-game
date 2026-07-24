import Phaser from 'phaser';
import { buildMechTextures, reskinMech, HULL_FRAMES } from '../art/index.js';
import { playerMechArt } from '../art/playerMechLook.js';
import { makeMechParts, poseMechParts } from '../art/mechView.js';
import { Mech } from '../data/Mech.js';
import { CHASSIS_IDS } from '../data/chassis/index.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import {
  PLAYER_MECH_KEYS, MAX_GARAGE_PLAYERS, makeGarageSession, sessionEditingKey, sessionMechKeys,
  garageAction, garageActionLabel, garageStatusText, advanceEditing, joinPlayer, canJoin,
  playerTabs,
} from '../data/coopGarage.js';
import { playerColor } from '../data/players.js';
import { MECH_SWATCHES, mechColorFor, takenSwatches, canPickSwatch } from '../data/mechColors.js';
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
import { DirRepeater, dominantDir, slotBindAction } from '../ui/padNav.js';
import { Audio } from '../audio/index.js';
import { StatsOverlay } from './garage/statsOverlay.js';

// The mech lab. The build is four weapon skill slots (#188: the old fifth "ability" slot —
// centerTorso, jumpJet/bubbleShield — is gone; #261: L3/Space is a hardcoded Dash, never
// mounted), shown as a row of square "skill button" tiles
// (#26) along the bottom-left — one per slot, each showing its mounted item + fire bind. Click
// a tile to edit that slot: the catalog (the SHARED WeaponCardList, formerly also hosted by the
// now-retired Weapon Lab tab) filters to the items that fit it, each card running its live
// shot/fx preview. Click a card to mount it (or to unmount if it's already there).
// #470: the sound-authoring surface that #121 folded in here — the sound-tuning panel and the
// explosion-category / UI-cue / catalog-demo-sound trigger rows — has MOVED OUT to the dev-only
// AUDIO tab (scenes/AudioScene.js). The mech lab is player-facing UI again: the catalog spans the
// full width and this scene has no dev-vs-prod layout branch at all. A
// small live mech preview sits bottom-right (#248: the chassis switch is disabled for now —
// light/heavy are off, every mech is locked to medium; #454 dropped the leftover chassis-name
// label, since there's only one chassis to show). "Deploy" (greyed
// until every slot is filled) enters the arena.
const UI = {
  text: '#c8d2dd', accent: '#5ec8e0', bad: '#e2533a',
  panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744,
};

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

    this.allMechs = this.registry.get('allMechs');
    // #349/#388: the co-op session `{ count, editing }`. The joined COUNT survives a return from
    // the arena (so a co-op squad coming back from a run finds all its tabs still there) but
    // `editing` always resets to player 1 — the sequential flow is re-walked from the top every
    // visit, which is also what makes each handoff an explicit act rather than sticky state
    // nobody remembers setting.
    this.session = makeGarageSession({ count: this.registry.get('coopPlayerCount') || 1 });
    this.mechKey = sessionEditingKey(this.session);
    this.mech = this.allMechs[this.mechKey];
    // #249: every entry into the Garage (fresh boot, ESC from the Music tab, or — the bug —
    // returning from Arena after a run ends in a win OR a loss) must show a healthy mech. Damage
    // used to only get healed at the START of the NEXT deploy (see deploy() below), so the
    // bottom-right preview + paper-doll kept reading as destroyed for the whole time the player
    // was back in the Garage after a loss. repairAll() is idempotent (a no-op on an already-healthy
    // mech), so doing it unconditionally here — before textures are built below — is safe on every
    // path, not just the post-run one; deploy()'s own repairAll() stays as a harmless belt-and-braces.
    // #349: repair EVERY player slot, not just the one on screen — player 2's mech comes back
    // from a co-op run damaged too, and it must be healthy the moment the handoff swaps it in
    // (there is no second create() to heal it). Still idempotent, still safe on every path.
    for (const key of PLAYER_MECH_KEYS) this.allMechs[key]?.repairAll();
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

    // Layout: the top region is the weapon catalog (shared WeaponCardList) at full width; a
    // bottom strip holds the skill tiles (left) and the small live mech preview (right).
    this.bottomH = 200;                             // bottom strip height (tiles + preview)
    this.previewW = 210;                            // right slice of the strip for the preview
    this.dollX = 20;
    this.dollW = this.W - this.previewW - 60;
    this._rowBottom = this.H - 22;                  // tile-row bottom edge

    buildMechTextures(this, 'garageMech', this.mech, this._previewArt());

    // The catalog starts below the two-line SCRAP/last-run readout (right-anchored, see below)
    // rather than right under the tab bar, so the two never share a horizontal band at narrow
    // widths. CATALOG_TOP_GAP clears currencyText + lastRunText (2 lines).
    const CATALOG_TOP_GAP = 54;
    const r = this._topRegion(TAB_BAR_H + CATALOG_TOP_GAP);
    this.list = new WeaponCardList(this, {
      x: r.list.x, y: r.list.y, w: r.list.w, h: r.list.h,
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
    this._buildPlayerTabs();

    // #423: the post-run stats screen — a modal overlay showing the committed run history
    // (per-weapon and per-enemy tables + a copyable plain-text report). #445: it's a dev-only
    // tuning tool, so both the overlay and the STATS button that opens it are built only under
    // `import.meta.env.DEV` (Vite's build-time flag, stripped/dead-code-eliminated in
    // `npm run build`) — a production garage has neither. The button itself is no longer a
    // free-floating rect in the band under the tab bar: it's an `actions` entry in the shared tab
    // bar's own row, next to MECH LAB / MUSIC / Deploy (see _buildHeader).
    if (import.meta.env.DEV) this._statsOverlay = new StatsOverlay(this);

    // Controller support (#29 deploy + #30 + #70): CATALOG-FIRST. The pad focus lives in the
    // catalog from the first pad press — the whole unfiltered weapon set, never a per-slot
    // filter. D-pad/left-stick up-down browse it with auto-scroll; a slot's own fire bind
    // (RT/LT/RB/LB) ASSIGNS the highlighted item into that slot, or CLEARS it if the slot
    // already holds exactly that item. There is no tile-first gate: the tile row still renders
    // (mounts + binds) but is not a pad focus zone. Focus visuals + the button legend only
    // appear once a pad button is used (`padActive`), so mouse/keyboard users see no cursor.
    // #388: `padEdges` reads the CURRENT builder's pad (== that player's index), not always pad 0.
    this._bindBuilderPad();
    // START on any UNCLAIMED pad (indices count..MAX-1) is the JOIN button — one PadEdges per
    // watchable pad, mirroring the arena's mid-sortie join (scenes/arena/coop.js). Pads below the
    // current count are already claimed builders; `_updateGarageJoin` only polls the unclaimed ones.
    this._joinEdges = {};
    for (let pad = 1; pad < MAX_GARAGE_PLAYERS; pad++) this._joinEdges[pad] = new PadEdges(this, pad);
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
    this.events.once('shutdown', () => this.list.destroy());

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

  // #388: the co-op player-tab row — a strip of small tabs tucked into the band between the tab
  // bar and the catalog (the same 54px gap the SCRAP/last-run readout uses). That band is empty
  // on the LEFT and the readout is right-anchored, so this adds nothing to the horizontal
  // crowding the garage already has at narrow widths (#330/#342). One OCCUPIED tab per joined
  // player (the active one highlighted) plus a trailing dotted ADD tab inviting the next START,
  // with a status/hint line beside it. Rebuilt wholesale on every session change via a container.
  _buildPlayerTabs() {
    this.tabsY = TAB_BAR_H + 8;
    this.tabsLayer = this.add.container(0, 0);
    this.coopHint = this.add.text(0, this.tabsY + 12, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#efc14a',
    }).setOrigin(0, 0.5);
    this._refreshPlayerTabs();
  }

  // #404 follow-up (third pass): the art options the lab preview is baked with. This method no
  // longer WRITES those options — it asks `art/playerMechLook.js` for them, the one definition the
  // arena's spawn/join and damage-reskin paths bake from too. Two rounds of this issue were caused
  // by the lab assembling its own option object and being a field behind: first no accent at all
  // (grey in the lab, azure the instant it deployed), then the accent but no `statusSpot` — which
  // dropped mechArt into its ENEMY branch and painted the reactor spine, its two vents and the
  // cockpit optic REACTOR PURPLE, which the deployed mech has never had.
  //
  // The subject is whoever is BUILDING RIGHT NOW (`session.editing`), so the co-op handoff re-tints
  // the preview to player 2 the moment the editing surface rebinds to their slot.
  //
  // The one deliberate lab-vs-arena difference is `hullFrames`: the preview is a STILL pose that
  // only ever shows `_hull_0`, and frame 0 is pixel-identical at any frame count
  // (`strideDir(0, n) === 0`), so it bakes the cheap 4 rather than the arena player's 16 and still
  // shows the exact same legs. Everything else is the arena's own player look, unedited.
  _previewArt() {
    // #487: the preview bakes with the CURRENT builder's chosen colour (their build's pick, or the
    // per-index auto-default) as the rim-tint accent — so the moment a swatch is clicked, or the
    // handoff rebinds the surface to the next player, the preview shows that player's colour.
    return playerMechArt(this.session.editing, {
      hullFrames: HULL_FRAMES,
      accent: mechColorFor(this.mech, this.session.editing),
    });
  }

  _refreshPlayerTabs() {
    this.tabsLayer?.removeAll(true);
    const tabW = 34, tabH = 24, gap = 6, x0 = 20, y = this.tabsY;
    const tabs = playerTabs(this.session);
    for (const tab of tabs) {
      const x = x0 + tab.index * (tabW + gap);
      if (tab.occupied) {
        const col = playerColor(tab.index);
        const rect = this.add.rectangle(x, y, tabW, tabH, col, tab.active ? 0.32 : 0.14)
          .setOrigin(0, 0).setStrokeStyle(tab.active ? 2 : 1, col, tab.active ? 1 : 0.6);
        const t = this.add.text(x + tabW / 2, y + tabH / 2, `P${tab.index + 1}`, {
          fontFamily: 'monospace', fontSize: '12px', color: '#e8eef4',
        }).setOrigin(0.5);
        this.tabsLayer.add([rect, t]);
      } else {
        // The ADD affordance: a dotted-border ghost tab with a plus, meaning "press START to
        // join". Drawn as a dashed rectangle so it reads as an empty slot, not a real player.
        const g = this._dashedRect(x, y, tabW, tabH, 0x7c8794);
        const t = this.add.text(x + tabW / 2, y + tabH / 2, '+', {
          fontFamily: 'monospace', fontSize: '15px', color: '#7c8794',
        }).setOrigin(0.5);
        this.tabsLayer.add([g, t]);
      }
    }
    // The hint sits just right of the last tab. It names whose turn it is once there is more than
    // one player, and always reminds that START adds another player while slots remain.
    const endX = x0 + tabs.length * (tabW + gap) + 6;
    const status = garageStatusText(this.session);
    const addable = canJoin(this.session) ? 'START JOINS' : '';
    const hint = [status, addable].filter(Boolean).join('   ');
    this.coopHint.setPosition(endX, y + tabH / 2).setText(hint);
  }

  // A dashed-border rectangle (Phaser has no dotted stroke), used for the empty "add player" tab.
  _dashedRect(x, y, w, h, color) {
    const g = this.add.graphics().lineStyle(1, color, 0.8);
    const dash = 4, gapLen = 3;
    const line = (x1, y1, x2, y2) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      for (let d = 0; d < len; d += dash + gapLen) {
        const e = Math.min(d + dash, len);
        g.beginPath();
        g.moveTo(x1 + ux * d, y1 + uy * d);
        g.lineTo(x1 + ux * e, y1 + uy * e);
        g.strokePath();
      }
    };
    line(x, y, x + w, y); line(x + w, y, x + w, y + h);
    line(x + w, y + h, x, y + h); line(x, y + h, x, y);
    return g;
  }

  // Bind the single editing surface to whichever player's mech the session now says. This IS the
  // whole "the whole squad shares one garage" mechanism: nothing is duplicated, the same tiles,
  // catalog and preview are simply pointed at the other saved build. Also rebinds the active
  // build controller to the current builder's OWN pad (#388: the build surface is driven by whose
  // turn it is, not always pad 0) and repaints the tab row.
  _setSession(next) {
    const prevKey = this.mechKey;
    this.session = next;
    this.registry.set('coopPlayerCount', this.session.count);
    this.mechKey = sessionEditingKey(this.session);
    if (this.mechKey !== prevKey) {
      this.allMechs[prevKey] = this.mech;      // commit the outgoing player's work
      this.mech = this.allMechs[this.mechKey];
      this.mech.repairAll();
      // A handoff changes the ACCENT as well as the build, and the rim tint runs over the hull
      // (leg plates, skirts, thruster glow) just as much as the turret — so this is a full
      // rebuild, not a reskin. reskinMech deliberately skips the hull (it is damage-independent),
      // which would have left the outgoing player's colour on the legs. Four garage hull frames
      // re-raster once per handoff; the arena's 16-frame player set is untouched by this path.
      buildMechTextures(this, 'garageMech', this.mech, this._previewArt());
      this._positionPreviewParts();
      this.selected = null;
      this.list.setIds(this._eligibleIds(null));
      this.list.setSelected(null);
    }
    saveAllMechs(this.allMechs);
    this._bindBuilderPad();
    this._refreshPlayerTabs();
    // #487: a handoff rebinds the picker to the new builder's colour, and a join changes which
    // swatches other players hold — both re-run the swatch paint against the new session.
    this._refreshSwatches();
    this.refresh();
  }

  // Point the catalog-navigation PadEdges at the CURRENT builder's physical pad (player index ==
  // pad index). Solo = pad 0, unchanged. This is what makes player 2's controller — not player
  // 1's — drive the paper-doll/catalog during player 2's turn (#388).
  _bindBuilderPad() {
    this.padEdges = new PadEdges(this, this.session.editing);
  }

  // Per-frame: has an unclaimed controller pressed START to JOIN? Players claim pads 0..count-1,
  // so the unclaimed pads are count..MAX-1. Mirrors the arena's `_updateCoopJoin` pad model
  // (scenes/arena/coop.js) so the two ways in behave identically. Inert in solo only until
  // someone presses a second pad — a single-player garage with no second controller never joins.
  _updateGarageJoin() {
    if (!this._joinEdges || !canJoin(this.session)) return;
    for (let pad = this.session.count; pad < MAX_GARAGE_PLAYERS; pad++) {
      if (this._joinEdges[pad]?.pressed(PAD.START)) { this._joinPlayer(); return; }
    }
  }

  _joinPlayer() {
    Audio.ui('deploy');
    this._setSession(joinPlayer(this.session));   // count++, editing unchanged (join never steals control)
    this.toast(`PLAYER ${this.session.count} JOINED — PRESS START TO HAND OFF`, UI.accent);
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

    // #388: a new controller joining via START on an unclaimed pad, checked before the builder's
    // own input so a join is never mistaken for a build action.
    this._updateGarageJoin();

    const e = this.padEdges;
    const pad = e.pad();
    if (!pad) return;

    // The current builder's START: hand off to the next joined player, or (if they are the last)
    // deploy. deploy() itself branches on garageAction, so this is the same call for both.
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
      // #349: in co-op, while player 1 is the one building, the pinned action is the HANDOFF —
      // same button, different label, so no new control was added to the bar.
      deployLabel: garageActionLabel(this.session),
      // #445: the run-stats overlay's opener lives IN the tab row (same size/gap/alignment as the
      // tabs), and only in dev builds — spread in exactly like the MUSIC tab is in tabBar.js.
      actions: import.meta.env.DEV
        ? [{ key: 'STATS', onClick: () => this._statsOverlay.open() }]
        : [],
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
    this.allMechs[this.mechKey] = this.mech;   // #349: whichever player is currently editing
    buildMechTextures(this, 'garageMech', this.mech, this._previewArt());
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

  // The top catalog area: the card list, full width, between `top` and the bottom strip.
  // #470: there is nothing else in this region any more — the SFX panel and the explosion/UI/
  // demo-sound trigger rows that used to reserve space here moved to the AUDIO tab — so this is
  // ONE unconditional rect, identical in dev and production.
  _topRegion(top) {
    const bottom = this.H - this.bottomH - 16;
    return { list: { x: 20, y: top, w: this.W - 40, h: bottom - top } };
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
  // right slice. The sprites reference fixed texture keys; onChange re-skins those textures in
  // place.
  // #248: light/heavy chassis are disabled for now, so the clickable chassis-switch button is
  // gone — swap a `this.button(...)` call (see cycleChassis) back in here to re-enable switching.
  // #454: the plain chassis-name label that #248 left in its place is gone too — with exactly one
  // chassis to fly, "TROOPER" told the player nothing. Only the label was removed; the chassis
  // data + cycleChassis are untouched.
  _buildPreview() {
    const stripTop = this.H - this.bottomH + 6;
    // #487: the box hugs the TOP of the strip now and is shrunk from the old full-height square,
    // so the colour-swatch picker seats directly below it in the same right slice. The mech shown
    // is small but the arena renders the real thing at size — the lab's job here is just to show
    // the current build (and, now, the current colour) at a glance.
    const box = 100;                                            // square preview size
    const cx = this.W - this.previewW / 2 - 20;                 // centred in the right slice
    const cy = stripTop + box / 2;
    this.previewPanel = this.add.rectangle(cx, cy, box, box, 0x10151c).setStrokeStyle(1, UI.panelEdge);
    const scale = (box - 30) / 230;
    this._previewScale = scale;
    this._previewCx = cx; this._previewCy = cy + 8;
    // #404 (third pass): the sprite stack is built by the SAME shared helper the arena mech view
    // uses (art/mechView.js) — hull → side torsos → arms, each with its #433 muzzle-glow overlay
    // above it → turret — rather than a hand-maintained copy of that list. `isPlayer: true`,
    // because the lab is showing a PLAYER mech: it gets the lit muzzle overlays exactly as the
    // deployed mech does. The only lab-specific bits are the fixed screen position and the preview
    // scale; the sprites are free (not containered) because nothing here moves.
    this._preview = makeMechParts(this, 'garageMech', { x: cx, y: cy + 8, scale, isPlayer: true });
    this.previewHull = this._preview.hull;
    this.previewTurret = this._preview.turret;
    this._positionPreviewParts();
    // #487: the colour picker sits just below the preview box.
    const boxBottom = cy + box / 2;
    this.add.text(cx, boxBottom + 4, 'COLOR', {
      fontFamily: 'monospace', fontSize: '10px', color: '#7c8794',
    }).setOrigin(0.5, 0);
    this._buildSwatches(cx, boxBottom + 20);
  }

  // #487: the mech-colour swatch grid, under the preview box in the right slice. Pure geometry
  // here; `_refreshSwatches` paints the tiles from the current build + co-op distinctness, so a
  // pick or a handoff just re-runs that rather than rebuilding the layout.
  _buildSwatches(cx, top) {
    const cols = 5, sw = 22, gap = 6;
    const gridW = cols * sw + (cols - 1) * gap;
    this._swatchGeom = { x0: cx - gridW / 2, y0: top, cols, sw, gap };
    this.swatchLayer = this.add.container(0, 0);
    this._refreshSwatches();
  }

  // The joined players' builds, in player order — what co-op distinctness reads. In solo this is
  // just `[mech1]`, so `takenSwatches` is empty and P1 picks freely. Each entry is the live Mech
  // in the roster (the currently-edited one included, since `this.mech` IS `allMechs[mechKey]`).
  _joinedBuilds() {
    const builds = [];
    for (let i = 0; i < this.session.count; i++) builds.push(this.allMechs[PLAYER_MECH_KEYS[i]]);
    return builds;
  }

  // Repaint the swatch tiles: the current builder's resolved colour gets the white selection ring;
  // any swatch HELD BY ANOTHER joined player is dimmed + crossed out and inert (co-op distinctness,
  // #487). Rebuilt wholesale into the container on every pick / handoff / join.
  _refreshSwatches() {
    if (!this.swatchLayer || !this._swatchGeom) return;
    this.swatchLayer.removeAll(true);
    const { x0, y0, cols, sw, gap } = this._swatchGeom;
    const taken = takenSwatches(this._joinedBuilds(), this.session.editing);
    const current = mechColorFor(this.mech, this.session.editing);
    MECH_SWATCHES.forEach((hex, i) => {
      const x = x0 + (i % cols) * (sw + gap);
      const y = y0 + Math.floor(i / cols) * (sw + gap);
      const selected = hex === current;
      const disabled = taken.has(hex) && !selected;   // held by another player
      const rect = this.add.rectangle(x, y, sw, sw, hex, disabled ? 0.28 : 1).setOrigin(0, 0)
        .setStrokeStyle(selected ? 3 : 1, selected ? 0xffffff : UI.panelEdge, selected ? 1 : 0.85);
      this.swatchLayer.add(rect);
      if (disabled) {
        const mark = this.add.text(x + sw / 2, y + sw / 2, '✕', {
          fontFamily: 'monospace', fontSize: '12px', color: '#0d1014',
        }).setOrigin(0.5);
        this.swatchLayer.add(mark);
      } else {
        rect.setInteractive({ useHandCursor: true }).on('pointerdown', () => this._pickColor(hex));
      }
    });
  }

  // Apply a swatch pick to the current builder's slot. Guarded by `canPickSwatch` so a taken
  // colour can never be forced in (the UI already disables it; this is the model's own check). A
  // colour change re-tints the WHOLE mech — hull plates included — so it is a full texture rebuild,
  // exactly like the handoff path; `reskinMech` skips the hull and would leave the old colour on
  // the legs. Persists immediately so the pick survives the session.
  _pickColor(hex) {
    if (this.mech.color === hex) return;
    if (!canPickSwatch(this._joinedBuilds(), this.session.editing, hex)) return;
    this.mech.color = hex;
    Audio.ui('menuNav');
    buildMechTextures(this, 'garageMech', this.mech, this._previewArt());
    this._positionPreviewParts();
    saveAllMechs(this.allMechs);
    this._refreshSwatches();
  }

  // Place + pivot the static preview side-torso + arm sprites at their joints. Poses through the
  // arena's own joint math (art/mechView.js `poseMechParts`) with an EMPTY tilt map — the lab shows
  // the mech at REST, where the arena's live weapon-convergence tilts are 0 too, so this is the
  // same pose, not a different one. The preview faces "up" (turret rotation 0): passing
  // angle = -π/2 gives rot = 0 (matching the turret) and the right dx/dy. Called on build and after
  // a chassis switch (which changes mechLayout → part placement).
  _positionPreviewParts() {
    if (!this._preview) return;
    poseMechParts(this._preview, this.mech, -Math.PI / 2, this._previewScale,
      this._previewCx, this._previewCy, {});
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
    reskinMech(this, 'garageMech', this.mech, this._previewArt());
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
    // #349/#388: in co-op, a non-last player pressing this button means "I'm done, next player's
    // turn" — the completeness check above already gates it, so a player cannot hand off a
    // half-built mech and then be unable to get back to it. Only the LAST joined player's press
    // (garageAction === 'deploy') actually launches the run.
    if (garageAction(this.session) === 'handoff') {
      Audio.ui('equip');
      const next = this.session.editing + 2;   // 1-based number of the player taking over
      this._setSession(advanceEditing(this.session));
      this.toast(`PLAYER ${next - 1} READY — PLAYER ${next}, BUILD YOUR MECH`, UI.accent);
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
    // #349: which builds are taking the field. One key in solo (unchanged), both in co-op —
    // this is the ONLY thing the arena needs in order to put a second, garage-built player on
    // the field (scenes/arena/coop.js `_spawnGarageCoopPlayers`).
    this.registry.set('coopMechKeys', sessionMechKeys(this.session));
    this.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
    this.scene.start('ArenaScene');
  }
}
