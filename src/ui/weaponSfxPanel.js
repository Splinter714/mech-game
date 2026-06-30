import Phaser from 'phaser';
import { Slider } from './slider.js';
import { Audio } from '../audio/index.js';
import { TRAJECTORY_DELAY } from '../audio/sfxParams.js';

// Weapon Lab sound panel — a right-side column of live sliders for whichever weapon is
// selected in the card list, one section per stage (fire / trajectory / impact), one row
// per tunable field of each stage's layers (see audio/sfxParams.js for the data shape).
// Dragging a slider writes straight to Audio.sfxParams and plays that stage back (throttled)
// so the change is audible immediately. Mirrors the Music tab's tuner (same Slider widget,
// same "copy settings" convention), scoped to one weapon at a time instead of one global mix.
const UI = {
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', good: '#7bd17b', btn: 0x1a212b, btnHover: 0x232c38, edge: 0x2a333f,
};
const ROW_H = 18;
const STAGES = [['fire', 'FIRE (trigger pull)'], ['trajectory', 'TRAJECTORY (in flight)'], ['impact', 'IMPACT (on landing)']];
const PREVIEW_THROTTLE = 140;   // ms between live-preview replays while dragging a slider

// Only numeric fields get a slider; `type`/`kind` (waveform/filter shape) stay fixed —
// hand-edit via "copy settings" if a layer needs a different shape.
const FIELD_SPEC = {
  freq: [20, 4000, 5], freqEnd: [20, 4000, 5], dur: [0.005, 1, 0.005], gain: [0, 1, 0.01],
  attack: [0, 0.05, 0.001], q: [0.1, 6, 0.05],
};
const FIELD_ORDER = ['freq', 'freqEnd', 'dur', 'gain', 'attack', 'q'];
const FIELD_LABEL = { freq: 'freq', freqEnd: 'freq end', dur: 'dur', gain: 'gain', attack: 'attack', q: 'Q' };

export class WeaponSfxPanel {
  constructor(scene, { x, y, w, h }) {
    this.scene = scene;
    this.region = { x, y, w, h };
    this.weaponId = null;
    this._lastPreviewAt = { fire: 0, trajectory: 0, impact: 0 };

    this.root = scene.add.container(x, y);
    this.scroller = scene.add.container(0, 0);
    this.root.add(this.scroller);
    this.sliders = [];
    this._scrollY = 0;
    this._maxScroll = 0;

    this.maskG = scene.make.graphics();
    this._paintMask();
    this.scroller.setMask(this.maskG.createGeometryMask());

    this._onWheel = (p, _o, _dx, dy) => { if (this._inRegion(p)) this._setScroll(this._scrollY + dy); };
    scene.input.on('wheel', this._onWheel);

    this._build();
  }

  _paintMask() {
    const { x, y, w, h } = this.region;
    this.maskG.clear().fillStyle(0xffffff).fillRect(x, y, w, h);
  }

  _inRegion(p) {
    const dpr = this.scene.registry.get('dpr') || 1;
    const { x, y, w, h } = this.region;
    const lx = p.x / dpr, ly = p.y / dpr;
    return lx >= x && lx <= x + w && ly >= y && ly <= y + h;
  }

  _setScroll(y) {
    this._scrollY = Phaser.Math.Clamp(y, 0, this._maxScroll);
    this.scroller.y = -this._scrollY;
  }

  setRegion(x, y, w, h) {
    this.region = { x, y, w, h };
    this.root.setPosition(x, y);
    this._paintMask();
    this._build();
  }

  setWeapon(weaponId) {
    this.weaponId = weaponId;
    this._scrollY = 0;
    this._build();
  }

  _button(x, y, w, h, label, onClick, { color = UI.text } = {}) {
    const rect = this.scene.add.rectangle(x, y, w, h, UI.btn).setOrigin(0, 0)
      .setStrokeStyle(1, UI.edge).setInteractive({ useHandCursor: true });
    const text = this.scene.add.text(x + w / 2, y + h / 2, label, { fontFamily: 'monospace', fontSize: '10px', color }).setOrigin(0.5);
    rect.on('pointerover', () => rect.setFillStyle(UI.btnHover));
    rect.on('pointerout', () => rect.setFillStyle(UI.btn));
    rect.on('pointerdown', onClick);
    this.scroller.add([rect, text]);
    return { rect, text };
  }

  _build() {
    for (const s of this.sliders) s.destroy();
    this.sliders = [];
    this.scroller.removeAll(true);
    const { w } = this.region;

    if (!this.weaponId) {
      this.scroller.add(this.scene.add.text(0, 0, 'Select a weapon\nto tune its sound.', {
        fontFamily: 'monospace', fontSize: '12px', color: UI.dim, lineSpacing: 6,
      }));
      this._maxScroll = 0;
      return;
    }

    let y = 0;
    this.scroller.add(this.scene.add.text(0, y, this.weaponId.toUpperCase(), { fontFamily: 'monospace', fontSize: '13px', color: UI.accent }));
    y += 4;
    const bw = Math.floor((w - 8) / 3);
    this._button(0, y + 18, bw, 22, '▶ test fire', () => this._testFire(), { color: UI.good });
    this._button(bw + 4, y + 18, bw, 22, 'reset', () => this._reset());
    this._button((bw + 4) * 2, y + 18, bw, 22, 'copy', () => this._copy(), { color: UI.good });
    y += 50;

    const params = Audio.getSfxParams(this.weaponId);
    for (const [stage, label] of STAGES) {
      const layers = params[stage];
      if (!layers || !layers.length) continue;
      this.scroller.add(this.scene.add.text(0, y, label, { fontFamily: 'monospace', fontSize: '11px', color: UI.text }));
      y += 18;
      layers.forEach((layer, li) => {
        this.scroller.add(this.scene.add.text(6, y, `layer ${li + 1} · ${layer.kind ?? 'tone'} · ${layer.type}`, {
          fontFamily: 'monospace', fontSize: '9px', color: UI.dim,
        }));
        y += 15;
        for (const field of FIELD_ORDER) {
          if (!(field in layer)) continue;
          const [min, max, step] = FIELD_SPEC[field];
          const s = new Slider(this.scene, {
            x: 10, y, w: w - 10, labelW: 56, valueW: 44, label: FIELD_LABEL[field], min, max, step,
            value: layer[field],
            onChange: (v) => {
              Audio.setSfxParam(this.weaponId, stage, li, field, v);
              this._previewThrottled(stage);
            },
          });
          this.scroller.add(s.container);
          this.sliders.push(s);
          y += ROW_H;
        }
        y += 8;
      });
      y += 6;
    }
    this._maxScroll = Math.max(0, y - this.region.h + 12);
    this._setScroll(this._scrollY);
  }

  _previewThrottled(stage) {
    const t = this.scene.time.now;
    if (t - this._lastPreviewAt[stage] < PREVIEW_THROTTLE) return;
    this._lastPreviewAt[stage] = t;
    if (stage === 'fire') Audio.fire({ id: this.weaponId });
    else if (stage === 'trajectory') Audio.trajectory(this.weaponId);
    else Audio.impact(this.weaponId);
  }

  // Fires the full sequence in context (fire -> trajectory -> impact), like a real shot.
  _testFire() {
    Audio.fire({ id: this.weaponId });
    this.scene.time.delayedCall(TRAJECTORY_DELAY, () => Audio.trajectory(this.weaponId));
    this.scene.time.delayedCall(300, () => Audio.impact(this.weaponId));
  }

  _reset() {
    Audio.resetSfxParams(this.weaponId);
    this._build();
    this._toast('reset to defaults');
  }

  _copy() {
    const params = Audio.getSfxParams(this.weaponId);
    const text = `  ${this.weaponId}: ${JSON.stringify(params, null, 2).replace(/\n/g, '\n  ')},`;
    navigator.clipboard?.writeText(text).catch(() => {});
    console.log(`[SFX TUNER] ${this.weaponId}:\n` + text);
    this._toast('copied! (also in console)');
  }

  _toast(msg) {
    this._toastText?.destroy();
    const { w, h } = this.region;
    this._toastText = this.scene.add.text(w / 2, h - 16, msg, {
      fontFamily: 'monospace', fontSize: '11px', color: UI.good, backgroundColor: '#161b22', padding: { x: 6, y: 3 },
    }).setOrigin(0.5).setScrollFactor(0);
    this.root.add(this._toastText);
    this.scene.tweens.add({ targets: this._toastText, alpha: 0, delay: 1200, duration: 400, onComplete: () => this._toastText?.destroy() });
  }

  destroy() {
    this.scene.input.off('wheel', this._onWheel);
    for (const s of this.sliders) s.destroy();
    this.root.destroy();
    this.maskG.destroy();
  }
}
