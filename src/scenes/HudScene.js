import Phaser from 'phaser';
import { LOCATIONS, LOCATION_INFO } from '../data/anatomy.js';
import { SKILL_BINDS } from '../input/Controls.js';

// Screen-fixed overlay for the arena: controls hint, a live weapons/ammo readout, a
// compact per-part health column for the player, and the dummy's status. Runs as its
// own scene (like the garage) so it lays out in logical screen space without fighting
// the arena's follow camera. Text objects are created once and updated in place.
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
    this.add.text(16, 36, 'WASD/L-stick: move  ·  mouse/R-stick: aim  ·  LMB/RMB/Q/E: weapons  ·  pad: LT/RT/LB/RB+L3/R3  ·  G: garage',
      { fontFamily: 'monospace', fontSize: '12px', color: C.dim });
    this.modeText = this.add.text(this.W - 16, this.H - 24, '', { fontFamily: 'monospace', fontSize: '12px', color: C.warn }).setOrigin(1, 1);

    // Weapons / ammo readout (top-left). One line per mounted weapon, updated in place.
    this.add.text(16, 62, 'WEAPONS', { fontFamily: 'monospace', fontSize: '12px', color: C.dim });
    this.weaponsText = this.add.text(16, 80, '', { fontFamily: 'monospace', fontSize: '12px', color: C.text, lineSpacing: 3 });
    this.abilityText = this.add.text(16, 168, '', { fontFamily: 'monospace', fontSize: '12px', color: C.accent, lineSpacing: 3 });

    // Per-part health column (player).
    this.partTexts = {};
    let y = this.H - 110;
    for (const loc of LOCATIONS) {
      if (loc === 'cockpit') continue;
      this.partTexts[loc] = this.add.text(16, y, '', { fontFamily: 'monospace', fontSize: '12px', color: C.text });
      y += 14;
    }

    this.dummyText = this.add.text(this.W - 16, 16, '', { fontFamily: 'monospace', fontSize: '13px', color: C.text }).setOrigin(1, 0);
  }

  update() {
    const mech = this.registry.get('playerMech');
    const dummy = this.registry.get('dummyMech');
    if (!mech) return;

    this.modeText.setText(this.registry.get('inputMode') === 'pad' ? 'CONTROLLER' : 'MOUSE + KB');

    // Weapons / ammo: each weapon's fire bind + name + magazine (∞ for melee). Offline
    // weapons (their location wrecked) show a marker.
    const lines = mech.weapons().map((w) => {
      const bind = (SKILL_BINDS[w.location]?.key ?? '?').padEnd(5);
      const name = w.weapon.name.padEnd(12);
      const ammo = w.ammo == null ? '  ∞' : `${String(Math.floor(w.ammo)).padStart(2)}/${w.weapon.ammoMax}`;
      if (!w.online) return `${bind} ${name} OFFLINE`;
      return `${bind} ${name} ${ammo}`;
    });
    this.weaponsText.setText(lines.length ? lines.join('\n') : '(no weapons)');

    // Abilities: bind + name + cooldown state.
    const cds = this.registry.get('abilityCooldowns') || {};
    const abilityLines = mech.abilities().map((ab) => {
      const bind = (SKILL_BINDS[ab.location]?.key ?? '?').padEnd(5);
      const cd = cds[ab.location] || 0;
      const state = cd > 0 ? `${(cd / 1000).toFixed(1)}s` : 'READY';
      return `${bind} ${ab.equip.name.padEnd(12)} ${state}`;
    });
    if (this.registry.get('shieldActive')) abilityLines.push('      SHIELD UP');
    this.abilityText.setText(abilityLines.length ? 'ABILITIES\n' + abilityLines.join('\n') : '');

    for (const loc of LOCATIONS) {
      if (loc === 'cockpit') continue;
      const p = mech.parts[loc];
      const frac = mech.partHealthFraction(loc);
      const hp = Math.ceil(p.armor + p.structure);
      const max = p.maxArmor + p.maxStructure;
      const col = mech.isPartDestroyed(loc) ? C.bad : frac > 0.5 ? C.good : C.warn;
      this.partTexts[loc].setText(`${LOCATION_INFO[loc].short.padEnd(2)} ${String(hp).padStart(3)}/${max}`).setColor(col);
    }

    if (dummy) {
      const downed = LOCATIONS.filter((l) => l !== 'cockpit' && dummy.isPartDestroyed(l)).map((l) => LOCATION_INFO[l].short);
      const status = dummy.isDestroyed() ? 'DUMMY: DESTROYED' : `DUMMY  parts down: ${downed.length ? downed.join(' ') : 'none'}`;
      this.dummyText.setText(status).setColor(dummy.isDestroyed() ? C.bad : C.dim);
    }
  }
}
