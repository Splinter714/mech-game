import Phaser from 'phaser';
import { LOCATION_INFO } from '../data/anatomy.js';
import { TILE_ORDER, tileRow, drawSkillTile, updateSkillTile } from '../ui/skillTiles.js';
import { InkCache, fitScale } from '../art/inkBounds.js';
import { mechPreviewKeys, poseMechInto, vehiclePreviewKeys } from '../art/preview.js';
import { HULL_FRAMES } from '../art/index.js';
import { POWERUPS, durationMs } from '../data/powerups.js';
import { isPointInView, edgeArrowPosition } from '../data/wayfinding.js';
import { miniProjector, clampToBox } from '../data/minimap.js';
import { UI_HIGHLIGHT_COLOR } from './arena/shared.js';
import { CORRIDOR_HALF_WIDTH_PX } from '../data/worldgen.js';
import { rendererLabel, gpuRendererString, probeGl, perfLines } from '../data/perfReadout.js';
import {
  hudLayout, panelLabel, panelStatusText, panelsNeedRebuild, BUFF_RING_R,
  integrityLayout, INTEGRITY_ORDER,
  CONSOLE, CONSOLE_TILES, consoleLayout, consoleBand, consoleTileSize, tileRowWidth,
  HUD_DISC, minimapBox, targetDiscBox, targetDiscLayout, ringSweep, discReserveBottom,
  OBJECTIVE_PANEL, objectivePanelRect,
} from '../data/hudLayout.js';
import {
  normalizeReadoutMode, nextReadoutMode,
  orbLayout, orbFillPolygon, paperDollLayout, perimeterRun, mechPools, noneLayout,
} from '../data/healthReadout.js';
import { themeFor } from '../art/mechPrims.js';
import { playerColor, showsPlayerColor } from '../data/players.js';
import { baseClearLabel } from '../data/bases.js';
import { magazineReadout } from '../data/weaponStats.js';
import { respawnHudRows } from '../data/respawn.js';

// #394: the respawn row's ring colour when the downed player has no identifying colour of their
// own (the pre-`hudPlayers` singleton fallback). Every real player carries one.
const C_RESPAWN_RING = 0xe2533a;

// #465: Phaser's TextureManager fires this (with the key) synchronously the moment a texture is
// destroyed — `Phaser.Textures.Events.REMOVE`. Written as the literal string rather than reached
// through the namespace so it stays readable in the tests that stub the `phaser` module.
const TEXTURE_REMOVE_EVENT = 'removetexture';

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
// cooldown) read right on its button. The per-part integrity readout is a block of vertical
// bars in the BOTTOM-LEFT corner beside them (#448), sharing their baseline.
// #452 (stage 3) frames all of that: one CONSOLE shell spans the bottom edge with the integrity
// block, the tile row and a new bottom-right TARGET readout recessed into it as bays, so the
// bottom of the screen reads as a single instrument panel rather than three floating widgets.
// Runs as its own scene so it lays out in logical screen space without fighting the arena's
// follow camera; tiles are built once and updated in place each frame.
// #238: `cooldown` matches skillTiles.js's TILE_UI.cooldown so the subtitle text and the
// ammo-bar tint read as the same visual language for the "locked out, recharging" state.
const C = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', good: '#7bd17b', warn: '#efc14a', bad: '#e2533a',
  cooldown: '#5e7ce0',
};

// #448: the integrity readout's palette. The three layers have to be told apart INSTANTLY and
// with no numbers to fall back on, so each one is a different hue AND a different surface:
//
//  - ARMOR is the player mech's own dark plate tone (src/art/mechPrims.js `THEMES.player`:
//    `face`/`deep`/`rimHi`, mirrored here as literals the same way the old bar mirrored the
//    armor-shell colour), drawn with plate seams + a lit edge so it reads as armor, not a fill.
//    #246's steel-blue armor bar is gone with it — a bright blue armor bar next to a bright blue
//    SHIELD bar was most of what made the old readout hard to read at a glance.
//  - SHIELD keeps the Shield powerup's own colour (data/powerups.js `POWERUPS.shield.color`),
//    now with a soft glow so it reads as energy rather than paint.
//  - HP is plain red, with a brighter cap on the top of the fill so its level is crisp.
//
// The dark track under every bar is always drawn full height: the EMPTY space is half the
// readout (armor's empty space is what it can be patched back into, HP's is the damage you are
// never getting back).
const BAR_TRACK = 0x0e1218;
const BAR_EDGE = 0x2a333f;
const ARMOR_PLATE = 0x3a4250;
const ARMOR_SEAM = 0x1b212b;
const ARMOR_RIM = 0x566273;
const ARMOR_SEAM_H = 7;         // px between plate seams down the armor bar
const HP_COLOR = 0xd8433a;
const HP_CAP = 0xff8f80;
const SHIELD_BAR_COLOR = 0x5ec8e0;
const SHIELD_CAP = 0xd6f6ff;
// Plain Graphics has no blur filter, so a couple of oversized, low-alpha copies behind the fill
// stand in for one — the same trick `drawChevronGlow` above uses for the wayfinding chevron.
const SHIELD_GLOW = [{ pad: 4, a: 0.10 }, { pad: 2, a: 0.20 }];

// One vertical bar's dark backing + frame, always full height (see the palette note above).
function drawBarTrack(g, x, top, w, h) {
  g.fillStyle(BAR_TRACK, 1);
  g.fillRect(x, top, w, h);
  g.lineStyle(1, BAR_EDGE, 0.9);
  g.strokeRect(x, top, w, h);
}

// The ARMOR bar: fills bottom-up in the mech's own plate tone, banded by thin dark seams every
// `ARMOR_SEAM_H` px and lit along its left and top edges — the same "dark face, rim on the lit
// edge" language the mech art itself is drawn in, so a glance at the HUD and a glance at the
// mech agree about what armor looks like. Seams are laid out from the BOTTOM of the bar so they
// stay put as the fill drains instead of sliding around.
function drawArmorBar(g, x, top, w, h, frac) {
  const fh = Math.max(0, Math.min(1, frac)) * h;
  if (fh <= 0) return;
  const y = top + h - fh;
  g.fillStyle(ARMOR_PLATE, 1);
  g.fillRect(x, y, w, fh);
  g.fillStyle(ARMOR_SEAM, 0.85);
  for (let sy = top + h - ARMOR_SEAM_H; sy > y; sy -= ARMOR_SEAM_H) g.fillRect(x, sy, w, 1);
  g.fillStyle(ARMOR_RIM, 0.9);
  g.fillRect(x, y, Math.min(1.5, w), fh);
  g.fillRect(x, y, w, 1.5);
}

// The HP bar: flat red, with a brighter cap so the top of the fill (the actual reading) is crisp
// against the dark track.
function drawHpBar(g, x, top, w, h, frac) {
  const fh = Math.max(0, Math.min(1, frac)) * h;
  if (fh <= 0) return;
  const y = top + h - fh;
  g.fillStyle(HP_COLOR, 1);
  g.fillRect(x, y, w, fh);
  g.fillStyle(HP_CAP, 0.9);
  g.fillRect(x, y, w, 1.5);
}

// The SHIELD bar: the shield colour with a slight glow bleeding past its edges.
function drawShieldBar(g, x, bottom, w, fh) {
  if (fh <= 0) return;
  const y = bottom - fh;
  for (const { pad, a } of SHIELD_GLOW) {
    g.fillStyle(SHIELD_BAR_COLOR, a);
    g.fillRect(x - pad, y - pad, w + pad * 2, fh + pad * 2);
  }
  g.fillStyle(SHIELD_BAR_COLOR, 1);
  g.fillRect(x, y, w, fh);
  g.fillStyle(SHIELD_CAP, 0.95);
  g.fillRect(x, y, w, 1.5);
}

// ── #452: the CONSOLE ────────────────────────────────────────────────────────────────────────
//
// The skill tiles and the integrity block sit in ONE mech-style instrument shell along the bottom
// edge: a plated body with a lit top rail and bolt heads, with each readout recessed into it as a
// BAY. All geometry comes from data/hudLayout.js (`consoleBand`/`consoleLayout`); this is the paint.
//
// The style pass took the shell's colours straight from the PLAYER MECH's own palette
// (art/mechPrims.js `themeFor`) rather than inventing HUD greys — the console is a piece of the
// machine you are sitting in, so it is painted out of the same tones its plates are, in the same
// order (dark outline → shadowed lower body → mid face → lit top rim). It is fully OPAQUE: the
// old 0.78 shell let the fight read through the instrument panel, which is exactly what Jackson
// called "too much transparency".
const MECH = themeFor({ theme: 'player' });
const CONSOLE_COL = {
  outline: MECH.outline,   // 0x0b0e14 — the plate edge, same as every mech part's
  body: MECH.faceMid,      // the plate face
  bodyLo: MECH.lower,      // its shadowed lower half
  bodyHi: MECH.face,       // the lit upper band
  rim: MECH.rim,           // the top highlight rim / rail
  bolt: MECH.rimHi,
  bay: MECH.ao,            // a recessed bay's floor (the mech's own ambient-occlusion tone)
  bayEdge: MECH.deep,
};

// Recess one bay into the console plate: a dark floor, a shadowed top lip and (optionally) a
// hairline frame. The tile bay skips the frame — the tiles carry their own edge + halo now, and a
// second outline around them read as a box in a box. Opaque throughout, like the shell.
function drawBay(g, rect, { framed = true } = {}) {
  g.fillStyle(CONSOLE_COL.bay, 1);
  g.fillRoundedRect(rect.x, rect.y, rect.w, rect.h, CONSOLE.bayRadius);
  if (!framed) return;
  g.lineStyle(1, CONSOLE_COL.bayEdge, 1);
  g.strokeRoundedRect(rect.x, rect.y, rect.w, rect.h, CONSOLE.bayRadius);
}

// #452: the target readout's own colours. The name line takes the reticle's red so the disc and
// the bracket drawn around the unit in the world read as the same lock.
const POD_LIVE = '#e2533a';
// How fast the pod spins a rotor overlay, per enemy art kind — the SAME rates the arena drives
// them at (arena/enemies.js `_updateVehicle`), which is what makes the preview read as the unit
// you are looking at rather than a generic idle loop.
const POD_ROTOR_SPIN = { drone: 40, helicopter: 26 };
// Cadence of the posed mech's walk cycle in the pod. The arena advances an enemy's gait by its
// real ground speed, which a HUD panel has no business guessing at; a steady stride reads as
// "this thing walks" without pretending to know how fast it is currently moving.
const POD_STEP_MS = 160;

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

    // #449 took the top-left 'ARENA' title; #463 takes the last thing that was up there — the
    // controls hint line and the debug d-pad/keys cheat sheet (Jackson: "all the 'controls' help
    // text on top left should also be removed"). The top-left corner is now empty by design. The
    // per-slot BINDS are untouched: every skill tile still shows the button that fires it, which
    // is where a player actually needs that information.

    // #66: objective line, reading the live Mission published to the registry each frame.
    // #449: it moved out of the old top-LEFT text block (which also carried an 'ARENA' title, an
    // OBJECTIVES/SCRAP run readout and — top-right — a separate enemy count) to sit directly UNDER
    // the corner minimap, and it is now the ONLY line up there: the remaining-structures /
    // remaining-garrison tally the enemy count used to carry folds into this same line, because
    // data/bases.js `baseClearLabel` already renders exactly that (see update()). Positioned by
    // `_applyChromeLayout` once the minimap box exists — the layout's shared slot, so co-op still
    // moves it to top-centre clear of player 2's column.
    // #449 (playtest follow-up): "fewer lines, bigger, and solid backing". It is ONE line, set at
    // `OBJECTIVE_PANEL.fontSize` rather than the 13px it shipped at, painted over an OPAQUE plate
    // (`objectivePanel`, drawn under the text each frame from the line's measured width) so it
    // reads on snow, sand or a burning compound alike instead of dissolving into the terrain.
    this.objectivePanel = this.add.graphics();
    this.objectiveText = this.add.text(0, 0, '', {
      fontFamily: 'monospace', fontSize: `${OBJECTIVE_PANEL.fontSize}px`, color: C.warn, fontStyle: 'bold',
    });
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
    // #452 (style pass): the dev overlays used to sit in opposite bottom corners — the perf block
    // bottom-LEFT and these two bottom-RIGHT — where the now-centred console could run under them.
    // Jackson: the FPS counter and the control-mode indicator must sit NEXT TO EACH OTHER and
    // ABOVE the instrument panel. They are laid out together in `_placeDevReadouts`, off the
    // console's own top edge, so they can never overlap it at any window size.
    if (import.meta.env.DEV) {
      this.modeText = this.add.text(16, this.H - 24, '', { fontFamily: 'monospace', fontSize: '12px', color: C.warn }).setOrigin(0, 1);
      this.aiText = this.add.text(16, this.H - 40, '', { fontFamily: 'monospace', fontSize: '11px', color: C.dim }).setOrigin(0, 1);
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
      this.fpsText = this.add.text(16, this.H - 16, '', { fontFamily: 'monospace', fontSize: '11px', color: C.dim }).setOrigin(0, 0);
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
    // Explicit depth (mirroring tabBar/AudioScene/mission-marker's use of setDepth) keeps it
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
    // #452: the console shell every panel's readouts are recessed into. Its own layer, painted on
    // a panel rebuild rather than per frame (it only moves when the player count does), and
    // explicitly BEHIND everything else in the band.
    this.consoleGfx = this.add.graphics().setDepth(-1);
    // #452: the target readout poses real enemy art in a HUD bay, and every texture in this game
    // is a fixed-size square canvas — so the art has to be fitted to its INKED bounds or a drone
    // renders as a speck in the corner. Shared with the art gallery (art/inkBounds.js).
    this.ink = new InkCache(this.textures);
    // Reset alongside the cache it gates (#465): Phaser REUSES this scene instance across
    // sorties, while the arena's enemy keys restart at `enemy0` every deploy — so a signature
    // left over from the last run would be answering about a different unit's art.
    this._podInkSig = new Map();
    // #465: the pod poses art the ARENA owns and destroys. Subscribe to the texture manager's own
    // teardown signal so those sprites are released in the same call stack that removes their
    // textures — see `_onTextureRemoved` for why no per-frame check can do this job. The manager
    // is game-wide and outlives this scene, so the listener is dropped on shutdown (create() runs
    // again on the next deploy) rather than stacking up one per sortie.
    this.textures.on(TEXTURE_REMOVE_EVENT, this._onTextureRemoved, this);
    this.events.once('shutdown', () => this.textures.off(TEXTURE_REMOVE_EVENT, this._onTextureRemoved, this));

    // #448: the READOUT SWITCH. Three health readouts exist (the shipped bars, ARPG orbs, a paper
    // doll — data/healthReadout.js) and the point of building all three was to judge them in play,
    // so the switch has to be reachable mid-run: H cycles it. The mode lives in the REGISTRY, which
    // is game-wide, so it survives redeploying to the garage and back rather than resetting to the
    // shipped readout every sortie.
    // #452 (style pass): the on-screen `READOUT: BARS   [H] to switch` prompt is GONE (Jackson
    // doesn't want the control prompt on the HUD, and the top-left corner it sat in is the target
    // disc's now). The KEY still cycles — only the instruction text was chrome.
    this.input.keyboard?.on('keydown-H', () => this._cycleReadout());

    this.panels = [];
    this._panelCount = 0;
    this._syncPanels();

    // #80 follow-up: per-edge margins for the wayfinding arrow, so it clamps clear of the
    // reserved HUD chrome instead of the literal screen edge. #452: the bottom margin is now the
    // whole CONSOLE shell (which wraps the tiles, the integrity block and the target readout), not
    // just the tile row's top edge — one number for one panel.
    // #366: the left/right insets come from the layout. The top clears the CORNER DISCS — the
    // minimap on the right and the (possibly stacked) target discs on the left are the same
    // height, so one number covers both (`discReserveBottom`).
    this.wayMargins = {
      top: discReserveBottom(this._layout.count) + 20, right: this._layout.margins.right,
      bottom: this.H - this._consoleTop + 6, left: this._layout.margins.left,
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
    // #452 (style pass): the diameter is now the SHARED disc size (data/hudLayout.js `HUD_DISC`) —
    // the map and the new top-left target disc are the same circle, a touch larger than the 132px
    // the map used to be, because Jackson asked for both "the same size, and slightly larger than
    // current minimap size". One constant, so they cannot drift apart.
    this._miniSize = { w: HUD_DISC.d, h: HUD_DISC.d };
    this.miniBox = minimapBox(this.W);
    // The top-right corner otherwise hosts the objective line + buff rings; push those down to sit
    // just below the map so they clear it (solo only — co-op moves both to top-centre, untouched).
    // #449 is exactly this slot: "put the current objective label below the top-right minimap."
    // #449: the gap has to clear the objective PLATE's own top padding, not just the text's
    // ascender — the block is a solid panel now, and a plate touching the disc above it reads as
    // one smeared blob rather than two instruments.
    this._mapReserveBottom = this.miniBox.y + this.miniBox.h + 8 + OBJECTIVE_PANEL.padY;
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
  // The buff rings start under the objective PLATE, whose height is its font plus its own padding
  // (#449 made it much taller than the 13px line the old +24 was measured against).
  _objectivePanelH() { return OBJECTIVE_PANEL.fontSize + OBJECTIVE_PANEL.padY * 2 + 6; }
  _buffStartY() {
    return this._objectiveTextY() + this._objectivePanelH() + (this._rightStack() ? 8 : 12);
  }

  // #449: the objective line's opaque backing plate, repainted whenever the line's text (and so
  // its measured width) changes. Painted in the console's own plate palette so the two instrument
  // surfaces on screen are made of the same material. Hidden entirely when there is no line —
  // an empty plate floating under the map would read as a broken widget.
  _paintObjectivePanel() {
    const g = this.objectivePanel;
    const t = this.objectiveText;
    if (!g || !t) return;
    g.clear();
    if (!t.text) return;
    const r = objectivePanelRect(t.width || 0, t.height || OBJECTIVE_PANEL.fontSize, {
      x: t.x, y: t.y, originX: t.originX ?? 1,
    });
    g.fillStyle(CONSOLE_COL.outline, 1);
    g.fillRoundedRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3, OBJECTIVE_PANEL.radius + 1);
    g.fillStyle(CONSOLE_COL.bodyLo, 1);
    g.fillRoundedRect(r.x, r.y, r.w, r.h, OBJECTIVE_PANEL.radius);
    g.fillStyle(CONSOLE_COL.body, 1);
    g.fillRoundedRect(r.x, r.y, r.w, Math.max(6, r.h * 0.36), OBJECTIVE_PANEL.radius);
    g.lineStyle(1, CONSOLE_COL.rim, 0.9);
    g.strokeRoundedRect(r.x, r.y, r.w, r.h, OBJECTIVE_PANEL.radius);
  }

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
    // #452 (style pass): the console is only as wide as its contents, so the contents have to be
    // MEASURED before they can be placed. The integrity block's width depends on which of the
    // three readouts is switched on (#448), so it is asked for at full size (`availW: 0` =
    // unsqueezed) rather than assumed; the tiles then take the biggest size that still fits every
    // player's group across the screen, and `consoleBand` packs the lot into one centred run.
    const blockW = this._integrityLayoutFor(0, 0).w;
    const blockWs = this._layout.panels.map(() => blockW);
    const tilesW = tileRowWidth(consoleTileSize(this.W, blockWs));
    this._band = consoleBand(this.W, blockWs.map((b) => ({ blockW: b, tilesW })));
    for (const spec of this._layout.panels) {
      this.panels.push(this._makePanel(spec, count, snapshots[spec.index], this._band.groups[spec.index]));
    }
    this._panelCount = this._layout.panels.length;
    // #452: the shell wraps whatever the panels just laid out, so it is painted from them rather
    // than from its own idea of where they are — and it must be painted BEFORE the chrome layout,
    // which reads `_consoleTop` for the wayfinding margins.
    this._paintConsole();
    this._applyChromeLayout();
  }

  // #452: paint the console shell + one recessed bay per readout. Called on a panel rebuild only
  // (the shell is a function of the player count and the window size, neither of which changes
  // per frame). Every number comes from the panels' own layouts, so a bay can never drift off
  // what it frames.
  _paintConsole() {
    // The band's top edge, which the wayfinding margins clamp to. Defaulted first so a panel-less
    // frame (or a scene double with no Graphics) can never leave it undefined.
    this._consoleTop = this.H - 10;
    const g = this.consoleGfx;
    if (!g) return;
    g.clear();
    if (!this.panels.length) return;
    const pad = CONSOLE.bayPad;
    // The band's content ceiling: the highest thing any panel put in it (in practice the integrity
    // header line, which sits a little above the tile row).
    let contentTop = Infinity;
    for (const p of this.panels) contentTop = Math.min(contentTop, p.tileTop, p.bars.headerY);
    const c = consoleLayout(this.H, contentTop, this._band);
    this._consoleTop = c.y;

    // The plate, in the PLAYER MECH's own palette and fully opaque: outline, a shadowed body, a
    // lit upper band and a highlight rim along the top lip — the same dark-edge → shadow → face →
    // rim stack every armour plate in art/mechPrims.js is built from. Rounded along the TOP only;
    // the bottom runs off the screen edge, which is what makes it read as a console built into the
    // frame rather than a floating card.
    const corners = { tl: CONSOLE.radius, tr: CONSOLE.radius, bl: 4, br: 4 };
    g.fillStyle(CONSOLE_COL.outline, 1);
    g.fillRoundedRect(c.x - 1.5, c.y - 1.5, c.w + 3, c.h + 3, corners);
    g.fillStyle(CONSOLE_COL.bodyLo, 1);
    g.fillRoundedRect(c.x, c.y, c.w, c.h, corners);
    // The lit upper band: the top third of the plate, catching the same overhead light the mech's
    // own plates do.
    g.fillStyle(CONSOLE_COL.body, 1);
    g.fillRoundedRect(c.x, c.y, c.w, Math.max(8, c.h * 0.34), corners);
    // Highlight rim along the very top lip, plus the rail line and its bolt heads just under it.
    g.lineStyle(2, CONSOLE_COL.bodyHi, 1);
    g.beginPath();
    g.moveTo(c.x + CONSOLE.radius * 0.6, c.y + 1);
    g.lineTo(c.x + c.w - CONSOLE.radius * 0.6, c.y + 1);
    g.strokePath();
    g.lineStyle(1, CONSOLE_COL.rim, 1);
    g.beginPath();
    g.moveTo(c.x + CONSOLE.railInset, c.y + 5.5);
    g.lineTo(c.x + c.w - CONSOLE.railInset, c.y + 5.5);
    g.strokePath();
    g.fillStyle(CONSOLE_COL.bolt, 1);
    for (const bx of [c.x + CONSOLE.boltInset, c.x + c.w - CONSOLE.boltInset]) {
      g.fillCircle(bx, c.y + 5.5, CONSOLE.boltR);
    }

    const bottom = this.H - 10 + pad;
    for (const panel of this.panels) {
      const b = panel.bars;
      // #448: no block ⇒ no bay. An empty recess where the readout used to be is exactly the
      // "hole" the NONE mode has to avoid.
      if (b.w > 0) drawBay(g, { x: b.x - pad, y: b.headerY - 2, w: b.w + pad * 2, h: bottom - (b.headerY - 2) });
      const t = panel.tileBox;
      if (t) drawBay(g, { x: t.x - pad, y: t.y - pad, w: t.w + pad * 2, h: bottom - (t.y - pad) }, { framed: false });
    }
    this._placeDevReadouts();
  }

  // ── #448: which of the three health readouts is on ───────────────────────────────────────────
  //
  // The mode is a single registry value read here and NOWHERE else, so every panel (both co-op
  // players) is always on the same readout and nothing can end up half-switched. Cycling rebuilds
  // the panels outright — the three readouts have completely different geometry, and a rebuild is
  // exactly the path a mid-sortie co-op join already takes, so it is a proven one.
  _readoutMode() { return normalizeReadoutMode(this.registry.get('hudReadout')); }

  _cycleReadout() {
    this.registry.set('hudReadout', nextReadoutMode(this._readoutMode()));
    this._buildPanels(Math.max(1, this._panelCount), this._playerSnapshots());
  }

  // One panel's integrity geometry, in whichever readout is currently on. All three return the same
  // shape (x/w/top/bottom/headerY/labelY/segments/shieldLabel/extraLabels), which is what lets the
  // console shell, the labels and the downed line stay mode-agnostic — and what lets `_buildPanels`
  // MEASURE the block (`availW: 0` = unsqueezed) before the band decides where to put it.
  // #452 (style pass): every block now hangs off its own LEFT edge, because the band packs them
  // into a centred run rather than pinning one to each screen edge.
  _integrityLayoutFor(anchorX, availW) {
    const box = { anchorX, side: 'left', bottomY: this.H - 10, availW };
    const mode = this._readoutMode();
    // #448: NONE is a zero-width block on the tile row's baseline — the band then drops the
    // block gap with it (data/hudLayout.js `consoleBand`) so the shell collapses to its tiles.
    if (mode === 'none') return noneLayout(box);
    if (mode === 'orbs') return orbLayout(box);
    if (mode === 'paperdoll') return paperDollLayout(INTEGRITY_ORDER, box);
    const bars = integrityLayout(INTEGRITY_ORDER, box);
    return {
      mode: 'bars',
      ...bars,
      shieldLabel: { x: bars.shield.x + bars.shield.w / 2, y: bars.labelY },
      extraLabels: [],
    };
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
      top: discReserveBottom(this._layout.count) + 20,
      right: margins.right, bottom: this.H - this._consoleTop + 6, left: margins.left,
    };
    this.lockWayMargins = {
      top: this.wayMargins.top + 16, right: this.wayMargins.right + 16,
      bottom: this.wayMargins.bottom + 16, left: this.wayMargins.left + 16,
    };
    // The circular map is pinned to the top-right corner (a function of W alone, which is constant),
    // so a co-op panel rebuild no longer moves it — nothing to recompute here.
  }

  // Build one player's set of objects at the layout's coordinates.
  //
  // #448: the integrity readout is now a block of VERTICAL bars in this panel's bottom corner,
  // sharing the skill-tile row's baseline, instead of a top-left column of horizontal bars with
  // numbers beside them. Its geometry all comes from `integrityLayout` (data/hudLayout.js) — the
  // scene paints, it doesn't decide — so #452 can reframe/reposition the block from those
  // constants alone. Only the labels/header are display objects; every bar is drawn into the one
  // Graphics layer each frame.
  _makePanel(spec, count, snapshot, group) {
    const color = snapshot?.color ?? playerColor(spec.index);
    const colStr = '#' + color.toString(16).padStart(6, '0');
    // #348's rule, reused: the identifying COLOUR only means something once there is a second
    // player to be told apart from, so solo's header stays the plain dim 'INTEGRITY'.
    const identify = showsPlayerColor(count);
    const panel = {
      index: spec.index, spec, columnX: group.blockX, color,
      partLabels: {}, skillRefs: {}, extras: [],
    };

    // #452 (style pass): both pieces are placed by the centred BAND — the integrity block first,
    // then this player's tile row immediately to its right — rather than each hugging a screen
    // edge with the leftovers in between. Nothing here has to negotiate for room any more: the
    // band already sized the group, so the block is laid out at full size (`availW: 0`).
    const tiles = tileRow(group.tilesX, group.tilesW, { bottom: this.H - 10, maxSize: CONSOLE_TILES.max });
    const last = tiles[tiles.length - 1];
    // #448: whichever of the three readouts is switched on. Same shape either way, so everything
    // below this line — header, labels, downed line, console bay — is mode-agnostic.
    const bars = this._integrityLayoutFor(group.blockX, 0);
    panel.bars = bars;
    panel.mode = bars.mode;
    const blank = bars.mode === 'none';
    // #448: with NO integrity block there is nothing for a header to head, and reserving its line
    // would leave exactly the hole the mode exists to remove — so the block's content ceiling
    // becomes the tile row itself and no header is created at all.
    if (blank) bars.headerY = tiles.length ? tiles[0].y : this.H - 10;

    panel.header = blank ? null : this.add.text(bars.x, bars.headerY, panelLabel(spec.index, count), {
      fontFamily: 'monospace', fontSize: '12px', color: identify ? colStr : C.dim,
    });
    panel.partBarsGfx = this.add.graphics();
    // Two-letter location label centred under each segment — which part, not how much of it: the
    // bar fill is the entire quantity readout (#448: no numbers anywhere).
    for (const seg of bars.segments) {
      panel.partLabels[seg.loc] = this.add.text(seg.cx, bars.labelY, LOCATION_INFO[seg.loc].short, {
        fontFamily: 'monospace', fontSize: '10px', color: C.dim,
      }).setOrigin(0.5, 0);
    }
    // #448: captions the SEGMENT loop above can't produce — the orb readout has no per-location
    // segments at all, so its HP/armor globe captions ride this channel instead.
    for (const l of bars.extraLabels ?? []) {
      panel.extras.push(this.add.text(l.x, l.y, l.text, {
        fontFamily: 'monospace', fontSize: '10px', color: C.dim,
      }).setOrigin(0.5, 0));
    }
    // ...and one for the whole mech's SHIELD, which is a pool rather than a segment. The paper doll
    // draws the shield as the outline around the entire doll, so it asks for no caption at all
    // (`shieldLabel: null`) and this is simply never created there.
    panel.shieldLabel = bars.shieldLabel
      ? this.add.text(bars.shieldLabel.x, bars.shieldLabel.y, 'SH', {
        fontFamily: 'monospace', fontSize: '10px', color: C.accent,
      }).setOrigin(0.5, 0).setVisible(false)
      : null;

    // A downed player must read as DOWN — WAITING/RESPAWN, not as a stale or zeroed block. The
    // bars themselves keep showing the wreck truthfully; this line says why nothing is happening
    // and how long it has left (data/hudLayout.js `panelStatusText`, off data/respawn.js's clock).
    // #452: it sits ON the header's line and hides the header while it shows — the two are
    // mutually exclusive states, and a second stacked text row made the console taller for a line
    // nobody ever sees at the same time as the other.
    // #448: in the NONE readout there is no header line to take over, so the downed line rides
    // centred over that player's own tile row instead — the tiles are dimmed to 0.3 while a player
    // is down, so it sits on a quiet surface either way.
    panel.statusText = blank
      ? this.add.text(group.tilesX + group.tilesW / 2, bars.headerY + 6, '', {
        fontFamily: 'monospace', fontSize: '11px', color: C.bad,
      }).setOrigin(0.5, 0).setVisible(false)
      : this.add.text(bars.x, bars.headerY, '', {
        fontFamily: 'monospace', fontSize: '11px', color: C.bad,
      }).setVisible(false);

    // Skill tiles for THIS player's own mech, in this panel's half of the bottom edge.
    panel.skillBar = this.add.container(0, 0);
    for (const r of tiles) {
      const id = snapshot?.mech?.mounts?.[r.loc]?.[0] ?? null;
      panel.skillRefs[r.loc] = drawSkillTile(this, panel.skillBar, r, { loc: r.loc, itemId: id });
    }
    panel.tileTop = tiles.length ? tiles[0].y : this.H - 10;
    // The row's outer box, so the console can recess a bay behind exactly what the tiles occupy.
    panel.tileBox = tiles.length
      ? { x: tiles[0].x, y: tiles[0].y, w: last.x + last.w - tiles[0].x, h: last.h }
      : null;

    this._makeTargetDisc(panel, spec, count);
    return panel;
  }

  // ── #452: the TARGET readout, as the top-left DISC ────────────────────────────────────────
  //
  // An ANIMATED preview of the unit this player currently has locked — the same `convergeTarget`
  // the red reticle is drawn on, so the two can never disagree — posed inside a circle in the
  // top-LEFT corner, mirroring the corner minimap top-right (Jackson: "the locked enemy preview
  // should be in a circle top left similar to the minimap on top right"). Both discs are the same
  // size, from one constant (`HUD_DISC`).
  //
  // Its condition rides three concentric GAUGE RINGS around the preview — structure, armor,
  // shield, outermost first, the same three layers in the same order the player's own block draws
  // as bars. Co-op stacks player 2's disc under player 1's: the right corner is the map's, and
  // each player is locked onto their own target, so one shared readout would be wrong for someone.
  _makeTargetDisc(panel, spec, count) {
    const box = targetDiscBox(spec.index);
    const disc = targetDiscLayout(box);
    panel.pod = disc;
    // Behind the art: the dark backing + frame. In front: the gauge rings, so a big posed unit
    // can never paint over its own readout.
    panel.podGfx = this.add.graphics().setDepth(19);
    panel.podArt = this.add.container(disc.cx, disc.cy).setDepth(20);
    panel.podRings = this.add.graphics().setDepth(21);
    // Clip the pose to the disc, exactly as the minimap clips its scrolling corridor.
    panel.podMask = this.make.graphics();
    panel.podArt.setMask(panel.podMask.createGeometryMask());
    panel.podMask.clear().fillStyle(0xffffff).fillCircle(disc.cx, disc.cy, disc.inner);
    // The unit name under the disc — the same slot the objective line takes under the map.
    panel.podName = this.add.text(disc.nameX, disc.nameY, '', {
      fontFamily: 'monospace', fontSize: '11px', color: C.dim,
    }).setOrigin(0.5, 0).setDepth(21);
    panel.podSig = undefined;   // identity of the art currently built (undefined = nothing built)
    panel.podAnim = null;
  }

  _destroyPanel(panel) {
    panel.podArt?.removeAll(true);
    // Drop the geometry mask with its container (a rebuild makes a fresh one), then the Graphics
    // the mask was cut from — otherwise a readout cycle leaves a mask per rebuild behind.
    panel.podArt?.clearMask(true);
    const objs = [
      panel.header, panel.partBarsGfx, panel.shieldLabel, panel.statusText, panel.skillBar,
      panel.podGfx, panel.podRings, panel.podArt, panel.podMask, panel.podName,
      ...Object.values(panel.partLabels), ...panel.extras,
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
  _updatePanel(panel, snapshot, delta = 16) {
    const mech = snapshot?.mech;
    const present = !!mech;
    panel.skillBar.setVisible(present);
    panel.statusText.setVisible(false);
    panel.header?.setVisible(present);   // #448: the NONE readout has no header at all
    this._updateTargetPod(panel, present ? snapshot : null, delta);
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
          // #451: the readout counts PROJECTILES, not trigger pulls — a 4-round rack of 5-missile
          // salvoes reads 20 and falls by 5 a pull. `magazineReadout` (data/weaponStats.js) is
          // where that conversion lives, keyed off `delivery.count` for every weapon rather than
          // special-casing the missiles; a single-shot gun's line is unchanged.
          const m = magazineReadout(w.weapon, w.ammo);
          opts.subtitle = `${m.left}/${m.max}`;
          opts.subtitleColor = w.ready ? C.good : C.warn;
          opts.ammoFrac = m.frac;
        }
      }
      updateSkillTile(panel.skillRefs[loc], opts);
    }

    this._updateIntegrity(panel, mech);

    // Downed: dim this player's own controls (they cannot use them) and say what they are
    // waiting on. Everything else in the panel keeps reading true.
    const status = panelStatusText(snapshot);
    panel.skillBar.setAlpha(snapshot.dead ? 0.3 : 1);
    // #452: the downed line takes the header's place rather than stacking above it.
    if (status) {
      panel.statusText.setText(status).setVisible(true);
      panel.header?.setVisible(false);
    }
  }

  // The target disc's per-frame refresh: rebuild its posed art when the locked unit changes,
  // redraw its gauge rings, and advance whatever that unit is doing (rotors, walk cycle, doors).
  _updateTargetPod(panel, snapshot, delta) {
    const disc = panel.pod;
    if (!disc) return;
    // A downed player has no live pick — the same rule the off-screen lock chevron follows.
    const t = snapshot && !snapshot.dead ? (snapshot.target ?? null) : null;
    const sig = t ? `${t.kind}|${t.texKey}|${t.damageSig}` : null;
    if (sig !== panel.podSig) {
      panel.podSig = sig;
      this._buildPodArt(panel, t);
    }

    // The name line under the disc — the unit you are locked on, in the reticle's own red; a dim
    // 'NO TARGET' when there is nothing, so the disc reads as idle instead of vanishing.
    const wide = Math.max(4, Math.floor(disc.r * 2 / 6.7));
    panel.podName.setText(t ? t.name.slice(0, wide) : 'NO TARGET').setColor(t ? POD_LIVE : C.dim);

    // The backing, painted once per box (it only moves on a rebuild) — same dark disc + bright
    // frame the minimap uses, so the two corners read as one pair of instruments.
    const g = panel.podGfx;
    g.clear();
    g.fillStyle(MM.panelFill, 0.92);
    g.fillCircle(disc.cx, disc.cy, disc.r);
    g.lineStyle(1, MM.panelInner, 0.8);
    g.strokeCircle(disc.cx, disc.cy, disc.r - 1.5);
    g.lineStyle(2, MM.panelStroke, 0.95);
    g.strokeCircle(disc.cx, disc.cy, disc.r);
    if (!t) {
      // Idle: a faint crosshair where the unit would stand.
      const r = 8;
      g.lineStyle(1, BAR_EDGE, 0.9);
      g.beginPath();
      g.moveTo(disc.cx - r, disc.cy); g.lineTo(disc.cx + r, disc.cy);
      g.moveTo(disc.cx, disc.cy - r); g.lineTo(disc.cx, disc.cy + r);
      g.strokePath();
    }

    // ...and the condition, in exactly the three layers the player's own block draws — structure,
    // armor, shield — wound round the disc as gauge arcs. Every ring's empty TRACK is drawn
    // whether or not that layer exists, for the same reason the bars keep their empty space: the
    // gap is half the readout.
    const rings = panel.podRings;
    const p = t?.pools ?? null;
    const layers = {
      hp: { frac: p?.hp ?? 0, color: HP_COLOR, on: !!p },
      armor: { frac: p?.armor ?? 0, color: ARMOR_PLATE, on: !!p?.hasArmor },
      shield: { frac: p?.shield ?? 0, color: SHIELD_BAR_COLOR, on: !!p?.hasShield },
    };
    rings.clear();
    for (const ring of disc.rings) {
      const layer = layers[ring.key];
      rings.lineStyle(ring.w, BAR_TRACK, 1);
      rings.strokeCircle(disc.cx, disc.cy, ring.r);
      const sweep = ringSweep(layer.on ? layer.frac : 0);
      if (!sweep.drawn) continue;
      rings.lineStyle(ring.w, layer.color, 1);
      rings.beginPath();
      rings.arc(disc.cx, disc.cy, ring.r, sweep.start, sweep.end, false);
      rings.strokePath();
    }

    this._animatePod(panel, t, delta);
  }

  // ── #465: RELEASE THE POSED ART THE INSTANT ITS TEXTURES ARE DESTROYED ────────────────────
  //
  // THE FREEZE. The pod is the only thing in the game that renders ANOTHER scene's per-instance
  // art: an enemy MECH owns a texture set keyed on its own id (`enemy31_hull_0`, `enemy31_turret`,
  // …) and arena/enemies.js `_destroyEnemy` removes that whole set the moment the unit dies.
  // Phaser's `Texture.destroy()` destroys every Frame, and `Frame.destroy()` nulls `frame.source`
  // while `Frame.glTexture` is a GETTER that reads `this.source.glTexture`. So a Sprite still
  // sitting in a display list holding one of those frames throws
  // `TypeError: null is not an object (evaluating 'this.source.glTexture')` from `batchSprite`
  // the next time it renders — and that throw comes out of Phaser's requestAnimationFrame
  // callback, which is NOT rescheduled after an exception (dom/RequestAnimationFrame.js). The
  // loop stops for good: the game freezes on the last drawn frame. Killing an enemy mech you had
  // locked did it every single time; only mechs, because a vehicle kind's textures are SHARED
  // between siblings and deliberately never removed.
  //
  // WHY NOTHING ELSE SAVES US. Phaser's SceneManager UPDATES scenes in REVERSE order and RENDERS
  // them forward, so HudScene.update runs BEFORE ArenaScene.update every frame. The kill — and
  // the texture removal with it — therefore lands AFTER this scene has finished updating and
  // BEFORE anything renders. No per-frame liveness check here can ever see it in time, and no
  // amount of reordering inside ArenaScene.update helps either.
  //
  // So the release has to be driven by the texture manager's own teardown, not by a frame tick.
  // `TextureManager.remove()` emits `removetexture` synchronously right after destroying the
  // Texture, so this handler runs inside `_destroyEnemy` itself — the pod's sprites are destroyed
  // in the same call stack that killed their art, long before the frame renders. Order-independent
  // by construction, and it is a release, not a guard: nothing checks a null at the render site.
  _onTextureRemoved(key) {
    // The scan is cheap and the cache would otherwise keep bounds for a texture that no longer
    // exists (see art/inkBounds.js) — drop it on the same signal.
    this.ink?.drop(key);
    for (const panel of this.panels ?? []) {
      const prefix = panel.podAnim?.texPrefix;
      // `_destroyEnemy` removes a set key by key, so match the SET, not one key: whichever goes
      // first releases the whole pose, and the rest of the set then finds nothing to do.
      if (!prefix || !key.startsWith(prefix)) continue;
      this._buildPodArt(panel, null);
      panel.podSig = undefined;   // 'nothing built' — the next frame rebuilds from a live target
    }
  }

  // Build the posed sprites for one locked unit. Vehicles are the hull + turret pair the arena
  // stacks; mechs are the full six-sprite pose. Both are fitted to their INKED bounds rather than
  // their canvas — see art/inkBounds.js for why that is the whole ball game here.
  _buildPodArt(panel, t) {
    panel.podArt.removeAll(true);
    panel.podAnim = null;
    if (!t || !panel.pod || !t.texKey) return;
    const a = panel.pod.art;
    const box = Math.min(a.w, a.h);
    if (box <= 0) return;

    if (t.kind === 'mech') {
      if (!t.mech) return;
      // A mech re-skins IN PLACE as it loses parts (same keys, new pixels), so its cached ink
      // bounds have to be dropped when its DAMAGE changes — but only then. Re-acquiring the same
      // undamaged mech (sweeping the reticle back and forth across a fight) must not re-scan nine
      // 256px canvases every time; that is the one genuinely expensive thing this pod can do.
      this._podInkSig ??= new Map();
      if (this._podInkSig.get(t.texKey) !== t.damageSig) {
        this._podInkSig.set(t.texKey, t.damageSig);
        this.ink.drop(`${t.texKey}_`);
      }
      const u = this.ink.union(mechPreviewKeys(this.textures, t.texKey));
      if (!u) return;
      const s = fitScale(u.w, u.h, box);
      const ox = (u.texW / 2 - u.cx) * s, oy = (u.texH / 2 - u.cy) * s;
      const { hull } = poseMechInto(this, panel.podArt, t.texKey, t.mech, s, 0, ox, oy);
      // `texPrefix` names the texture SET this pose is assembled from, so `_onTextureRemoved`
      // can release the whole thing the moment the arena tears any of it down (#465).
      panel.podAnim = { texPrefix: `${t.texKey}_`, hull, prefix: `${t.texKey}_hull_`, frames: HULL_FRAMES, frame: 0, acc: 0 };
      return;
    }

    const keys = vehiclePreviewKeys(t.texKey, t);
    const live = [keys.hull, keys.turret].filter((k) => this.textures.exists(k));
    if (!live.length) return;
    const u = this.ink.union(live);
    if (!u) return;
    const s = fitScale(u.w, u.h, box);
    const ox = (u.texW / 2 - u.cx) * s, oy = (u.texH / 2 - u.cy) * s;
    // A vehicle kind's textures are SHARED across every live unit of that (art, theme) and so are
    // deliberately never removed (see `_destroyEnemy`) — this pose cannot be pulled out from under
    // us the way a mech's can. It carries `texPrefix` anyway so the #465 release rule is one rule
    // rather than a mech special case.
    const anim = { texPrefix: `${t.texKey}_`, spin: 0, rotor: POD_ROTOR_SPIN[t.art] ?? 0 };
    if (this.textures.exists(keys.hull)) {
      anim.hull = this.add.sprite(ox, oy, keys.hull).setScale(s);
      panel.podArt.add(anim.hull);
      if (t.legFrames) Object.assign(anim, { prefix: `${t.texKey}_hull_`, frames: t.legFrames, frame: 0, acc: 0 });
    }
    if (this.textures.exists(keys.turret)) {
      anim.turret = this.add.sprite(ox, oy, keys.turret).setScale(s);
      panel.podArt.add(anim.turret);
      anim.turretPrefix = t.turretFrames ? `${t.texKey}_turret_` : null;
    }
    panel.podAnim = anim;
  }

  // Advance the posed unit. Rotors spin at the arena's own rates, a legged/walking unit steps
  // through its baked cycle, and a multi-frame turret (the carrier's bay doors) simply renders
  // whatever frame the live unit is on — so what the pod shows is what that thing is doing.
  _animatePod(panel, t, delta) {
    const a = panel.podAnim;
    if (!a) return;
    if (a.rotor && a.turret) {
      a.spin += (delta / 1000) * a.rotor;
      a.turret.rotation = a.spin;
    }
    if (a.prefix && a.frames > 1 && a.hull) {
      a.acc += delta;
      if (a.acc >= POD_STEP_MS) {
        a.acc = 0;
        a.frame = (a.frame + 1) % a.frames;
        a.hull.setTexture(`${a.prefix}${a.frame}`);
      }
    }
    if (a.turretPrefix && a.turret) a.turret.setTexture(`${a.turretPrefix}${t?.turretFrame ?? 0}`);
  }

  // #452 (style pass): the dev overlays as ONE cluster, sitting on the console's top edge rather
  // than in the bottom corners the console now reaches into. Laid out left-to-right — the perf
  // block, then the control-method indicator, then the AI debug line — off each object's measured
  // width, so a longer GPU string pushes its neighbours along instead of drawing over them. No-op
  // in production, where none of these objects exist.
  _placeDevReadouts() {
    const y = (this._consoleTop ?? this.H) - 8;
    const gap = 18;
    let x = 16;
    for (const o of [this.fpsText, this.modeText, this.aiText]) {
      if (!o) continue;
      o.setOrigin(0, 1).setPosition(x, y);
      x += (o.width || 0) + gap;
    }
  }

  // Dev overlay label for the active input scheme. #346 added a third one, 'touch';
  // anything else still reads as mouse+keyboard.
  _inputModeLabel() {
    const m = this.registry.get('inputMode');
    return m === 'pad' ? 'CONTROLLER' : m === 'touch' ? 'TOUCH' : 'MOUSE + KB';
  }

  // `delta` (ms since the last frame) drives the #452 target readout's animation — the pod's
  // rotors/walk cycle are the only thing in this scene that moves under its own steam.
  update(time, delta = 16) {
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
    for (const panel of this.panels) this._updatePanel(panel, snapshots[panel.index], delta);

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
        .setText(complete ? 'COMPLETE' : line)
        .setColor(complete ? C.good : C.warn);
      // #449: the plate is measured off the line, so it is repainted with it.
      this._paintObjectivePanel();
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

    this._updateBuffHud(snapshots);
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
      // #449: the plate is measured off the line, so it is repainted with it.
      this._paintObjectivePanel();
      // Re-flow the cluster now every line's text (and so its width) is current.
      this._placeDevReadouts();
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

  // #448: paint whichever health readout is switched on (H cycles them). All three read the SAME
  // live mech and draw the SAME three layers — armor, structure, shield — with no numerals
  // anywhere; they differ only in how those three quantities are shaped. Geometry is decided in
  // data/healthReadout.js; this is the paint.
  _updateIntegrity(panel, mech) {
    // #448: NONE draws nothing at all — the mech's own display has to carry it.
    if (panel.mode === 'none') return panel.partBarsGfx.clear();
    if (panel.mode === 'orbs') return this._paintOrbReadout(panel, mech);
    if (panel.mode === 'paperdoll') return this._paintDollReadout(panel, mech);
    this._updatePartBars(panel, mech);
    this._updateShieldBar(panel, mech);
  }

  // ORBS: three ARPG-style globes that drain from the top down, aggregate over the whole mech
  // (structure, armor, shield). The fill is a circular SEGMENT, not a rect, so the liquid narrows
  // as it empties — that narrowing is what makes a globe read as a globe rather than a round bar.
  _paintOrbReadout(panel, mech) {
    const g = panel.partBarsGfx;
    const L = panel.bars;
    g.clear();
    const p = mechPools(mech, INTEGRITY_ORDER);
    const layers = {
      hp: { frac: p.hp, color: HP_COLOR, cap: HP_CAP, on: true },
      armor: { frac: p.armor, color: ARMOR_PLATE, cap: ARMOR_RIM, on: p.hasArmor },
      shield: { frac: p.shield, color: SHIELD_BAR_COLOR, cap: SHIELD_CAP, on: p.hasShield },
    };
    for (const orb of L.orbs) {
      const layer = layers[orb.key];
      // The empty vessel is always drawn — the same rule the bars follow, for the same reason: the
      // empty space IS half the readout.
      g.fillStyle(BAR_TRACK, 1);
      g.fillCircle(orb.cx, orb.cy, orb.r);
      if (layer.on && layer.frac > 0) {
        const pts = orbFillPolygon(orb.cx, orb.cy, orb.r, layer.frac);
        if (orb.key === 'shield') {
          // Same stand-in-for-a-blur trick the shield bar uses: oversized, fainter copies behind.
          for (const { pad, a } of SHIELD_GLOW) {
            g.fillStyle(SHIELD_BAR_COLOR, a);
            g.fillCircle(orb.cx, orb.cy, orb.r + pad);
          }
        }
        g.fillStyle(layer.color, 1);
        g.fillPoints(pts, true);
        // The water line, brightened, so the actual reading is crisp against the dark vessel.
        if (pts.length > 1) {
          g.lineStyle(1.5, layer.cap, 0.95);
          g.beginPath();
          g.moveTo(pts[0].x, pts[0].y);
          g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
          g.strokePath();
        }
      }
      g.lineStyle(1.5, BAR_EDGE, 0.9);
      g.strokeCircle(orb.cx, orb.cy, orb.r);
    }
    panel.shieldLabel?.setVisible(p.hasShield);
  }

  // PAPER DOLL: one rounded rect per damage-tracked location, arranged as a mech silhouette.
  // Per-segment FILL = that part's structure, per-segment OUTLINE = that part's armor, and ONE
  // outline around the whole doll = the mech's shield — exactly the three-layer reading the issue
  // asked for. An outline can only carry a fraction if it DRAINS around the frame, which is what
  // `perimeterRun` is for: the dim full perimeter is the track, the lit run over it is what's left.
  _paintDollReadout(panel, mech) {
    const g = panel.partBarsGfx;
    const L = panel.bars;
    const R = 3;   // segment corner rounding
    g.clear();
    for (const seg of L.segments) {
      const part = mech.parts[seg.loc];
      if (!part) continue;
      const destroyed = mech.isPartDestroyed(seg.loc);
      const hpFrac = part.maxHp > 0 ? Math.max(0, Math.min(1, part.hp / part.maxHp)) : 0;
      const armorFrac = part.maxArmor > 0 ? Math.max(0, Math.min(1, part.armor / part.maxArmor)) : 0;
      // The empty body: a dark cell showing how much of this part is already gone.
      g.fillStyle(BAR_TRACK, 1);
      g.fillRoundedRect(seg.x, seg.y, seg.w, seg.h, R);
      // FILL = structure, rising from the bottom of the part.
      const fh = seg.h * hpFrac;
      if (fh > 0) {
        g.fillStyle(HP_COLOR, 1);
        g.fillRect(seg.x, seg.y + seg.h - fh, seg.w, fh);
        g.fillStyle(HP_CAP, 0.9);
        g.fillRect(seg.x, seg.y + seg.h - fh, seg.w, 1.5);
      }
      // OUTLINE = armor: the whole perimeter dim as the track, the surviving run lit over it.
      g.lineStyle(2, BAR_EDGE, 0.9);
      g.strokeRect(seg.x, seg.y, seg.w, seg.h);
      const run = perimeterRun(seg, armorFrac);
      if (run.length > 1) {
        g.lineStyle(2.5, destroyed ? ARMOR_SEAM : ARMOR_RIM, 1);
        g.strokePoints(run, false);
      }
      if (destroyed) {
        g.lineStyle(1.5, HP_COLOR, 0.9);
        g.beginPath();
        g.moveTo(seg.x, seg.y);
        g.lineTo(seg.x + seg.w, seg.y + seg.h);
        g.moveTo(seg.x + seg.w, seg.y);
        g.lineTo(seg.x, seg.y + seg.h);
        g.strokePath();
      }
      panel.partLabels[seg.loc]?.setColor(destroyed ? C.bad : C.dim);
    }
    // ONE outline around ALL segments = the shield. Drawn last so it reads as a field OVER the
    // body, and only when this mech actually has one — an empty box around everything would say
    // "your shield is down" on a build that never had a shield at all.
    const p = mechPools(mech, INTEGRITY_ORDER);
    if (p.hasShield) {
      g.lineStyle(2, SHIELD_BAR_COLOR, 0.22);
      g.strokeRect(L.outline.x, L.outline.y, L.outline.w, L.outline.h);
      const run = perimeterRun(L.outline, p.shield);
      if (run.length > 1) {
        for (const { a } of SHIELD_GLOW) {
          g.lineStyle(5, SHIELD_BAR_COLOR, a);
          g.strokePoints(run, false);
        }
        g.lineStyle(2.5, SHIELD_CAP, 0.95);
        g.strokePoints(run, false);
      }
    }
  }

  // #448: the per-location integrity bars — one SEGMENT per damage-tracked location (the four
  // mount locations, which are also the kill condition), each segment a PAIR of vertical bars:
  // HP on the left, armor on the right. Armor absorbs before HP does, so in play the right-hand
  // bar of a pair is the one that drains first and the left one only starts moving once that
  // part is stripped. Both bars always show their empty space — armor's because a repair can
  // fill it back in, HP's because the damage you can never get back is exactly what has to stay
  // legible. No numbers, by design: the fill IS the readout.
  //
  // A destroyed part gets a red cross over its pair, which is the numberless replacement for the
  // old 'DESTROYED' text (its bars are already empty; the cross says "and it is gone").
  _updatePartBars(panel, mech) {
    const g = panel.partBarsGfx;
    const L = panel.bars;
    g.clear();
    for (const seg of L.segments) {
      const p = mech.parts[seg.loc];
      if (!p) continue;
      const destroyed = mech.isPartDestroyed(seg.loc);
      drawBarTrack(g, seg.hpX, L.top, L.barW, L.barH);
      drawBarTrack(g, seg.armorX, L.top, L.barW, L.barH);
      drawHpBar(g, seg.hpX, L.top, L.barW, L.barH, p.maxHp > 0 ? p.hp / p.maxHp : 0);
      drawArmorBar(g, seg.armorX, L.top, L.barW, L.barH, p.maxArmor > 0 ? p.armor / p.maxArmor : 0);
      if (destroyed) {
        g.lineStyle(1.5, HP_COLOR, 0.9);
        g.beginPath();
        g.moveTo(seg.x, L.top);
        g.lineTo(seg.x + seg.w, L.top + L.barH);
        g.moveTo(seg.x + seg.w, L.top);
        g.lineTo(seg.x, L.top + L.barH);
        g.strokePath();
      }
      panel.partLabels[seg.loc]?.setColor(destroyed ? C.bad : C.dim);
    }
  }

  // #448: full-mech shield readout — the block's RIGHTMOST vertical bar, lining up alongside the
  // per-segment pairs, because the shield is one pool for the whole mech rather than per part.
  // Hidden entirely (bar + label) when the mech has no native shield at all (`hasShield()` false
  // — some enemy kinds and loadouts genuinely have none); its slot in the layout is reserved
  // either way so a shieldless build doesn't shift the other bars sideways.
  // #381: the bar physically GROWS with a live TEMPORARY pool — vertically now, so the track
  // climbs ABOVE the segment bars' top while the temp pool is up (base 100 + 150 temp ⇒ a bar
  // 2.5x tall, capped by `shield.maxGrowth`) and shrinks back to their height as it is spent.
  // That keeps #381's "truly grows, then you lose it" read; with no temp pool the maths reduces
  // exactly to a bar the same height as the segment bars beside it.
  _updateShieldBar(panel, mech) {
    const has = mech.hasShield?.() ?? false;
    panel.shieldLabel?.setVisible(has);
    if (!has) return;
    const L = panel.bars, g = panel.partBarsGfx, sh = L.shield;
    const baseMax = mech.shield.max || 0;
    const totalHp = mech.shieldTotalHp?.() ?? mech.shield.hp;
    const totalMax = mech.shieldTotalMax?.() ?? mech.shield.max;
    const growth = baseMax > 0 ? Phaser.Math.Clamp(totalMax / baseMax, 1, sh.maxGrowth) : 1;
    const trackH = L.barH * growth;
    drawBarTrack(g, sh.x, L.bottom - trackH, sh.w, trackH);
    const fillH = baseMax > 0 ? Phaser.Math.Clamp(L.barH * (totalHp / baseMax), 0, trackH) : 0;
    drawShieldBar(g, sh.x, L.bottom, sh.w, fillH);
  }

  // #60: draw one radial "draining" ring per active timed buff. Each is a rounded circular
  // timer, tinted the buff colour, whose arc empties clockwise from full to zero over the buff's
  // duration — a cooldown-pie. The label + remaining seconds sit to the left so several buffs
  // stack readably down the top-right. Text objects are pooled; the Graphics layer is redrawn
  // each frame. #409: instant buffs (Armor Patch AND Shield) never enter `activePowerups`, so they
  // never show a ring — only the timed buffs (Overdrive/Overclock/Barrage/Infinite Fire) do.
  // #394: a downed player's RESPAWN clock rides this same stack as one more row (Jackson: "HUD
  // timer + a better in-world cue" — the countdown in the powerup timers' visual language). It is
  // appended rather than given its own widget precisely so it inherits the idiom: same ring, same
  // radius, same label-and-seconds line to the left, same anchor. `respawnHudRows`
  // (data/respawn.js) decides which rows exist and what each says.
  _updateBuffHud(snapshots = this._playerSnapshots()) {
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

    // Every row this stack draws, in one list: the live timed buffs, then any downed player's
    // respawn clock (#394). One shape — label, colour, drain fraction, seconds — so the draw loop
    // below cannot treat them differently and the two can never drift apart visually.
    const rowsData = ids.map((id) => {
      const p = POWERUPS[id];
      return {
        label: p?.label ?? id,
        color: p?.color ?? 0xffffff,
        fraction: Math.max(0, Math.min(1, active[id] / (this._buffCache[id] || active[id]))),
        seconds: active[id] / 1000,
        holding: false,
      };
    }).concat(respawnHudRows(snapshots).map((r) => ({ ...r, color: r.color ?? C_RESPAWN_RING })));

    rowsData.forEach((row, i) => {
      const color = row.color;
      const colStr = '#' + color.toString(16).padStart(6, '0');
      const cy = y + R;
      const frac = row.fraction;

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

      // Label + seconds to the left of the ring. A respawn held on the out-of-combat gate says
      // HOLD instead of a stuck 0.0s — the same call the in-world marker makes.
      let t = this.buffTexts[i];
      if (!t) {
        t = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '12px' }).setOrigin(1, 0.5);
        this.buffTexts[i] = t;
      }
      t.setText(`${row.label}  ${row.holding ? 'HOLD' : `${row.seconds.toFixed(1)}s`}`)
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
    for (let i = rowsData.length; i < this.buffTexts.length; i++) this.buffTexts[i].setVisible(false);
  }
}
