import Phaser from 'phaser';
import { LOCATIONS, LOCATION_INFO } from '../data/anatomy.js';
import { TILE_ORDER, tileRow, drawSkillTile, updateSkillTile } from '../ui/skillTiles.js';
import { POWERUPS, durationMs } from '../data/powerups.js';

// Screen-fixed overlay for the arena. The skills are shown with the SAME tile UI as the
// garage, in a row along the BOTTOM, with each weapon's live ammo (and each ability's
// cooldown) read right on its button. A compact per-part integrity column sits top-left.
// Runs as its own scene so it lays out in logical screen space without fighting the arena's
// follow camera; tiles are built once and updated in place each frame.
const C = { text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', good: '#7bd17b', warn: '#efc14a', bad: '#e2533a' };

export default class HudScene extends Phaser.Scene {
  constructor() {
    super('HudScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);

    this.add.text(16, 12, 'ARENA', { fontFamily: 'monospace', fontSize: '18px', color: C.accent });
    this.add.text(16, 36, 'WASD/L-stick: move  ·  mouse/R-stick: aim  ·  LMB/RMB/Q/E + Space: skills  ·  pad: LT/RT/LB/RB+L3  ·  T/R3: drop lock  ·  M: mute  ·  G/B: garage',
      { fontFamily: 'monospace', fontSize: '12px', color: C.dim });
    this.add.text(16, 54, 'debug d-pad:  ↑ add  ↓ reset  ← move  → fire   ·   keys:  N add · R reset · [ move · ] fire',
      { fontFamily: 'monospace', fontSize: '11px', color: C.dim });

    // #66: objective line, reading the live Mission published to the registry each frame.
    this.objectiveText = this.add.text(16, 70, '', { fontFamily: 'monospace', fontSize: '13px', color: C.warn });
    // Big centred "MISSION COMPLETE" banner, hidden until the mission resolves.
    this.completeBanner = this.add.text(this.W / 2, this.H * 0.32, 'MISSION COMPLETE', {
      fontFamily: 'monospace', fontSize: '40px', color: C.good, fontStyle: 'bold',
    }).setOrigin(0.5).setVisible(false);

    this.modeText = this.add.text(this.W - 16, this.H - 24, '', { fontFamily: 'monospace', fontSize: '12px', color: C.warn }).setOrigin(1, 1);
    this.aiText = this.add.text(this.W - 16, this.H - 40, '', { fontFamily: 'monospace', fontSize: '11px', color: C.dim }).setOrigin(1, 1);
    this.dummyText = this.add.text(this.W - 16, 16, '', { fontFamily: 'monospace', fontSize: '13px', color: C.text }).setOrigin(1, 0);

    // #60: active timed-buff readout, top-right under the enemy count. One radial "cooldown-pie"
    // per active buff — a ring tinted the buff colour that drains clockwise as it runs out, with
    // the label + remaining seconds beside it. A single Graphics layer draws all the rings; the
    // labels are pooled Text objects. Armor Patch is instant so it never appears here.
    this.buffGfx = this.add.graphics();
    this.buffTexts = [];
    this._buffCache = {};   // typeId → full duration (ms), captured the frame a buff first appears

    // Per-part integrity column (player), top-left under the hints + objective line.
    this.add.text(16, 96, 'INTEGRITY', { fontFamily: 'monospace', fontSize: '12px', color: C.dim });
    this.partTexts = {};
    let y = 114;
    for (const loc of LOCATIONS) {
      if (loc === 'cockpit') continue;
      this.partTexts[loc] = this.add.text(16, y, '', { fontFamily: 'monospace', fontSize: '12px', color: C.text });
      y += 14;
    }

    // Skill bar — the shared garage tiles, centred along the bottom of the screen.
    this.skillBar = this.add.container(0, 0);
    this.skillRefs = {};
    const mech = this.registry.get('playerMech');
    for (const r of tileRow(this.W * 0.12, this.W * 0.76, { bottom: this.H - 10, maxSize: 92 })) {
      const id = mech?.mounts[r.loc]?.[0] ?? null;
      this.skillRefs[r.loc] = drawSkillTile(this, this.skillBar, r, { loc: r.loc, itemId: id });
    }
  }

  update() {
    const mech = this.registry.get('playerMech');
    if (!mech) return;

    this.modeText.setText(this.registry.get('inputMode') === 'pad' ? 'CONTROLLER' : 'MOUSE + KB');
    const aiMove = this.registry.get('aiMove') !== false;
    const aiFire = this.registry.get('aiFire') !== false;
    this.aiText.setText((aiMove && aiFire) ? '' : `AI  move:${aiMove ? 'on' : 'OFF'}  fire:${aiFire ? 'on' : 'OFF'}`);

    // Skill tiles: live ammo on each weapon, cooldown on each ability (#).
    const mode = this.registry.get('inputMode') === 'pad' ? 'pad' : 'kbm';
    const weapons = mech.weapons();
    const abilities = mech.abilities();
    const cds = this.registry.get('abilityCooldowns') || {};
    const shieldActive = this.registry.get('shieldActive');
    for (const loc of TILE_ORDER) {
      const id = mech.mounts[loc][0] ?? null;
      const opts = { loc, itemId: id, mode };
      const w = weapons.find((x) => x.location === loc);
      const ab = abilities.find((x) => x.location === loc);
      if (w) {
        opts.iconAlpha = w.online ? 1 : 0.3;
        if (!w.online) { opts.subtitle = 'OFFLINE'; opts.subtitleColor = C.bad; }
        else if (w.ammo == null) { opts.subtitle = '∞'; opts.subtitleColor = C.dim; }
        else {
          opts.subtitle = `${Math.floor(w.ammo)}/${w.weapon.ammoMax}`;
          opts.subtitleColor = w.ready ? C.good : C.warn;
          opts.ammoFrac = w.ammo / w.weapon.ammoMax;
        }
      } else if (ab) {
        const cd = cds[loc] || 0;
        if (loc === 'centerTorso' && shieldActive) { opts.subtitle = 'ACTIVE'; opts.subtitleColor = C.accent; }
        else { opts.subtitle = cd > 0 ? `${(cd / 1000).toFixed(1)}s` : 'READY'; opts.subtitleColor = cd > 0 ? C.warn : C.good; }
      }
      updateSkillTile(this.skillRefs[loc], opts);
    }

    for (const loc of LOCATIONS) {
      if (loc === 'cockpit') continue;
      const p = mech.parts[loc];
      const frac = mech.partHealthFraction(loc);
      const hp = Math.ceil(p.armor + p.structure);
      const max = p.maxArmor + p.maxStructure;
      const col = mech.isPartDestroyed(loc) ? C.bad : frac > 0.5 ? C.good : C.warn;
      this.partTexts[loc].setText(`${LOCATION_INFO[loc].short.padEnd(2)} ${String(hp).padStart(3)}/${max}`).setColor(col);
    }

    const total = this.registry.get('enemyCount') || 0;
    const alive = this.registry.get('enemiesAlive') ?? total;
    if (total) {
      this.dummyText.setText(`ENEMIES ${alive}/${total}`).setColor(alive ? C.dim : C.bad);
    }

    // #66: objective line + win banner, driven by the Mission the arena publishes each frame.
    const mission = this.registry.get('mission');
    if (mission) {
      const complete = mission.status === 'complete';
      this.objectiveText
        .setText(`OBJECTIVE: ${mission.objective}${complete ? '  [COMPLETE]' : ''}`)
        .setColor(complete ? C.good : C.warn);
      this.completeBanner.setVisible(complete);
    }

    this._updateBuffHud();
  }

  // #60: draw one radial "draining" ring per active timed buff. Each is a rounded circular
  // timer, tinted the buff colour, whose arc empties clockwise from full to zero over the buff's
  // duration — a cooldown-pie. The label + remaining seconds sit to the left so several buffs
  // stack readably down the top-right. Text objects are pooled; the Graphics layer is redrawn
  // each frame. Instant buffs (Armor Patch) never enter `activePowerups`, so they never show.
  _updateBuffHud() {
    const active = this.registry.get('activePowerups') || {};
    const ids = Object.keys(active).filter((id) => active[id] > 0);

    // Peak-remaining denominator: on pickup/refresh a buff's remaining jumps up, so track the
    // max seen for each live type as its "full" and derive the drain fraction against it. Falls
    // back to the catalog duration. Prune types that are no longer active.
    for (const id of Object.keys(this._buffCache)) if (!ids.includes(id)) delete this._buffCache[id];
    for (const id of ids) {
      const full = durationMs(id) || active[id];
      this._buffCache[id] = Math.max(this._buffCache[id] || 0, active[id], full);
    }

    const g = this.buffGfx;
    g.clear();
    const R = 15;                 // ring radius
    const cx = this.W - 16 - R;   // ring centre x (ring hugs the right edge)
    const rowH = 2 * R + 10;
    let y = 44;

    ids.forEach((id, i) => {
      const p = POWERUPS[id];
      const color = p?.color ?? 0xffffff;
      const colStr = '#' + color.toString(16).padStart(6, '0');
      const cy = y + R;
      const frac = Math.max(0, Math.min(1, active[id] / (this._buffCache[id] || active[id])));

      // Track: a dim full ring behind the drain, so the empty portion still reads as a ring.
      g.lineStyle(4, color, 0.22);
      g.strokeCircle(cx, cy, R);
      // Drained-in remainder: an arc from 12 o'clock going clockwise, shrinking as time runs out.
      const start = -Math.PI / 2;                 // 12 o'clock
      const end = start + frac * Math.PI * 2;      // clockwise sweep for the time remaining
      g.lineStyle(4, color, 1);
      g.beginPath();
      g.arc(cx, cy, R, start, end, false);
      g.strokePath();
      // Soft inner fill so the pie centre glows in the buff colour (fades as it drains).
      g.fillStyle(color, 0.10 + 0.14 * frac);
      g.fillCircle(cx, cy, R - 3);

      // Label + seconds to the left of the ring.
      let t = this.buffTexts[i];
      if (!t) {
        t = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '12px' }).setOrigin(1, 0.5);
        this.buffTexts[i] = t;
      }
      t.setText(`${p?.label ?? id}  ${(active[id] / 1000).toFixed(1)}s`)
        .setColor(colStr)
        .setPosition(cx - R - 8, cy)
        .setVisible(true);

      y += rowH;
    });
    for (let i = ids.length; i < this.buffTexts.length; i++) this.buffTexts[i].setVisible(false);
  }
}
