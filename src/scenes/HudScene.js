import Phaser from 'phaser';
import { LOCATIONS, LOCATION_INFO } from '../data/anatomy.js';
import { TILE_ORDER, tileRow, drawSkillTile, updateSkillTile } from '../ui/skillTiles.js';

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
    this.add.text(16, 36, 'WASD/L-stick: move  ·  mouse/R-stick: aim  ·  LMB/RMB/Q/E + Space: skills  ·  pad: LT/RT/LB/RB+L3  ·  T/R3: aim-assist  ·  M: mute  ·  G/B: garage',
      { fontFamily: 'monospace', fontSize: '12px', color: C.dim });
    this.add.text(16, 54, 'debug d-pad:  ↑ add  ↓ reset  ← move  → fire   ·   keys:  N add · R reset · [ move · ] fire',
      { fontFamily: 'monospace', fontSize: '11px', color: C.dim });

    this.assistText = this.add.text(this.W / 2, 28, '', { fontFamily: 'monospace', fontSize: '14px', color: C.accent }).setOrigin(0.5, 0);
    this.modeText = this.add.text(this.W - 16, this.H - 24, '', { fontFamily: 'monospace', fontSize: '12px', color: C.warn }).setOrigin(1, 1);
    this.aiText = this.add.text(this.W - 16, this.H - 40, '', { fontFamily: 'monospace', fontSize: '11px', color: C.dim }).setOrigin(1, 1);
    this.dummyText = this.add.text(this.W - 16, 16, '', { fontFamily: 'monospace', fontSize: '13px', color: C.text }).setOrigin(1, 0);

    // Per-part integrity column (player), top-left under the hints.
    this.add.text(16, 80, 'INTEGRITY', { fontFamily: 'monospace', fontSize: '12px', color: C.dim });
    this.partTexts = {};
    let y = 98;
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
    const assistOn = this.registry.get('assistOn') !== false;
    this.assistText.setText(`AIM-ASSIST ${assistOn ? 'ON' : 'OFF'}`).setColor(assistOn ? C.accent : C.dim);
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
  }
}
