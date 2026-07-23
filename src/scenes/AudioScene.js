import Phaser from 'phaser';
import { buildTabBar, attachPadTabCycle, TAB_BAR_H } from '../ui/tabBar.js';
import { Slider } from '../ui/slider.js';
import { GROUPS, TRACK_OF, WAVE_PARAM, WAVES, WAVE_ABBR } from '../ui/musicTunerSpec.js';
import { WeaponSfxPanel } from '../ui/weaponSfxPanel.js';
import { loadAutoFireEnabled, saveAutoFireEnabled } from '../ui/weaponCardList.js';
import { EXPLOSION_CATEGORIES, EXPLOSION_CATEGORY_LABEL, explosionSfxId } from '../audio/sfxParams.js';
import { SFX_UI_GROUPS, resolveSfxUiEntry } from '../audio/sfxDomains.js';
import { WEAPON_IDS } from '../data/weapons.js';
import { getItem } from '../data/items.js';
import { Audio } from '../audio/index.js';
import { Mech } from '../data/Mech.js';
import { ACTIVE_MECH_KEY } from '../data/rosters.js';
import { saveAllMechs } from '../data/save.js';
import { MECH_DEPLOYED } from '../data/events.js';

// The AUDIO tab (#470) — ONE dev-only sound-authoring screen holding everything sound-related.
// It was the MUSIC tab (#2, a full-screen Phaser rebuild of the old DOM tuner); #470 folded the
// SFX-authoring surface into it as a second section, taking that whole surface OUT of
// GarageScene so the mech lab renders identically in dev and production (no panel reserve, no
// dev-vs-prod layout branch left there at all).
//
// Two sections, switched by a small MUSIC / SFX button pair under the tab bar:
//   MUSIC — play/pause + a track switcher up top, then every instrument group laid out as its
//     own horizontal COLUMN of live sliders (wired straight to Audio.setParam), with waveform
//     pickers and DAW-style solo/mute. "Copy" dumps a paste-ready defaults block. Switching
//     track rebuilds the body (re-reads the track's tempo/params).
//   SFX — the per-sound tuner (the shared WeaponSfxPanel, #121) on the right, and on the left
//     the trigger rows that feed it: every weapon, the #107 destruction-explosion size
//     categories, and the `ui`/pickup cues (SFX_UI_GROUPS), plus the mech-lab catalog's
//     demo-sound toggle.
//
// The whole scene is only reachable via the dev-only AUDIO tab (see ui/tabBar.js, #296).
const UI = {
  bg: '#0d1014', text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', good: '#7bd17b',
  sel: 0xefc14a, mute: 0xe06c6c, panel: 0x161b22, panelEdge: 0x2a333f, btn: 0x1a212b, btnHover: 0x232c38,
};
const COL_GAP = 14;
const ROW_H = 19;
const MIN_COL_W = 250;   // a column never gets narrower than this; extra groups wrap to new rows

// SFX section layout. The tuner panel is a fixed-width right-hand column (as it was in the
// garage); the trigger blocks take the remaining width to its left.
const PANEL_W = 300;
const PANEL_GAP = 14;
const TRIG_H = 22;        // one trigger button
const TRIG_GAP = 6;       // gap between buttons in a row
const TRIG_HEADER_H = 18; // a block's header line
const BLOCK_GAP = 12;     // gap between stacked trigger blocks
const WEAPONS_PER_ROW = 5;
const AUTOFIRE_H = 24;

// Where the section switcher and the section content sit, measured from the tab bar.
const SWITCH_Y = TAB_BAR_H + 10;
const SWITCH_H = 24;
const CONTENT_TOP = TAB_BAR_H + 44;

const SECTIONS = [['music', 'MUSIC'], ['sfx', 'SFX']];

export default class AudioScene extends Phaser.Scene {
  constructor() { super('AudioScene'); }

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
    buildTabBar(this, { active: 'AudioScene', canDeploy, onDeploy: () => this._deploy() });
    attachPadTabCycle(this, 'AudioScene');   // SELECT cycles the top tabs (#70)

    Slider.attachDrag(this);
    this.body = this.add.container(0, 0);
    this.sliders = [];
    this.mixRefreshers = [];
    this.triggerBtns = [];
    // Which section is showing, remembered across visits (registry, not localStorage — a
    // session-scoped convenience, not a setting worth persisting).
    this.section = this.registry.get('audioSection') || 'music';
    this.selectedSfxId = null;   // the id currently loaded into the tuner panel
    this._build();

    this.input.keyboard.on('keydown-ESC', () => this.scene.start('GarageScene'));
    this.events.once('shutdown', () => this._destroyPanel());
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
    this.triggerBtns = [];
    this._weaponHeader = null;
    this._destroyPanel();

    this._buildSectionSwitch();
    if (this.section === 'sfx') this._buildSfx();
    else this._buildMusic();
  }

  _destroyPanel() {
    this.panel?.destroy();
    this.panel = null;
  }

  _setSection(section) {
    if (this.section === section) return;
    this.section = section;
    this.registry.set('audioSection', section);
    this._build();
  }

  // The MUSIC / SFX section switcher — the one control shared by both halves of the tab.
  _buildSectionSwitch() {
    let x = 16;
    for (const [key, label] of SECTIONS) {
      const w = 84;
      const b = this._button(this.body, x, SWITCH_Y, w, SWITCH_H, label, () => this._setSection(key), { size: 11 });
      b.setActive(this.section === key, 0x5ec8e0);
      x += w + 6;
    }
  }

  // ── MUSIC section ────────────────────────────────────────────────────────────────────────

  _buildMusic() {
    this._buildControls();
    this._buildColumns();
  }

  _buildControls() {
    const y = CONTENT_TOP;
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
    const top = CONTENT_TOP + 44;
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

  // ── SFX section (#470: moved here wholesale from GarageScene) ────────────────────────────

  // The tuner panel on the right + the trigger blocks on the left. Every trigger feeds the SAME
  // panel (a weapon, an explosion size category and a UI cue are all just sfxParams ids with a
  // stage list), so one `selectedSfxId` drives every block's highlight.
  _buildSfx() {
    const top = CONTENT_TOP;
    const bottom = this.H - 16;
    const listW = Math.max(280, this.W - 40 - PANEL_W - PANEL_GAP);
    const panelRegion = { x: 20 + listW + PANEL_GAP, y: top, w: PANEL_W - PANEL_GAP, h: bottom - top };
    // #470 playtest: the section used to open with NOTHING selected — an empty tuner reading
    // "Select a weapon" next to a wall of same-looking trigger buttons, which didn't read as a
    // picker at all. Default to the first weapon so the panel always has a subject and the
    // highlighted button always shows which one it is.
    if (!this._applySelection) {
      this.selectedSfxId = WEAPON_IDS[0];
      this._applySelection = () => this.panel.setWeapon(WEAPON_IDS[0]);
    }
    this.panel = new WeaponSfxPanel(this, panelRegion);
    this.body.add(this.add.rectangle(panelRegion.x - PANEL_GAP / 2, panelRegion.y, 1, panelRegion.h, UI.panelEdge).setOrigin(0.5, 0));
    // A rebuild (a section switch) re-points the panel at whatever was being worked on, so
    // flipping to MUSIC and back doesn't drop it. `_applySelection` is the clicked trigger's own
    // panel-pointing closure, minus any preview playback.
    this._applySelection?.();

    let y = top;
    // Every weapon's fire sound — this block is the selector the garage catalog's cards used
    // to be (#121); the mech lab's catalog is a player-facing shop again, not a tuner input.
    // It's framed and accent-headed (unlike the plain trigger rows below) because it IS the
    // "which weapon am I tuning?" control, and the first pass shipped it looking like just
    // another row of buttons.
    this._weaponNames = new Map(WEAPON_IDS.map((id) => [id, getItem(id).name]));
    const weaponEntries = WEAPON_IDS.map((id) => ({
      id, label: getItem(id).name, size: 10, apply: () => this.panel.setWeapon(id),
    }));
    const weaponsH = this._blockHeight(weaponEntries, WEAPONS_PER_ROW);
    this.body.add(this.add.rectangle(12, y - 10, listW + 16, weaponsH + 20, UI.panel)
      .setOrigin(0, 0).setStrokeStyle(1, UI.sel));
    y += this._triggerBlock(20, y, listW, '', weaponEntries, WEAPONS_PER_ROW, { live: true }) + BLOCK_GAP + 10;

    // #107: the destruction-explosion size categories, tuned through the same panel with a
    // friendly label instead of the raw `deathExplosion…` id.
    y += this._triggerBlock(20, y, listW, 'DESTRUCTION EXPLOSION — size category', EXPLOSION_CATEGORIES.map((category) => ({
      id: explosionSfxId(category),
      label: category[0].toUpperCase() + category.slice(1),
      apply: () => this.panel.setWeapon(explosionSfxId(category), EXPLOSION_CATEGORY_LABEL[category]),
    })), EXPLOSION_CATEGORIES.length) + BLOCK_GAP;

    // #178/#196/#207: the `ui` sfxDomains cues, one labelled block per SFX_UI_GROUPS row.
    // Selecting one also PLAYS it, so clicking a button is itself a quick preview.
    for (const group of SFX_UI_GROUPS) {
      const entries = group.ids.map((id) => {
        const entry = resolveSfxUiEntry(id);
        return {
          id: entry.id, label: entry.label, size: 10,
          apply: () => this.panel.setTarget(entry.id, { label: entry.label, stages: entry.stages }),
          preview: () => Audio.ui(entry.id, entry.stages[0][0]),
        };
      });
      y += this._triggerBlock(20, y, listW, group.header, entries, entries.length) + BLOCK_GAP;
    }

    this._buildAutofireRow(20, y, listW);
    this._paintTriggers();
  }

  // One labelled block of trigger buttons: a header line then `perRow` buttons per row, wrapping.
  // Returns the block's height so the caller can stack the next one under it.
  // `opts.live` marks the WEAPON block: its header is bright and names the current pick, and
  // it's kept on `this._weaponHeader` so `_paintTriggers` can retitle it on every click.
  _triggerBlock(x, y, w, header, entries, perRow, opts = {}) {
    const headerText = this.add.text(x, y, header, {
      fontFamily: 'monospace', fontSize: opts.live ? '12px' : '11px', color: opts.live ? UI.sel : UI.dim,
    });
    this.body.add(headerText);
    if (opts.live) this._weaponHeader = headerText;
    const cols = Math.max(1, Math.min(perRow, entries.length));
    const bw = Math.floor((w - TRIG_GAP * (cols - 1)) / cols);
    entries.forEach((entry, i) => {
      const bx = x + (i % cols) * (bw + TRIG_GAP);
      const by = y + TRIG_HEADER_H + Math.floor(i / cols) * (TRIG_H + TRIG_GAP);
      const rect = this.add.rectangle(bx, by, bw, TRIG_H, UI.btn).setOrigin(0, 0)
        .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
      const text = this.add.text(bx + bw / 2, by + TRIG_H / 2, entry.label, {
        fontFamily: 'monospace', fontSize: `${entry.size ?? 11}px`, color: UI.text,
      }).setOrigin(0.5);
      rect.on('pointerover', () => { if (this.selectedSfxId !== entry.id) rect.setFillStyle(UI.btnHover); });
      rect.on('pointerout', () => this._paintTriggers());
      rect.on('pointerdown', () => {
        this.selectedSfxId = entry.id;
        this._applySelection = entry.apply;
        entry.apply();
        entry.preview?.();          // a UI cue also PLAYS on click — the row is its own preview
        this._paintTriggers();
      });
      this.body.add([rect, text]);
      this.triggerBtns.push({ id: entry.id, rect, text });
    });
    return this._blockHeight(entries, perRow);
  }

  // A block's height, known before it's drawn (so a frame can be laid down behind it first).
  _blockHeight(entries, perRow) {
    const cols = Math.max(1, Math.min(perRow, entries.length));
    const rows = Math.ceil(entries.length / cols);
    return TRIG_HEADER_H + rows * TRIG_H + (rows - 1) * TRIG_GAP;
  }

  _paintTriggers() {
    for (const b of this.triggerBtns) {
      const on = b.id === this.selectedSfxId;
      b.rect.setFillStyle(on ? 0x2a3446 : UI.btn).setStrokeStyle(on ? 2 : 1, on ? UI.sel : UI.panelEdge);
      b.text.setColor(on ? '#efc14a' : UI.text);
    }
    if (this._weaponHeader) {
      const name = this._weaponNames?.get(this.selectedSfxId);
      this._weaponHeader.setText(name
        ? `TUNING WEAPON:  ${name.toUpperCase()}   — click another to switch`
        : 'CLICK A WEAPON TO TUNE ITS SOUND');
    }
  }

  // #197: the mech lab catalog's auto-fire demo SOUND toggle. Each weapon card in the mech lab
  // auto-fires a live shot/beam preview on a loop regardless (that visual animation is
  // unaffected), but it also plays the real fire/trajectory/impact sound, which is noisy while
  // browsing or tuning. The flag is persisted in localStorage (weaponCardList.js owns it), so
  // flipping it here takes effect the next time the mech lab's catalog is built.
  _buildAutofireRow(x, y, w) {
    this._autoFire = loadAutoFireEnabled();
    const paint = () => {
      const on = this._autoFire;
      this.autofireText.setText(on
        ? 'MECH LAB CATALOG DEMO SOUND: ON (click to mute)'
        : 'MECH LAB CATALOG DEMO SOUND: OFF (click to unmute)');
      this.autofireBtn.setFillStyle(on ? 0x1b2430 : UI.btn).setStrokeStyle(on ? 2 : 1, on ? UI.sel : UI.panelEdge);
    };
    this.autofireBtn = this.add.rectangle(x, y, w, AUTOFIRE_H, UI.btn)
      .setOrigin(0, 0).setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
    this.autofireText = this.add.text(x + w / 2, y + AUTOFIRE_H / 2, '', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.text,
    }).setOrigin(0.5);
    this.autofireBtn.on('pointerover', () => { if (!this._autoFire) this.autofireBtn.setFillStyle(UI.btnHover); });
    this.autofireBtn.on('pointerout', () => paint());
    this.autofireBtn.on('pointerdown', () => {
      this._autoFire = !this._autoFire;
      saveAutoFireEnabled(this._autoFire);
      paint();
    });
    this.body.add([this.autofireBtn, this.autofireText]);
    paint();
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
