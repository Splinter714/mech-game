import Phaser from 'phaser';
import { offerMissions } from '../data/missions.js';
import { getBiome } from '../data/biomes.js';
import { rollOutpostThreat } from '../data/outposts.js';
import { OUTPOSTS_KEY, DEEP_MISSIONS_WON_KEY } from '../data/events.js';
import { saveOutposts } from '../data/save.js';
import { launchMission } from './base/launchMission.js';

// #510: reached by walking onto the base's scanner hex. Presents a small set of candidate runs
// (data/missions.js `offerMissions`) — click a card to SELECT it, then hit Deploy to launch.
// #509/#514: this is now the ONLY place a run launches (GarageScene's own button just returns
// to base). Deliberately a full scene (like GarageScene) rather than a panel baked into
// BaseScene, for the same reason GarageScene is its own scene: a modal decision screen that
// takes over the whole view, entered and exited by a full scene swap.
//
// #509 Stage 5: this is also where outpost threat gets rolled (data/outposts.js
// `rollOutpostThreat`) — "each time the base-scan/mission-select surface is opened," per the
// #297 design conversation. There's no dedicated "defend" mission yet, so a threatened outpost
// just shows as a warning here; committing to ANY mission resolves it (launchMission.js).
//
// #514: offers are gated by which biomes are unlocked (data/missions.js `unlockedBiomes`) — the
// frontier biome's offer is flagged `isDeep` ("DEEP STRIKE"); winning it unlocks the next biome.
const UI = {
  text: '#c8d2dd', accent: '#5ec8e0', bad: '#e2533a', deep: '#efc14a', dim: '#565f6b',
  panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744, selected: 0x24404a,
};

export default class MissionSelectScene extends Phaser.Scene {
  constructor() {
    super('MissionSelectScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);
    this.cameras.main.setBackgroundColor('#0d1014');
    this.cameras.main.fadeIn(300, 13, 16, 20);

    this.add.text(this.W / 2, 60, 'SELECT A RUN', {
      fontFamily: 'monospace', fontSize: '22px', fontStyle: 'bold', color: UI.text,
    }).setOrigin(0.5);

    const attacked = this._rollOutpostThreat();
    if (attacked.length) {
      const list = attacked.map((o) => `${o.type.toUpperCase()} (${o.biomeId})`).join(', ');
      this.add.text(this.W / 2, 92, `⚠ UNDER ATTACK: ${list} — deploying elsewhere risks losing it`, {
        fontFamily: 'monospace', fontSize: '13px', color: UI.bad,
      }).setOrigin(0.5);
    }

    this._selected = null;
    this._cardRects = new Map();   // offer.id -> rect, for repainting the selection highlight

    const deepMissionsWon = this.registry.get(DEEP_MISSIONS_WON_KEY) || 0;
    const offers = offerMissions(Math.random, undefined, deepMissionsWon);
    const cardW = 220, cardH = 260, gap = 30;
    const totalW = offers.length * cardW + (offers.length - 1) * gap;
    const startX = (this.W - totalW) / 2;
    const cardY = this.H / 2 - cardH / 2;
    offers.forEach((offer, i) => this._buildCard(offer, startX + i * (cardW + gap), cardY, cardW, cardH));

    this._buildDeployButton(cardY + cardH + 50);

    this.add.text(this.W / 2, this.H - 30, 'ESC — back to base', {
      fontFamily: 'monospace', fontSize: '12px', color: '#7c8794',
    }).setOrigin(0.5);
    this.input.keyboard.on('keydown-ESC', () => this.scene.start('BaseScene'));
    this.input.keyboard.on('keydown-D', () => this._deploy());
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
    this.add.text(x + w / 2, y + 30, biome.name.toUpperCase(), {
      fontFamily: 'monospace', fontSize: '16px', fontStyle: 'bold', color: UI.text,
    }).setOrigin(0.5);
    this.add.text(x + w / 2, y + h - 30, offer.isDeep ? 'DEEP STRIKE' : 'EXPLORE', {
      fontFamily: 'monospace', fontSize: '12px', color: offer.isDeep ? UI.deep : UI.accent,
    }).setOrigin(0.5);
    rect.on('pointerover', () => { if (this._selected !== offer) rect.setFillStyle(UI.btnHover); });
    rect.on('pointerout', () => { if (this._selected !== offer) rect.setFillStyle(UI.btn); });
    rect.on('pointerdown', () => this._selectOffer(offer));
  }

  // Selecting a card highlights it (and un-highlights whichever was selected before) and enables
  // the Deploy button — it does NOT launch anything by itself, per the owner's ask: pick a
  // mission, then hit Deploy to commit.
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
