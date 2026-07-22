// #423 phase 2 — the GARAGE post-run stats screen. A self-contained modal overlay the Garage
// opens from its STATS button. It reads the cross-run history (data/statsHistory.js), shows the
// selected run's reduced report as a clean monospace readout (global summary + the per-weapon and
// per-enemy tables, straight from the SAME tested text layout the Copy button exports), lets the
// player browse prior runs newest-first, copies the plain-text report to the clipboard, and handles
// the empty state (no runs yet).
//
// Deliberately text/table-driven: this is a data screen, so aligned columns matter more than
// flourish, and reusing runStatsText.js's `runReportText` guarantees what's on screen is exactly
// what Copy yields. Everything is procedural Phaser (no assets), matching the rest of the garage.
import { makeStatsHistory } from '../../data/statsHistory.js';
import { runReportText } from '../../data/runStatsText.js';

const COL = {
  scrim: 0x05070a,
  panel: 0x121820,
  edge: 0x2a333f,
  btn: 0x222b35,
  btnHover: 0x2c3744,
  text: '#c8d2dc',
  dim: '#7c8794',
  accent: '#efc14a',
  good: '#7bd17b',
};

export class StatsOverlay {
  constructor(scene) {
    this.scene = scene;
    this.history = makeStatsHistory({});
    this.entries = [];
    this.index = 0;
    this.layer = scene.add.container(0, 0).setDepth(2000).setVisible(false);
    this.layer.setScrollFactor?.(0);
    this._build();
  }

  _build() {
    const s = this.scene;
    const W = s.W, H = s.H;
    // Full-screen scrim that also swallows clicks behind the modal.
    this.scrim = s.add.rectangle(0, 0, W, H, COL.scrim, 0.92).setOrigin(0, 0)
      .setInteractive();
    // Framed panel.
    const pad = 24;
    this.panel = s.add.rectangle(pad, pad, W - pad * 2, H - pad * 2, COL.panel, 1)
      .setOrigin(0, 0).setStrokeStyle(1, COL.edge);
    this.title = s.add.text(pad + 18, pad + 14, 'RUN STATS', {
      fontFamily: 'monospace', fontSize: '18px', color: COL.accent,
    });
    this.subtitle = s.add.text(pad + 18, pad + 40, '', {
      fontFamily: 'monospace', fontSize: '12px', color: COL.dim,
    });
    // The report body — monospace so the tables line up. Sized to fit; capped width so a wide
    // weapons table scrolls off the right edge rather than overrunning the panel border.
    this.body = s.add.text(pad + 18, pad + 70, '', {
      fontFamily: 'monospace', fontSize: '11px', color: COL.text, lineSpacing: 2,
    });

    // Controls row (bottom of the panel): browse prev/next, copy, close.
    const by = H - pad - 40;
    this.prevBtn = this._button(pad + 18, by, 96, 28, '◀ NEWER', () => this._step(-1));
    this.nextBtn = this._button(pad + 122, by, 96, 28, 'OLDER ▶', () => this._step(+1));
    this.copyBtn = this._button(W - pad - 18 - 220, by, 108, 28, 'COPY', () => this._copy());
    this.closeBtn = this._button(W - pad - 18 - 104, by, 104, 28, 'CLOSE', () => this.close());

    this.layer.add([
      this.scrim, this.panel, this.title, this.subtitle, this.body,
      this.prevBtn.r, this.prevBtn.t, this.nextBtn.r, this.nextBtn.t,
      this.copyBtn.r, this.copyBtn.t, this.closeBtn.r, this.closeBtn.t,
    ]);
  }

  _button(x, y, w, h, label, onClick) {
    const s = this.scene;
    const r = s.add.rectangle(x, y, w, h, COL.btn).setOrigin(0, 0)
      .setStrokeStyle(1, COL.edge).setInteractive({ useHandCursor: true });
    const t = s.add.text(x + w / 2, y + h / 2, label, {
      fontFamily: 'monospace', fontSize: '12px', color: COL.text,
    }).setOrigin(0.5);
    r.on('pointerover', () => r.setFillStyle(COL.btnHover));
    r.on('pointerout', () => r.setFillStyle(COL.btn));
    r.on('pointerdown', onClick);
    return { r, t };
  }

  open() {
    this.entries = this.history.list();   // newest-first
    this.index = 0;
    this.layer.setVisible(true);
    this._render();
  }

  close() { this.layer.setVisible(false); }

  isOpen() { return this.layer.visible; }

  _step(dir) {
    if (!this.entries.length) return;
    this.index = Math.max(0, Math.min(this.entries.length - 1, this.index + dir));
    this._render();
  }

  _current() { return this.entries[this.index] ?? null; }

  _render() {
    const entry = this._current();
    const total = this.entries.length;
    const showBrowse = total > 1;
    this.prevBtn.r.setVisible(showBrowse); this.prevBtn.t.setVisible(showBrowse);
    this.nextBtn.r.setVisible(showBrowse); this.nextBtn.t.setVisible(showBrowse);
    if (!entry) {
      this.subtitle.setText('');
      this.body.setColor(COL.dim);
      this.body.setText('No runs recorded yet.\n\nDeploy, fight, and finish a sortie — a run commits\non a win, a death, or a manual exit of 10s or more.');
      this.copyBtn.r.setVisible(false); this.copyBtn.t.setVisible(false);
      return;
    }
    this.copyBtn.r.setVisible(true); this.copyBtn.t.setVisible(true);
    const run = entry.run ?? {};
    const m = run.meta ?? {};
    const when = this._ago(entry.id);
    this.subtitle.setText(
      `RUN ${this.index + 1} / ${total}   •   ${(entry.reason ?? '?').toUpperCase()}`
      + `   •   ${m.biome ?? '-'} / ${m.chassis ?? '-'}${when ? `   •   ${when}` : ''}`,
    );
    this.body.setColor(COL.text);
    this.body.setText(runReportText(run));
    this._resetCopyLabel();
  }

  _copy() {
    const entry = this._current();
    if (!entry) return;
    const text = runReportText(entry.run ?? {});
    try {
      navigator.clipboard?.writeText(text);
      this.copyBtn.t.setText('COPIED ✓').setColor(COL.good);
    } catch {
      this.copyBtn.t.setText('COPY FAILED').setColor(COL.dim);
    }
    this.scene.time?.delayedCall?.(1400, () => this._resetCopyLabel());
  }

  _resetCopyLabel() {
    this.copyBtn.t.setText('COPY').setColor(COL.text);
  }

  // Rough relative time from the commit timestamp (Date.now stamped in statsHistory.commit).
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
