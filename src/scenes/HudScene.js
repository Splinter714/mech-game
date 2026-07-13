import Phaser from 'phaser';
import { LOCATIONS, LOCATION_INFO } from '../data/anatomy.js';
import { TILE_ORDER, tileRow, drawSkillTile, updateSkillTile } from '../ui/skillTiles.js';
import { POWERUPS, durationMs } from '../data/powerups.js';
import { STAGE_COUNT } from '../data/run.js';
import { isPointInView, edgeArrowPosition } from '../data/wayfinding.js';
import { UI_HIGHLIGHT_COLOR } from './arena/shared.js';
import { CORRIDOR_HALF_WIDTH_PX } from '../data/worldgen.js';
import { SPRINT_BIND } from '../input/Controls.js';

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
const C = { text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', good: '#7bd17b', warn: '#efc14a', bad: '#e2533a' };

// #116: corner-minimap palette (numeric, for the Graphics layer). The corridor silhouette is a
// muted steel; the player rides the shared accent, the objective the shared amber wayfinding
// highlight (so it matches the edge arrow / world marker), and enemies the danger red.
const MM = {
  panelFill: 0x0c1116, panelStroke: 0x2b3742,
  corridor: 0x39434d, corridorEdge: 0x515e6b,
  player: 0x5ec8e0, enemy: 0xe2533a,
};

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

    this.add.text(16, 12, 'ARENA', { fontFamily: 'monospace', fontSize: '18px', color: C.accent });
    this.add.text(16, 36, 'WASD/L-stick: move  ·  mouse/R-stick: aim  ·  LMB/RMB/Q/E + Space: skills  ·  pad: LT/RT/LB/RB+L3  ·  T/R3: drop lock  ·  M: mute  ·  G/B: garage',
      { fontFamily: 'monospace', fontSize: '12px', color: C.dim });
    this.add.text(16, 54, 'debug d-pad:  ↑ add  ↓ reset  ← move  → fire   ·   keys:  N add · R reset · [ move · ] fire',
      { fontFamily: 'monospace', fontSize: '11px', color: C.dim });

    // #64: run/stage readout, sitting right next to the objective line.
    this.stageText = this.add.text(16, 70, '', { fontFamily: 'monospace', fontSize: '13px', color: C.accent });
    // #66: objective line, reading the live Mission published to the registry each frame.
    this.objectiveText = this.add.text(16, 88, '', { fontFamily: 'monospace', fontSize: '13px', color: C.warn });
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

    this.modeText = this.add.text(this.W - 16, this.H - 24, '', { fontFamily: 'monospace', fontSize: '12px', color: C.warn }).setOrigin(1, 1);
    this.aiText = this.add.text(this.W - 16, this.H - 40, '', { fontFamily: 'monospace', fontSize: '11px', color: C.dim }).setOrigin(1, 1);
    this.dummyText = this.add.text(this.W - 16, 16, '', { fontFamily: 'monospace', fontSize: '13px', color: C.text }).setOrigin(1, 0);

    // #142: FPS readout, bottom-left — the one corner nothing else occupies (top-left has the
    // hints/stage/objective/integrity block, top-right has enemy count + buff rings, bottom-right
    // has mode/AI text, bottom-centre has the skill bar). Phaser's own `game.loop.actualFps` is
    // already an EMA (25% new / 75% old, see TimeStep.js) refreshed once a second — plenty stable
    // frame-to-frame on its own, so no extra rolling-average layer is needed on top of it.
    this.fpsText = this.add.text(16, this.H - 16, '', { fontFamily: 'monospace', fontSize: '12px', color: C.dim }).setOrigin(0, 1);

    // #60: active timed-buff readout, top-right under the enemy count. One radial "cooldown-pie"
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

    // Per-part integrity column (player), top-left under the hints + stage/objective lines.
    this.add.text(16, 112, 'INTEGRITY', { fontFamily: 'monospace', fontSize: '12px', color: C.dim });
    this.partTexts = {};
    let y = 130;
    for (const loc of LOCATIONS) {
      this.partTexts[loc] = this.add.text(16, y, '', { fontFamily: 'monospace', fontSize: '12px', color: C.text });
      y += 14;
    }

    // Skill bar — the shared garage tiles, centred along the bottom of the screen.
    this.skillBar = this.add.container(0, 0);
    this.skillRefs = {};
    const mech = this.registry.get('playerMech');
    const tiles = tileRow(this.W * 0.12, this.W * 0.76, { bottom: this.H - 10, maxSize: 92 });
    for (const r of tiles) {
      const id = mech?.mounts[r.loc]?.[0] ?? null;
      this.skillRefs[r.loc] = drawSkillTile(this, this.skillBar, r, { loc: r.loc, itemId: id });
    }

    // #188: Sprint fuel bar — a simple track+fill bar centred just above the skill-tile row,
    // showing remaining fuel (drains while active, refills while not) and whether sprint is
    // currently engaged. Mirrors the tile row's own ammo-bar visual language (a dim track
    // rectangle behind a colored fill), same as the per-weapon ammo bars in skillTiles.js.
    const barW = Math.min(260, this.W * 0.32), barH = 8;
    const barX = this.W / 2 - barW / 2, barY = tiles.length ? tiles[0].y - 22 : this.H - 32;
    this.sprintBarTrack = this.add.rectangle(barX, barY, barW, barH, 0x0e1218).setOrigin(0, 0.5).setStrokeStyle(1, 0x2a333f);
    this.sprintBarFill = this.add.rectangle(barX, barY, barW, barH, C.accent).setOrigin(0, 0.5);
    this.sprintLabel = this.add.text(barX + barW / 2, barY - 12, '', {
      fontFamily: 'monospace', fontSize: '10px', color: C.dim,
    }).setOrigin(0.5, 1);
    this._sprintBarW = barW;

    // #80 follow-up: per-edge margins for the wayfinding arrow, so it clamps clear of the
    // reserved HUD chrome instead of the literal screen edge. Bottom excludes the skill-tile
    // toolbar (its top edge + a little breathing room); top excludes the hints/objective text
    // block (INTEGRITY starts at y=112, so keep clear of that).
    const tileTop = tiles.length ? tiles[0].y : this.H - 10;
    this.wayMargins = { top: 116, right: 24, bottom: this.H - tileTop + 12, left: 24 };

    // #116: corner minimap — the deferred half of #80 (the edge-direction arrow was the other
    // half). A compact box in the RIGHT margin, sitting just ABOVE the skill-tile toolbar (so it
    // clears both the toolbar and the bottom-right mode/AI text) and below the top-right enemy-
    // count/buff stack. It renders the WHOLE snaking corridor's silhouette (from `spineWorld`)
    // with live player/objective/enemy markers moving within it.
    const mmW = 152, mmH = 128;
    this.miniBox = { x: this.W - 14 - mmW, y: tileTop - 12 - mmH, w: mmW, h: mmH };
    // Static layer: panel + corridor silhouette, drawn once the spine is known (it never changes
    // mid-run). Dynamic layer: the live markers, cleared/redrawn each frame. Both on the same
    // depth tier as the wayfinding arrow so they sit above the skill toolbar.
    this.miniStaticGfx = this.add.graphics().setDepth(19);
    this.miniGfx = this.add.graphics().setDepth(21);
    this.miniLabel = this.add.text(this.miniBox.x + 6, this.miniBox.y + 4, 'MAP',
      { fontFamily: 'monospace', fontSize: '10px', color: C.dim }).setDepth(21);
    this._miniFit = null;      // {toMini, scale} once computed
    this._miniSpineRef = null; // identity of the spine snapshot the static layer was drawn from
  }

  update() {
    const mech = this.registry.get('playerMech');
    if (!mech) return;

    this.modeText.setText(this.registry.get('inputMode') === 'pad' ? 'CONTROLLER' : 'MOUSE + KB');
    const aiMove = this.registry.get('aiMove') !== false;
    const aiFire = this.registry.get('aiFire') !== false;
    this.aiText.setText((aiMove && aiFire) ? '' : `AI  move:${aiMove ? 'on' : 'OFF'}  fire:${aiFire ? 'on' : 'OFF'}`);

    // Skill tiles: live ammo on each weapon (#188: the old per-slot ability cooldown/shield
    // display is gone along with the ability slot — Sprint's state renders in its own fuel
    // bar below instead, since it isn't tied to a body location any more).
    const mode = this.registry.get('inputMode') === 'pad' ? 'pad' : 'kbm';
    const weapons = mech.weapons();
    for (const loc of TILE_ORDER) {
      const id = mech.mounts[loc][0] ?? null;
      const opts = { loc, itemId: id, mode };
      const w = weapons.find((x) => x.location === loc);
      if (w) {
        opts.iconAlpha = w.online ? 1 : 0.3;
        if (!w.online) { opts.subtitle = 'OFFLINE'; opts.subtitleColor = C.bad; }
        else if (w.ammo == null) { opts.subtitle = '∞'; opts.subtitleColor = C.dim; }
        else {
          opts.subtitle = `${Math.floor(w.ammo)}/${w.weapon.ammoMax}`;
          opts.subtitleColor = w.ready ? C.good : C.warn;
          opts.ammoFrac = w.ammo / w.weapon.ammoMax;
        }
      }
      updateSkillTile(this.skillRefs[loc], opts);
    }

    // #188: Sprint fuel bar — fill fraction + color track remaining fuel; the label shows
    // the bind + ACTIVE/READY/EMPTY state, mirroring the old ability tile's READY/cooldown text.
    this._updateSprintBar();

    for (const loc of LOCATIONS) {
      const p = mech.parts[loc];
      const frac = mech.partHealthFraction(loc);
      const hp = Math.ceil(p.armor + p.structure);
      const max = p.maxArmor + p.maxStructure;
      const col = mech.isPartDestroyed(loc) ? C.bad : frac > 0.5 ? C.good : C.warn;
      this.partTexts[loc].setText(`${LOCATION_INFO[loc].short.padEnd(2)} ${String(hp).padStart(3)}/${max}`).setColor(col);
    }

    const total = this.registry.get('enemyCount') || 0;
    const alive = this.registry.get('enemiesAlive') ?? total;
    if (total) {
      this.dummyText.setText(`ENEMIES ${alive}/${total}`).setColor(alive ? C.dim : C.bad);
    }

    // #64: run/stage readout, driven by the Run the arena publishes each frame.
    const run = this.registry.get('run');
    if (run) {
      this.stageText.setText(`STAGE ${run.stageIndex + 1}/${STAGE_COUNT}   SCRAP ${run.currency}`);
    }

    // #66: objective line + win banner, driven by the Mission the arena publishes each frame.
    const mission = this.registry.get('mission');
    if (mission) {
      const complete = mission.status === 'complete';
      this.objectiveText
        .setText(`OBJECTIVE: ${mission.objective}${complete ? '  [COMPLETE]' : ''}`)
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
    this._updateWayArrow();
    this._updateMinimap();

    // #142: reads Phaser's own smoothed fps tracker directly (see the create()-time note above).
    this.fpsText.setText(`FPS ${Math.round(this.game.loop.actualFps)}`);
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
    const view = this.registry.get('cameraView');
    const g = this.wayGfx;
    g.clear();
    if (!objectiveWorld || !view) return;
    if (isPointInView(view, objectiveWorld)) return;
    const { x, y, angle } = edgeArrowPosition(view, this.W, this.H, objectiveWorld, this.wayMargins);
    // #143: ride the pulse counter for both a scale bump (1.0 → 1.35x) and an alpha swell
    // (0.55 → 1.0), plus a glow halo behind the chevron whose own strength rides the same pulse —
    // combining both treatments read best in playtest vs. either alone.
    const pulse = this.wayPulse.t;
    const size = 16 * (1 + 0.35 * pulse);
    const alpha = 0.55 + 0.45 * pulse;
    drawChevronGlow(g, x, y, angle, size, UI_HIGHLIGHT_COLOR, alpha);
    drawChevron(g, x, y, angle, size, UI_HIGHLIGHT_COLOR, 0.92 * (0.7 + 0.3 * pulse));   // shared wayfinding highlight colour (#136)
  }

  // #116: build the world→minimap fit and paint the static layer (panel + corridor silhouette).
  // Run once per run — the corridor is built once (#111), so `spineWorld` is a stable snapshot; we
  // re-run only if its identity changes (a fresh deploy/run swaps in a new array). The fit letter-
  // boxes the corridor's padded bounding box into the box preserving aspect, so any random
  // per-deploy orientation of the snake fits cleanly whether it runs wide or tall.
  _buildMinimap(spine) {
    const box = this.miniBox;
    const inset = 10;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of spine) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    // Pad the bounds by the corridor half-width so the drawn floor (and any marker out at the
    // corridor's edge) stays inside the box, not clipped at the centreline's own extent.
    const pad = CORRIDOR_HALF_WIDTH_PX;
    minX -= pad; maxX += pad; minY -= pad; maxY += pad;
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    const availW = box.w - 2 * inset, availH = box.h - 2 * inset;
    const scale = Math.min(availW / spanX, availH / spanY);
    const offX = box.x + inset + (availW - spanX * scale) / 2;
    const offY = box.y + inset + (availH - spanY * scale) / 2;
    const toMini = (wx, wy) => ({ x: offX + (wx - minX) * scale, y: offY + (wy - minY) * scale });
    this._miniFit = { toMini, scale };

    const g = this.miniStaticGfx;
    g.clear();
    // Panel: dark rounded backing + subtle border.
    g.fillStyle(MM.panelFill, 0.72);
    g.fillRoundedRect(box.x, box.y, box.w, box.h, 6);
    g.lineStyle(1, MM.panelStroke, 0.9);
    g.strokeRoundedRect(box.x, box.y, box.w, box.h, 6);
    // Corridor silhouette: the union of discs along the spine — exactly how the playable set is
    // defined (worldgen.js `corridorHexSet`), so the sketch is faithful and gap-free. Subsample the
    // dense spine (samples are 24px apart; discs are `CORRIDOR_HALF_WIDTH_PX` wide) so ~2 dozen
    // solid circles cover it with heavy overlap instead of drawing all ~150 every rebuild.
    const r = CORRIDOR_HALF_WIDTH_PX * scale;
    const step = 6;
    g.fillStyle(MM.corridor, 0.95);
    for (let i = 0; i < spine.length; i += step) {
      const m = toMini(spine[i].x, spine[i].y);
      g.fillCircle(m.x, m.y, r);
    }
    // Always include the last sample so the far end isn't dropped by the stride.
    const last = toMini(spine[spine.length - 1].x, spine[spine.length - 1].y);
    g.fillCircle(last.x, last.y, r);
    this._miniSpineRef = spine;
  }

  // #116: draw the live markers (player facing, objective, enemies) into the dynamic layer each
  // frame. Reads the SAME `objectiveWorld` the edge arrow uses, so the two can never disagree.
  _updateMinimap() {
    const spine = this.registry.get('spineWorld');
    const g = this.miniGfx;
    g.clear();
    if (!spine || !spine.length) { this.miniStaticGfx.clear(); return; }
    if (this._miniSpineRef !== spine || !this._miniFit) this._buildMinimap(spine);
    const { toMini } = this._miniFit;
    const box = this.miniBox;
    const inBox = (m) => m.x >= box.x && m.x <= box.x + box.w && m.y >= box.y && m.y <= box.y + box.h;

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
    g.fillStyle(MM.enemy, 0.95);
    for (const e of shown) {
      const m = toMini(e.x, e.y);
      if (inBox(m)) g.fillCircle(m.x, m.y, 2.2);
    }

    // Objective: amber diamond + ring (shared wayfinding highlight colour).
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
      }
    }

    // Player: a facing chevron in the shared accent colour, oriented to the hull heading.
    if (player) {
      const m = toMini(player.x, player.y);
      if (inBox(m)) drawChevron(g, m.x, m.y, player.angle, 6.5, MM.player, 1);
    }
  }

  // #188: Sprint fuel bar — fill width tracks the live fuel fraction (registry-published by
  // arena/firing.js's _handleSprint each frame); color/label reflect ACTIVE/READY/EMPTY so
  // the owner can read at a glance both how much fuel is left and whether it's draining or
  // regenerating right now.
  _updateSprintBar() {
    const fuel = this.registry.get('sprintFuel');
    if (fuel == null) return;   // no player mech / sprint state published yet
    const cap = this.registry.get('sprintFuelMax') || 1;
    const active = !!this.registry.get('sprintActive');
    const frac = Phaser.Math.Clamp(fuel / cap, 0, 1);
    this.sprintBarFill.setSize(Math.max(1, this._sprintBarW * frac), this.sprintBarFill.height);
    const color = active ? C.accent : frac > 0.25 ? C.good : frac > 0 ? C.warn : C.bad;
    this.sprintBarFill.setFillStyle(Phaser.Display.Color.HexStringToColor(color).color);
    const bind = this.registry.get('inputMode') === 'pad' ? SPRINT_BIND.pad : SPRINT_BIND.key;
    const state = active ? 'ACTIVE' : frac <= 0 ? 'EMPTY' : 'READY';
    this.sprintLabel.setText(`SPRINT (${bind})  ${state}`).setColor(color);
  }

  // #60: draw one radial "draining" ring per active timed buff. Each is a rounded circular
  // timer, tinted the buff colour, whose arc empties clockwise from full to zero over the buff's
  // duration — a cooldown-pie. The label + remaining seconds sit to the left so several buffs
  // stack readably down the top-right. Text objects are pooled; the Graphics layer is redrawn
  // each frame. Instant buffs (Armor Patch) never enter `activePowerups`, so they never show.
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
    const R = 15;                 // ring radius
    const cx = this.W - 16 - R;   // ring centre x (ring hugs the right edge)
    const rowH = 2 * R + 10;
    let y = 44;

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

    // #187: Shield draws one extra row, same visual language (a ring + label) as the timed
    // buffs above, but keyed off the remaining damage POOL instead of remaining time — a
    // simple starting treatment, left for the owner to refine visually via playtest. Not part
    // of `ids`/`activePowerups` (Shield isn't a timed buff), so it always lands in the next
    // slot after them and is skipped entirely (row hidden) when the pool is empty.
    const shieldPool = this.registry.get('shieldPool') || 0;
    let rows = ids.length;
    if (shieldPool > 0) {
      const cap = this._shieldCapSeen = Math.max(this._shieldCapSeen || 0, shieldPool);
      const p = POWERUPS.shield;
      const color = p?.color ?? 0x5ec8e0;
      const colStr = '#' + color.toString(16).padStart(6, '0');
      const cy = y + R;
      const frac = Math.max(0, Math.min(1, shieldPool / cap));

      g.lineStyle(4, color, 0.22);
      g.strokeCircle(cx, cy, R);
      const start = -Math.PI / 2;
      const end = start + frac * Math.PI * 2;
      g.lineStyle(4, color, 1);
      g.beginPath();
      g.arc(cx, cy, R, start, end, false);
      g.strokePath();
      g.fillStyle(color, 0.10 + 0.14 * frac);
      g.fillCircle(cx, cy, R - 3);

      let t = this.buffTexts[rows];
      if (!t) {
        t = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '12px' }).setOrigin(1, 0.5);
        this.buffTexts[rows] = t;
      }
      t.setText(`${p?.label ?? 'SHIELD'}  ${Math.round(shieldPool)}`)
        .setColor(colStr)
        .setPosition(cx - R - 8, cy)
        .setVisible(true);
      rows += 1;
    } else {
      this._shieldCapSeen = 0;   // reset the "full" reference once the shield is gone
    }
    for (let i = rows; i < this.buffTexts.length; i++) this.buffTexts[i].setVisible(false);
  }
}
