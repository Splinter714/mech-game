import Phaser from 'phaser';
import { drawProjectileBody, drawBeam, drawSlash, drawGroundFire, drawAbilityFx, itemFxKey } from '../art/index.js';
import { planEmissions, makeProjectile, stepProjectile } from '../data/delivery.js';
import { CATEGORIES } from '../data/categories.js';
import { getItem, isWeapon } from '../data/items.js';
import { Audio } from '../audio/index.js';
import { TRAJECTORY_DELAY } from '../audio/sfxParams.js';

// Shared weapon/ability card list — the SINGLE implementation behind both the standalone
// Weapon Lab tab and the garage catalog, so the two can't drift. It renders a scrollable
// column of cards inside a bounded region; each weapon card auto-fires a live shot/beam
// preview using the same delivery sim + art primitives the arena uses, and each ability
// card shows its signature fx. Optional `onSelect(id)` makes a card clickable (the garage
// arms the picked item); `selectedId` highlights one.
//
// Usage:
//   const list = new WeaponCardList(scene, { x, y, w, h, ids, onSelect, selectedId });
//   // in scene.update(): list.update(time, delta);
//   list.setIds(newIds);        // refilter (e.g. eligible items for a slot)
//   list.setSelected(id);
//   list.setRegion(x, y, w, h); // on resize
//   list.destroy();

const UI = {
  panel: 0x161b22, panelEdge: 0x2a333f, panelSel: 0x1b2430, stage: 0x0b0e12,
  text: '#c8d2dd', dim: '#7c8794', sel: 0xefc14a,
};

const CARD_H = 96;
const CARD_GAP = 12;
const ICON = 30;
const LABEL_W = 200;     // left block: icon + name + stats

export class WeaponCardList {
  constructor(scene, { x, y, w, h, ids, onSelect = null, selectedId = null } = {}) {
    this.scene = scene;
    this.onSelect = onSelect;
    this.selectedId = selectedId;
    this.region = { x, y, w, h };
    this._scrollY = 0;
    this._maxScroll = 0;
    this.cards = [];

    this.root = scene.add.container(x, y);
    this.scroller = scene.add.container(0, 0);
    this.root.add(this.scroller);

    // Clip the scrolling cards to the region so they never spill past it.
    this.maskG = scene.make.graphics();
    this._paintMask();
    this.scroller.setMask(this.maskG.createGeometryMask());

    this._onWheel = (p, _o, _dx, dy) => { if (this._inRegion(p)) this._setScroll(this._scrollY + dy); };
    this._onDown = (p) => { if (this._inRegion(p)) { this._dragY = p.y; this._dragFrom = this._scrollY; } };
    this._onMove = (p) => {
      if (!p.isDown || this._dragY == null) return;
      const dpr = scene.registry.get('dpr') || 1;
      this._setScroll(this._dragFrom - (p.y - this._dragY) / dpr);
    };
    this._onUp = () => { this._dragY = null; };
    scene.input.on('wheel', this._onWheel);
    scene.input.on('pointerdown', this._onDown);
    scene.input.on('pointermove', this._onMove);
    scene.input.on('pointerup', this._onUp);

    this.setIds(ids ?? []);
  }

  _paintMask() {
    // The mask renders through the same camera (zoom = dpr) as the cards, so it's painted in
    // logical coords — the camera scales it to physical to match.
    const { x, y, w, h } = this.region;
    this.maskG.clear().fillStyle(0xffffff).fillRect(x, y, w, h);
  }

  _inRegion(p) {
    const dpr = this.scene.registry.get('dpr') || 1;
    const { x, y, w, h } = this.region;
    const lx = p.x / dpr, ly = p.y / dpr;
    return lx >= x && lx <= x + w && ly >= y && ly <= y + h;
  }

  setRegion(x, y, w, h) {
    this.region = { x, y, w, h };
    this.root.setPosition(x, y);
    this._paintMask();
    this._layout();
  }

  setSelected(id) {
    this.selectedId = id;
    for (const c of this.cards) this._paintSelection(c);
  }

  // Rebuild the card set (e.g. filtered to a slot's eligible items). Reuses nothing — cards
  // are cheap and this only fires on a slot change, not per frame.
  setIds(ids) {
    for (const c of this.cards) c.container.destroy();
    this.cards = [];
    for (const id of ids) this._buildCard(getItem(id), id);
    this._scrollY = 0;
    this._layout();
  }

  _buildCard(item, id) {
    const weapon = isWeapon(id) ? item : null;
    const color = weapon ? (CATEGORIES[weapon.category]?.color ?? 0xffffff) : 0x7bd17b;
    const c = this.scene.add.container(0, 0);

    const panel = this.scene.add.rectangle(0, 0, 100, CARD_H, UI.panel).setOrigin(0, 0).setStrokeStyle(1, UI.panelEdge);
    const stage = this.scene.add.rectangle(0, 0, 100, 100, UI.stage).setOrigin(0, 0);
    const swatch = this.scene.add.rectangle(14, 16, 4, CARD_H - 32, color).setOrigin(0, 0);
    const icon = this.scene.add.image(0, 0, itemFxKey(id)).setDisplaySize(ICON, ICON);
    const name = this.scene.add.text(0, 14, item.name, { fontFamily: 'monospace', fontSize: '14px', color: UI.text });
    const catLabel = weapon ? (CATEGORIES[weapon.category]?.label ?? weapon.category) : 'Ability';
    const cat = this.scene.add.text(0, 33, catLabel, {
      fontFamily: 'monospace', fontSize: '11px', color: Phaser.Display.Color.IntegerToColor(color).rgba,
    });
    const stats = this.scene.add.text(0, 50, this._statLines(item, weapon), {
      fontFamily: 'monospace', fontSize: '10px', color: UI.dim, lineSpacing: 2,
    });
    const fxG = this.scene.add.graphics();

    c.add([panel, stage, swatch, icon, name, cat, stats, fxG]);
    this.scroller.add(c);

    const card = {
      id, item, weapon, color, container: c, panel, stage, icon, name, cat, stats, fxG,
      cd: this.cards.length * 120, streamPhase: 0, holdBeam: false,
      pending: [], projectiles: [], beams: [], dyingBeams: [], bursts: [], slashes: [], patches: [],
    };

    if (this.onSelect) {
      panel.setInteractive({ useHandCursor: true });
      panel.on('pointerover', () => { if (this.selectedId !== id) panel.setFillStyle(UI.panelSel); });
      panel.on('pointerout', () => this._paintSelection(card));
      panel.on('pointerdown', () => this.onSelect(id));
    }
    this.cards.push(card);
    this._paintSelection(card);
  }

  _paintSelection(card) {
    const on = card.id === this.selectedId;
    card.panel.setFillStyle(on ? UI.panelSel : UI.panel)
      .setStrokeStyle(on ? 2 : 1, on ? UI.sel : UI.panelEdge);
  }

  _statLines(item, weapon) {
    if (!weapon) {
      const cd = item.cooldown != null ? `${item.cooldown}s cooldown` : '';
      const extra = item.duration ? `${item.duration}s active` : item.impulse ? 'mobility burst' : '';
      return ['ability', [cd, extra].filter(Boolean).join(' · ')].join('\n');
    }
    const d = weapon.delivery;
    const parts = [];
    if (d.hit === 'hitscan') parts.push('hitscan');
    else if (d.hit === 'contact') parts.push('melee');
    else parts.push(`proj ${d.velocity}px/s${d.path === 'arcing' ? ' · arc' : ''}`);
    if (d.pattern === 'spread') parts.push(`spread×${d.spreadCount}`);
    else if (d.pattern === 'stream') parts.push(`stream ${d.fireRate}/s`);
    if (d.burst) parts.push(`burst×${d.burst.count}`);
    if (d.guidance === 'homing') parts.push('homing');
    const ammo = weapon.ammoMax == null ? '∞' : `${weapon.ammoMax} (+${weapon.ammoRegen}/s)`;
    const cadence = d.pattern === 'stream' ? `${d.fireRate}/s` : `${(weapon.cycleTime / 1000).toFixed(2)}s`;
    return [parts.join(' · '), `dmg ${weapon.damage} · rng ${weapon.range.max} · ${cadence} · ammo ${ammo}`].join('\n');
  }

  // Flow cards into a single column within the region; compute max scroll.
  _layout() {
    const cardW = this.region.w;
    const stageX = LABEL_W + 8;
    const stageW = cardW - stageX - 12;
    this.cards.forEach((card, i) => {
      const y = i * (CARD_H + CARD_GAP);
      card.container.setPosition(0, y);
      card.panel.setSize(cardW, CARD_H);
      card.stage.setPosition(stageX, 8).setSize(Math.max(20, stageW), CARD_H - 16);
      card.icon.setPosition(28, CARD_H / 2);
      card.name.setX(48); card.cat.setX(48); card.stats.setX(48);
      card.muzzleX = stageX + 14;
      card.muzzleY = 8 + (CARD_H - 16) / 2;
      card.stageW = Math.max(20, stageW - 22);
    });
    const contentH = this.cards.length * (CARD_H + CARD_GAP);
    this._maxScroll = Math.max(0, contentH - this.region.h);
    this._setScroll(this._scrollY);
  }

  _setScroll(y) {
    this._scrollY = Phaser.Math.Clamp(y, 0, this._maxScroll);
    this.scroller.y = -this._scrollY;
  }

  update(_time, delta) {
    const dt = Math.min(0.05, delta / 1000);
    for (const card of this.cards) this._updateCard(card, dt, delta);
  }

  // ── Per-card firing sim (identical to what the arena fires; see data/delivery.js) ──────

  _updateCard(card, dt, delta) {
    if (card.weapon) this._tickWeapon(card, delta);
    this._advance(card, dt, delta);
    this._draw(card);
  }

  // Cadence only — WHEN a trigger pulls. The shared delivery sim owns what each pull emits.
  _tickWeapon(card, delta) {
    const w = card.weapon, d = w.delivery;
    card.holdBeam = false;
    if (d.sustained) {
      card.streamPhase += delta;
      card.holdBeam = card.streamPhase % 2400 < 1600;
    } else if (d.pattern === 'stream') {
      card.streamPhase += delta;
      if (card.streamPhase % 2400 < 1600) {
        card.cd -= delta;
        if (card.cd <= 0) { this._fire(card); card.cd = Math.max(1000 / (d.fireRate || 10), 16); }
      } else card.cd = 0;
    } else {
      card.cd -= delta;
      if (card.cd <= 0) {
        this._fire(card);
        const burstDur = d.burst ? d.burst.count * (d.burst.wubOn ?? d.burst.interval) + (d.burst.count - 1) * (d.burst.wubOff ?? 0) : 0;
        card.cd = Math.max((w.cycleTime || 800) - burstDur, 250);
      }
    }
  }

  // Sound only plays for the SELECTED card — with every weapon auto-firing on its own
  // cadence, playing all of them at once would be noise; the selected one is what you're
  // actually listening to (e.g. tuning in the Weapon Lab sound panel).
  _isAudible(card) { return card.id === this.selectedId; }

  _fire(card) {
    if (this._isAudible(card)) {
      Audio.fire(card.weapon);
      this.scene.time.delayedCall(TRAJECTORY_DELAY, () => Audio.trajectory(card.weapon.id));
    }
    const plan = planEmissions(card.weapon);
    for (const s of plan.shots) {
      if (s.delay > 0) card.pending.push({ at: s.delay, mode: plan.mode, shot: s });
      else this._emit(card, plan.mode, s);
    }
  }

  _emit(card, mode, s) {
    const ax = card.muzzleX, ay = card.muzzleY, color = card.color;
    if (mode === 'contact') {
      card.slashes.push({ t: 0, ttl: 260, color });
      if (this._isAudible(card)) Audio.impact(card.weapon.id);
      return;
    }
    if (mode === 'hitscan') {
      const len = Math.min(card.stageW, card.weapon.range.opt || 200);
      const burstTtl = card.weapon.delivery.burst?.wubOn ?? 130;
      card.beams.push({ x0: ax, y0: ay, x1: ax + len, y1: ay, color, ttl: burstTtl, age: 0, heavy: card.weapon.delivery.kind === 'rail' });
      if (this._isAudible(card)) Audio.impact(card.weapon.id);
      return;
    }
    const angle = s.angleOffset;
    const perp = angle + Math.PI / 2;
    const ox = ax + Math.cos(perp) * s.lateral, oy = ay + Math.sin(perp) * s.lateral;
    card.projectiles.push(makeProjectile(card.weapon, ox, oy, angle, { maxDist: card.stageW }));
  }

  _advance(card, dt, delta) {
    if (card.pending.length) {
      const still = [];
      for (const e of card.pending) { e.at -= delta; if (e.at <= 0) this._emit(card, e.mode, e.shot); else still.push(e); }
      card.pending = still;
    }
    for (const p of card.projectiles) {
      stepProjectile(p, dt, p.homing ? 0 : null);
      if (p.dist >= p.maxDist) {
        p.dead = true;
        if (this._isAudible(card)) Audio.impact(p.weaponId);
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
    const SPARK_FADE = 300;
    for (const b of card.beams) { if (b.ttl <= 0) card.dyingBeams.push({ ...b, fadeAge: 0, fadeTtl: SPARK_FADE }); }
    card.beams = card.beams.filter((b) => b.ttl > 0);
    for (const b of card.dyingBeams) b.fadeAge += ms;
    card.dyingBeams = card.dyingBeams.filter((b) => b.fadeAge < b.fadeTtl);
    card.bursts = card.bursts.filter((b) => b.t < b.ttl);
    card.slashes = card.slashes.filter((s) => s.t < s.ttl);
    card.patches = card.patches.filter((fp) => fp.born < fp.ttl);
  }

  _draw(card) {
    const g = card.fxG;
    g.clear();

    // Ability card: a gentle pulsing signature fx centred in the stage.
    if (!card.weapon) {
      const cx = card.muzzleX + card.stageW / 2, cy = card.muzzleY;
      const pulse = 1 + 0.15 * Math.sin((card.streamPhase += 16) * 0.004);
      drawAbilityFx(g, card.item.ability, cx, cy, 2.2 * pulse);
      return;
    }

    const w = card.weapon;
    g.fillStyle(0x3a4654, 1).fillRect(card.muzzleX - 12, card.muzzleY - 4, 12, 8);   // muzzle nub
    for (const fp of card.patches) drawGroundFire(g, fp.x, fp.y, fp.r, fp.born, 1);
    if (card.holdBeam) {
      const len = Math.min(card.stageW, w.range.opt || 220);
      drawBeam(g, card.muzzleX, card.muzzleY, card.muzzleX + len, card.muzzleY, card.color, 1, false, card.streamPhase);
    }
    for (const b of card.beams) drawBeam(g, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age);
    for (const b of card.dyingBeams) drawBeam(g, b.x0, b.y0, b.x1, b.y1, b.color, 1, b.heavy, b.age + b.fadeAge, 1 - b.fadeAge / b.fadeTtl);
    for (const p of card.projectiles) {
      let lift = 0;
      if (p.arc) {
        lift = Math.sin((p.dist / p.maxDist) * Math.PI) * Math.min(22, p.maxDist * 0.12);
        g.fillStyle(0x000000, 0.25).fillEllipse(p.x, p.y, 7, 3);
      }
      drawProjectileBody(g, p.x, p.y - lift, p.angle, p.kind, p.color, p.scale || 1, p.dist);
    }
    for (const s of card.slashes) drawSlash(g, card.muzzleX, card.muzzleY, 0, s.t / s.ttl, s.color, 1, 34);
    for (const b of card.bursts) {
      const f = 1 - b.t / b.ttl;
      g.lineStyle(2, b.color, f).strokeCircle(b.x, b.y, (1 - f) * 14 + 2);
    }
  }

  destroy() {
    const s = this.scene;
    s.input.off('wheel', this._onWheel);
    s.input.off('pointerdown', this._onDown);
    s.input.off('pointermove', this._onMove);
    s.input.off('pointerup', this._onUp);
    this.maskG.destroy();
    this.root.destroy();
    this.cards = [];
  }
}
