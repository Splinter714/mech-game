import Phaser from 'phaser';
import { buildTabBar, TAB_BAR_H } from '../ui/tabBar.js';
import { Slider } from '../ui/slider.js';
import { GROUPS, TRACK_OF, WAVE_PARAM, WAVES, WAVE_ABBR } from '../ui/musicTunerSpec.js';
import { Audio } from '../audio/index.js';
import { Mech } from '../data/Mech.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs } from '../data/save.js';
import { MECH_DEPLOYED } from '../data/events.js';

// Music tab (#2) — a full-screen Phaser rebuild of the old DOM tuner. Play/pause + a track
// switcher up top, then every instrument group laid out as its own horizontal COLUMN of live
// sliders (wired straight to Audio.setParam), with waveform pickers and DAW-style solo/mute.
// "Copy" dumps a paste-ready defaults block. Switching track rebuilds the body (re-reads the
// track's tempo/params).
const UI = {
  bg: '#0d1014', text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', good: '#7bd17b',
  sel: 0xefc14a, mute: 0xe06c6c, panel: 0x161b22, panelEdge: 0x2a333f, btn: 0x1a212b, btnHover: 0x232c38,
};
const COL_GAP = 14;
const ROW_H = 19;
const MIN_COL_W = 250;   // a column never gets narrower than this; extra groups wrap to new rows

export default class MusicScene extends Phaser.Scene {
  constructor() { super('MusicScene'); }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);
    this.cameras.main.setBackgroundColor(UI.bg);

    this.allMechs = this.registry.get('allMechs');
    const mech = this.allMechs?.[ACTIVE_MECH_KEY];
    const canDeploy = mech instanceof Mech ? mech.isComplete() : false;
    buildTabBar(this, { active: 'MusicScene', canDeploy, onDeploy: () => this._deploy() });

    Slider.attachDrag(this);
    this.body = this.add.container(0, 0);
    this.sliders = [];
    this.mixRefreshers = [];
    this._build();

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('GarageScene'));
  }

  // Tiny button helper → { rect, text, setActive(on, onColor) }.
  _button(parent, x, y, w, h, label, onClick, { size = 11, color = UI.text } = {}) {
    const rect = this.add.rectangle(x, y, w, h, UI.btn).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
    const text = this.add.text(x + w / 2, y + h / 2, label, { fontFamily: 'monospace', fontSize: `${size}px`, color }).setOrigin(0.5);
    rect.on('pointerover', () => rect.setFillStyle(UI.btnHover));
    rect.on('pointerout', () => rect.setFillStyle(UI.btn));
    rect.on('pointerdown', onClick);
    parent.add([rect, text]);
    const setActive = (on, onColor = UI.sel) => {
      rect.setFillStyle(on ? 0x1b2430 : UI.btn).setStrokeStyle(1, on ? onColor : UI.panelEdge);
      text.setColor(on ? Phaser.Display.Color.IntegerToColor(onColor).rgba : UI.text);
      rect.off('pointerout'); rect.on('pointerout', () => rect.setFillStyle(on ? 0x1b2430 : UI.btn));
    };
    return { rect, text, setActive };
  }

  _build() {
    this.body.removeAll(true);
    for (const s of this.sliders) s.destroy();
    this.sliders = [];
    this.mixRefreshers = [];

    this._buildControls();
    this._buildColumns();
  }

  _buildControls() {
    const y = TAB_BAR_H + 12;
    // Play / pause.
    this.playBtn = this._button(this.body, 16, y, 150, 30, '', () => { Audio.toggleMusic(); this._paintPlay(); });
    this._paintPlay();

    // Track switcher: one button per (style × mode) track id, highlighting the active one.
    let tx = 182;
    this.trackBtns = [];
    for (const id of Audio.trackIds) {
      const label = id.replace('-', ' ');
      const w = 12 + label.length * 7;
      const b = this._button(this.body, tx, y, w, 30, label, () => { Audio.setTrack(id); this._build(); }, { size: 10 });
      b.setActive(Audio.track === id);
      this.trackBtns.push(b);
      tx += w + 6;
    }

    // Copy settings (far right).
    this._button(this.body, this.W - 150, y, 134, 30, 'copy settings', () => this._copy(), { size: 11, color: UI.good });
  }

  _paintPlay() {
    const on = Audio.musicOn;
    this.playBtn.text.setText(on ? '⏸  pause music' : '▶  play music');
    this.playBtn.setActive(on, on ? UI.sel : 0x7bd17b);
    this.playBtn.text.setColor(on ? '#efc14a' : '#7bd17b');
  }

  // Lay the groups out as columns, but keep each at least MIN_COL_W wide: fit as many across
  // as the screen allows, then WRAP the rest to further rows (each row drops below the tallest
  // column above it). On a wide screen everything stays on one row; on a narrow one it spills.
  _buildColumns() {
    const top = TAB_BAR_H + 56;
    const avail = this.W - 28;
    const perRow = Math.max(1, Math.floor((avail + COL_GAP) / (MIN_COL_W + COL_GAP)));
    const colW = Math.floor((avail - (perRow - 1) * COL_GAP) / perRow);
    let x = 14, y = top, rowMaxH = 0;
    GROUPS.forEach(([name, rows], i) => {
      if (i > 0 && i % perRow === 0) { x = 14; y += rowMaxH + 16; rowMaxH = 0; }   // wrap to next row
      const h = this._buildColumn(name, rows, x, y, colW);
      rowMaxH = Math.max(rowMaxH, h);
      x += colW + COL_GAP;
    });
  }

  // Build one column at (x, top) of width w; returns its content height (for row wrapping).
  _buildColumn(name, rows, x, top, w) {
    const hasWave = !!WAVE_PARAM[name];
    const panelH = 28 + (hasWave ? 26 : 0) + rows.length * ROW_H + 8;
    this.body.add(this.add.rectangle(x - 6, top - 8, w + 12, panelH, UI.panel).setOrigin(0, 0).setStrokeStyle(1, UI.panelEdge));
    this.body.add(this.add.text(x, top, name.toUpperCase(), { fontFamily: 'monospace', fontSize: '11px', color: UI.accent }));
    let y = top + 20;

    // Optional waveform selector for this instrument.
    const waveKey = WAVE_PARAM[name];
    if (waveKey) {
      const bw = Math.floor((w - 9) / 4);
      const wbtns = [];
      const paint = () => wbtns.forEach(({ b, wv }) => b.setActive(Audio.params[waveKey] === wv, 0x5ec8e0));
      WAVES.forEach((wv, i) => {
        const b = this._button(this.body, x + i * (bw + 3), y, bw, 18, WAVE_ABBR[wv], () => { Audio.setParam(waveKey, wv); paint(); }, { size: 10 });
        wbtns.push({ b, wv });
      });
      paint();
      y += 26;
    }

    // Sliders.
    for (const [key, label, min, max, step] of rows) {
      const track = TRACK_OF[key];
      const sliderW = track ? w - 40 : w;
      const s = new Slider(this, {
        x, y, w: sliderW, labelW: 64, valueW: 30, label, min, max, step,
        value: Audio.params[key], onChange: (v) => Audio.setParam(key, v),
      });
      this.body.add(s.container);
      this.sliders.push(s);

      // DAW-style Solo / Mute for tracks with a mixer level.
      if (track) {
        const solo = this._button(this.body, x + w - 38, y, 17, 14, 'S', () => { Audio.soloTrack(track); this._refreshMix(); }, { size: 9 });
        const mute = this._button(this.body, x + w - 19, y, 17, 14, 'M', () => { Audio.muteTrack(track); this._refreshMix(); }, { size: 9 });
        const refresh = () => { solo.setActive(Audio.isSoloed(track), UI.sel); mute.setActive(Audio.isMuted(track), UI.mute); };
        refresh();
        this.mixRefreshers.push(refresh);
      }
      y += ROW_H;
    }
    return panelH;
  }

  _refreshMix() { for (const fn of this.mixRefreshers) fn(); }

  _copy() {
    const lines = Object.entries(Audio.params)
      .map(([k, v]) => `      ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v},`).join('\n');
    const text = `params = {\n${lines}\n    };`;
    navigator.clipboard?.writeText(text).catch(() => {});
    console.log('[MUSIC TUNER] settings:\n' + text);
    this._toast('copied! (also in console)');
  }

  _toast(msg) {
    this._toastText?.destroy();
    this._toastText = this.add.text(this.W / 2, this.H - 16, msg, {
      fontFamily: 'monospace', fontSize: '12px', color: UI.good, backgroundColor: '#161b22', padding: { x: 8, y: 4 },
    }).setOrigin(0.5).setDepth(60);
    this.tweens.add({ targets: this._toastText, alpha: 0, delay: 1200, duration: 500, onComplete: () => this._toastText?.destroy() });
  }

  _deploy() {
    const mech = this.allMechs?.[ACTIVE_MECH_KEY];
    if (mech) { mech.repairAll(); saveAllMechs(this.allMechs); }
    this.game.events.emit(MECH_DEPLOYED, ACTIVE_MECH_KEY);
    this.scene.start('ArenaScene');
  }
}
