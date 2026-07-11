import Phaser from 'phaser';
import { Slider } from './slider.js';
import { Audio } from '../audio/index.js';
import { TRAJECTORY_DELAY } from '../audio/sfxParams.js';

// #107: the destruction-explosion size categories (deathExplosionSmall/Medium/Large/Massive)
// are tuned through this SAME panel — they're just more sfxParams ids (single `fire` stage,
// no trajectory/impact) fed in by WeaponLabScene's category row via setWeapon(id, label). This
// prefix is how the panel tells "a category" from "a real weapon" apart for cosmetic tweaks
// only (the header label, the ▶ button's wording) — everything else (sliders/type-row/reset/
// copy) already works on any sfxParams id unchanged.
const EXPLOSION_ID_PREFIX = 'deathExplosion';

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

// `type` picker options, by layer kind — a tone's oscillator waveform vs. a noise layer's
// filter shape (its BiquadFilterNode type). Distinct sets since they mean different things.
const TONE_TYPES = ['sine', 'triangle', 'sawtooth', 'square'];
const TONE_ABBR = { sine: 'sin', triangle: 'tri', sawtooth: 'saw', square: 'sqr' };
const NOISE_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch'];
const NOISE_ABBR = { lowpass: 'low', highpass: 'high', bandpass: 'band', notch: 'notch' };
const TYPE_ROW_H = 22;

// Copy `text` to the clipboard, resolving to whether it actually landed. The async
// Clipboard API only exists in secure contexts (HTTPS/localhost); on plain-HTTP LAN
// (how the game is reached on mobile) `navigator.clipboard` is undefined, so fall back
// to the legacy hidden-textarea + execCommand path. Never throws — always a boolean.
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // secure-context API present but rejected (e.g. permission denied) — try fallback
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export class WeaponSfxPanel {
  constructor(scene, { x, y, w, h }) {
    this.scene = scene;
    this.region = { x, y, w, h };
    this.weaponId = null;
    this._lastPreviewAt = { fire: 0, trajectory: 0, impact: 0 };

    // Both containers stay at world (0,0) — the Slider widget caches absolute world
    // coordinates at construction time (it compares against pointer.worldX directly, not
    // through the container transform), so every child below must be built with the
    // region's x/y baked into its own position rather than relying on a positioned parent
    // container to shift it visually. Only `scroller`'s Y moves (for scroll), since Y never
    // feeds into a slider's value math, so vertical scroll doesn't have this problem.
    this.root = scene.add.container(0, 0);
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
    this._paintMask();
    this._build();
  }

  // `label` optionally overrides the header text (used by the destruction-explosion category
  // row — "DEATHEXPLOSIONSMALL" reads badly, "Small (drone / infantry)" doesn't). Omit it for
  // a real weapon id, where the id itself IS the label (unchanged behavior).
  setWeapon(weaponId, label = null) {
    this.weaponId = weaponId;
    this.weaponLabel = label;
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

  // A row of small buttons picking `layer.type` — a tone's waveform or a noise layer's
  // filter shape, whichever `layer.kind` calls for. Repaints in place (no full rebuild) so
  // dragging sliders elsewhere in the panel isn't disturbed by a waveform change.
  _typeRow(x, y, w, layer, weaponId, stage, li) {
    const isNoise = layer.kind === 'noise';
    const types = isNoise ? NOISE_TYPES : TONE_TYPES;
    const abbr = isNoise ? NOISE_ABBR : TONE_ABBR;
    const gap = 3;
    const bw = Math.floor((w - (types.length - 1) * gap) / types.length);
    const btns = [];
    const paint = () => btns.forEach(({ rect, tw }) => {
      const on = layer.type === tw;
      rect.setFillStyle(on ? 0x1b2430 : UI.btn).setStrokeStyle(1, on ? UI.accent : UI.edge);
    });
    types.forEach((tw, i) => {
      const bx = x + i * (bw + gap);
      const rect = this.scene.add.rectangle(bx, y, bw, 16, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.edge).setInteractive({ useHandCursor: true });
      const text = this.scene.add.text(bx + bw / 2, y + 8, abbr[tw], { fontFamily: 'monospace', fontSize: '8px', color: UI.text }).setOrigin(0.5);
      rect.on('pointerdown', () => {
        Audio.setSfxParam(weaponId, stage, li, 'type', tw);   // mutates the same layer object
        paint();
        this._previewThrottled(stage);
      });
      this.scroller.add([rect, text]);
      btns.push({ rect, tw });
    });
    paint();
  }

  _build() {
    for (const s of this.sliders) s.destroy();
    this.sliders = [];
    this.scroller.removeAll(true);
    const { x: ox, y: oy, w } = this.region;   // origin to bake into every child below

    if (!this.weaponId) {
      this.scroller.add(this.scene.add.text(ox, oy, 'Select a weapon\nto tune its sound.', {
        fontFamily: 'monospace', fontSize: '12px', color: UI.dim, lineSpacing: 6,
      }));
      this._maxScroll = 0;
      return;
    }

    const isExplosion = this.weaponId.startsWith(EXPLOSION_ID_PREFIX);
    let y = oy;
    this.scroller.add(this.scene.add.text(ox, y, this.weaponLabel ?? this.weaponId.toUpperCase(), { fontFamily: 'monospace', fontSize: '13px', color: UI.accent }));
    y += 4;
    const bw = Math.floor((w - 8) / 3);
    this._button(ox, y + 18, bw, 22, isExplosion ? '▶ test boom' : '▶ test fire', () => this._testFire(), { color: UI.good });
    this._button(ox + bw + 4, y + 18, bw, 22, 'reset', () => this._reset());
    this._button(ox + (bw + 4) * 2, y + 18, bw, 22, 'copy', () => this._copy(), { color: UI.good });
    y += 50;

    const params = Audio.getSfxParams(this.weaponId);
    for (const [stage, label] of STAGES) {
      const layers = params[stage];
      if (!layers || !layers.length) continue;
      this.scroller.add(this.scene.add.text(ox, y, label, { fontFamily: 'monospace', fontSize: '11px', color: UI.text }));
      y += 18;
      layers.forEach((layer, li) => {
        this.scroller.add(this.scene.add.text(ox + 6, y, `layer ${li + 1} · ${layer.kind ?? 'tone'}`, {
          fontFamily: 'monospace', fontSize: '9px', color: UI.dim,
        }));
        y += 14;
        this._typeRow(ox + 6, y, w - 16, layer, this.weaponId, stage, li);
        y += TYPE_ROW_H;
        for (const field of FIELD_ORDER) {
          if (!(field in layer)) continue;
          const [min, max, step] = FIELD_SPEC[field];
          const s = new Slider(this.scene, {
            x: ox + 10, y, w: w - 10, labelW: 56, valueW: 44, label: FIELD_LABEL[field], min, max, step,
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
    this._maxScroll = Math.max(0, y - oy - this.region.h + 12);
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
    console.log(`[SFX TUNER] ${this.weaponId}:\n` + text);
    copyToClipboard(text).then((ok) => {
      this._toast(ok ? 'copied! (also in console)' : 'copy failed — see console');
    });
  }

  _toast(msg) {
    this._toastText?.destroy();
    const { x, y, w, h } = this.region;
    this._toastText = this.scene.add.text(x + w / 2, y + h - 16, msg, {
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
