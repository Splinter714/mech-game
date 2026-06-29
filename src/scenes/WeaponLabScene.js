import Phaser from 'phaser';
import { drawProjectileBody, drawBeam, drawSlash, drawGroundFire, itemFxKey } from '../art/index.js';
import { planEmissions, makeProjectile, stepProjectile } from '../data/delivery.js';
import { WEAPONS, WEAPON_IDS } from '../data/weapons.js';
import { CATEGORIES } from '../data/categories.js';

// ── Weapon Lab (dev/art tool) ────────────────────────────────────────────────
// A standalone gallery for art-directing weapons and their fired rounds. One card
// per weapon, each auto-firing into a little stage so we can eyeball the shot/beam
// art and iterate on it. It draws live rounds with the SAME primitives the arena
// uses (drawProjectileBody / drawBeam / projectileKind), so what you tune here is
// exactly what fires in combat — change a primitive in art/projectileArt.js and
// both this lab and the arena update together.
//
// The mini-sim deliberately honours each weapon's real cadence (cycleTime /
// fireRate), real velocity, and its delivery profile (hitscan/contact beam,
// straight/arcing projectile, single/spread/stream, homing) so the relative feel
// reads true — a slow plasma lob vs. a fast slug vs. a stuttering repeater.
//
// Reached from the garage header ("⚔ WEAPON LAB") or by booting with ?lab.

const UI = {
  bg: '#0d1014', panel: 0x161b22, panelEdge: 0x2a333f, stage: 0x0b0e12,
  text: '#c8d2dd', dim: '#7c8794', accent: '#5ec8e0', sel: '#efc14a',
};

const CARD_H = 96;        // card height (logical px)
const CARD_GAP = 12;      // gap between cards
const TOP = 56;           // y of the first card (below the title)
const MARGIN = 20;        // left/right page margin
const ICON = 30;          // garage-icon display size

export default class WeaponLabScene extends Phaser.Scene {
  constructor() {
    super('WeaponLabScene');
  }

  create() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);
    this.cameras.main.setZoom(dpr);
    this.cameras.main.setOrigin(0, 0);
    this.cameras.main.setBackgroundColor(UI.bg);

    // Everything that scrolls lives in this container; chrome (title/back) stays pinned.
    this.scroller = this.add.container(0, 0);
    this.cards = [];
    this._scrollY = 0;
    this._maxScroll = 0;

    WEAPON_IDS.forEach((id, i) => this._buildCard(WEAPONS[id], i));

    // Pinned chrome.
    this.add.text(MARGIN, 16, '⚔ WEAPON LAB — live shot/projectile preview', {
      fontFamily: 'monospace', fontSize: '16px', color: UI.accent,
    }).setOrigin(0, 0).setDepth(10);
    this._backBtn(this.W - 130, 14, 110, 30, '‹ BACK', () => this.scene.start('GarageScene'));

    this._scrollHint = this.add.text(this.W / 2, this.H - 8, '⌄ scroll for more', {
      fontFamily: 'monospace', fontSize: '11px', color: UI.dim,
    }).setOrigin(0.5, 1).setDepth(10).setVisible(false);

    // Scroll: wheel (desktop) + drag (touch).
    this.input.on('wheel', (_p, _o, _dx, dy) => this._setScroll(this._scrollY + dy));
    this.input.on('pointerdown', (p) => { this._dragY = p.y; this._dragFrom = this._scrollY; });
    this.input.on('pointermove', (p) => {
      if (!p.isDown || this._dragY == null) return;
      this._setScroll(this._dragFrom - (p.y - this._dragY) / dpr);
    });
    this.input.on('pointerup', () => { this._dragY = null; });
    this.input.keyboard.on('keydown-ESC', () => this.scene.start('GarageScene'));

    this.layout();
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));
  }

  _backBtn(x, y, w, h, label, onClick) {
    const r = this.add.rectangle(x, y, w, h, UI.panel).setOrigin(0, 0)
      .setStrokeStyle(1, UI.panelEdge).setInteractive({ useHandCursor: true }).setDepth(10);
    this.add.text(x + w / 2, y + h / 2, label, { fontFamily: 'monospace', fontSize: '13px', color: UI.sel })
      .setOrigin(0.5).setDepth(11);
    r.on('pointerover', () => r.setFillStyle(0x222b35));
    r.on('pointerout', () => r.setFillStyle(UI.panel));
    r.on('pointerdown', onClick);
  }

  // One weapon card: static art (panel, icon, label, stats) + a live firing stage.
  // Sim state lives on the card; positions are container-local so scrolling is free.
  _buildCard(weapon, index) {
    const color = CATEGORIES[weapon.category]?.color ?? 0xffffff;
    const c = this.add.container(0, 0);

    const panel = this.add.rectangle(0, 0, 100, CARD_H, UI.panel).setOrigin(0, 0).setStrokeStyle(1, UI.panelEdge);
    const stage = this.add.rectangle(0, 0, 100, 100, UI.stage).setOrigin(0, 0);
    const swatch = this.add.rectangle(14, 16, 4, CARD_H - 32, color).setOrigin(0, 0);
    const icon = this.add.image(0, 0, itemFxKey(weapon.id)).setDisplaySize(ICON, ICON);
    const name = this.add.text(0, 14, weapon.name, { fontFamily: 'monospace', fontSize: '14px', color: UI.text });
    const cat = this.add.text(0, 33, CATEGORIES[weapon.category]?.label ?? weapon.category, {
      fontFamily: 'monospace', fontSize: '11px', color: Phaser.Display.Color.IntegerToColor(color).rgba,
    });
    const stats = this.add.text(0, 50, this._statLines(weapon), {
      fontFamily: 'monospace', fontSize: '10px', color: UI.dim, lineSpacing: 2,
    });
    const fxG = this.add.graphics();

    c.add([panel, stage, swatch, icon, name, cat, stats, fxG]);
    this.scroller.add(c);

    this.cards.push({
      weapon, color, container: c, panel, stage, icon, name, cat, stats, fxG,
      cd: index * 120,        // stagger first shots so they don't all fire in lockstep
      streamPhase: 0,         // stream/sustained on/off envelope
      holdBeam: false,        // sustained beam this frame (beam laser)
      pending: [],            // scheduled sub-shots of an in-flight burst (delay countdown)
      projectiles: [], beams: [], bursts: [], slashes: [], patches: [],
    });
  }

  _statLines(w) {
    const d = w.delivery;
    const parts = [];
    if (d.hit === 'hitscan') parts.push('hitscan');
    else if (d.hit === 'contact') parts.push('melee');
    else parts.push(`proj ${d.velocity}px/s${d.path === 'arcing' ? ' · arc' : ''}`);
    if (d.pattern === 'spread') parts.push(`spread×${d.spreadCount}`);
    else if (d.pattern === 'stream') parts.push(`stream ${d.fireRate}/s`);
    if (d.guidance === 'homing') parts.push('homing');
    const ammo = w.ammoMax == null ? '∞' : `${w.ammoMax} (+${w.ammoRegen}/s)`;
    const cadence = d.pattern === 'stream' ? `${d.fireRate}/s` : `${(w.cycleTime / 1000).toFixed(2)}s`;
    return [
      parts.join(' · '),
      `dmg ${w.damage} · rng ${w.range.max} · ${cadence} · ammo ${ammo}`,
    ].join('\n');
  }

  // Flow cards into a single scrollable column; pin chrome; compute max scroll.
  layout() {
    const dpr = this.registry.get('dpr') || 1;
    this.W = Math.round(this.scale.width / dpr);
    this.H = Math.round(this.scale.height / dpr);

    const cardW = this.W - MARGIN * 2;
    const labelW = 220;                       // left block: icon + name + stats
    const stageX = labelW + 8;
    const stageW = cardW - stageX - 12;

    this.cards.forEach((card, i) => {
      const y = TOP + i * (CARD_H + CARD_GAP);
      card.container.setPosition(MARGIN, y);
      card.panel.setSize(cardW, CARD_H);
      card.stage.setPosition(stageX, 8).setSize(stageW, CARD_H - 16);
      card.icon.setPosition(28, CARD_H / 2);
      card.name.setX(48);
      card.cat.setX(48);
      card.stats.setX(48);
      // Muzzle: left edge of the stage, vertically centred. Rounds travel rightward.
      card.muzzleX = stageX + 14;
      card.muzzleY = 8 + (CARD_H - 16) / 2;
      card.stageW = stageW - 22;              // travel distance before impact
    });

    const bottom = TOP + this.cards.length * (CARD_H + CARD_GAP);
    this._maxScroll = Math.max(0, bottom + 12 - this.H);
    this._scrollHint?.setPosition(this.W / 2, this.H - 8);
    this._setScroll(this._scrollY);
  }

  _setScroll(y) {
    this._scrollY = Phaser.Math.Clamp(y, 0, this._maxScroll);
    this.scroller.y = -this._scrollY;
    this._scrollHint?.setVisible(this._scrollY < this._maxScroll - 1);
  }

  update(_time, delta) {
    const dt = Math.min(0.05, delta / 1000);
    for (const card of this.cards) this._updateCard(card, dt, delta);
  }

  // Cadence only — WHEN a trigger pulls. The shared delivery sim owns what each pull
  // emits (planEmissions) and how rounds move (makeProjectile/stepProjectile).
  _updateCard(card, dt, delta) {
    const w = card.weapon, d = w.delivery;
    card.holdBeam = false;

    if (d.sustained) {
      // Beam laser: one continuous held beam, with a periodic rest so it reads as bursts.
      card.streamPhase += delta;
      card.holdBeam = card.streamPhase % 2400 < 1600;
    } else if (d.pattern === 'stream') {
      // Stream weapons fire on fireRate with a periodic rest. Tick the timer only while
      // firing and RESET it (don't accumulate) so the rest gap can't dump a clump.
      card.streamPhase += delta;
      if (card.streamPhase % 2400 < 1600) {
        card.cd -= delta;
        if (card.cd <= 0) { this._fire(card); card.cd = Math.max(1000 / (d.fireRate || 10), 16); }
      } else card.cd = 0;
    } else {
      // Single / spread / burst: one trigger pull per cycle (a burst's sub-pulses are
      // scheduled inside _fire). The gap keeps each pull legible in the preview.
      card.cd -= delta;
      if (card.cd <= 0) {
        this._fire(card);
        // cycleTime = start-to-start; subtract burst duration so the cooldown gap is correct.
        const burstDur = d.burst ? d.burst.count * (d.burst.wubOn ?? d.burst.interval) + (d.burst.count - 1) * (d.burst.wubOff ?? 0) : 0;
        card.cd = Math.max((w.cycleTime || 800) - burstDur, 250);
      }
    }

    this._advance(card, dt, delta);
    this._draw(card);
  }

  // One trigger pull: ask the shared sim what to emit, then realise each emission from the
  // (fixed) muzzle. Delayed sub-shots (a burst's pulses) go on the card's pending queue.
  _fire(card) {
    const plan = planEmissions(card.weapon);
    for (const s of plan.shots) {
      if (s.delay > 0) card.pending.push({ at: s.delay, mode: plan.mode, shot: s });
      else this._emit(card, plan.mode, s);
    }
  }

  _emit(card, mode, s) {
    const ax = card.muzzleX, ay = card.muzzleY, color = card.color;
    if (mode === 'contact') { card.slashes.push({ t: 0, ttl: 260, color }); return; }
    if (mode === 'hitscan') {
      const len = Math.min(card.stageW, card.weapon.range.opt || 200);
      // Burst weapons: each pulse expires just before the next fires so pulses are distinct flashes.
      const burstTtl = card.weapon.delivery.burst?.wubOn ?? 130;
      card.beams.push({ x0: ax, y0: ay, x1: ax + len, y1: ay, color, ttl: burstTtl, age: 0, heavy: card.weapon.delivery.kind === 'rail' });
      return;
    }
    // Projectile: the rounds fire along +x (angle 0); apply the emission's angle + lateral.
    const angle = s.angleOffset;
    const perp = angle + Math.PI / 2;
    const ox = ax + Math.cos(perp) * s.lateral, oy = ay + Math.sin(perp) * s.lateral;
    card.projectiles.push(makeProjectile(card.weapon, ox, oy, angle, { maxDist: card.stageW }));
  }

  _advance(card, dt, delta) {
    // Fire any due burst sub-shots.
    if (card.pending.length) {
      const still = [];
      for (const e of card.pending) { e.at -= delta; if (e.at <= 0) this._emit(card, e.mode, e.shot); else still.push(e); }
      card.pending = still;
    }
    for (const p of card.projectiles) {
      // Homing rounds steer toward straight-ahead (angle 0), so a wide launch fan curves
      // in like seekers chasing a target down-range.
      stepProjectile(p, dt, p.homing ? 0 : null);
      if (p.dist >= p.maxDist) {
        p.dead = true;
        if (p.ground) card.patches.push({ x: p.x, y: card.muzzleY, r: Math.min(p.ground.radius, 26), born: 0, ttl: p.ground.duration * 1000 });
        else card.bursts.push({ x: p.x, y: p.y, color: p.color, t: 0, ttl: 220 });
      }
    }
    if (card.projectiles.some((p) => p.dead)) card.projectiles = card.projectiles.filter((p) => !p.dead);

    const ms = delta;
    for (const b of card.beams) { b.ttl -= ms; b.age = (b.age ?? 0) + ms; }
    for (const b of card.bursts) b.t += ms;
    for (const s of card.slashes) s.t += ms;
    for (const fp of card.patches) fp.born += ms;
    card.beams = card.beams.filter((b) => b.ttl > 0);
    card.bursts = card.bursts.filter((b) => b.t < b.ttl);
    card.slashes = card.slashes.filter((s) => s.t < s.ttl);
    card.patches = card.patches.filter((fp) => fp.born < fp.ttl);
  }

  _draw(card) {
    const g = card.fxG;
    const w = card.weapon;
    g.clear();
    // Muzzle nub.
    g.fillStyle(0x3a4654, 1).fillRect(card.muzzleX - 12, card.muzzleY - 4, 12, 8);

    // Burning ground patches sit under everything.
    for (const fp of card.patches) drawGroundFire(g, fp.x, fp.y, fp.r, fp.born, 1);

    // Sustained held beam (beam laser): one steady beam while firing.
    if (card.holdBeam) {
      const len = Math.min(card.stageW, w.range.opt || 220);
      drawBeam(g, card.muzzleX, card.muzzleY, card.muzzleX + len, card.muzzleY, card.color, 1, false, card.streamPhase);
    }
    for (const b of card.beams) drawBeam(g, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age);

    for (const p of card.projectiles) {
      let lift = 0;
      if (p.arc) {
        lift = Math.sin((p.dist / p.maxDist) * Math.PI) * Math.min(22, p.maxDist * 0.12);
        g.fillStyle(0x000000, 0.25).fillEllipse(p.x, p.y, 7, 3);
      }
      drawProjectileBody(g, p.x, p.y - lift, p.angle, p.kind, p.color, 1, p.dist);
    }

    // Melee swings sweep a crescent out from the muzzle.
    for (const s of card.slashes) drawSlash(g, card.muzzleX, card.muzzleY, 0, s.t / s.ttl, s.color, 1, 34);

    for (const b of card.bursts) {
      const f = 1 - b.t / b.ttl;
      g.lineStyle(2, b.color, f).strokeCircle(b.x, b.y, (1 - f) * 14 + 2);
    }
  }
}
