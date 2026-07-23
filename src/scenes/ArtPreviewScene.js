import Phaser from 'phaser';
import { buildTabBar, attachPadTabCycle, TAB_BAR_H } from '../ui/tabBar.js';
import { TERRAIN, isBaseCategory, RUBBLE } from '../data/terrain.js';
import { BIOMES, BIOME_IDS } from '../data/biomes.js';
import {
  COVER_CANOPY_IDS, canopyTexKey, DOCK_DOOR_TEX, DOCK_DOOR_SLIDE, terrainFillColor,
} from '../art/hexArt.js';
import { ENEMY_KINDS, ENEMY_KIND_IDS } from '../data/enemyKinds.js';
import { ENEMIES } from '../data/enemies.js';
import { Mech } from '../data/Mech.js';
import {
  buildMechTextures, buildVehicleTextures, ARMORED_SUFFIX, ART_SCALE, mountIconKey, itemFxKey,
  HULL_FRAMES,
} from '../art/index.js';
import { playerMechArt } from '../art/playerMechLook.js';
import { vehicleHasArmorArt } from '../art/vehicles/index.js';
// #452 lifted the ink-fitting + mech-posing this scene pioneered into shared modules, so the HUD's
// target readout renders an enemy by the exact same rules rather than a second copy of them.
import { InkCache, texSize, fitScale } from '../art/inkBounds.js';
import { mechPreviewKeys, poseMechInto, vehiclePreviewKeys } from '../art/preview.js';
import { vehicleScaleFactor, MECH_SCALE_FACTOR, trueScaleBase } from '../data/unitScale.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { CHASSIS_IDS } from '../data/chassis/index.js';
import { WEAPON_IDS } from '../data/weapons.js';
import { getItem } from '../data/items.js';
import { WeaponCardList } from '../ui/weaponCardList.js';
import { saveAllMechs } from '../data/save.js';
import { MECH_DEPLOYED } from '../data/events.js';

// ── ART PREVIEW (#461) — a DEV-ONLY gallery for art-directing everything the game draws ───
//
// Every art issue in the backlog (#446 enemy mechs, #447 hex texture, #429 wall turret, #457
// muzzle, #458 projectile, #401 armor, #437 stripped art, #403 legs, #146 infantry, #395 dock
// doors) is bottlenecked on the same thing: SEEING the art in isolation. Hunting for a wall
// turret mid-firefight to judge its base is a terrible review loop; this turns it into a scan.
//
// Modelled on the horse game's src/scenes/ArtPreviewScene.js — its principles, not its file.
// What carried over verbatim: structural enumeration (ask the texture manager what actually
// exists rather than hardcoding frame lists), normalized cells labelled with native W×H, and
// the wheel + drag scroll. What did NOT: its flat family grid, tuned for "one animal = one
// animated spritesheet". Our art is heterogeneous (single hex tiles, two-sprite vehicles,
// six-sprite posed mechs, live-fire projectile sims), so cells are per-view builders instead.
//
// Reached from the DEV-only ART tab (ui/tabBar.js). Deliberately NOT ported: dissectOverlay
// (needs a layer recorder + g.layer() tags across ~30 art files) and the wall edge geometry
// (drawWallEdges paints vector edges into a live Graphics — there is no wall TEXTURE to show).
const UI = {
  bg: '#0d1014', text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', sel: 0xefc14a,
  panel: 0x161b22, panelEdge: 0x2a333f, btn: 0x1a212b, btnHover: 0x232c38, cellEdge: 0x232c38,
};

// Every texture this scene bakes is prefixed so shutdown can drop the lot without touching the
// game's own (identically-drawn but separately-keyed) textures.
const TEX_PREFIX = 'apv_';

const CTRL_H = 40;            // the control strip under the shared tab bar
const PAD = 16;
const CELL_GAP = 10;
const CELL_LABEL_H = 46;      // reserved at the bottom of every cell for its (up to 3) label lines
const GROUP_HEAD_H = 26;

// Zoom is a multiplier on the CELL, and art is fitted to the cell — so a bigger zoom is
// literally more pixels per sprite, which is the whole point (owner: "I want to see DETAIL,
// not a contact sheet"). Defaults deliberately high; 1× exists only as a step-back overview.
const ZOOMS = [1, 2, 3, 4, 6];
const DEFAULT_ZOOM_INDEX = 2;   // 3× — a hex tile or a turret base fills a big chunk of screen
const CELL_BASE = 96;

// Mech silhouettes are explicitly tuned to stay legible against BOTH light and dark ground
// (see the legibility-halo rationale in art/mechPrims.js), so the cell background has to be
// swappable — that check is unfalsifiable on one fixed backdrop. Each entry resolves through
// terrainFillColor() so these stay the REAL biome ground colours, not hand-picked lookalikes.
const BACKDROPS = [
  { label: 'VOID', color: 0x0d1014 },
  { label: 'SNOW', id: 'snow' },
  { label: 'ASH', id: 'ash' },
  { label: 'GRASS', id: 'grass' },
  { label: 'SAND', id: 'sand' },
  { label: 'PAVEMENT', id: 'pavement' },
];

const VIEWS = ['HEXES', 'ENEMIES', 'WEAPONS', 'MECH'];

// Walk-cycle playback (the mech hull's 4 frames, the carrier's 2-frame bay door).
const FRAME_MS = 150;
// One "step" of the paused sim: a fixed slice so a frame-step is reproducible rather than
// however long the button click happened to take.
const STEP_MS = 16 * 4;

export default class ArtPreviewScene extends Phaser.Scene {
  constructor() { super('ArtPreviewScene'); }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);
    this.cameras.main.setBackgroundColor(UI.bg);

    this.allMechs = this.registry.get('allMechs');
    const playerMech = this.allMechs?.[ACTIVE_MECH_KEY];
    const canDeploy = playerMech instanceof Mech ? playerMech.isComplete() : false;
    buildTabBar(this, { active: 'ArtPreviewScene', canDeploy, onDeploy: () => this._deploy() });
    attachPadTabCycle(this, 'ArtPreviewScene');

    this.view = VIEWS[0];
    this.zoomIndex = DEFAULT_ZOOM_INDEX;
    this.bgIndex = 0;
    this.playing = true;
    this.frame = 0;
    this._animAcc = 0;
    this._scrollY = 0;
    this._maxScroll = 0;
    this._chassisIndex = -1;    // -1 = the player's own saved chassis (MECH view)
    this.trueScale = false;     // ENEMIES: normalized by default, TRUE relative scale on demand (#468)
    this._damageStep = 0;

    this.ink = new InkCache(this.textures);
    this.chrome = this.add.container(0, 0).setDepth(20);
    // Per-view chrome that must NOT scroll with the gallery (the live-fire catalog's header
    // bar). Separate from `chrome` because that gets rebuilt on every control click, and
    // separate from `content` because it's pinned.
    this.pinned = this.add.container(0, 0).setDepth(15);
    this.content = this.add.container(0, 0);
    this.maskG = this.make.graphics();
    this._paintMask();
    this.content.setMask(this.maskG.createGeometryMask());

    this._buildControls();
    this._wireScroll();
    this._rebuild();

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('GarageScene'));
    this.scale.on('resize', this._onResize, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this._onResize, this);
      this.list?.destroy();
      this.list = null;
      this.content.removeAll(true);
      this.maskG.destroy();
      // Drop every texture this scene baked, so re-entering doesn't stack duplicates.
      for (const k of this.textures.getTextureKeys()) {
        if (k.startsWith(TEX_PREFIX)) this.textures.remove(k);
      }
    });
  }

  _deploy() {
    const mech = this.allMechs?.[ACTIVE_MECH_KEY];
    if (mech) { mech.repairAll(); saveAllMechs(this.allMechs); }
    this.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
    this.scene.start('ArenaScene');
  }

  _onResize() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this._paintMask();
    this._rebuild();
  }

  get contentTop() { return TAB_BAR_H + CTRL_H; }
  get contentH() { return Math.max(80, this.H - this.contentTop); }
  get cellSize() { return CELL_BASE * ZOOMS[this.zoomIndex]; }

  _paintMask() {
    this.maskG.clear().fillStyle(0xffffff)
      .fillRect(0, this.contentTop, this.W, this.contentH);
  }

  // ── Chrome ────────────────────────────────────────────────────────────────────────────

  _button(x, y, w, h, label, onClick, { active = false, size = 11 } = {}) {
    const rect = this.add.rectangle(x, y, w, h, active ? 0x1b2430 : UI.btn).setOrigin(0, 0)
      .setStrokeStyle(active ? 2 : 1, active ? UI.sel : UI.panelEdge)
      .setInteractive({ useHandCursor: true });
    const t = this.add.text(x + w / 2, y + h / 2, label, {
      fontFamily: 'monospace', fontSize: `${size}px`,
      color: active ? '#efc14a' : UI.text,
    }).setOrigin(0.5);
    rect.on('pointerover', () => rect.setFillStyle(UI.btnHover));
    rect.on('pointerout', () => rect.setFillStyle(active ? 0x1b2430 : UI.btn));
    rect.on('pointerdown', onClick);
    this.chrome.add([rect, t]);
    return { rect, text: t };
  }

  _buildControls() {
    this.chrome.removeAll(true);
    const y = TAB_BAR_H + 6;
    const h = CTRL_H - 12;
    let x = PAD;
    this.chrome.add(this.add.rectangle(0, TAB_BAR_H, this.W, CTRL_H, UI.panel).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge));

    for (const v of VIEWS) {
      const w = 92;
      this._button(x, y, w, h, v, () => this._setView(v), { active: v === this.view });
      x += w + 6;
    }

    x += 18;
    this._button(x, y, 74, h, this.playing ? '❚❚ PAUSE' : '▶ PLAY', () => {
      this.playing = !this.playing;
      this._buildControls();
    });
    x += 80;
    this._button(x, y, 66, h, '▶| STEP', () => this._step());
    x += 72;

    x += 18;
    const bd = BACKDROPS[this.bgIndex];
    this._button(x, y, 132, h, `BG: ${bd.label}`, () => {
      this.bgIndex = (this.bgIndex + 1) % BACKDROPS.length;
      this._buildControls();
      this._rebuild();
    });
    x += 138;
    this._button(x, y, 84, h, `ZOOM ${ZOOMS[this.zoomIndex]}×`, () => {
      this.zoomIndex = (this.zoomIndex + 1) % ZOOMS.length;
      this._buildControls();
      this._rebuild();
    });
    x += 90;

    // #468: the ENEMIES tab's scale mode. Follows the CHASSIS button's pattern (view-specific,
    // states cycled on the button itself) and uses the shared `active` styling, so the current
    // mode reads off the control strip without opening anything — gold + outlined while TRUE
    // scale is on, plain while normalized.
    if (this.view === 'ENEMIES') {
      this._button(x, y, 210, h, `SCALE: ${this.trueScale ? 'TRUE RELATIVE' : 'NORMALIZED'}`, () => {
        this.trueScale = !this.trueScale;
        this._buildControls();
        this._rebuild();
      }, { active: this.trueScale });
      x += 216;
    }

    if (this.view === 'MECH') {
      const label = this._chassisIndex < 0 ? 'CHASSIS: SAVED' : `CHASSIS: ${CHASSIS_IDS[this._chassisIndex].toUpperCase()}`;
      this._button(x, y, 176, h, label, () => {
        this._chassisIndex = this._chassisIndex + 1 >= CHASSIS_IDS.length ? -1 : this._chassisIndex + 1;
        this._buildControls();
        this._rebuild();
      });
      x += 182;
    }
  }

  _setView(v) {
    if (v === this.view) return;
    this.view = v;
    this._scrollY = 0;
    this._buildControls();
    this._rebuild();
  }

  _step() {
    this.frame = (this.frame + 1) % 4;
    this._applyFrame();
    this.list?.update(this.time.now, STEP_MS);
  }

  _bgColor() {
    const bd = BACKDROPS[this.bgIndex];
    return bd.color ?? terrainFillColor(bd.id) ?? 0x0d1014;
  }

  // ── Scroll (wheel + drag, with a tap-vs-drag guard — ported from the horse game) ────────

  _wireScroll() {
    const dprOf = () => this.registry.get('dpr') || 1;
    const inContent = (p) => {
      const ly = p.y / dprOf();
      return ly >= this.contentTop;
    };
    this.input.on('wheel', (p, _o, _dx, dy) => {
      // The WEAPONS view hands its lower half to WeaponCardList, which owns its own scroll.
      if (this._listOwns(p)) return;
      if (inContent(p)) this._setScroll(this._scrollY + dy);
    });
    this.input.on('pointerdown', (p) => {
      this._moved = false;
      if (this._listOwns(p) || !inContent(p)) { this._dragY = null; return; }
      this._dragY = p.y; this._dragFrom = this._scrollY;
    });
    this.input.on('pointermove', (p) => {
      if (!p.isDown || this._dragY == null) return;
      const dy = (p.y - this._dragY) / dprOf();
      if (Math.abs(dy) > 6) this._moved = true;
      this._setScroll(this._dragFrom - dy);
    });
    this.input.on('pointerup', () => { this._dragY = null; });
  }

  // True when the pointer is over the embedded WeaponCardList's region (it scrolls itself).
  _listOwns(p) {
    if (!this.list) return false;
    const dpr = this.registry.get('dpr') || 1;
    const { x, y, w, h } = this.list.region;
    const lx = p.x / dpr, ly = p.y / dpr;
    return lx >= x && lx <= x + w && ly >= y && ly <= y + h;
  }

  _setScroll(y) {
    this._scrollY = Phaser.Math.Clamp(y, 0, this._maxScroll);
    this.content.y = -this._scrollY;
  }

  // ── Cell + group layout ───────────────────────────────────────────────────────────────
  //
  // A GROUP is a labelled row of CELLS that wraps across the content width. A CELL is a fixed
  // square: backdrop swatch, the art fitted into it, and a two-line label (name + native W×H).
  // Every view is expressed as groups, so layout/scroll/zoom/backdrop are written once.

  _rebuild() {
    this.list?.destroy();
    this.list = null;
    this.content.removeAll(true);
    this.pinned.removeAll(true);
    this._animSprites = [];
    this._cursorY = this.contentTop + PAD;
    // Textures this scene bakes are re-drawn in place on every rebuild (a chassis switch changes
    // the mech's whole silhouette), so their cached ink bounds must go with them. The game's own
    // boot textures never change, so those stay cached for the life of the scene.
    this.ink.drop(TEX_PREFIX);

    if (this.view === 'HEXES') this._buildHexes();
    else if (this.view === 'ENEMIES') this._buildEnemies();
    else if (this.view === 'WEAPONS') this._buildWeapons();
    else this._buildMech();

    this._maxScroll = Math.max(0, this._cursorY + PAD - this.contentTop - this.contentH);
    this._setScroll(this._scrollY);
    this._applyFrame();
  }

  // Add one labelled group of cells. `cells` is an array of { label, sub, build(container, box) }
  // where `box` is the art area's side length and the container's origin is the art centre.
  _group(label, cells) {
    if (!cells.length) return;
    const head = this.add.text(PAD, this._cursorY, label, {
      fontFamily: 'monospace', fontSize: '13px', color: UI.accent,
    }).setOrigin(0, 0);
    this.content.add(head);
    this._cursorY += GROUP_HEAD_H;

    const size = this.cellSize;
    const perRow = Math.max(1, Math.floor((this.W - PAD * 2 + CELL_GAP) / (size + CELL_GAP)));
    cells.forEach((cell, i) => {
      const col = i % perRow, row = Math.floor(i / perRow);
      const x = PAD + col * (size + CELL_GAP);
      const y = this._cursorY + row * (size + CELL_GAP);
      this._cell(x, y, size, cell);
    });
    const rows = Math.ceil(cells.length / perRow);
    this._cursorY += rows * (size + CELL_GAP) + PAD;
  }

  _cell(x, y, size, cell) {
    const box = size - 16;
    const artH = box - CELL_LABEL_H;
    // The swatch covers the ART area only, not the label strip — a light backdrop (SNOW) would
    // otherwise swallow the label text, and this reads more honestly as "the ground it stands on".
    const bg = this.add.rectangle(x, y, size, artH + 16, this._bgColor()).setOrigin(0, 0)
      .setStrokeStyle(1, UI.cellEdge);
    this.content.add(bg);

    const holder = this.add.container(x + size / 2, y + 8 + artH / 2);
    this.content.add(holder);
    const sub = cell.build(holder, Math.min(box, artH)) ?? '';

    const label = this.add.text(x + size / 2, y + size - CELL_LABEL_H + 2, `${cell.label}\n${cell.sub ?? sub}`, {
      fontFamily: 'monospace', fontSize: '11px', color: UI.text, align: 'center', lineSpacing: 2,
    }).setOrigin(0.5, 0);
    this.content.add(label);
  }

  // Fit a box of w×h into `box`, and the inked bounds of one texture / a stack of them. All three
  // live in art/inkBounds.js since #452 — the HUD's target readout needs the identical rule (see
  // that module's header for WHY fitting the canvas is wrong), and one copy can't drift.
  _fit(w, h, box) { return fitScale(w, h, box); }

  _texSize(key) { return texSize(this.textures, key); }

  _ink(key) { return this.ink.bounds(key); }

  _inkUnion(keys, offsets = []) { return this.ink.union(keys, offsets); }

  // A cell showing one or more textures stacked at a shared scale (hex + canopy, hull + turret).
  // `offsets` optionally shifts a layer, in TEXTURE px, before the shared scale is applied.
  _stackCell(label, keys, { offsets = [] } = {}) {
    return {
      label,
      build: (holder, box) => {
        const live = keys.filter((k) => this.textures.exists(k));
        if (!live.length) return 'missing';
        const liveOffsets = keys.map((k, i) => offsets[i]).filter((_, i) => this.textures.exists(keys[i]));
        const u = this._inkUnion(live, liveOffsets);
        if (!u) return 'blank';
        const s = this._fit(u.w, u.h, box);
        live.forEach((k, i) => {
          const o = liveOffsets[i] ?? { x: 0, y: 0 };
          const size = this._texSize(k);
          holder.add(this.add.image((size.w / 2 + o.x - u.cx) * s, (size.h / 2 + o.y - u.cy) * s, k).setScale(s));
        });
        return `${Math.round(u.w)}×${Math.round(u.h)} ink`;
      },
    };
  }

  // ── HEXES ─────────────────────────────────────────────────────────────────────────────
  // Every hex tile the world can stamp: one row per biome (its six terrain ROLES in the same
  // order biomes.js declares them, each role trailed by whatever belongs TO it — its canopy
  // overlay, its cleared/rubble derivatives), then the fabricated base hexes (with the whole
  // dock assembly as one contiguous run), and finally two catch-all safety nets so nothing
  // can hide.
  //
  // #461 playtest follow-ups (twice, same complaint): things that belong to a tile were
  // floating in their own anonymous standalone groups instead of sitting with it.
  //   1. The biome-specific `clearedId`/`rubbleId` derivatives (forest → forestCleared, …) fell
  //      through to the catch-all row — exactly the wrong context, since #405 gave each one its
  //      OWN look precisely so it reads as that biome's own cleared ground. (#464 deleted the
  //      dead `*Rubble` soft-cover derivatives, so `cleared` is the only one soft cover has left;
  //      the mechanism still handles both.)
  //   2. The #289 canopy overlays had a standalone COVER CANOPY group, and the #395 dock doors
  //      a standalone DOCK DOORS group while `dock`/`dockClosed` sat in BASE + STRUCTURE.
  // Now: each cover role reads intact → + canopy → cleared → rubble in one place per biome (with
  // the intact cell folded into the canopy composite when the two share one ground tile — see the
  // #464 note in `_buildHexes`), and
  // every dock piece is one run inside the base grouping. Both memberships are DERIVED (canopy
  // from the biome's own role ids, derivatives from the TERRAIN fields), never a hand-written
  // map, so new content flows through by itself. A derivative reachable from two biomes appears
  // in both rows — duplicated in context beats orphaned. The generic biome-INDEPENDENT `rubble`
  // is deliberately excluded (all the base infra collapses to it); it stays in BASE + STRUCTURE.
  //
  // The standalone-group mechanism survives ONLY as a safety net: an unclaimed canopy or an
  // unclaimed terrain id still surfaces rather than vanishing. Both are empty today, and
  // `_group` no-ops on an empty list, so neither header renders.

  // #464: a terrain id's ground texture is whatever its TERRAIN entry NAMES, never `hex_<id>`
  // reconstructed from the id. The five soft-cover ids now ALIAS their cleared twin's tile
  // (`TERRAIN.forest.tex === 'hex_forestCleared'`), so the old assumption would have looked up a
  // `hex_forest` that no longer gets baked and silently dropped every cover role out of its biome
  // row. The `?? hex_<id>` fallback covers the one non-TERRAIN key this view shows: `wall`.
  _hexTex(id) { return TERRAIN[id]?.tex ?? `hex_${id}`; }
  _hasHexTex(id) { return this.textures.exists(this._hexTex(id)); }

  // The cleared/rubble tiles a destructible terrain id collapses into, in lifecycle order.
  _derivativesOf(id) {
    const t = TERRAIN[id];
    if (!t) return [];
    return [['cleared', t.clearedId], ['rubble', t.rubbleId]]
      .filter(([, did]) => did && did !== RUBBLE && TERRAIN[did] && this._hasHexTex(did));
  }

  _buildHexes() {
    const shown = new Set();
    const canopyShown = new Set();
    const tile = (id, label) => {
      shown.add(id);
      return this._stackCell(label ?? id, [this._hexTex(id)]);
    };
    // A canopy is a transparent foliage-only raster — it reads as nothing on its own, so it is
    // always composited over the ground tile it overlays. Keyed by terrain ID (the canopy registry's
    // own key), NOT by the ground texture — see `_hexTex` above.
    const canopyCell = (id, label) => {
      canopyShown.add(id);
      return this._stackCell(label, [this._hexTex(id), canopyTexKey(id)]);
    };
    const hasCanopy = (id) => COVER_CANOPY_IDS.includes(id) && this.textures.exists(canopyTexKey(id));

    for (const bid of BIOME_IDS) {
      const B = BIOMES[bid];
      const roles = [
        ['groundA', B.groundA], ['groundB', B.groundB], ['channel', B.channel],
        ['deep', B.deep], ['hazard', B.hazard], ['cover', B.cover],
      // #464 (playtest): `deep` now always filters itself out — hexArt.js stopped baking a tile
      // for the five world-boundary-only ids, which is the whole reason the role vanishes from
      // these rows. The role stays declared so the list still mirrors biomes.js, and so it comes
      // back on its own if a boundary tile is ever baked again.
      ].filter(([, id]) => id && this._hasHexTex(id));
      const cells = [];
      for (const [role, id] of roles) {
        const derivatives = this._derivativesOf(id);
        // #464 (playtest, owner: "I'm seeing separate forest cover and forest cleared cover, which
        // feels redundant"): the first pass merged each soft-cover role's intact GROUND tile into
        // its cleared twin (`TERRAIN.forest.tex === 'hex_forestCleared'`), but this row still drew
        // a bare cell for each — so "forest / cover" and "forestCleared / ↳ cover cleared" sat
        // side by side showing the byte-identical image. When that alias holds and the role wears
        // a canopy, the canopy composite IS the intact state (a standing cover hex is never
        // rendered without it, scenes/arena/world.js), so the bare ground cell is dropped and the
        // composite takes the role's own label. Derived from the textures, not a hand-written
        // list: a cover terrain that ever regains its own distinct ground tile gets both cells
        // back automatically.
        const aliasesCleared = derivatives.some(([, did]) => this._hexTex(did) === this._hexTex(id));
        const canopy = hasCanopy(id);
        const merged = aliasesCleared && canopy;
        if (merged) shown.add(id);           // still claimed by this row, so the catch-all skips it
        else cells.push(tile(id, `${id}\n${role}`));
        // The full lifecycle of this role, in order: the canopy overlay it wears while intact,
        // then what it collapses into once shot away.
        if (canopy) cells.push(canopyCell(id, merged ? `${id}\n${role}` : `${id}\n↳ ${role} + canopy`));
        for (const [kind, did] of derivatives) {
          cells.push(tile(did, `${did}\n↳ ${role} ${kind}`));
        }
      }
      this._group(`${B.name.toUpperCase()}  (${bid})`, cells);
    }

    // The fabricated base/objective hexes + the two structural tiles that aren't biome roles.
    // The dock is an ASSEMBLY, not one tile — the open bay, the two #395 door leaves over it
    // (shut, and parted by the same DOCK_DOOR_SLIDE the arena tweens them across), and the
    // sealed `dockClosed` hex a vacated dock swaps to. They render as one contiguous run,
    // emitted where the first dock piece falls in TERRAIN order.
    const baseIds = Object.keys(TERRAIN).filter(isBaseCategory);
    const structural = ['rubble', 'wall'].filter((id) => this._hasHexTex(id));
    const dockPieces = ['dock', 'dockClosed'];
    let dockRunEmitted = false;
    const baseCells = [];
    for (const id of [...baseIds, ...structural].filter((i) => this._hasHexTex(i))) {
      if (!dockPieces.includes(id)) { baseCells.push(tile(id)); continue; }
      if (dockRunEmitted) continue;          // the rest of the assembly went out with the first
      dockRunEmitted = true;
      baseCells.push(...this._dockRunCells(tile));
    }
    this._group('BASE + STRUCTURE', baseCells);

    // Safety nets, not buckets: anything no row above claimed still shows up. Both are empty
    // today (`_group` no-ops on an empty list, so no stray header) — they exist so a future
    // canopy or terrain id can never hide.
    this._group('COVER CANOPY (claimed by no biome)',
      COVER_CANOPY_IDS.filter((id) => !canopyShown.has(id) && this.textures.exists(canopyTexKey(id))
        && this._hasHexTex(id))
        .map((id) => canopyCell(id, `${id}\n+ canopy`)));

    const rest = Object.keys(TERRAIN)
      .filter((id) => !shown.has(id) && this._hasHexTex(id));
    this._group('EVERY OTHER TERRAIN (unclaimed)', rest.map((id) => tile(id)));
  }

  // The dock assembly as one ordered run: open bay → doors shut → doors parted → sealed hex.
  // `tile` is passed in so the plain hexes still register as SHOWN for the catch-all row.
  _dockRunCells(tile) {
    const cells = [];
    if (this.textures.exists('hex_dock')) {
      cells.push(tile('dock', 'dock\nopen bay'));
      if (this.textures.exists(DOCK_DOOR_TEX.L)) {
        cells.push(this._stackCell('dock\n↳ doors shut', ['hex_dock', DOCK_DOOR_TEX.L, DOCK_DOOR_TEX.R]));
        cells.push(this._stackCell('dock\n↳ doors parted', ['hex_dock', DOCK_DOOR_TEX.L, DOCK_DOOR_TEX.R], {
          offsets: [null, { x: -DOCK_DOOR_SLIDE * ART_SCALE, y: 0 }, { x: DOCK_DOOR_SLIDE * ART_SCALE, y: 0 }],
        }));
      }
    }
    if (this.textures.exists('hex_dockClosed')) cells.push(tile('dockClosed', 'dockClosed\n↳ sealed hex'));
    return cells;
  }

  // ── ENEMIES ───────────────────────────────────────────────────────────────────────────
  // Non-mech kinds are two sprites (hull + turret) stacked exactly as the arena stacks them;
  // an armored kind (#300) also gets its plated variant beside the bare one. Enemy MECHS are
  // built from their real data defs and posed with the same part transforms the arena uses.

  _vehicleKey(id) { return `${TEX_PREFIX}veh_${id}`; }

  // The two texture keys a vehicle cell stacks, by the multi-frame conventions the arena renders
  // with (`legFrames` ⇒ `_hull_0..N`, `turretFrames` ⇒ `_turret_0..N`).
  _vehicleTexKeys(key, def) {
    const { hull, turret } = vehiclePreviewKeys(key, def);
    return [hull, turret];
  }

  // ── TRUE RELATIVE SCALE (#468) ──────────────────────────────────────────────────────────
  // Normalized (the default) fits every unit to its own cell, which is the only way infantry is
  // reviewable at all — but it makes "is the drone too big next to the tank" unanswerable from
  // this screen. The toggle switches the whole tab to ONE shared scale: each cell draws at
  // `base × the unit's game scale factor`, so the cells reproduce the arena's real size ratios
  // (and infantry duly becomes a speck — that IS the answer, not a bug to half-fix).
  //
  // The base has to be settled BEFORE any cell builds, because `_group` builds its cells
  // synchronously — so `_buildEnemies` collects every unit's ink + factor first, then lays out.
  _trueBase(box) {
    if (this._trueBox !== box) {
      this._trueBox = box;
      this._trueBaseScale = trueScaleBase(this._trueEntries ?? [], box);
    }
    return this._trueBaseScale;
  }

  // The scale one cell draws at: its shared-scale share in TRUE mode, else fitted to its cell.
  _unitScale(u, box, factor) {
    return factor == null ? this._fit(u.w, u.h, box) : this._trueBase(box) * factor;
  }

  _buildEnemies() {
    const on = this.trueScale;
    this._trueEntries = [];
    this._trueBox = null;
    // Everything that will be drawn, resolved up front (textures baked, ink measured) so the
    // shared TRUE scale can see the whole tab before the first cell lays out.
    const note = (keys, factor) => {
      if (!on) return;
      const u = this._inkUnion(keys.filter((k) => this.textures.exists(k)));
      if (u) this._trueEntries.push({ w: u.w, h: u.h, factor });
    };

    const cells = [];
    for (const id of ENEMY_KIND_IDS) {
      const def = ENEMY_KINDS[id];
      const key = this._vehicleKey(id);
      if (!this.textures.exists(`${key}_turret`)) buildVehicleTextures(this, key, def);
      const armored = vehicleHasArmorArt(def);
      const factor = on ? vehicleScaleFactor(def) : null;
      if (armored) cells.push(this._vehicleCell(`${id}\narmored`, key + ARMORED_SUFFIX, def, { factor }));
      cells.push(this._vehicleCell(armored ? `${id}\nbare (#401)` : id, key, def, { factor }));
      note(this._vehicleTexKeys(key, def), factor);
    }

    const built = Object.keys(ENEMIES).map((id) => {
      const mech = new Mech(ENEMIES[id]);
      mech.repairAll();
      const key = `${TEX_PREFIX}emech_${id}`;
      buildMechTextures(this, key, mech, { theme: 'enemy' });
      note(this._mechKeys(key), MECH_SCALE_FACTOR);
      return { id, mech, key };
    });
    // Normalized: one shared ink across the mech row, so chassis sizes compare within it. TRUE:
    // the shared scale already does that job across the WHOLE tab, and each mech re-centres on
    // its own ink.
    const enemyInk = on ? null : this._inkUnion(built.flatMap((b) => this._mechKeys(b.key)));

    this._group(`VEHICLE KINDS (hull + turret, as the arena stacks them)${on ? ' — TRUE SCALE' : ''}`, cells);
    this._group(on
      ? 'ENEMY MECHS (#446) — TRUE SCALE, shared with the vehicles above'
      : 'ENEMY MECHS (#446 — one shared scale, so chassis sizes compare)',
    built.map((b) => this._mechCell(`${ENEMIES[b.id].name ?? b.id}\n${b.id}`, b.key, b.mech, {
      ink: enemyInk, factor: on ? MECH_SCALE_FACTOR : null,
    })));
  }

  // `factor` non-null puts the cell on the tab's shared TRUE scale (#468) at that game-scale
  // multiple; null (the default) fits the art to its own cell.
  _vehicleCell(label, key, def, { factor = null } = {}) {
    const [hullKey, turretKey] = this._vehicleTexKeys(key, def);
    return {
      label,
      build: (holder, box) => {
        const live = [hullKey, turretKey].filter((k) => this.textures.exists(k));
        if (!live.length) return 'missing';
        const u = this._inkUnion(live);
        if (!u) return 'blank';
        const s = this._unitScale(u, box, factor);
        const ox = (u.texW / 2 - u.cx) * s, oy = (u.texH / 2 - u.cy) * s;
        const hullSprite = this.add.sprite(ox, oy, hullKey).setScale(s);
        holder.add(hullSprite);
        if (def.legFrames) this._animSprites.push({ sprite: hullSprite, prefix: `${key}_hull_`, count: def.legFrames });
        if (this.textures.exists(turretKey)) {
          const turretSprite = this.add.sprite(ox, oy, turretKey).setScale(s);
          holder.add(turretSprite);
          if (def.turretFrames) this._animSprites.push({ sprite: turretSprite, prefix: `${key}_turret_`, count: def.turretFrames });
        }
        return `${Math.round(u.w)}×${Math.round(u.h)} ink · game ${vehicleScaleFactor(def).toFixed(2)}×`;
      },
    };
  }

  // ── Shared mech posing ────────────────────────────────────────────────────────────────
  // The six-sprite mech, assembled the way GarageScene's preview does it: hull frame, the two
  // side torsos and two arms pivoted at their joints via partSpriteTransform, the player-only
  // muzzle-glow overlays (#433) sharing each part's transform, then the turret on top.

  // At the shared preview facing (-π/2) partSpriteTransform reproduces each part's baked-in
  // placement exactly, so the whole assembled mech lives in the parts' shared texture frame —
  // which means the union of their inked bounds IS the mech's real silhouette box, and `ox/oy`
  // re-centres it in the cell. Both halves live in art/preview.js since #452, so the HUD's target
  // readout poses an enemy mech with the identical stack.
  _mechKeys(key) { return mechPreviewKeys(this.textures, key); }

  _poseMech(holder, key, mech, scale, frame, ox, oy, { animate = false } = {}) {
    const { hull } = poseMechInto(this, holder, key, mech, scale, frame, ox, oy);
    if (animate) this._animSprites.push({ sprite: hull, prefix: `${key}_hull_`, count: 4 });
  }

  // `ink` lets a whole ROW share one scale (pass the union across every mech in it) — without
  // that, a damage progression re-zooms at each step and the mech never looks like it's losing
  // parts, and enemy mechs can't be compared to each other by size.
  _mechCell(label, key, mech, { frame = 0, animate = false, ink = null, factor = null } = {}) {
    return {
      label,
      build: (holder, box) => {
        const u = ink ?? this._inkUnion(this._mechKeys(key));
        if (!u) return 'missing';
        const s = this._unitScale(u, box, factor);
        this._poseMech(holder, key, mech, s, frame, (u.texW / 2 - u.cx) * s, (u.texH / 2 - u.cy) * s, { animate });
        return `${Math.round(u.w)}×${Math.round(u.h)} ink · ${mech.chassisId}`;
      },
    };
  }

  // ── WEAPONS ───────────────────────────────────────────────────────────────────────────
  // The top band is the mount + fx STILLS at full zoom (silhouette review for #457/#458); the
  // lower band embeds the real WeaponCardList — the same component the garage catalog uses,
  // which already live-fires every weapon's projectiles/beams/slashes/ground fire through the
  // shared delivery sim. No fake harness needed, and no drift from what the arena fires.

  _buildWeapons() {
    const stills = [];
    for (const id of WEAPON_IDS) {
      const item = getItem(id);
      stills.push({
        label: `${item?.name ?? id}\nmount + fx`,
        build: (holder, box) => {
          // Two halves: the on-mech mount hardware (#457's muzzle lives on it) beside the
          // projectile/beam still (#458). Each fitted to its own inked bounds, so a stubby
          // pulse laser and a long rail lance both fill their half.
          const half = box / 2 - 6;
          const put = (key, cx) => {
            const u = this._inkUnion([key]);
            if (!u) return null;
            const s = this._fit(u.w, u.h, Math.min(half, box));
            holder.add(this.add.image(cx + (u.texW / 2 - u.cx) * s, (u.texH / 2 - u.cy) * s, key).setScale(s));
            return u;
          };
          const m = put(mountIconKey(id), -box / 4);
          put(itemFxKey(id), box / 4);
          return m ? `${Math.round(m.w)}×${Math.round(m.h)} ink` : 'missing';
        },
      });
    }
    this._group('WEAPON MOUNTS + FX STILLS (#457 muzzle / #458 projectile)', stills);

    // The live-fire catalog gets its own fixed band at the bottom of the viewport (it scrolls
    // itself), so it never fights the gallery scroll above it.
    const listH = Math.min(360, Math.max(180, this.contentH * 0.45));
    const listY = this.contentTop + this.contentH - listH;
    const bar = this.add.rectangle(0, listY - 26, this.W, 26, UI.panel).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge);
    const barText = this.add.text(PAD, listY - 21, 'LIVE FIRE — the shared garage catalog, firing through the real delivery sim', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    });
    // Opaque backdrop for the band — without it the (scrolling) stills above show through the
    // gaps between cards.
    const backdrop = this.add.rectangle(0, listY, this.W, this.H - listY, 0x0d1014).setOrigin(0, 0);
    this.pinned.add([backdrop, bar, barText]);
    this.list = new WeaponCardList(this, {
      x: PAD, y: listY, w: this.W - PAD * 2, h: listH - PAD, ids: WEAPON_IDS,
    });
    this.list.root.setDepth(16);   // above `pinned` (15), which is above the scrolled gallery
    // Reserve the band so the stills above can't scroll underneath the catalog.
    this._cursorY += listH + 26;
  }

  // ── MECH ──────────────────────────────────────────────────────────────────────────────
  // The player's own saved build, big. The 4-frame hull walk cycle laid out frame by frame
  // (the only real frame animation in the game) plus one live animating copy, then the damage
  // progression — the same applyDamage + reskin path the arena runs, so a stripped/destroyed
  // part reads here exactly as it does mid-fight (#437 / #403).

  _playerConfig() {
    const saved = this.allMechs?.[ACTIVE_MECH_KEY];
    const base = saved instanceof Mech ? saved.toJSON() : { chassisId: 'medium', mounts: {} };
    const chassisId = this._chassisIndex < 0 ? base.chassisId : CHASSIS_IDS[this._chassisIndex];
    return { chassisId, name: base.name, mounts: base.mounts };
  }

  _freshPlayerMech() {
    const m = new Mech(this._playerConfig());
    m.repairAll();
    return m;
  }

  _buildMech() {
    const cfg = this._playerConfig();
    const live = this._freshPlayerMech();
    const liveKey = `${TEX_PREFIX}player_live`;
    // #404: bake the REAL player look (art/playerMechLook.js) — the same options the arena and the
    // garage lab use — so this gallery row shows the mech as it actually deploys rather than the
    // bare palette (which renders the enemy reactor-purple centre spot). HULL_FRAMES because the
    // walk-cycle row below shows every baked frame.
    buildMechTextures(this, liveKey, live, playerMechArt(0, { hullFrames: HULL_FRAMES }));
    this._group(`PLAYER BUILD — ${cfg.chassisId}`, [
      this._mechCell(`${live.name}\nwalking`, liveKey, live, { animate: true }),
    ]);

    this._group('HULL WALK CYCLE (#403 legs — frame by frame)',
      Array.from({ length: HULL_FRAMES }, (_, f) => this._mechCell(`hull frame ${f}`, liveKey, live, { frame: f })));

    // Damage progression. Each step is its OWN Mech + texture set (rather than mutating one),
    // so all four states are on screen at once for comparison instead of one at a time.
    const steps = [
      { label: 'intact', hits: [] },
      { label: 'right arm gone', hits: ['rightArm'] },
      { label: 'right torso gone\n(+ its arm, cascade)', hits: ['rightTorso'] },
      { label: 'both torsos gone\n(destroyed)', hits: ['leftTorso', 'rightTorso'] },
    ];
    const damaged = steps.map((step, i) => {
      const m = this._freshPlayerMech();
      for (const loc of step.hits) m.applyDamage(loc, 99999, 'ballistic');
      const key = `${TEX_PREFIX}player_dmg${i}`;
      buildMechTextures(this, key, m, playerMechArt(0, { hullFrames: HULL_FRAMES }));
      return { step, m, key };
    });
    // One shared scale across the row — otherwise each step re-zooms to fill its cell and the
    // mech never visibly LOSES anything, which is the entire point of the row.
    const dmgInk = this._inkUnion(damaged.flatMap((d) => this._mechKeys(d.key)));
    this._group('DAMAGE STATES (#437 stripped art)',
      damaged.map((d) => this._mechCell(d.step.label, d.key, d.m, { ink: dmgInk })));
  }

  // ── Playback ──────────────────────────────────────────────────────────────────────────

  _applyFrame() {
    for (const a of this._animSprites ?? []) {
      a.sprite.setTexture(`${a.prefix}${this.frame % a.count}`);
    }
  }

  update(time, delta) {
    if (this.playing) {
      this._animAcc += delta;
      if (this._animAcc >= FRAME_MS) {
        this._animAcc = 0;
        this.frame = (this.frame + 1) % 4;
        this._applyFrame();
      }
      this.list?.update(time, delta);
    }
  }
}
