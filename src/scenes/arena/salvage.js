// Arena salvage mixin (#65) — SCRAP pickups dropped by some destroyed enemies, distinct from
// the timed-buff powerups (arena/powerups.js) but rolled at the same kill site and drawn with
// the same "world-space collectible" shape (a bobbing/pulsing container) for visual consistency.
// A pickup adds straight into the LIVE run currency (this.run.currency, the same pool
// arena/run.js banks on stage-clear / loses on death), so it shows in the HUD SCRAP readout
// immediately and follows #64's existing banked-vs-lost rules with no extra plumbing.
import { SALVAGE_DROP_CHANCE, salvageAmount } from '../../data/shop.js';
import { Audio } from '../../audio/index.js';

const SALVAGE_COLOR = 0xf5c542;   // gold/amber — reads distinct from the powerup palette
const PICKUP_RADIUS = 26;
const PICKUP_TTL = 15000;
const BOB_PERIOD = 1300;

export const SalvageMixin = {
  _initSalvage() {
    this.salvage = [];   // dropped SCRAP pickups awaiting pickup: { x, y, amount, ttl, age, view }
  },

  // Roll the drop chance and, on success, drop a SCRAP pickup at an enemy's death position.
  // Called from the kill path (combat.js), same call site as _maybeDropPowerup.
  _maybeDropSalvage(x, y) {
    if (Math.random() >= SALVAGE_DROP_CHANCE) return;
    const amount = salvageAmount();
    const view = this._makeSalvageView(x, y);
    this.salvage.push({ x, y, amount, ttl: PICKUP_TTL, age: 0, view });
  },

  // A small spinning gold diamond over a ground glow — a lighter beacon than the powerup one
  // (a passive currency trickle, not a big timed-buff moment) but still readable at a glance.
  _makeSalvageView(x, y) {
    const glow = this.add.ellipse(0, 6, 30, 12, SALVAGE_COLOR, 0.22);
    const ring = this.add.circle(0, 0, 10, SALVAGE_COLOR, 0.16).setStrokeStyle(2, SALVAGE_COLOR, 0.9);
    const gem = this.add.rectangle(0, 0, 9, 9, SALVAGE_COLOR, 1).setAngle(45).setStrokeStyle(1, 0xffffff, 0.8);
    const c = this.add.container(x, y, [glow, ring, gem]);
    c._glow = glow; c._ring = ring; c._gem = gem;
    return c;
  },

  // Per-frame: bob/spin live drops, expire old ones, grab any the player touches.
  _updateSalvage(delta) {
    if (!this.salvage) return;
    for (let i = this.salvage.length - 1; i >= 0; i--) {
      const s = this.salvage[i];
      s.age += delta;
      s.ttl -= delta;
      const t = s.age / BOB_PERIOD;
      const v = s.view;
      v.y = s.y + Math.sin(t * Math.PI * 2) * 3;
      v._gem.rotation += delta * 0.002;
      v._ring.rotation -= delta * 0.0015;
      if (s.ttl < 1000) v.setAlpha(Math.max(0, s.ttl / 1000));

      if (Math.hypot(this.px - s.x, this.py - s.y) <= PICKUP_RADIUS) {
        this._collectSalvage(s);
        v.destroy();
        this.salvage.splice(i, 1);
        continue;
      }
      if (s.ttl <= 0) { v.destroy(); this.salvage.splice(i, 1); }
    }
  },

  // Feed a pickup straight into the live run's currency total — the same field _advanceRun
  // banks from and _endRun persists, so this needs no separate bookkeeping.
  _collectSalvage(s) {
    if (this.run) {
      this.run.currency += s.amount;
      this.registry.set('run', this.run);
    }
    Audio.ability?.('shield');   // reuse the bright pickup blip; a bespoke cue is later polish
    this._floatText(this.px, this.py - 34, `+${s.amount} SCRAP`, '#f5c542');
  },
};
