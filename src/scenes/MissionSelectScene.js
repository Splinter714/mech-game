import Phaser from 'phaser';
import { offerMissions } from '../data/missions.js';
import { getBiome } from '../data/biomes.js';
import { rollOutpostThreat } from '../data/outposts.js';
import { OUTPOSTS_KEY, DEEP_MISSIONS_WON_KEY } from '../data/events.js';
import { saveOutposts } from '../data/save.js';
import { PadEdges, PAD } from '../input/Controls.js';
import { DirRepeater, dominantDir } from '../ui/padNav.js';
import { launchMission } from './base/launchMission.js';
import { wirePauseMenu } from './PauseMenuScene.js';
import { buildHexTextures, HEX_TEX_W, HEX_TEX_H, canopyTexKey, isCoverCanopyId } from '../art/hexArt.js';
import { ART_SCALE } from '../art/index.js';
import { HEX_SIZE } from '../data/hexgrid.js';
import { getTerrain } from '../data/terrain.js';

// #510: reached by walking onto the base's scanner hex. Presents a small set of candidate runs
// (data/missions.js `offerMissions`) — pick a card (click, or d-pad/stick + A on a controller),
// then hit Deploy to launch. #509/#514: this is now the ONLY place a run launches (GarageScene's
// own button just returns to base). Deliberately a full scene (like GarageScene) rather than a
// panel baked into BaseScene, for the same reason GarageScene is its own scene: a modal decision
// screen that takes over the whole view, entered and exited by a full scene swap.
//
// #509 Stage 5: this is also where outpost threat gets rolled (data/outposts.js
// `rollOutpostThreat`) — "each time the base-scan/mission-select surface is opened," per the
// #297 design conversation. There's no dedicated "defend" mission yet, so a threatened outpost
// just shows as a warning here; committing to ANY mission resolves it (launchMission.js).
//
// #514: offers are gated by which biomes are unlocked (data/missions.js `unlockedBiomes`,
// currently every biome — see its own UNLOCK_ALL_BIOMES) — the frontier biome's offer is
// flagged `isDeep` ("DEEP STRIKE"); winning it unlocks the next biome.
//
// Pad support: cards lay out in a wrapping GRID (as many columns as comfortably fit), so pad
// navigation is 2-D — d-pad/left-stick moves the focus by row+column, A deploys the focused card
// directly (no separate confirm-then-deploy step needed on pad, since moving focus already
// selects), B returns to base. #535 dropped START as a second deploy trigger — START now opens
// the shared pause menu everywhere (see PauseMenuScene.js), and this scene's own PadEdges was
// independently edge-tracking the same button, so a Start press would have fired both actions
// in the same frame. Mirrors GarageScene's own pad-wake convention: the first pad input just
// reveals the cursor rather than also moving it.
const UI = {
  text: '#c8d2dd', accent: '#5ec8e0', bad: '#e2533a', deep: '#efc14a', dim: '#565f6b',
  panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744, selected: 0x24404a,
};

const CARD_W = 180, CARD_H = 220, GAP_X = 20, GAP_Y = 20;

export default class MissionSelectScene extends Phaser.Scene {
  constructor() {
    super('MissionSelectScene');
  }

  create() {
    // #546-ish (live chat ask, not filed): bake hex textures unconditionally so each mission
    // card can show a small preview cluster of its biome's terrain tiles, regardless of whether
    // BaseScene/ArenaScene already baked them this session (buildHexTextures is idempotent).
    buildHexTextures(this);

    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);
    this.cameras.main.setBackgroundColor('#0d1014');
    this.cameras.main.fadeIn(300, 13, 16, 20);

    this.add.text(this.W / 2, 44, 'SELECT A RUN', {
      fontFamily: 'monospace', fontSize: '22px', fontStyle: 'bold', color: UI.text,
    }).setOrigin(0.5);

    const attacked = this._rollOutpostThreat();
    if (attacked.length) {
      const list = attacked.map((o) => `${o.type.toUpperCase()} (${o.biomeId})`).join(', ');
      this.add.text(this.W / 2, 74, `⚠ UNDER ATTACK: ${list} — deploying elsewhere risks losing it`, {
        fontFamily: 'monospace', fontSize: '13px', color: UI.bad,
      }).setOrigin(0.5);
    }

    this._selected = null;
    this._focusIndex = -1;   // no pad focus yet — first pad input just wakes the cursor
    this._padActive = false;
    this._cardRects = new Map();   // offer.id -> rect, for repainting the selection highlight

    const deepMissionsWon = this.registry.get(DEEP_MISSIONS_WON_KEY) || 0;
    this._offers = offerMissions(Math.random, undefined, deepMissionsWon);

    // Wrap into a grid — as many columns as comfortably fit the window, rather than assuming a
    // single row (a fixed 3-wide layout doesn't scale once #514's gate opens up to 5+ biomes).
    const maxCols = Math.max(1, Math.floor((this.W - 40 + GAP_X) / (CARD_W + GAP_X)));
    this._cols = Math.min(this._offers.length, maxCols);
    this._rows = Math.max(1, Math.ceil(this._offers.length / this._cols));
    const totalW = this._cols * CARD_W + (this._cols - 1) * GAP_X;
    const totalH = this._rows * CARD_H + (this._rows - 1) * GAP_Y;
    const startX = (this.W - totalW) / 2;
    const startY = Math.max(100, (this.H - totalH) / 2 - 10);
    this._offers.forEach((offer, i) => {
      const col = i % this._cols, row = Math.floor(i / this._cols);
      this._buildCard(offer, startX + col * (CARD_W + GAP_X), startY + row * (CARD_H + GAP_Y), CARD_W, CARD_H);
    });

    this._buildDeployButton(startY + totalH + 50);

    this._footerHint = this.add.text(this.W / 2, this.H - 30, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#7c8794',
    }).setOrigin(0.5);
    this._refreshFooterHint();

    // #523: ESC used to return straight to base — it now always opens the shared pause menu
    // instead, per the issue's confirmed design. B (pad) still returns to base directly, below.
    wirePauseMenu(this);
    this.input.keyboard.on('keydown-D', () => this._deploy());

    this.padEdges = new PadEdges(this, 0);
    this.dirRepeat = new DirRepeater();
  }

  update() {
    const pad = this.padEdges.pad();
    if (!pad) return;
    if (this.padEdges.pressed(PAD.B)) { this.scene.start('BaseScene'); return; }
    if (this.padEdges.pressed(PAD.A)) {
      if (this._wakePad()) return;   // first pad press just reveals the cursor
      this._deploy();
      return;
    }
    const step = this.dirRepeat.step(this._padDir(pad), this.time.now);
    if (!step) return;
    if (this._wakePad()) return;
    if (step === 'left') this._moveFocus(-1, 0);
    else if (step === 'right') this._moveFocus(1, 0);
    else if (step === 'up') this._moveFocus(0, -1);
    else if (step === 'down') this._moveFocus(0, 1);
  }

  // First pad interaction just reveals the focus cursor (on whatever's already selected, or
  // card 0) rather than also moving/deploying — same "wake, don't act" convention GarageScene
  // uses for its own catalog cursor.
  _wakePad() {
    if (this._padActive) return false;
    this._padActive = true;
    this._refreshFooterHint();
    if (this._focusIndex < 0) {
      this._focusIndex = 0;
      this._selectOffer(this._offers[0]);
    }
    return true;
  }

  _padDir(pad) {
    const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    if (btn(PAD.DPAD_UP)) return 'up';
    if (btn(PAD.DPAD_DOWN)) return 'down';
    if (btn(PAD.DPAD_LEFT)) return 'left';
    if (btn(PAD.DPAD_RIGHT)) return 'right';
    const s = pad.leftStick;
    return s ? dominantDir(s.x, s.y) : null;
  }

  _moveFocus(dCol, dRow) {
    const n = this._offers.length;
    if (!n) return;
    const idx = this._focusIndex < 0 ? 0 : this._focusIndex;
    let col = idx % this._cols;
    let row = Math.floor(idx / this._cols);
    if (dCol) col = ((col + dCol) % this._cols + this._cols) % this._cols;
    if (dRow) row = ((row + dRow) % this._rows + this._rows) % this._rows;
    let next = row * this._cols + col;
    if (next >= n) next = n - 1;   // a short last row clamps back onto the nearest real card
    this._focusIndex = next;
    this._selectOffer(this._offers[next]);
  }

  _refreshFooterHint() {
    this._footerHint.setText(this._padActive
      ? '◀▶▲▼ CHOOSE   A DEPLOY   B BACK'
      : 'CLICK A MISSION, THEN DEPLOY   ESC — BACK TO BASE');
  }

  // Rolls threat on every held outpost (data/outposts.js `rollOutpostThreat`), persists the
  // result, and returns whichever outposts are now under attack (for the warning banner above).
  _rollOutpostThreat() {
    const outposts = this.registry.get(OUTPOSTS_KEY) ?? [];
    const rolled = rollOutpostThreat(outposts);
    if (rolled !== outposts) {
      this.registry.set(OUTPOSTS_KEY, rolled);
      saveOutposts(rolled);
    }
    return rolled.filter((o) => o.threatState === 'attacked');
  }

  _buildCard(offer, x, y, w, h) {
    const biome = getBiome(offer.biomeId);
    const rect = this.add.rectangle(x + w / 2, y + h / 2, w, h, UI.btn, 1)
      .setStrokeStyle(2, offer.isDeep ? UI.deep : UI.panelEdge)
      .setInteractive({ useHandCursor: true });
    this._cardRects.set(offer.id, rect);
    this._buildBiomePreview(biome, x + w / 2, y + 58);
    this.add.text(x + w / 2, y + 104, biome.name.toUpperCase(), {
      fontFamily: 'monospace', fontSize: '15px', fontStyle: 'bold', color: UI.text,
    }).setOrigin(0.5);
    this.add.text(x + w / 2, y + h - 24, offer.isDeep ? 'DEEP STRIKE' : 'EXPLORE', {
      fontFamily: 'monospace', fontSize: '12px', color: offer.isDeep ? UI.deep : UI.accent,
    }).setOrigin(0.5);
    rect.on('pointerover', () => { if (this._selected !== offer) rect.setFillStyle(UI.btnHover); });
    rect.on('pointerout', () => { if (this._selected !== offer) rect.setFillStyle(UI.btn); });
    rect.on('pointerdown', () => {
      this._focusIndex = this._offers.indexOf(offer);
      this._selectOffer(offer);
    });
  }

  // A quick-glance "what biome is this" cue (live-chat ask, not a filed issue): all 5 of the
  // biome's representative terrain roles — groundA, groundB, cover, hazard, channel — as a
  // real interlocking pointy-top hex cluster (3 tiles top row, 2 nested in the gaps below).
  // Never touches `deep` (boundary-only, no baked texture — see hexArt.js `isBoundaryTerrainId`).
  //
  // First pass here scaled the images by an arbitrary factor and derived spacing from the baked
  // TEXTURE's own padded canvas size (HEX_TEX_W/H, which include #465's bleed + a flat border),
  // so tiles never actually seamed — they only look right at the game's own convention: every
  // real hex tile is displayed via `.setScale(1/ART_SCALE)` (world.js), with neighbour spacing
  // computed from `HEX_SIZE` via hexgrid.hexToPixel's formula (same-row neighbours HEX_SIZE·√3
  // apart, rows HEX_SIZE·1.5 apart). Reproduce that exactly, then shrink the whole cluster
  // uniformly (spacing AND image scale together) to fit inside the card.
  _buildBiomePreview(biome, cx, cy) {
    const SQRT3 = Math.sqrt(3);
    const baseScale = 1 / ART_SCALE;              // the scale every real hex tile renders at
    const colStepBase = HEX_SIZE * SQRT3;         // true same-row neighbour spacing
    const rowStepBase = HEX_SIZE * 1.5;           // true row-to-row spacing
    const naturalW = 2 * colStepBase + HEX_TEX_W * baseScale;   // 3-wide row, edge to edge
    const targetW = CARD_W - 40;                  // comfortable margin inside the card
    const shrink = Math.min(1, targetW / naturalW);
    const scale = baseScale * shrink;
    const colStep = colStepBase * shrink, rowStep = rowStepBase * shrink;
    const spots = [
      { id: biome.groundA, dx: -colStep, dy: -rowStep / 2 },
      { id: biome.cover, dx: 0, dy: -rowStep / 2 },
      { id: biome.hazard, dx: colStep, dy: -rowStep / 2 },
      { id: biome.groundB, dx: -colStep / 2, dy: rowStep / 2 },
      { id: biome.channel, dx: colStep / 2, dy: rowStep / 2 },
    ];
    // #289/#464 (mirrors world.js's own terrain rendering): a terrain id's ground image is
    // ALWAYS `getTerrain(id).tex`, never a hand-built `hex_${id}` — most ids' tex happens to
    // equal `hex_${id}`, but cover ids don't get their own ground tile at all (a standing
    // forest shares its cleared twin's texture, `hex_forestCleared`), so hand-building the key
    // silently missed a real texture and rendered nothing. Cover ids additionally get the
    // tree/foliage canopy overlay layered on top, same as the real hex grid.
    for (const { id, dx, dy } of spots) {
      if (!id) continue;
      this.add.image(cx + dx, cy + dy, getTerrain(id).tex).setScale(scale);
      if (isCoverCanopyId(id)) {
        this.add.image(cx + dx, cy + dy, canopyTexKey(id)).setScale(scale);
      }
    }
  }

  // Selecting a card highlights it (and un-highlights whichever was selected before) and enables
  // the Deploy button — it does NOT launch anything by itself on its own (mouse/keyboard), per
  // the owner's ask: pick a mission, then hit Deploy to commit. A on pad does both steps in one
  // press once the cursor is already on a card, which is the natural pad idiom.
  _selectOffer(offer) {
    this._selected = offer;
    for (const [id, rect] of this._cardRects) rect.setFillStyle(id === offer.id ? UI.selected : UI.btn);
    this._refreshDeployButton();
  }

  _buildDeployButton(y) {
    this._deployRect = this.add.rectangle(this.W / 2, y, 200, 44, UI.btn, 1)
      .setStrokeStyle(2, UI.panelEdge)
      .setInteractive({ useHandCursor: true });
    this._deployText = this.add.text(this.W / 2, y, '▶ DEPLOY', {
      fontFamily: 'monospace', fontSize: '16px', fontStyle: 'bold', color: UI.dim,
    }).setOrigin(0.5);
    this._deployRect.on('pointerdown', () => this._deploy());
    this._refreshDeployButton();
  }

  _refreshDeployButton() {
    const enabled = !!this._selected;
    this._deployText.setColor(enabled ? UI.accent : UI.dim);
    this._deployRect.setStrokeStyle(2, enabled ? UI.accent : UI.panelEdge);
  }

  _deploy() {
    if (!this._selected) return;   // Deploy is inert until a mission is picked
    launchMission(this, this._selected.biomeId, this._selected.isDeep);
  }
}
