import Phaser from 'phaser';
import { offerMissions } from '../data/missions.js';
import { getBiome } from '../data/biomes.js';
import { launchMission } from './base/launchMission.js';

// #510: reached by walking onto the base's scanner hex. Presents a small set of candidate runs
// (data/missions.js `offerMissions` — currently just distinct biome picks, since there's no
// outpost/threat content yet to differentiate missions further) and launches whichever the
// player clicks. Deliberately a full scene (like GarageScene) rather than a panel baked into
// BaseScene, for the same reason GarageScene is its own scene: a modal decision screen that
// takes over the whole view, entered and exited by a full scene swap.
const UI = {
  text: '#c8d2dd', accent: '#5ec8e0', panelEdge: 0x2a333f, btn: 0x222b35, btnHover: 0x2c3744,
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

    const offers = offerMissions();
    const cardW = 220, cardH = 260, gap = 30;
    const totalW = offers.length * cardW + (offers.length - 1) * gap;
    const startX = (this.W - totalW) / 2;
    offers.forEach((offer, i) => this._buildCard(offer, startX + i * (cardW + gap), this.H / 2 - cardH / 2, cardW, cardH));

    this.add.text(this.W / 2, this.H - 30, 'ESC — back to base', {
      fontFamily: 'monospace', fontSize: '12px', color: '#7c8794',
    }).setOrigin(0.5);
    this.input.keyboard.on('keydown-ESC', () => this.scene.start('BaseScene'));
  }

  _buildCard(offer, x, y, w, h) {
    const biome = getBiome(offer.biomeId);
    const rect = this.add.rectangle(x + w / 2, y + h / 2, w, h, UI.btn, 1)
      .setStrokeStyle(2, UI.panelEdge)
      .setInteractive({ useHandCursor: true });
    this.add.text(x + w / 2, y + 30, biome.name.toUpperCase(), {
      fontFamily: 'monospace', fontSize: '16px', fontStyle: 'bold', color: UI.text,
    }).setOrigin(0.5);
    this.add.text(x + w / 2, y + h - 30, 'EXPLORE', {
      fontFamily: 'monospace', fontSize: '12px', color: UI.accent,
    }).setOrigin(0.5);
    rect.on('pointerover', () => rect.setFillStyle(UI.btnHover));
    rect.on('pointerout', () => rect.setFillStyle(UI.btn));
    rect.on('pointerdown', () => launchMission(this, offer.biomeId));
  }
}
