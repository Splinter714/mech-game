// #423 phase 2 / #440 — the GARAGE post-run stats screen. A self-contained modal overlay the Garage
// opens from its STATS button. It reads the cross-run history (data/statsHistory.js) and shows the
// selected run's report: a plain SUMMARY block plus two INTERACTIVE tables (weapons, enemies).
//
// #440 made the tables real: each is a grid of Phaser text cells (not one monospace blob) with
//   • CLICKABLE column headers that sort that table by that column (toggle asc/desc, arrow marker),
//   • HOVER tooltips defining every column,
//   • a bumped font size + row spacing for readability, and
//   • horizontal scroll (trackpad / shift-wheel) when a table is wider than the panel, plus
//     vertical scroll when the whole report is taller than the viewport.
// The brood-spawned subset line stays attached under its Drone parent when sorting (it's a subset,
// not an independently-sortable row). The pooled parent/subset accounting comes from
// runStatsEnemies.splitBroodSubsets (shared with the Copy export, so the two never disagree).
//
// The COPY button still exports the exact SAME tested plain-text layout (runReportText) — the
// interactive display is a separate view over the same reduced data. The CLEAR button is
// context-sensitive (#440): on ALL RUNS it wipes everything; on a single run it deletes just that
// run. Everything is procedural Phaser (no assets), matching the rest of the garage.
import { makeStatsHistory } from '../../data/statsHistory.js';
import {
  runReportText, runSummaryText, splitBroodSubsets, displayName,
} from '../../data/runStatsText.js';
import { aggregateRuns } from '../../data/runStats.js';
import {
  WEAPON_COLUMNS, ENEMY_COLUMNS, compareRows, defaultDir,
} from '../../data/runStatsColumns.js';

const COL = {
  scrim: 0x05070a,
  panel: 0x121820,
  edge: 0x2a333f,
  btn: 0x222b35,
  btnHover: 0x2c3744,
  headerBg: 0x1b2430,
  headerHover: 0x263241,
  text: '#c8d2dc',
  dim: '#7c8794',
  sub: '#94a2b0',
  accent: '#efc14a',
  good: '#7bd17b',
  tipBg: 0x0a0e13,
};

const FONT = 'monospace';
const CELL_PX = 13;          // #440: bumped from the old cramped 11px monospace
const ROW_H = 22;            // row pitch (font + breathing room)
const HEAD_H = 24;
const COL_GAP = 18;          // px between columns
const TITLE_PX = 13;

// Format a reduced-entry value for its column's fmt tag. Non-finite → '-'.
function fmtCell(v, fmt) {
  if (fmt === 'str') return String(v ?? '');
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return '-';
  switch (fmt) {
    case 'int': return String(Math.round(n));
    case 'pct': return `${(n * 100).toFixed(0)}%`;
    case 'secs': return `${(n / 1000).toFixed(1)}s`;
    case 'num':
    default: return n.toFixed(1);
  }
}

export class StatsOverlay {
  constructor(scene) {
    this.scene = scene;
    this.history = makeStatsHistory({});
    this.entries = [];
    this.index = 0;
    // Per-table interaction state, persisted across re-renders and view switches.
    this.sort = {
      weapon: { col: WEAPON_COLUMNS.findIndex((c) => c.key === 'damageDealt'), dir: -1 },
      enemy: { col: ENEMY_COLUMNS.findIndex((c) => c.key === 'damageToYou'), dir: -1 },
    };
    this.hoff = { weapon: 0, enemy: 0 };
    this.scrollY = 0;
    this._tables = [];        // laid-out table descriptors for hit-testing scroll
    this.layer = scene.add.container(0, 0).setDepth(2000).setVisible(false);
    this.layer.setScrollFactor?.(0);
    this._build();
  }

  _build() {
    const s = this.scene;
    const W = s.W, H = s.H;
    this.scrim = s.add.rectangle(0, 0, W, H, COL.scrim, 0.92).setOrigin(0, 0).setInteractive();
    const pad = 24;
    this.pad = pad;
    this.panel = s.add.rectangle(pad, pad, W - pad * 2, H - pad * 2, COL.panel, 1)
      .setOrigin(0, 0).setStrokeStyle(1, COL.edge);
    this.title = s.add.text(pad + 18, pad + 14, 'RUN STATS', {
      fontFamily: FONT, fontSize: '18px', color: COL.accent,
    });
    this.subtitle = s.add.text(pad + 18, pad + 40, '', {
      fontFamily: FONT, fontSize: '12px', color: COL.dim,
    });

    // Buttons row (bottom).
    const by = H - pad - 40;
    this.prevBtn = this._button(pad + 18, by, 96, 28, '◀ NEWER', () => this._step(-1));
    this.nextBtn = this._button(pad + 122, by, 96, 28, 'OLDER ▶', () => this._step(+1));
    const rx = (slot) => W - pad - 18 - 104 - slot * 112;   // slot 0 = rightmost
    this.closeBtn = this._button(rx(0), by, 104, 28, 'CLOSE', () => this.close());
    this.copyBtn = this._button(rx(1), by, 104, 28, 'COPY', () => this._copy());
    this.clearBtn = this._button(rx(2), by, 104, 28, 'CLEAR', () => this._askClear());

    // Scrollable content viewport: between the subtitle and the button row.
    this.vx = pad + 18;
    this.vy = pad + 64;
    this.vw = W - pad * 2 - 36;
    this.vh = (by - 14) - this.vy;
    this.content = s.add.container(this.vx, this.vy).setScrollFactor?.(0);
    const g = s.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0xffffff).fillRect(this.vx, this.vy, this.vw, this.vh);
    this.content.setMask(g.createGeometryMask());
    this._maskG = g;

    // Empty-state / fallback text (also used when there are no runs).
    this.empty = s.add.text(this.vx, this.vy, '', {
      fontFamily: FONT, fontSize: '13px', color: COL.dim, lineSpacing: 3,
    }).setVisible(false);

    this.layer.add([
      this.scrim, this.panel, this.title, this.subtitle, this.content, this.empty,
      this.prevBtn.r, this.prevBtn.t, this.nextBtn.r, this.nextBtn.t,
      this.clearBtn.r, this.clearBtn.t,
      this.copyBtn.r, this.copyBtn.t, this.closeBtn.r, this.closeBtn.t,
    ]);

    this._buildConfirm();
    this._buildTooltip();

    // Scroll: plain wheel = vertical; horizontal wheel / shift-wheel = pan the hovered table.
    s.input.on('wheel', (pointer, _over, dx, dy) => {
      if (!this.isOpen() || this.confirm.visible) return;
      const horizontal = Math.abs(dx) > Math.abs(dy) || !!pointer.event?.shiftKey;
      if (horizontal) {
        const t = this._tableAt(pointer.y);
        if (t) { this._panTable(t, (dx || dy)); return; }
      }
      this._scrollV(dy);
    });
  }

  _buildConfirm() {
    const s = this.scene;
    const W = s.W, H = s.H;
    const cw = 400, ch = 150;
    const cx = (W - cw) / 2, cy = (H - ch) / 2;
    this.confirm = s.add.container(0, 0).setDepth(2100).setVisible(false);
    this.confirm.setScrollFactor?.(0);
    const dim = s.add.rectangle(0, 0, W, H, COL.scrim, 0.55).setOrigin(0, 0).setInteractive();
    const box = s.add.rectangle(cx, cy, cw, ch, COL.panel, 1).setOrigin(0, 0)
      .setStrokeStyle(1, COL.edge);
    this.confirmMsg = s.add.text(cx + cw / 2, cy + 44, '', {
      fontFamily: FONT, fontSize: '15px', color: COL.text,
    }).setOrigin(0.5);
    this.confirmSub = s.add.text(cx + cw / 2, cy + 70, 'This cannot be undone.', {
      fontFamily: FONT, fontSize: '11px', color: COL.dim,
    }).setOrigin(0.5);
    const bw = 140, bh = 30, by = cy + ch - 46;
    const cancel = this._button(cx + 28, by, bw, bh, 'CANCEL', () => this._hideConfirm());
    const wipe = this._button(cx + cw - 28 - bw, by, bw, bh, 'DELETE', () => this._doConfirm());
    wipe.t.setColor('#e88');
    this.confirmBtn = wipe;
    this.confirm.add([dim, box, this.confirmMsg, this.confirmSub, cancel.r, cancel.t, wipe.r, wipe.t]);
    this.layer.add(this.confirm);
  }

  _buildTooltip() {
    const s = this.scene;
    this.tip = s.add.container(0, 0).setDepth(2200).setVisible(false);
    this.tip.setScrollFactor?.(0);
    this.tipBg = s.add.rectangle(0, 0, 10, 10, COL.tipBg, 0.97).setOrigin(0, 0)
      .setStrokeStyle(1, COL.accent);
    this.tipText = s.add.text(8, 6, '', {
      fontFamily: FONT, fontSize: '12px', color: COL.text,
      wordWrap: { width: 360 },
    }).setOrigin(0, 0);
    this.tip.add([this.tipBg, this.tipText]);
    this.layer.add(this.tip);   // added last → renders above the masked content
  }

  _showTip(str, x, y) {
    this.tipText.setText(str);
    const pw = this.tipText.width + 16;
    const ph = this.tipText.height + 12;
    this.tipBg.setSize(pw, ph);
    // Clamp within the panel so it never clips off-edge.
    const W = this.scene.W, H = this.scene.H;
    const minX = this.pad + 8, maxX = W - this.pad - 8 - pw;
    const minY = this.pad + 8, maxY = H - this.pad - 8 - ph;
    this.tip.setPosition(
      Math.max(minX, Math.min(maxX, x)),
      Math.max(minY, Math.min(maxY, y)),
    );
    this.tip.setVisible(true);
  }

  _hideTip() { this.tip.setVisible(false); }

  _button(x, y, w, h, label, onClick) {
    const s = this.scene;
    const r = s.add.rectangle(x, y, w, h, COL.btn).setOrigin(0, 0)
      .setStrokeStyle(1, COL.edge).setInteractive({ useHandCursor: true });
    const t = s.add.text(x + w / 2, y + h / 2, label, {
      fontFamily: FONT, fontSize: '12px', color: COL.text,
    }).setOrigin(0.5);
    r.on('pointerover', () => r.setFillStyle(COL.btnHover));
    r.on('pointerout', () => r.setFillStyle(COL.btn));
    r.on('pointerdown', onClick);
    return { r, t };
  }

  // ── CLEAR: context-sensitive (#440) ────────────────────────────────────────────────────────
  _askClear() {
    if (!this.entries.length) return;
    if (this._isAggIndex()) {
      this.confirmMsg.setText(`Wipe all ${this.entries.length} runs?`);
      this.confirmSub.setText('This cannot be undone.');
      this.confirmBtn.t.setText('WIPE');
    } else {
      this.confirmMsg.setText('Delete this run?');
      this.confirmSub.setText('Only this one run — the rest are kept.');
      this.confirmBtn.t.setText('DELETE');
    }
    this._hideTip();
    this.confirm.setVisible(true);
  }

  _hideConfirm() { this.confirm.setVisible(false); }

  _doConfirm() {
    if (this._isAggIndex()) {
      // ALL RUNS view → wipe everything.
      this.history.clear();
      this.entries = [];
      this.index = 0;
    } else {
      // Individual run → delete just this entry, then land on a valid neighbour.
      const cur = this._current();
      if (cur?.id != null) this.entries = this.history.remove(cur.id);
      else this.entries = this.history.list();
      // Clamp the browse index to the new view count (fall to the empty state if it was the last).
      this.index = Math.min(this.index, Math.max(0, this._viewCount() - 1));
    }
    this._hideConfirm();
    this._render();
  }

  open() {
    this.entries = this.history.list();
    this.index = this._hasAgg() ? 1 : 0;
    this.scrollY = 0;
    this.hoff = { weapon: 0, enemy: 0 };
    this.layer.setVisible(true);
    this._render();
  }

  close() { this._hideConfirm(); this._hideTip(); this.layer.setVisible(false); }

  isOpen() { return this.layer.visible; }

  _hasAgg() { return this.entries.length >= 2; }
  _viewCount() { return this.entries.length + (this._hasAgg() ? 1 : 0); }
  _isAggIndex() { return this._hasAgg() && this.index === 0; }

  _step(dir) {
    if (!this._viewCount()) return;
    this.index = Math.max(0, Math.min(this._viewCount() - 1, this.index + dir));
    this.scrollY = 0;
    this.hoff = { weapon: 0, enemy: 0 };
    this._render();
  }

  _current() { return this.entries[this._hasAgg() ? this.index - 1 : this.index] ?? null; }

  _render() {
    const total = this._viewCount();
    const showBrowse = total > 1;
    this.prevBtn.r.setVisible(showBrowse); this.prevBtn.t.setVisible(showBrowse);
    this.nextBtn.r.setVisible(showBrowse); this.nextBtn.t.setVisible(showBrowse);
    const haveRuns = this.entries.length > 0;
    this.clearBtn.r.setVisible(haveRuns); this.clearBtn.t.setVisible(haveRuns);
    this._hideTip();
    this.content.removeAll(true);
    this._tables = [];

    if (!haveRuns) {
      this.subtitle.setText('');
      this.empty.setVisible(true).setText(
        'No runs recorded yet.\n\nDeploy, fight, and finish a sortie — a run commits\non a win, a death, or a manual exit of 10s or more.',
      );
      this.copyBtn.r.setVisible(false); this.copyBtn.t.setVisible(false);
      return;
    }
    this.empty.setVisible(false);
    this.copyBtn.r.setVisible(true); this.copyBtn.t.setVisible(true);

    const run = this._viewRun();
    if (this._isAggIndex()) {
      this.subtitle.setText(`ALL RUNS   •   ${this.entries.length} pooled   •   view 1 / ${total}`);
    } else {
      const entry = this._current();
      const m = (entry.run ?? {}).meta ?? {};
      const when = this._ago(entry.id);
      const runRank = this._hasAgg() ? this.index : this.index + 1;
      this.subtitle.setText(
        `RUN ${runRank} / ${this.entries.length}   •   ${(entry.reason ?? '?').toUpperCase()}`
        + `   •   ${m.biome ?? '-'} / ${m.chassis ?? '-'}${when ? `   •   ${when}` : ''}`,
      );
    }
    this._resetCopyLabel();
    this._layoutReport(run);
  }

  _viewRun() {
    return this._isAggIndex() ? this._aggregate() : (this._current()?.run ?? {});
  }

  _aggregate() { return aggregateRuns(this.entries.map((e) => e.run ?? {})); }

  // Build the SUMMARY block + the two interactive tables into `this.content`.
  _layoutReport(run) {
    let y = 0;
    // SUMMARY (plain text — reuses the exact Copy-export summary lines).
    const summary = this.scene.add.text(0, y, runSummaryText(run), {
      fontFamily: FONT, fontSize: '13px', color: COL.text, lineSpacing: 3,
    });
    this.content.add(summary);
    y += summary.height + 18;

    // SAFETY NET (#440): the interactive tables must NEVER silently blank the screen. If anything
    // in the grid layout throws (e.g. an unexpectedly-shaped stored run), catch it, log the run
    // for diagnosis, and fall back to rendering the whole report as a plain-text block so the user
    // always sees their data.
    try {
      // WEAPONS table.
      const weaponRows = Object.values(run.weapons ?? {}).map((w) => ({ data: w, sub: null }));
      y = this._buildTable('weapons', 'WEAPONS', WEAPON_COLUMNS, weaponRows, y);
      y += 20;

      // ENEMIES table (pooled parents + brood subsets attached under each parent).
      y = this._buildTable('enemies', 'ENEMIES', ENEMY_COLUMNS, this._enemyRows(run), y);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[StatsOverlay] interactive table layout failed — falling back to text', err, run);
      y = this._layoutTextFallback(run, y);
    }

    this._contentHeight = y;
    this._applyScroll();
  }

  // Fallback renderer (#440): drop the whole run report in as one monospace text block. Reuses the
  // tested Copy-export layout so even a run the grid can't lay out is still fully readable.
  _layoutTextFallback(run, y0) {
    let text = '(report unavailable)';
    try { text = runReportText(run); } catch { /* keep the placeholder */ }
    const block = this.scene.add.text(0, y0, text, {
      fontFamily: FONT, fontSize: `${CELL_PX}px`, color: COL.text, lineSpacing: 2,
    });
    this.content.add(block);
    return y0 + block.height + ROW_H;
  }

  _enemyRows(run) {
    const { base, brood } = splitBroodSubsets(run.enemies ?? {});
    return Object.values(base).map((e) => ({
      data: { ...e, displayName: displayName(e.kind) },
      sub: brood[e.kind]
        ? { ...brood[e.kind], displayName: '  └ of which brood-spawned' }
        : null,
    }));
  }

  // Build one sortable table. Returns the y just past its bottom (in content-local coords).
  _buildTable(id, titleText, columns, rows, y0) {
    const s = this.scene;
    // `id` is the full table name ('weapons'/'enemies'); the per-table interaction state
    // (sort + horizontal offset) is keyed by the SHORT name ('weapon'/'enemy'). Map first —
    // indexing this.sort with the full id silently yields undefined and throws on .col (#440).
    const key = id === 'weapons' ? 'weapon' : 'enemy';
    const state = this.sort[key];
    const hoff = this.hoff[key] ?? 0;

    const title = s.add.text(0, y0, titleText, {
      fontFamily: FONT, fontSize: `${TITLE_PX}px`, color: COL.accent,
    });
    this.content.add(title);
    const tableTop = y0 + TITLE_PX + 8;

    if (!rows.length) {
      const none = s.add.text(12, tableTop, id === 'weapons' ? '(none fired)' : '(none encountered)', {
        fontFamily: FONT, fontSize: `${CELL_PX}px`, color: COL.dim,
      });
      this.content.add(none);
      return tableTop + ROW_H;
    }

    // Sort parents by the active column (subs stay attached to their parent).
    const col = columns[state.col] ?? null;
    const sorted = [...rows].sort((a, b) => compareRows(a.data, b.data, col, state.dir));

    // Create every cell text object first so we can measure column widths.
    const headerObjs = columns.map((c, ci) => {
      const label = ci === state.col ? `${c.label} ${state.dir < 0 ? '▼' : '▲'}` : c.label;
      return s.add.text(0, 0, label, {
        fontFamily: FONT, fontSize: `${CELL_PX}px`,
        color: ci === state.col ? COL.accent : COL.sub,
      });
    });
    const bodyRows = [];   // { objs:[], dim:bool }
    for (const r of sorted) {
      bodyRows.push({
        dim: false,
        objs: columns.map((c) => s.add.text(0, 0, fmtCell(r.data[c.key], c.fmt), {
          fontFamily: FONT, fontSize: `${CELL_PX}px`, color: COL.text,
        })),
      });
      if (r.sub) {
        bodyRows.push({
          dim: true,
          objs: columns.map((c) => s.add.text(0, 0, fmtCell(r.sub[c.key], c.fmt), {
            fontFamily: FONT, fontSize: `${CELL_PX}px`, color: COL.dim,
          })),
        });
      }
    }

    // Column widths = widest cell (header or body) in that column.
    const colW = columns.map((_, ci) => {
      let w = headerObjs[ci].width;
      for (const br of bodyRows) w = Math.max(w, br.objs[ci].width);
      return Math.ceil(w);
    });
    const colX = [];
    let x = 0;
    for (let ci = 0; ci < columns.length; ci++) { colX[ci] = x; x += colW[ci] + COL_GAP; }
    const tableWidth = x - COL_GAP;

    // Place header cells. First column left-aligned; the rest right-aligned like a stat sheet.
    const place = (obj, ci) => {
      const left = columns[ci].align === 'left' || ci === 0;
      if (left) obj.setPosition(colX[ci] - hoff, 0);
      else { obj.setOrigin(1, 0); obj.setPosition(colX[ci] + colW[ci] - hoff, 0); }
    };
    // header background strip
    const headBg = s.add.rectangle(0, tableTop, this.vw, HEAD_H, COL.headerBg, 1).setOrigin(0, 0);
    this.content.add(headBg);
    headerObjs.forEach((obj, ci) => {
      place(obj, ci);
      obj.y = tableTop + 4;
      this.content.add(obj);
      // Header interactivity: click to sort, hover for the column definition.
      obj.setInteractive({ useHandCursor: true });
      obj.on('pointerdown', () => this._sortBy(id, ci));
      obj.on('pointerover', () => {
        const sx = this.content.x + obj.x - (columns[ci].align === 'left' || ci === 0 ? 0 : obj.width);
        const sy = this.content.y + tableTop + HEAD_H + 2;
        this._showTip(columns[ci].def, sx, sy);
      });
      obj.on('pointerout', () => this._hideTip());
    });

    // Place body rows.
    let ry = tableTop + HEAD_H + 4;
    for (const br of bodyRows) {
      br.objs.forEach((obj, ci) => {
        place(obj, ci);
        obj.y = ry;
        this.content.add(obj);
      });
      ry += ROW_H;
    }

    // Record for scroll hit-testing.
    this._tables.push({
      key, localTop: tableTop, localBottom: ry, tableWidth,
    });

    return ry;
  }

  _sortBy(id, ci) {
    const state = this.sort[id === 'weapons' ? 'weapon' : 'enemy'];   // short-key state (#440)
    const columns = id === 'weapons' ? WEAPON_COLUMNS : ENEMY_COLUMNS;
    if (state.col === ci) state.dir = -state.dir;          // toggle
    else { state.col = ci; state.dir = defaultDir(columns[ci]); }
    this._hideTip();
    this._render();
  }

  _tableAt(screenY) {
    for (const t of this._tables) {
      const top = this.content.y + t.localTop;
      const bot = this.content.y + t.localBottom;
      if (screenY >= top && screenY <= bot) return t;
    }
    return null;
  }

  _panTable(t, delta) {
    const maxOff = Math.max(0, t.tableWidth - this.vw);
    this.hoff[t.key] = Math.max(0, Math.min(maxOff, (this.hoff[t.key] ?? 0) + delta));
    this._render();
  }

  _scrollV(dy) {
    const maxScroll = Math.max(0, (this._contentHeight ?? 0) - this.vh);
    if (maxScroll <= 0) return;
    this.scrollY = Math.max(0, Math.min(maxScroll, this.scrollY + dy));
    this._applyScroll();
  }

  _applyScroll() {
    const maxScroll = Math.max(0, (this._contentHeight ?? 0) - this.vh);
    this.scrollY = Math.max(0, Math.min(maxScroll, this.scrollY));
    this.content.y = this.vy - this.scrollY;
  }

  _copy() {
    if (!this.entries.length) return;
    const text = runReportText(this._viewRun());
    try {
      navigator.clipboard?.writeText(text);
      this.copyBtn.t.setText('COPIED ✓').setColor(COL.good);
    } catch {
      this.copyBtn.t.setText('COPY FAILED').setColor(COL.dim);
    }
    this.scene.time?.delayedCall?.(1400, () => this._resetCopyLabel());
  }

  _resetCopyLabel() { this.copyBtn.t.setText('COPY').setColor(COL.text); }

  _ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const mnt = Math.round(s / 60);
    if (mnt < 60) return `${mnt}m ago`;
    const h = Math.round(mnt / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
}
