import Phaser from 'phaser';
import { LOCATIONS, LOCATION_INFO } from '../data/anatomy.js';
import { TILE_ORDER, tileRow, drawSkillTile, updateSkillTile } from '../ui/skillTiles.js';
import { POWERUPS, durationMs } from '../data/powerups.js';
import { isPointInView, edgeArrowPosition } from '../data/wayfinding.js';
import { miniProjector, clampToBox } from '../data/minimap.js';
import { UI_HIGHLIGHT_COLOR } from './arena/shared.js';
import { CORRIDOR_HALF_WIDTH_PX } from '../data/worldgen.js';
import { rendererLabel, gpuRendererString, probeGl, perfLines } from '../data/perfReadout.js';
import {
  hudLayout, panelLabel, panelStatusText, panelsNeedRebuild, BUFF_RING_R,
} from '../data/hudLayout.js';
import { playerColor, showsPlayerColor } from '../data/players.js';
import { baseClearLabel } from '../data/bases.js';

// #80: a simple filled chevron/triangle, drawn pointing along `angle` with its tip at (x, y) —
// the edge-direction arrow's actual mark. A free function (no scene state needed) so it's easy
// to reuse if a second indicator ever wants the same shape.
const ARROW_SPREAD = 2.55;   // radians between the tip direction and each back corner (~146°)
function chevronPoints(x, y, angle, size) {
  const tipX = x + Math.cos(angle) * size, tipY = y + Math.sin(angle) * size;
  const b1x = x + Math.cos(angle + ARROW_SPREAD) * size * 0.62;
  const b1y = y + Math.sin(angle + ARROW_SPREAD) * size * 0.62;
  const b2x = x + Math.cos(angle - ARROW_SPREAD) * size * 0.62;
  const b2y = y + Math.sin(angle - ARROW_SPREAD) * size * 0.62;
  return { tipX, tipY, b1x, b1y, b2x, b2y };
}
function drawChevron(g, x, y, angle, size, color, alpha = 0.92) {
  const { tipX, tipY, b1x, b1y, b2x, b2y } = chevronPoints(x, y, angle, size);
  g.fillStyle(color, alpha);
  g.lineStyle(2, 0x000000, 0.35 * (alpha / 0.92));
  g.beginPath();
  g.moveTo(tipX, tipY);
  g.lineTo(b1x, b1y);
  g.lineTo(b2x, b2y);
  g.closePath();
  g.fillPath();
  g.strokePath();
}

// #143: a soft attention-drawing halo behind the chevron — two oversized, unstroked, low-alpha
// copies of the same silhouette (bigger + fainter, then smaller + brighter), the same "oversized
// silhouette drawn first and fainter" layering spirit as the #129 legibility-halo passes used
// elsewhere in the art, but here purely for visual emphasis rather than terrain contrast. Plain
// Graphics has no blur filter, so stacked oversized fills stand in for a blurred glow.
function drawChevronGlow(g, x, y, angle, size, color, alpha) {
  const layers = [{ mul: 2.4, a: 0.16 }, { mul: 1.7, a: 0.28 }];
  for (const { mul, a } of layers) {
    const { tipX, tipY, b1x, b1y, b2x, b2y } = chevronPoints(x, y, angle, size * mul);
    g.fillStyle(color, a * alpha);
    g.beginPath();
    g.moveTo(tipX, tipY);
    g.lineTo(b1x, b1y);
    g.lineTo(b2x, b2y);
    g.closePath();
    g.fillPath();
  }
}

// Screen-fixed overlay for the arena. The skills are shown with the SAME tile UI as the
// garage, in a row along the BOTTOM, with each weapon's live ammo (and each ability's
// cooldown) read right on its button. A compact per-part integrity column sits top-left.
// Runs as its own scene so it lays out in logical screen space without fighting the arena's
// follow camera; tiles are built once and updated in place each frame.
// #238: `cooldown` matches skillTiles.js's TILE_UI.cooldown so the subtitle text and the
// ammo-bar tint read as the same visual language for the "locked out, recharging" state.
const C = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', good: '#7bd17b', warn: '#efc14a', bad: '#e2533a',
  cooldown: '#5e7ce0',
};

// #246: per-location armor/hp split-bar geometry + colors. `ARMOR_BAR_COLOR` matches the mech-
// ART armor-shell overlay's steel-blue (src/art/mechPrims.js `ARMOR_SHELL`, 0x9fe0ff) exactly,
// so the HUD and the mech's own on-screen art read as the same "armor" visual language rather
// than two unrelated color choices. `SHIELD_BAR_COLOR` matches the Shield powerup's own color
// (data/powerups.js `POWERUPS.shield.color`) for the same reason.
const PART_BAR_X = 26;          // px offset of the bar from the row's left edge (past the short label)
const PART_BAR_W = 90;
const PART_BAR_H = 7;
const PART_ROW_H = 20;
const ARMOR_BAR_COLOR = 0x9fe0ff;
const SHIELD_BAR_COLOR = 0x5ec8e0;

// #116/#383: corner-minimap palette (numeric, for the Graphics layer). The corridor silhouette is
// a light steel that stands off the near-opaque dark backing; the player rides a brightened accent,
// the objective the shared amber wayfinding highlight (so it matches the edge arrow / world marker),
// and enemies a hot danger red. #383 raised the whole palette's contrast + the backing's opacity so
// the map still READS on a light biome (snow) instead of washing out — the backing is dark and near-
// solid, and it carries a bright outer frame so the box edge is crisp on light AND dark terrain.
const MM = {
  panelFill: 0x080b0f, panelStroke: 0x8fb4c8, panelInner: 0x1b242d,
  corridor: 0x5b6b79, corridorEdge: 0x515e6b,
  player: 0x8fe6f7, enemy: 0xff5a3c,
};

// #260: the lock-target off-screen arrow's color — matches targeting.js's `_drawLockReticle`
// reticle red (0xe2533a) exactly, so the arrow reads as "that same reticle, now off-screen."
const LOCK_RETICLE_COLOR = 0xe2533a;

export default class HudScene extends Phaser.Scene {
  constructor() {
    super('HudScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);

    // #449: the top-left 'ARENA' title is gone — it named the screen you are obviously looking at.
    // #296: the control-hints line and the debug d-pad/keys cheat sheet are dev-only playtest
    // aids, never a shipped HUD feature — gated behind `import.meta.env.DEV` (Vite's build-time
    // flag, stripped/dead-code-eliminated in `npm run build`; same pattern as the hex labels in
    // ArenaScene.js and the shop-unlock skip in GarageScene.js).
    if (import.meta.env.DEV) {
      this.add.text(16, 36, 'WASD/L-stick: move  ·  mouse/R-stick: aim  ·  LMB/RMB/Q/E + Space: skills  ·  pad: LT/RT/LB/RB+L3  ·  M: mute  ·  G/B: garage',
        { fontFamily: 'monospace', fontSize: '12px', color: C.dim });
      this.add.text(16, 54, 'debug d-pad:  ↑ add  ↓ reset  ← move  → fire   ·   keys:  N add · R reset · [ move · ] fire',
        { fontFamily: 'monospace', fontSize: '11px', color: C.dim });
    }

    // #66: objective line, reading the live Mission published to the registry each frame.
    // #449: it moved out of the old top-LEFT text block (which also carried an 'ARENA' title, an
    // OBJECTIVES/SCRAP run readout and — top-right — a separate enemy count) to sit directly UNDER
    // the corner minimap, and it is now the ONLY line up there: the remaining-structures /
    // remaining-garrison tally the enemy count used to carry folds into this same line, because
    // data/bases.js `baseClearLabel` already renders exactly that (see update()). Positioned by
    // `_applyChromeLayout` once the minimap box exists — the layout's shared slot, so co-op still
    // moves it to top-centre clear of player 2's column.
    this.objectiveText = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '13px', color: C.warn });
    // Big centred "MISSION COMPLETE" banner, hidden until the mission resolves.
    this.completeBanner = this.add.text(this.W / 2, this.H * 0.32, 'MISSION COMPLETE', {
      fontFamily: 'monospace', fontSize: '40px', color: C.good, fontStyle: 'bold',
    }).setOrigin(0.5).setVisible(false);
    // #64: run-over banner (WIN or DEAD), reusing the same big-centred-text styling/pattern as
    // the mission-complete banner for consistency. Text/color are set live from the registry's
    // `runOverBanner` (published by the run mixin) so this file stays free of win/lose branching.
    this.runOverBanner = this.add.text(this.W / 2, this.H * 0.46, '', {
      fontFamily: 'monospace', fontSize: '32px', color: C.bad, fontStyle: 'bold',
    }).setOrigin(0.5).setVisible(false);

    // #296: the control-method indicator (CONTROLLER / MOUSE + KB) and the AI move/fire debug
    // readout are dev-only overlays — created only under `import.meta.env.DEV` and updated behind
    // the same guard below, so they're absent from a production build entirely.
    if (import.meta.env.DEV) {
      this.modeText = this.add.text(this.W - 16, this.H - 24, '', { fontFamily: 'monospace', fontSize: '12px', color: C.warn }).setOrigin(1, 1);
      this.aiText = this.add.text(this.W - 16, this.H - 40, '', { fontFamily: 'monospace', fontSize: '11px', color: C.dim }).setOrigin(1, 1);
    }

    // #142: performance readout, bottom-left. Phaser's own `game.loop.actualFps` is already an EMA
    // (25% new / 75% old, see TimeStep.js) refreshed once a second — plenty stable frame-to-frame
    // on its own, so no extra rolling-average layer is needed on top of it.
    // #296 gated this dev-only; #334 put it BACK in production to diagnose a Windows/Edge frame-rate
    // problem, widened into FPS + renderer/GPU/resolution facts. #449 gates it dev-only AGAIN
    // (Jackson: "remove FPS data from production") — that diagnostic run is over and it is debug
    // chrome on a shipped HUD. It keeps every field; it just no longer ships. Same
    // `import.meta.env.DEV` treatment as the hints/AI overlays above (Vite strips it from the
    // production bundle), so the per-frame update below is gated too and `fpsText` simply doesn't
    // exist in production. See src/data/perfReadout.js for why each field is a suspect.
    if (import.meta.env.DEV) {
      this.fpsText = this.add.text(16, this.H - 16, '', { fontFamily: 'monospace', fontSize: '11px', color: C.dim }).setOrigin(0, 1);
      // Renderer type and GPU are fixed for the life of the page, so they're probed once here. The
      // renderer type is read LIVE off the game (Phaser falls back to Canvas2D silently, so the
      // config can't be trusted); the GPU probe degrades to 'unavailable' rather than throwing.
      this._perfRenderer = rendererLabel(this.game.renderer?.type, Phaser.WEBGL, Phaser.CANVAS);
      this._perfGpu = gpuRendererString(
        probeGl(this.game.renderer?.gl, () => document.createElement('canvas')),
      );
    }

    // #60: active timed-buff readout, top-right under the objective line. One radial "cooldown-pie"
    // per active buff — a ring tinted the buff colour that drains clockwise as it runs out, with
    // the label + remaining seconds beside it. A single Graphics layer draws all the rings; the
    // labels are pooled Text objects. Armor Patch is instant so it never appears here.
    this.buffGfx = this.add.graphics();
    this.buffTexts = [];
    this._buffCache = {};   // typeId → full duration (ms), captured the frame a buff first appears

    // #80: edge-direction arrow — an always-on indicator pointing at the current mission
    // objective whenever it's off-screen. Own Graphics layer, cleared/redrawn each frame.
    // Explicit depth (mirroring tabBar/MusicScene/mission-marker's use of setDepth) keeps it
    // drawn above the skill-tile toolbar regardless of scene add-order, since a playtest found
    // the arrow getting lost behind that bottom bar (#80 follow-up).
    this.wayGfx = this.add.graphics().setDepth(20);
    // #143: pulsing scale+alpha for the chevron (playtest: the static arrow wasn't eye-catching
    // enough). The Graphics layer itself is cleared/redrawn each frame, so the actual tween
    // target is a plain counter object read back in `_updateWayArrow` to scale/fade the shape
    // and its glow together.
    this.wayPulse = { t: 0 };
    this.tweens.add({ targets: this.wayPulse, t: 1, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    // #260: a second, independent off-screen indicator for the CURRENT lock target (mirrors the
    // objective arrow above via the shared `_drawEdgeIndicator` helper, just a different Graphics
    // layer/color/registry channel). Same depth as wayGfx so draw order between the two doesn't
    // matter — they're only ever both visible when pointing in different directions anyway (see
    // the inset-offset note on `lockWayMargins` below).
    this.lockWayGfx = this.add.graphics().setDepth(20);

    // #366: the PER-PLAYER panels — integrity column, shield row and skill-tile row,
    // one complete set per player on the field. Before this, every one of those read
    // `registry.get('playerMech')`, which is only ever player 1's mech, so co-op's player 2 had
    // no weapon, ammo or health readout at all. Jackson chose a FULL second HUD over a compact
    // health-and-ammo strip.
    //
    // Geometry comes from the pure `hudLayout` (data/hudLayout.js), which returns exactly today's
    // hardcoded numbers for a single player — so solo is untouched on every path — and mirrors a
    // second column/row onto the right for co-op. The panels are rebuilt whenever the player
    // COUNT changes, and the count is re-asked EVERY FRAME in `_syncPanels` rather than decided
    // here at construction: that is what makes a mid-sortie START join on gamepad 2 grow the
    // second HUD immediately (#348's ground-ring fix had exactly this bug, and the fix was the
    // same — ask the rule every frame).
    this.panels = [];
    this._panelCount = 0;
    this._syncPanels();

    // #80 follow-up: per-edge margins for the wayfinding arrow, so it clamps clear of the
    // reserved HUD chrome instead of the literal screen edge. Bottom excludes the skill-tile
    // toolbar (its top edge + a little breathing room); top excludes the hints/objective text
    // block (INTEGRITY starts at y=112, so keep clear of that).
    // #366: `_tileTop` is published by the panel build (the tile row's own top edge), and the
    // left/right insets come from the layout — a second, right-hand column has to be cleared too.
    const tileTop = this._tileTop;
    this.wayMargins = {
      top: 116, right: this._layout.margins.right,
      bottom: this.H - tileTop + 12, left: this._layout.margins.left,
    };
    // #260: the lock-target arrow uses the same margins, bumped out a further 16px on every edge —
    // if the objective and the live lock target ever sit in the same off-screen direction at once,
    // this keeps the two chevrons from landing exactly on top of each other (simplest fix: draw at
    // slightly different insets rather than detecting/resolving the overlap explicitly).
    this.lockWayMargins = {
      top: this.wayMargins.top + 16, right: this.wayMargins.right + 16,
      bottom: this.wayMargins.bottom + 16, left: this.wayMargins.left + 16,
    };

    // #116/#383: corner minimap — the deferred half of #80 (the edge-direction arrow was the other
    // half). A CIRCULAR follow-window map pinned to the TOP-RIGHT corner: a round dark backing +
    // frame with a circular clip mask. #383 turned it from a WHOLE-corridor letterbox into a WINDOW
    // that FOLLOWS the player — it shows 4× the area the camera frames, centred on the camera focus,
    // scrolling as the player moves (see `_updateMinimap` + data/minimap.js). The circular shape
    // (this follow-up) means the corridor and the marks are clipped to — and tested against — the
    // disc, not a rectangle. `miniBox` stays a square {x,y,w,h} (w === h): it's the bounding box of
    // the disc, whose centre is (x+w/2, y+h/2) and radius w/2. The HiDPI anchor is the top-right
    // corner (W is the logical width; the HUD camera's zoom=dpr scales the whole thing to physical),
    // so the disc stays glued to the corner at any resolution.
    const mmD = 132;                       // diameter (also the square bounding box's side)
    this._miniSize = { w: mmD, h: mmD };
    this.miniBox = { x: this.W - 14 - mmD, y: 14, w: mmD, h: mmD };
    // The top-right corner otherwise hosts the objective line + buff rings; push those down to sit
    // just below the map so they clear it (solo only — co-op moves both to top-centre, untouched).
    // #449 is exactly this slot: "put the current objective label below the top-right minimap."
    this._mapReserveBottom = this.miniBox.y + this.miniBox.h + 8;
    // Panel layer: the dark disc backing + frame, repainted only when the box moves (a panel
    // rebuild). Dynamic layer: the corridor silhouette AND the live markers, cleared/redrawn each
    // frame — a scrolling window means the corridor can no longer be a one-time static paint. Both
    // on the same depth tier as the wayfinding arrow so they sit above the skill toolbar. #383 chose
    // the per-frame redraw over a world-space translate/clip layer: the corridor is subsampled to
    // only ~two-dozen segments, so repainting them is as cheap as the enemy/player dots already
    // redrawn here every frame, and it avoids maintaining a separately-scaled offscreen layer.
    this.miniStaticGfx = this.add.graphics().setDepth(19);
    this.miniGfx = this.add.graphics().setDepth(21);
    // Geometry mask (a filled CIRCLE) so the scrolling corridor/markers are clipped to the disc
    // interior instead of spilling past its frame. Painted in logical coords — the HUD camera's
    // zoom=dpr scales it to physical, same pattern as ui/weaponCardList.js's scroll clip.
    this.miniMaskG = this.make.graphics();
    this.miniGfx.setMask(this.miniMaskG.createGeometryMask());
    this._miniBoxRef = null;   // identity of the box the panel + mask were last painted for

    // The map now occupies the top-right corner, so tuck the objective line just under the disc in
    // solo (co-op's centred origin leaves it at the top).
    this.objectiveText?.setPosition(this._layout.shared.objectiveX, this._objectiveTextY())
      .setOrigin(this._layout.shared.objectiveOriginX, 0);
  }

  // Is the top-right shared chrome (objective line + buff rings) right-aligned? True in solo, false
  // in co-op (where the layout moves both to top-centre). When right-aligned they share the corner
  // with the map, so they drop below it; centred, they keep their original top positions.
  _rightStack() { return this._layout?.shared?.objectiveOriginX === 1; }
  _objectiveTextY() { return this._rightStack() && this._mapReserveBottom ? this._mapReserveBottom : 16; }
  _buffStartY() { return this._rightStack() && this._mapReserveBottom ? this._mapReserveBottom + 24 : 44; }

  // ── #366: per-player panels ──────────────────────────────────────────────────────────────
  //
  // A PANEL is one player's whole readout: the integrity column (per-location armor/hp bars +
  // numbers), the shield row, the four skill tiles with their live ammo, and the downed/respawn
  // line. Everything here used to be one hardcoded set of objects fed from
  // `registry.get('playerMech')`.

  // The live per-player snapshots the arena publishes each frame (data/hudLayout.js
  // `hudPlayerSnapshot`). Falls back to the old singleton channels so any path that drives the
  // HUD without the arena's `hudPlayers` channel (older saves mid-transition, the smoke test's
  // direct scene starts) still renders exactly one working panel rather than nothing.
  _playerSnapshots() {
    const published = this.registry.get('hudPlayers');
    if (Array.isArray(published) && published.length) return published;
    const mech = this.registry.get('playerMech');
    if (!mech) return [];
    return [{
      id: 0,
      color: playerColor(0),
      mech,
      dead: false,
      respawn: null,
      // #368: the pre-`hudPlayers` singleton channel is still the fallback source for the
      // off-screen lock chevron, so this path draws exactly the one chevron it always did.
      lock: this.registry.get('lockWorld') ?? null,
    }];
  }

  // Asked EVERY frame (see the create()-time note): if the number of players changed, rebuild.
  // Panel geometry is a function of the count alone, so a steady frame rebuilds nothing and a
  // mid-sortie join is picked up on the frame it happens.
  _syncPanels() {
    const snapshots = this._playerSnapshots();
    if (panelsNeedRebuild(this._panelCount, snapshots.length)) {
      this._buildPanels(Math.max(1, snapshots.length), snapshots);
    }
    return snapshots;
  }

  _buildPanels(count, snapshots) {
    for (const panel of this.panels ?? []) this._destroyPanel(panel);
    this.panels = [];
    this._layout = hudLayout(count, this.W);
    for (const spec of this._layout.panels) {
      this.panels.push(this._makePanel(spec, count, snapshots[spec.index]));
    }
    this._panelCount = this._layout.panels.length;
    this._tileTop = this.panels[0].tileTop;
    this._applyChromeLayout();
  }

  // Reposition the SHARED chrome that has to move out of a second panel's way. Guarded on each
  // object existing because the first build runs mid-create(), before the minimap exists.
  _applyChromeLayout() {
    const { shared, margins } = this._layout;
    // Objective line rides below the map in solo (right-aligned corner), top-centre in co-op.
    this.objectiveText?.setPosition(shared.objectiveX, this._objectiveTextY())
      .setOrigin(shared.objectiveOriginX, 0);
    if (!this.wayMargins) return;   // first build: create() sets these itself, just below
    this.wayMargins = {
      top: 116, right: margins.right, bottom: this.H - this._tileTop + 12, left: margins.left,
    };
    this.lockWayMargins = {
      top: this.wayMargins.top + 16, right: this.wayMargins.right + 16,
      bottom: this.wayMargins.bottom + 16, left: this.wayMargins.left + 16,
    };
    // The circular map is pinned to the top-right corner (a function of W alone, which is constant),
    // so a co-op panel rebuild no longer moves it — nothing to recompute here.
  }

  // Build one player's set of objects at the layout's coordinates. Creation ORDER mirrors the
  // pre-#366 code exactly (header, bars layer, per-row labels + numbers, shield, tiles) so
  // a solo HUD is the same objects in the same draw order at the same positions as before.
  _makePanel(spec, count, snapshot) {
    const x = spec.columnX;
    const color = snapshot?.color ?? playerColor(spec.index);
    const colStr = '#' + color.toString(16).padStart(6, '0');
    // #348's rule, reused: the identifying COLOUR only means something once there is a second
    // player to be told apart from, so solo's header stays the plain dim 'INTEGRITY'.
    const identify = showsPlayerColor(count);
    const panel = {
      index: spec.index, spec, columnX: x, color,
      partTexts: {}, partRowY: {}, skillRefs: {}, extras: [],
    };

    panel.header = this.add.text(x, 112, panelLabel(spec.index, count), {
      fontFamily: 'monospace', fontSize: '12px', color: identify ? colStr : C.dim,
    });
    panel.partBarsGfx = this.add.graphics();
    let y = 130;
    for (const loc of LOCATIONS) {
      panel.partRowY[loc] = y;
      panel.extras.push(this.add.text(x, y, LOCATION_INFO[loc].short.padEnd(2), {
        fontFamily: 'monospace', fontSize: '11px', color: C.dim,
      }).setOrigin(0, 0.15));
      panel.partTexts[loc] = this.add.text(x + PART_BAR_X + PART_BAR_W + 8, y, '', {
        fontFamily: 'monospace', fontSize: '11px', color: C.text,
      }).setOrigin(0, 0.15);
      y += PART_ROW_H;
    }

    panel.shieldRowY = y + 4;
    panel.shieldLabel = this.add.text(x, panel.shieldRowY, 'SHIELD', {
      fontFamily: 'monospace', fontSize: '11px', color: C.accent,
    }).setVisible(false);
    panel.shieldBarTrack = this.add.rectangle(
      x + PART_BAR_X, panel.shieldRowY + 6, PART_BAR_W, PART_BAR_H, 0x0e1218,
    ).setOrigin(0, 0.5).setStrokeStyle(1, 0x2a333f).setVisible(false);
    panel.shieldBarFill = this.add.rectangle(
      x + PART_BAR_X, panel.shieldRowY + 6, PART_BAR_W, PART_BAR_H, SHIELD_BAR_COLOR,
    ).setOrigin(0, 0.5).setVisible(false);
    panel.shieldText = this.add.text(x + PART_BAR_X + PART_BAR_W + 8, panel.shieldRowY, '', {
      fontFamily: 'monospace', fontSize: '11px', color: C.text,
    }).setOrigin(0, 0.15).setVisible(false);

    // A downed player must read as DOWN — WAITING/RESPAWN, not as a stale or zeroed column. The
    // bars themselves keep showing the wreck truthfully; this line says why nothing is happening
    // and how long it has left (data/hudLayout.js `panelStatusText`, off data/respawn.js's clock).
    panel.statusText = this.add.text(x, panel.shieldRowY + 20, '', {
      fontFamily: 'monospace', fontSize: '11px', color: C.bad,
    }).setVisible(false);

    // Skill tiles for THIS player's own mech, in this panel's half of the bottom edge.
    panel.skillBar = this.add.container(0, 0);
    const tiles = tileRow(spec.tilesX, spec.tilesW, { bottom: this.H - 10, maxSize: 92 });
    for (const r of tiles) {
      const id = snapshot?.mech?.mounts?.[r.loc]?.[0] ?? null;
      panel.skillRefs[r.loc] = drawSkillTile(this, panel.skillBar, r, { loc: r.loc, itemId: id });
    }
    panel.tileTop = tiles.length ? tiles[0].y : this.H - 10;
    return panel;
  }

  _destroyPanel(panel) {
    const objs = [
      panel.header, panel.partBarsGfx, panel.shieldLabel, panel.shieldBarTrack,
      panel.shieldBarFill, panel.shieldText, panel.statusText, panel.skillBar,
      ...Object.values(panel.partTexts), ...panel.extras,
    ];
    for (const o of objs) o?.destroy();
  }

  // Which control glyphs a panel's tiles should show. Player 1 owns the keyboard+mouse
  // and so follows the live `inputMode`; every later player is gamepad-only by construction
  // (scenes/arena/coop.js builds their Controls with `keyboard: false`), so their binds are
  // always the pad's — showing them Q/E/LMB would be showing them keys they cannot press.
  _panelMode(panel) {
    if (panel.index > 0) return 'pad';
    return this.registry.get('inputMode') === 'pad' ? 'pad' : 'kbm';
  }

  // One panel's per-frame refresh. `snapshot` missing = that player left the field (the panel is
  // about to be rebuilt away next frame anyway) — hide rather than draw stale numbers.
  _updatePanel(panel, snapshot) {
    const mech = snapshot?.mech;
    const present = !!mech;
    panel.skillBar.setVisible(present);
    panel.statusText.setVisible(false);
    if (!present) {
      panel.partBarsGfx.clear();
      return;
    }

    // Skill tiles: live ammo on each weapon (#188: the old per-slot ability cooldown/shield
    // display is gone along with the ability slot — the always-available Dash has no readout at
    // all since #450, since it isn't tied to a body location any more).
    const mode = this._panelMode(panel);
    const weapons = mech.weapons();
    for (const loc of TILE_ORDER) {
      const id = mech.mounts[loc][0] ?? null;
      const opts = { loc, itemId: id, mode };
      const w = weapons.find((x) => x.location === loc);
      if (w) {
        opts.iconAlpha = w.online ? 1 : 0.3;
        if (!w.online) { opts.subtitle = 'OFFLINE'; opts.subtitleColor = C.bad; }
        else if (w.ammo == null) { opts.subtitle = '∞'; opts.subtitleColor = C.dim; }
        // #402: a slot mid-RELOAD gets its own readout (distinct from a plain "0/max" magazine
        // that's simply low) so the player can see the weapon is locked out and topping back up
        // to FULL. Countdown to the nearest tenth of a second; the tile's cooldown tint reuses
        // the same "locked out, recharging" visual language it did for #238. `w.reloadMax` is the
        // full reload period, so the fill fraction reads as reload progress.
        else if (w.reloading) {
          opts.subtitle = `RELOAD ${w.reload.toFixed(1)}s`;
          opts.subtitleColor = C.cooldown;
          opts.onCooldown = true;
          opts.cooldownFrac = w.reload / w.reloadMax;
        } else {
          opts.subtitle = `${Math.floor(w.ammo)}/${w.weapon.ammoMax}`;
          opts.subtitleColor = w.ready ? C.good : C.warn;
          opts.ammoFrac = w.ammo / w.weapon.ammoMax;
        }
      }
      updateSkillTile(panel.skillRefs[loc], opts);
    }

    this._updatePartBars(panel, mech);
    this._updateShieldBar(panel, mech);

    // Downed: dim this player's own controls (they cannot use them) and say what they are
    // waiting on. Everything else in the panel keeps reading true.
    const status = panelStatusText(snapshot);
    panel.skillBar.setAlpha(snapshot.dead ? 0.3 : 1);
    if (status) panel.statusText.setText(status).setVisible(true);
  }

  // Dev overlay label for the active input scheme. #346 added a third one, 'touch';
  // anything else still reads as mouse+keyboard.
  _inputModeLabel() {
    const m = this.registry.get('inputMode');
    return m === 'pad' ? 'CONTROLLER' : m === 'touch' ? 'TOUCH' : 'MOUSE + KB';
  }

  update() {
    // #366: re-ask the player list EVERY frame — this is what picks up a mid-sortie START join
    // (or a garage co-op deploy) and grows the second panel without a redeploy.
    const snapshots = this._syncPanels();
    const mech = snapshots[0]?.mech;
    if (!mech) return;

    // #296: dev-only overlays — the objects only exist under DEV (see create()), so their
    // per-frame updates are gated behind the same flag (stripped from the production build).
    if (import.meta.env.DEV) {
      this.modeText.setText(this._inputModeLabel());
      const aiMove = this.registry.get('aiMove') !== false;
      const aiFire = this.registry.get('aiFire') !== false;
      this.aiText.setText((aiMove && aiFire) ? '' : `AI  move:${aiMove ? 'on' : 'OFF'}  fire:${aiFire ? 'on' : 'OFF'}`);
    }

    // #366: one pass per PANEL — its own tiles/ammo, its own integrity bars, its own shield row,
    // its own downed-and-waiting line. Solo runs this exactly once, over the
    // same objects at the same coordinates the singleton HUD used.
    for (const panel of this.panels) this._updatePanel(panel, snapshots[panel.index]);

    // #449: the standalone `ENEMIES alive/total` readout and the `OBJECTIVES n  SCRAP n` run line
    // are both gone. The enemy tally was not deleted, it MOVED: `baseClearLabel` below already
    // renders the live requirement — remaining structures first, then the remaining garrison —
    // so the one line under the minimap says everything those two used to.

    // #66: objective line + win banner, driven by the Mission the arena publishes each frame.
    const mission = this.registry.get('mission');
    if (mission) {
      const complete = mission.status === 'complete';
      // #356: the objective line names the ONE thing the player has to do right now — destroy
      // the objective/docks, then eliminate what's left — instead of the bare mission type. The
      // step and its wording both come from the pure model (data/bases.js `baseClearState`/
      // `baseClearLabel`), which is what guarantees no enemy count is ever shown while a dock
      // still stands: docks reinforce forever (#326), so a live count at that point would climb
      // rather than fall. #449 folded the old standalone enemy count into this same line, so it
      // is now the ONLY place a count appears — rendering `baseClearLabel` verbatim rather than
      // composing our own string from `baseClear`'s raw fields is what keeps that guarantee
      // enforced in ONE place.
      const clear = this.registry.get('baseClear');
      const line = clear ? baseClearLabel(clear) : mission.objective;
      this.objectiveText
        .setText(`${line}${complete ? '  [COMPLETE]' : ''}`)
        .setColor(complete ? C.good : C.warn);
      // #64: the mission-complete banner only makes sense mid-run (a stage cleared, more to
      // come) — once the run itself is over (run-over banner below takes precedence), suppress
      // it so the two banners don't stack.
      this.completeBanner.setVisible(complete && !this.registry.get('runOverBanner'));
    }

    // #64: run-over banner (WIN or DEAD) — the run mixin publishes `runOverBanner` (label,
    // color, currency) for the few seconds it holds before returning to the garage; null once
    // that beat elapses (or when there's no run in progress).
    const over = this.registry.get('runOverBanner');
    if (over) {
      this.runOverBanner.setText(`${over.label}\n+${over.currency} SCRAP BANKED`).setColor(over.color).setVisible(true);
    } else {
      this.runOverBanner.setVisible(false);
    }

    this._updateBuffHud();
    // #383: the main-game-window objective edge arrow (#80) is now REDUNDANT — the follow-window
    // minimap carries its own on-map objective edge marker (see `_updateMinimap`), so the
    // navigational cue lives there instead of overlaying the play area. Jackson's call: "maybe
    // remove the objective edge marker on the main game window?" The code stays retrievable —
    // `_updateWayArrow`/`_drawEdgeIndicator` and `this.wayGfx` are untouched; we simply stop
    // calling it, so `wayGfx` never paints. The off-screen LOCK-target chevron (#260,
    // `_updateLockArrow`) is a DIFFERENT indicator and stays.
    this._updateLockArrow(snapshots);
    this._updateMinimap();

    // #142: reads Phaser's own smoothed fps tracker directly (see the create()-time note above).
    // #449: dev-only again — the object itself only exists under DEV, so its per-frame update sits
    // behind the same flag and the whole readout is stripped from the production bundle.
    // Resolution/DPR are re-read every frame (a window move between displays changes DPR live, and
    // main.js resizes the backing store to match); renderer/GPU were probed once in create().
    if (import.meta.env.DEV) {
      this.fpsText.setText(perfLines({
        fps: this.game.loop.actualFps,
        renderer: this._perfRenderer,
        gpu: this._perfGpu,
        width: this.scale.width,
        height: this.scale.height,
        dpr: this.registry.get('dpr') || window.devicePixelRatio || 1,
      }));
    }
  }

  // #80: point at the current objective whenever it's off-camera. Reads the SAME live source
  // the world-space objective marker (mission.js `_makeObjectiveMarker`) is built from — both
  // trace back to `this.objectiveHex` via `hexToPixel`, republished each frame as
  // `objectiveWorld` — so the two indicators can never disagree, and a stage advance (#81
  // reassigns `objectiveHex` to a fresh outpost on the regenerated map) is picked up for free.
  // Hides once the objective's own world-space marker is genuinely on-screen — no need to
  // double up on an indicator at that point.
  _updateWayArrow() {
    const objectiveWorld = this.registry.get('objectiveWorld');
    this._drawEdgeIndicator(this.wayGfx, objectiveWorld, this.wayMargins, UI_HIGHLIGHT_COLOR);
  }

  // #260: the same off-screen edge-direction indicator as the objective arrow, but for the
  // CURRENT target (`this.convergeTarget` in targeting.js, republished each frame by
  // ArenaScene as the `lockWorld` registry channel via `_lockAimPoint()` — the same query the
  // reticle/homing code reads, so this can never disagree with what's actually targeted). Hidden
  // entirely when there's no live target, and suppressed once the target is genuinely
  // on-screen (the live reticle itself is visible there — no need to double up), exactly
  // mirroring how the objective arrow behaves.
  // #368: ONE chevron PER PLAYER, riding the same `hudPlayers` snapshot array the panels do
  // (each snapshot carries its own `lock` point) rather than a second parallel channel — so a
  // mid-sortie START join gets its chevron on the frame it lands, for free. In co-op each
  // chevron takes its owner's identifying colour, gated on `showsPlayerColor` — the same rule
  // the ground rings, reticles and panel headers use, so identification turns on everywhere at
  // once. SOLO IS UNCHANGED: one snapshot, `showsPlayerColor(1) === false`, so it is exactly
  // today's single red chevron at today's position.
  _updateLockArrow(snapshots = this._playerSnapshots()) {
    const identify = showsPlayerColor(snapshots.length);
    this.lockWayGfx.clear();
    for (const s of snapshots) {
      if (s.dead) continue;   // a downed player has no live pick to point at
      const color = identify ? (s.color ?? LOCK_RETICLE_COLOR) : LOCK_RETICLE_COLOR;
      this._paintEdgeIndicator(this.lockWayGfx, s.lock, this.lockWayMargins, color);
    }
  }

  // #260: shared geometry + pulse/glow drawing for an off-screen edge-direction chevron, factored
  // out of the original #80 objective-arrow code so the lock-target arrow can reuse it exactly
  // rather than duplicating the shape/animation logic — only the Graphics layer, target world
  // point, margin set, and color differ per caller.
  _drawEdgeIndicator(g, worldPoint, margin, color) {
    g.clear();
    this._paintEdgeIndicator(g, worldPoint, margin, color);
  }

  // The same thing WITHOUT the clear, so several chevrons can share one Graphics layer (#368's
  // per-player lock arrows clear once, then paint one per player).
  _paintEdgeIndicator(g, worldPoint, margin, color) {
    const view = this.registry.get('cameraView');
    if (!worldPoint || !view) return;
    if (isPointInView(view, worldPoint)) return;
    const { x, y, angle } = edgeArrowPosition(view, this.W, this.H, worldPoint, margin);
    // #143: ride the pulse counter for both a scale bump (1.0 → 1.35x) and an alpha swell
    // (0.55 → 1.0), plus a glow halo behind the chevron whose own strength rides the same pulse —
    // combining both treatments read best in playtest vs. either alone.
    const pulse = this.wayPulse.t;
    const size = 16 * (1 + 0.35 * pulse);
    const alpha = 0.55 + 0.45 * pulse;
    drawChevronGlow(g, x, y, angle, size, color, alpha);
    drawChevron(g, x, y, angle, size, color, 0.92 * (0.7 + 0.3 * pulse));
  }

  // #116/#383: paint the panel backing + border, and (re)cut the clip mask, for the current box.
  // The panel no longer carries the corridor silhouette (that scrolls now, so it's redrawn per
  // frame in `_updateMinimap`); this is just the static chrome, repainted only when the box moves
  // (a co-op panel rebuild shifts it — see `_applyChromeLayout`), keyed off `_miniBoxRef`.
  _paintMiniPanel() {
    const box = this.miniBox;
    const g = this.miniStaticGfx;
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2, r = box.w / 2;
    g.clear();
    // Near-solid dark DISC backing so the map holds its own contrast over a BRIGHT biome (snow)
    // instead of letting the terrain bleed through and wash the corridor/marks out. A faint inner
    // hairline just inside the bright frame separates the fill from the frame so it reads as a device.
    g.fillStyle(MM.panelFill, 0.92);
    g.fillCircle(cx, cy, r);
    g.lineStyle(1, MM.panelInner, 0.8);
    g.strokeCircle(cx, cy, r - 1.5);
    // Bright outer frame — the high-contrast ring that keeps the map legible on light AND dark ground.
    g.lineStyle(2, MM.panelStroke, 0.95);
    g.strokeCircle(cx, cy, r);
    // The mask (a filled circle) clips the scrolling content to the disc interior. Painted in logical
    // coords — the HUD camera's zoom=dpr scales it to physical (same pattern as ui/weaponCardList.js).
    this.miniMaskG.clear().fillStyle(0xffffff).fillCircle(cx, cy, r);
    this._miniBoxRef = box;
  }

  // #116/#383: the follow-window minimap, redrawn each frame. It's a WINDOW that tracks the camera
  // focus and shows 4× the area the camera frames (data/minimap.js `miniProjector`), not the old
  // whole-corridor letterbox. Everything — the corridor silhouette, enemies, objective, player
  // chevron(s) — is projected through the same per-frame window and clipped to the box by the
  // geometry mask. Reads the SAME `objectiveWorld`/`cameraView` channels the rest of the HUD uses.
  _updateMinimap() {
    const spine = this.registry.get('spineWorld');
    const view = this.registry.get('cameraView');
    const g = this.miniGfx;
    g.clear();
    if (!spine || !spine.length || !view) { this.miniStaticGfx.clear(); this._miniBoxRef = null; return; }

    const box = this.miniBox;
    if (this._miniBoxRef !== box) this._paintMiniPanel();
    const { toMini, inBox, scale } = miniProjector(view, box);

    // Corridor silhouette: the union of discs along the spine — exactly how the playable set is
    // defined (worldgen.js `corridorHexSet`), so the sketch is faithful and gap-free. #383 draws it
    // as a single CONTINUOUS thick stroke down the spine (a round-jointed polyline = the Minkowski
    // sum of the path with a disc, i.e. the same union of discs) instead of a STRING of separate
    // filled circles. The old per-disc fill left a scalloped edge whose bumps crawled and aliased as
    // the follow-window scrolled ("mushy/warbly"); one stroke gives a clean, constant-width corridor
    // with no crawling scallops. A disc at each vertex rounds the joints so bends stay smooth, and a
    // finer subsample keeps the centreline curve crisp. Off-box spans are culled (with the entry/exit
    // point kept so the corridor still reaches the box edge under the mask) — with a follow-window
    // most of the 24,000px corridor is off-screen, so only a short visible run is ever stroked.
    const r = CORRIDOR_HALF_WIDTH_PX * scale;
    const step = 4;
    g.fillStyle(MM.corridor, 1);
    g.lineStyle(2 * r, MM.corridor, 1);
    const near = (m) => m.x + r >= box.x && m.x - r <= box.x + box.w && m.y + r >= box.y && m.y - r <= box.y + box.h;
    let run = [], prev = null;
    const flush = () => {
      if (run.length >= 2) {
        g.beginPath();
        g.moveTo(run[0].x, run[0].y);
        for (let k = 1; k < run.length; k++) g.lineTo(run[k].x, run[k].y);
        g.strokePath();
      }
      for (const p of run) g.fillCircle(p.x, p.y, r);   // round the joints (and cover a lone point)
      run = [];
    };
    const consider = (wx, wy) => {
      const m = toMini(wx, wy);
      if (near(m)) {
        if (run.length === 0 && prev) run.push(prev);   // seed with the just-outside entry point
        run.push(m);
      } else if (run.length) {
        run.push(m); flush();                            // keep the exit point, then break the run
      }
      prev = m;
    };
    for (let i = 0; i < spine.length; i += step) consider(spine[i].x, spine[i].y);
    consider(spine[spine.length - 1].x, spine[spine.length - 1].y);   // never drop the far end
    flush();

    // Enemies: small danger dots. Cap to the nearest N to the player so a swarm stays readable.
    const player = this.registry.get('playerWorld');
    const enemies = this.registry.get('enemyPositions') || [];
    let shown = enemies;
    const CAP = 50;
    if (enemies.length > CAP && player) {
      shown = [...enemies]
        .sort((a, b) => ((a.x - player.x) ** 2 + (a.y - player.y) ** 2) - ((b.x - player.x) ** 2 + (b.y - player.y) ** 2))
        .slice(0, CAP);
    }
    g.fillStyle(MM.enemy, 1);
    for (const e of shown) {
      const m = toMini(e.x, e.y);
      if (inBox(m)) g.fillCircle(m.x, m.y, 2.7);
    }

    // Objective: amber diamond + ring when it's inside the window; otherwise an amber edge marker
    // pinned to the map border pointing toward it (#383 — this replaces the old main-game-window
    // objective arrow, keeping the navigational cue the whole-world view used to give).
    const obj = this.registry.get('objectiveWorld');
    if (obj) {
      const m = toMini(obj.x, obj.y);
      if (inBox(m)) {
        g.fillStyle(UI_HIGHLIGHT_COLOR, 1);
        g.beginPath();
        g.moveTo(m.x, m.y - 4.5); g.lineTo(m.x + 4.5, m.y);
        g.lineTo(m.x, m.y + 4.5); g.lineTo(m.x - 4.5, m.y);
        g.closePath(); g.fillPath();
        g.lineStyle(1.2, UI_HIGHLIGHT_COLOR, 0.8);
        g.strokeCircle(m.x, m.y, 7);
      } else {
        // Off-window: a chevron riding the inset box edge, pulsing with the shared wayfinding
        // counter so it reads as the same "objective this way" language as the world-space marker.
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        const { x, y, angle } = clampToBox(box, cx, cy, m, 7);
        const pulse = this.wayPulse.t;
        drawChevron(g, x, y, angle, 6.5 * (1 + 0.25 * pulse), UI_HIGHLIGHT_COLOR, 0.75 + 0.25 * pulse);
      }
    }

    // Players: a facing chevron each, oriented to the turret/aim heading (Refs #116: playtest
    // feedback was that it should point where the mech is aiming, not where it's driving —
    // `angle` is ArenaScene's `turretAngle`, not the hull heading).
    // #366: one marker PER player, in that player's identifying colour once there are two of
    // them. In co-op the window is centred on the camera focus (the centroid the camera frames),
    // and the leash keeps both players within it, so both chevrons stay on the map. Solo keeps the
    // single chevron in the shared accent, now sitting near the map centre since the window
    // follows the player.
    const worlds = this.registry.get('playerWorlds') ?? (player ? [player] : []);
    const identify = showsPlayerColor(worlds.length);
    for (const w of worlds) {
      if (w.dead) continue;
      const m = toMini(w.x, w.y);
      if (inBox(m)) drawChevron(g, m.x, m.y, w.angle, 7.5, identify ? w.color : MM.player, 1);
    }
  }

  // #246: per-location armor/hp split bar — TWO adjacent segments in one bar frame, armor
  // first (left) then hp (right), each segment's own WIDTH proportional to that layer's share
  // of the location's combined max (maxArmor + maxHp), each segment's FILL proportional to its
  // own current/max. So a location with a bigger armor rating than hp rating (or vice versa)
  // reads as a wider armor (or hp) segment, and within each segment the fill drains as that
  // specific layer takes damage — armor drains first in play (it absorbs before hp), which
  // reads here as the LEFT segment emptying before the right one starts to. This is the
  // supporting HUD readout; the PRIMARY at-a-glance armor read is the mech-art armor-shell
  // overlay on the mech itself (see mechArt.js).
  _updatePartBars(panel, mech) {
    const g = panel.partBarsGfx;
    g.clear();
    for (const loc of LOCATIONS) {
      const p = mech.parts[loc];
      const y = panel.partRowY[loc];
      const bx = panel.columnX + PART_BAR_X;
      const totalMax = p.maxArmor + p.maxHp;
      const armorShare = totalMax > 0 ? p.maxArmor / totalMax : 0;
      const armorW = PART_BAR_W * armorShare;
      const hpW = PART_BAR_W - armorW;

      // Track (dim full-width backing) so an empty segment still reads as "there" but spent.
      g.fillStyle(0x0e1218, 1);
      g.fillRect(bx, y - PART_BAR_H / 2, PART_BAR_W, PART_BAR_H);

      // Armor segment (left): fills leftover-to-right within its own share of the bar width.
      if (armorW > 0) {
        const armorFrac = p.maxArmor > 0 ? p.armor / p.maxArmor : 0;
        g.fillStyle(ARMOR_BAR_COLOR, 1);
        g.fillRect(bx, y - PART_BAR_H / 2, Math.max(0, armorW * armorFrac), PART_BAR_H);
      }
      // HP segment (right): same idea, its own share/fraction, colored by remaining health.
      if (hpW > 0) {
        const hpFrac = p.maxHp > 0 ? p.hp / p.maxHp : 0;
        const hpCol = mech.isPartDestroyed(loc) ? 0xe2533a : hpFrac > 0.5 ? 0x7bd17b : 0xefc14a;
        g.fillStyle(hpCol, 1);
        g.fillRect(bx + armorW, y - PART_BAR_H / 2, Math.max(0, hpW * hpFrac), PART_BAR_H);
      }
      // Thin divider between the two segments so they read as distinct, not one blended bar.
      if (armorW > 0 && hpW > 0) {
        g.fillStyle(0x0e1218, 1);
        g.fillRect(bx + armorW - 0.5, y - PART_BAR_H / 2, 1, PART_BAR_H);
      }
      g.lineStyle(1, 0x2a333f, 0.9);
      g.strokeRect(bx, y - PART_BAR_H / 2, PART_BAR_W, PART_BAR_H);

      const destroyed = mech.isPartDestroyed(loc);
      const col = destroyed ? C.bad : C.text;
      panel.partTexts[loc]
        .setText(destroyed ? 'DESTROYED' : `${Math.ceil(p.armor)}+${Math.ceil(p.hp)}/${p.maxArmor}+${p.maxHp}`)
        .setColor(col);
    }
  }

  // #246: full-mech shield readout — a single bar (same visual language as the per-location
  // bars above), hidden ENTIRELY (bar + label) when the mech has no native shield at all
  // (`hasShield()` false — some enemy kinds and loadouts genuinely have none).
  // #381: the bar physically GROWS with a live TEMPORARY pool. The full base shield is `PART_BAR_W`
  // wide; a temp pool on top widens BOTH the track and the fill in proportion to the total capacity
  // (base 100 + 150 temp ⇒ a 2.5x-wide bar), and the readout number follows the track's right edge.
  // As the temp pool is spent the bar shrinks back to base — the "truly grows, then you lose it"
  // read. With no temp pool the maths reduces exactly to the old fixed-width bar.
  _updateShieldBar(panel, mech) {
    const has = mech.hasShield?.() ?? false;
    panel.shieldLabel.setVisible(has);
    panel.shieldBarTrack.setVisible(has);
    panel.shieldBarFill.setVisible(has);
    panel.shieldText.setVisible(has);
    if (!has) return;
    const baseMax = mech.shield.max || 0;
    const totalHp = mech.shieldTotalHp?.() ?? mech.shield.hp;
    const totalMax = mech.shieldTotalMax?.() ?? mech.shield.max;
    const growth = baseMax > 0 ? totalMax / baseMax : 1;     // >= 1 while a temp pool is live
    const trackW = PART_BAR_W * growth;
    const fillW = baseMax > 0 ? Phaser.Math.Clamp(PART_BAR_W * (totalHp / baseMax), 1, trackW) : 1;
    panel.shieldBarTrack.setSize(trackW, PART_BAR_H);
    panel.shieldBarFill.setSize(fillW, PART_BAR_H);
    panel.shieldText.setX(panel.shieldBarTrack.x + trackW + 8);
    panel.shieldText.setText(`${Math.ceil(totalHp)}/${Math.ceil(totalMax)}`);
  }

  // #60: draw one radial "draining" ring per active timed buff. Each is a rounded circular
  // timer, tinted the buff colour, whose arc empties clockwise from full to zero over the buff's
  // duration — a cooldown-pie. The label + remaining seconds sit to the left so several buffs
  // stack readably down the top-right. Text objects are pooled; the Graphics layer is redrawn
  // each frame. #409: instant buffs (Armor Patch AND Shield) never enter `activePowerups`, so they
  // never show a ring — only the timed buffs (Overdrive/Overclock/Barrage/Infinite Fire) do.
  _updateBuffHud() {
    const active = this.registry.get('activePowerups') || {};
    const ids = Object.keys(active).filter((id) => active[id] > 0);

    // Peak-remaining denominator: on pickup/refresh a buff's remaining jumps up, so track the
    // max seen for each live type as its "full" and derive the drain fraction against it. Falls
    // back to the catalog duration. Prune types that are no longer active.
    for (const id of Object.keys(this._buffCache)) if (!ids.includes(id)) delete this._buffCache[id];
    for (const id of ids) {
      const full = durationMs(id) || active[id];
      this._buffCache[id] = Math.max(this._buffCache[id] || 0, active[id], full);
    }

    const g = this.buffGfx;
    g.clear();
    const R = BUFF_RING_R;        // ring radius
    // #366: the ring stack's anchor comes from the layout — top-right in solo (unchanged), moved
    // to top-centre in co-op, where the right edge belongs to player 2's integrity column.
    const cx = this._layout.shared.buffCx;
    const rowH = 2 * R + 10;
    // In solo the rings share the top-right corner with the map, so they start below it; co-op
    // moves them to top-centre and keeps the original top start.
    let y = this._buffStartY();

    ids.forEach((id, i) => {
      const p = POWERUPS[id];
      const color = p?.color ?? 0xffffff;
      const colStr = '#' + color.toString(16).padStart(6, '0');
      const cy = y + R;
      const frac = Math.max(0, Math.min(1, active[id] / (this._buffCache[id] || active[id])));

      // Track: a dim full ring behind the drain, so the empty portion still reads as a ring.
      g.lineStyle(4, color, 0.22);
      g.strokeCircle(cx, cy, R);
      // Drained-in remainder: an arc from 12 o'clock going clockwise, shrinking as time runs out.
      const start = -Math.PI / 2;                 // 12 o'clock
      const end = start + frac * Math.PI * 2;      // clockwise sweep for the time remaining
      g.lineStyle(4, color, 1);
      g.beginPath();
      g.arc(cx, cy, R, start, end, false);
      g.strokePath();
      // Soft inner fill so the pie centre glows in the buff colour (fades as it drains).
      g.fillStyle(color, 0.10 + 0.14 * frac);
      g.fillCircle(cx, cy, R - 3);

      // Label + seconds to the left of the ring.
      let t = this.buffTexts[i];
      if (!t) {
        t = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '12px' }).setOrigin(1, 0.5);
        this.buffTexts[i] = t;
      }
      t.setText(`${p?.label ?? id}  ${(active[id] / 1000).toFixed(1)}s`)
        .setColor(colStr)
        .setPosition(cx - R - 8, cy)
        .setVisible(true);

      y += rowH;
    });

    // #246: Shield used to draw one extra ring row here, keyed off a scene-tracked
    // `shieldPool` that only ever existed while the powerup was active. The shield is now a
    // real, always-present-or-absent layer on the mech itself, with its own dedicated bar in
    // the INTEGRITY block (`_updateShieldBar`, right under the per-location armor/hp bars) —
    // a steadier, always-in-the-same-place readout than a buff ring that only appeared mid-
    // powerup, and it stays visible for the player's native baseline too, not just a boost.
    const rows = ids.length;
    for (let i = rows; i < this.buffTexts.length; i++) this.buffTexts[i].setVisible(false);
  }
}
