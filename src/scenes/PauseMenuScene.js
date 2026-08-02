// #523: a shared pause menu, reachable from every scene — ESC or the gamepad START button.
// #535: moved off SELECT/BACK, which is now freed up for the ready-up (Garage) / return-to-base
// (Arena) action instead — see GarageScene.js's `_toggleReady` pad wiring and ArenaScene.js's
// `toGarage()` pad wiring. START also closes the menu again (a toggle), same as B/ESC.
//
// Design: a small overlay Scene, `scene.launch()`ed on top of whichever scene opened it (the
// same launch-an-overlay pattern ArenaScene already uses for HudScene), while the opening scene
// — and, for Arena, HudScene alongside it — is `scene.pause()`d. Phaser's per-scene Keyboard/
// Input/Gamepad plugins all listen for their own scene's PAUSE/RESUME events and disable
// themselves accordingly, and a paused scene's `update()` is skipped entirely by Scene Systems'
// step() — so pausing genuinely stops movement/AI/input for the paused scene, not just visually
// covers it, with no extra wiring needed here beyond calling `scene.pause()`.
//
// `wirePauseMenu(scene, opts)` is the half every OTHER scene calls once from its own create():
// it registers ESC (event-based) and polls its own dedicated PadEdges for START on the scene's
// `update` event (Scene Systems always emits this once per active frame, whether or not the
// scene defines its own `update()` method — see ui/tabBar.js's `attachPadTabCycle`, the same
// trick) — so scenes with no `update()` of their own (AudioScene, ArtPreviewScene) still get
// working ESC/SELECT without gaining a full per-frame loop.
//
// `opts`:
//   pauseAlso   — extra scene keys to pause/resume alongside the opener (Arena passes
//                 ['HudScene'], its permanently-launched overlay).
//   getPlayers  — () => [...players] for the MOVEMENT row (Arena/Base only; omitted elsewhere,
//                 which reads as "no live mech to toggle" and disables that row).
//   arenaDebug  — #625: { spawnEnemy, resetEnemies, toggleAi, aiState } — the four dev actions
//                 that used to be bound to the arena's D-pad. Arena-only (nothing else has
//                 enemies on the field); its presence is what surfaces those dev rows at all.
import Phaser from 'phaser';
import { PadEdges, PAD } from '../input/Controls.js';
import { Audio } from '../audio/index.js';
import { applyMovementToggle } from './arena/shared.js';
import { Slider } from '../ui/slider.js';
import { dominantDir, DirRepeater } from '../ui/padNav.js';
import {
  DEV_NAV_ROWS, DEV_ARENA_ROWS, pauseRowIds, toggleRowLabel, navRowLabel, movementRowLabel,
  movementRowEnabled, actionRowLabel, aiToggleRowLabel,
} from '../data/pauseMenu.js';

const NAV_ROW_ID_SET = new Set(DEV_NAV_ROWS);
const ARENA_ROW_ID_SET = new Set(DEV_ARENA_ROWS);
import {
  loadShowVersion, saveShowVersion, loadShowPerf, saveShowPerf,
  loadShowControlMethod, saveShowControlMethod, loadShowAiDebug, saveShowAiDebug,
  loadDevUnlockAll, saveDevUnlockAll, loadMasterVolume, saveMasterVolume,
} from '../data/pauseSettings.js';

const UI = {
  backdrop: 0x05070a, panel: 0x161b22, panelEdge: 0x2a333f,
  row: 0x1a212b, rowHover: 0x232c38, rowOff: 0x1a212b,
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', sel: '#efc14a', off: '#4a525c',
};

const ROW_W = 340;
const ROW_H = 40;
const ROW_GAP = 10;

// Registry channel each toggle row reads/writes, plus its persistence pair — one small table
// instead of five near-identical branches scattered through the scene.
const TOGGLE_ROWS = {
  version: { channel: 'showVersion', load: loadShowVersion, save: saveShowVersion },
  perf: { channel: 'showPerf', load: loadShowPerf, save: saveShowPerf },
  controlMethod: { channel: 'showControlMethod', load: loadShowControlMethod, save: saveShowControlMethod },
  aiDebug: { channel: 'showAiDebug', load: loadShowAiDebug, save: saveShowAiDebug },
  // #555: replaces the old hardcoded shop.js UNLOCK_ALL flag with a dev-menu toggle.
  unlockAll: { channel: 'devUnlockAll', load: loadDevUnlockAll, save: saveDevUnlockAll },
};

// #558: step size for the VOLUME row's D-pad LEFT/RIGHT adjustment (mouse/touch drag on the
// slider itself is continuous, snapped to the Slider's own `step`).
const VOLUME_STEP = 0.05;

export default class PauseMenuScene extends Phaser.Scene {
  constructor() {
    super('PauseMenuScene');
  }

  init(data = {}) {
    this._returnKey = data.returnKey ?? null;
    this._pauseAlso = data.pauseAlso ?? [];
    this._getPlayers = typeof data.getPlayers === 'function' ? data.getPlayers : null;
    // #529: AUDIO/ART/STATS access, moved here from the scene-level tab bar. `dev` is set by
    // wirePauseMenu automatically (import.meta.env.DEV) — every caller gets it for free. `openStats`
    // is GarageScene-only (its own StatsOverlay instance); its mere presence is what makes the
    // STATS row exist at all (see pauseRowIds's `hasStats`).
    this._dev = !!data.dev;
    this._openStats = typeof data.openStats === 'function' ? data.openStats : null;
    // #625: the four arena dev actions that used to live on the arena's D-pad. Supplied only by
    // ArenaScene (see its wirePauseMenu call), exactly like `openStats` is Garage-only — its mere
    // presence is what makes those rows exist at all (pauseRowIds's `hasArenaDebug`), so pausing
    // in the Garage/Base/labs never shows an enemy action there's no field for.
    this._arenaDebug = (data.arenaDebug && typeof data.arenaDebug === 'object') ? data.arenaDebug : null;
    this._rowIds = pauseRowIds({
      dev: this._dev, hasStats: !!this._openStats, hasArenaDebug: !!this._arenaDebug,
    });
    this._cursor = 0;
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);

    this.add.rectangle(0, 0, this.W, this.H, UI.backdrop, 0.72).setOrigin(0, 0);

    // #625: a dev build now stacks up to 13 rows, which at the full 40+10 pitch can be taller
    // than a short browser window (the panel would centre off the top/bottom edge). Shrink the
    // row pitch just enough to fit, down to a readable floor; the normal case is unchanged.
    const { rowH, rowGap } = this._fitRows(this._rowIds.length);
    this._rowH = rowH;
    const panelH = this._rowIds.length * (rowH + rowGap) - rowGap + 96;
    const panelX = (this.W - ROW_W - 48) / 2;
    const panelY = (this.H - panelH) / 2;
    this.add.rectangle(panelX, panelY, ROW_W + 48, panelH, UI.panel).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge);
    this.add.text(this.W / 2, panelY + 28, 'PAUSED', {
      fontFamily: 'monospace', fontSize: '20px', color: UI.accent, fontStyle: 'bold',
    }).setOrigin(0.5);

    this._rows = [];
    const rowX = panelX + 24;
    let y = panelY + 64;
    for (const id of this._rowIds) {
      this._rows.push(this._buildRow(id, rowX, y));
      y += rowH + rowGap;
    }

    this.add.text(this.W / 2, panelY + panelH - 24, 'ESC / START — RESUME', {
      fontFamily: 'monospace', fontSize: '12px', color: UI.dim,
    }).setOrigin(0.5);

    this.input.keyboard.on('keydown-ESC', () => this._close());
    this._padEdges = new PadEdges(this, 0);
    this._stickRepeat = new DirRepeater();   // left-stick cursor/volume nav, mirrors D-pad below
    Slider.attachDrag(this);   // #558: the VOLUME row's slider drag needs this wired once

    this._refreshRows();
    this._highlight();
  }

  // #625: the row pitch that keeps `n` rows (plus the panel's 96px of title/footer chrome) inside
  // the window with a small margin — the full 40+10 whenever it fits, scaled down proportionally
  // (never past ~70%) when it doesn't.
  _fitRows(n) {
    const avail = this.H - 24 - 96;
    const needed = n * (ROW_H + ROW_GAP) - ROW_GAP;
    if (needed <= avail || avail <= 0) return { rowH: ROW_H, rowGap: ROW_GAP };
    const k = Math.max(0.7, avail / needed);
    return { rowH: Math.round(ROW_H * k), rowGap: Math.max(2, Math.round(ROW_GAP * k)) };
  }

  // One clickable row: a background rect + label text, both swapped out per-frame by
  // `_refreshRows` (label text) and mouse hover / `_highlight` (rect fill/stroke).
  // #558: VOLUME is the one row that isn't a plain label — it embeds an actual Slider widget
  // (ui/slider.js, the same component the dev AUDIO tab's tuner uses) instead of ON/OFF text.
  _buildRow(id, x, y) {
    const rowH = this._rowH ?? ROW_H;
    const rect = this.add.rectangle(x, y, ROW_W, rowH, UI.row).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true });
    rect.on('pointerover', () => { this._cursor = this._rowIds.indexOf(id); this._highlight(); });
    const row = { id, rect, enabled: true };
    if (id === 'volume') {
      row.slider = new Slider(this, {
        x: x + 12, y: y + Math.round((rowH - 20) / 2), w: ROW_W - 24, labelW: 60, valueW: 34,
        label: 'VOLUME', min: 0, max: 1, step: 0.05,
        value: loadMasterVolume(),
        onChange: (v) => this._setVolume(v),
      });
    } else {
      row.label = this.add.text(x + 16, y + rowH / 2, '', {
        fontFamily: 'monospace', fontSize: '14px', color: UI.text,
      }).setOrigin(0, 0.5);
      rect.on('pointerdown', () => this._activate(id));
    }
    return row;
  }

  // #558: apply + persist a new master volume — shared by the slider's own drag (onChange) and
  // the D-pad LEFT/RIGHT step adjustment in update().
  _setVolume(v) {
    saveMasterVolume(v);
    Audio.setParam('master', v);
  }

  // Pull each row's current label off the live registry/player state. Called on create() and
  // again after any toggle/action, so the menu never shows a stale value.
  _refreshRows() {
    for (const row of this._rows) {
      if (row.id === 'movement') {
        const players = this._getPlayers?.() ?? [];
        const enabled = movementRowEnabled(players);
        row.label.setText(movementRowLabel(players[0]?.legacyMovement)).setColor(enabled ? UI.text : UI.off);
        row.enabled = enabled;
      } else if (row.id === 'volume') {
        // The Slider repaints itself on drag/D-pad — nothing to sync here.
        row.enabled = true;
      } else if (NAV_ROW_ID_SET.has(row.id)) {
        // #529: AUDIO/ART/STATS — static labels, no ON/OFF state; always enabled (their mere
        // presence in this._rowIds already means they're relevant, see pauseRowIds).
        row.label.setText(navRowLabel(row.id)).setColor(UI.text);
        row.enabled = true;
      } else if (ARENA_ROW_ID_SET.has(row.id)) {
        // #625: SPAWN/RESET are static one-shot actions; AI MOVE/FIRE mirror the paused arena's
        // own live `enemyMove`/`enemyFire` flags (read back through `aiState`, not the registry,
        // which the arena only republishes from its paused-out update loop).
        if (row.id === 'aiMove' || row.id === 'aiFire') {
          const ai = this._arenaDebug?.aiState?.() ?? {};
          row.label.setText(aiToggleRowLabel(row.id, row.id === 'aiMove' ? ai.move : ai.fire));
        } else {
          row.label.setText(actionRowLabel(row.id));
        }
        row.label.setColor(UI.text);
        row.enabled = true;
      } else {
        const t = TOGGLE_ROWS[row.id];
        const on = this.registry.get(t.channel) === true;
        row.label.setText(toggleRowLabel(row.id, on)).setColor(UI.text);
        row.enabled = true;
      }
    }
  }

  // Repaint which row the cursor (mouse hover or D-pad) is on.
  _highlight() {
    this._rows.forEach((row, i) => {
      const on = i === this._cursor;
      row.rect.setFillStyle(on ? UI.rowHover : UI.row);
      row.rect.setStrokeStyle(on ? 2 : 1, on ? UI.accent : UI.panelEdge);
    });
  }

  _moveCursor(delta) {
    const n = this._rows.length;
    this._cursor = ((this._cursor + delta) % n + n) % n;
    this._highlight();
  }

  // Flip whichever row was activated (click, Enter/Space, or pad A on the highlighted row).
  // #529: AUDIO/ART/STATS are NAVIGATION, not toggles — they leave the pause menu entirely
  // rather than flipping a registry flag and staying open, so they're handled before (and
  // return before reaching) the toggle/movement path + the `_refreshRows()` that follows it.
  _activate(id) {
    const row = this._rows.find((r) => r.id === id);
    if (!row?.enabled) return;
    if (id === 'audio' || id === 'art') { this._navigateTo(id === 'audio' ? 'AudioScene' : 'ArtPreviewScene'); return; }
    if (id === 'stats') { this._openStatsAndClose(); return; }
    // #558: VOLUME has no click-to-activate action — the Slider's own hit area handles drag,
    // and D-pad LEFT/RIGHT (update(), below) handles the pad. Clicking the row background
    // (outside the slider track) is a no-op.
    if (id === 'volume') return;
    Audio.ui('menuNav');
    if (id === 'movement') {
      for (const p of this._getPlayers?.() ?? []) applyMovementToggle(p, { movementTogglePressed: true });
    } else if (ARENA_ROW_ID_SET.has(id)) {
      // #625: live arena dev actions, same shape as MOVEMENT above — reach into the PAUSED
      // ArenaScene through the accessors it handed us at launch and mutate its state directly.
      // A spawn/reset lands immediately (the paused scene still renders); the AI toggles take
      // effect the moment its update loop resumes.
      if (id === 'spawnEnemy') this._arenaDebug?.spawnEnemy?.();
      else if (id === 'resetEnemies') this._arenaDebug?.resetEnemies?.();
      else this._arenaDebug?.toggleAi?.(id === 'aiMove' ? 'move' : 'fire');
    } else {
      const t = TOGGLE_ROWS[id];
      const next = this.registry.get(t.channel) !== true;
      this.registry.set(t.channel, next);
      t.save(next);
    }
    this._refreshRows();
  }

  // #529: leave the paused scene behind entirely (STOP it, not resume — mirrors the old tab
  // bar's `scene.scene.start(tab.scene)`, which only one lab scene is ever active at a time for)
  // and start the dev scene fresh.
  _navigateTo(sceneKey) {
    Audio.ui('menuNav');
    if (this._returnKey) this.scene.stop(this._returnKey);
    for (const key of this._pauseAlso) this.scene.stop(key);
    this.scene.stop();
    this.scene.start(sceneKey);
  }

  // #529: STATS opens an overlay OWNED by the returning scene (GarageScene's StatsOverlay) — that
  // scene must be RESUMED (its input plugin re-enabled), not stopped, so the overlay's own buttons
  // are actually clickable. Simplest correct sequence: close exactly like ESC/SELECT would, then
  // fire the callback.
  _openStatsAndClose() {
    this._close();
    this._openStats?.();
  }

  _close() {
    Audio.ui('menuNav');
    if (this._returnKey) this.scene.resume(this._returnKey);
    for (const key of this._pauseAlso) this.scene.resume(key);
    this.scene.stop();
  }

  // #558: while the cursor is on the VOLUME row, D-pad LEFT/RIGHT nudges it by VOLUME_STEP —
  // the pad-only equivalent of dragging the slider (which needs a pointer).
  _adjustVolume(delta) {
    const row = this._rows[this._cursor];
    if (!row || row.id !== 'volume') return;
    const v = Phaser.Math.Clamp(Math.round((row.slider.value + delta) * 100) / 100, 0, 1);
    row.slider.setValue(v);
    this._setVolume(v);
  }

  update(time) {
    if (this._padEdges.pressed(PAD.START) || this._padEdges.pressed(PAD.B)) { this._close(); return; }
    if (this._padEdges.pressed(PAD.DPAD_DOWN)) this._moveCursor(1);
    if (this._padEdges.pressed(PAD.DPAD_UP)) this._moveCursor(-1);
    if (this._padEdges.pressed(PAD.DPAD_LEFT)) this._adjustVolume(-VOLUME_STEP);
    if (this._padEdges.pressed(PAD.DPAD_RIGHT)) this._adjustVolume(VOLUME_STEP);
    if (this._padEdges.pressed(PAD.A)) this._activate(this._rowIds[this._cursor]);
    // Left stick mirrors the D-pad exactly (up/down cursor, left/right volume step), same
    // auto-repeat cadence padNav.js's DirRepeater gives every other held-direction control.
    const ls = this._padEdges.pad()?.leftStick;
    const dir = ls ? dominantDir(ls.x, ls.y) : null;
    const step = this._stickRepeat.step(dir, time);
    if (step === 'up') this._moveCursor(-1);
    else if (step === 'down') this._moveCursor(1);
    else if (step === 'left') this._adjustVolume(-VOLUME_STEP);
    else if (step === 'right') this._adjustVolume(VOLUME_STEP);
  }
}

// #523: called once from each pause-able scene's own create(). Wires ESC (event-based) and a
// dedicated PadEdges polling START on the scene's `update` event, so the menu opens the same
// way from every scene regardless of whether that scene has its own per-frame update().
// #529: `dev` (import.meta.env.DEV) is passed through automatically — every caller gets the
// AUDIO/ART pause-menu rows for free in a dev build, with no per-scene wiring needed. `opts.
// openStats` (GarageScene-only) additionally surfaces the STATS row — see pauseRowIds.
// `opts.padStart` (default true) — set false to skip the gamepad START wiring entirely; ESC
// still opens the menu. GarageScene opts out of this so gamepad START is free to be its own
// ready-up trigger (see GarageScene.js's per-pad update loop) instead of colliding with it.
export function wirePauseMenu(scene, opts = {}) {
  const open = () => {
    if (scene.scene.isActive('PauseMenuScene')) return;   // already open — ignore a repeat edge
    Audio.ui('menuNav');
    const pauseAlso = opts.pauseAlso ?? [];
    scene.scene.launch('PauseMenuScene', {
      returnKey: scene.scene.key, pauseAlso, getPlayers: opts.getPlayers,
      dev: import.meta.env.DEV, openStats: opts.openStats, arenaDebug: opts.arenaDebug,
    });
    scene.scene.pause();
    for (const key of pauseAlso) scene.scene.pause(key);
  };
  scene.input.keyboard.on('keydown-ESC', open);
  if (opts.padStart !== false) {
    const edges = new PadEdges(scene, 0);
    const onUpdate = () => { if (edges.pressed(PAD.START)) open(); };
    scene.events.on('update', onUpdate);
    scene.events.once('shutdown', () => scene.events.off('update', onUpdate));
  }
}
