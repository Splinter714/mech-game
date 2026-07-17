// Arena salvage mixin (#65) — SCRAP pickups dropped by some destroyed enemies, distinct from
// the timed-buff powerups (arena/powerups.js) but rolled at the same kill site and drawn with
// the same "world-space collectible" shape (a bobbing/pulsing container) for visual consistency.
// A pickup adds straight into the LIVE run currency (this.run.currency, the same pool
// arena/run.js banks on stage-clear / loses on death), so it shows in the HUD SCRAP readout
// immediately and follows #64's existing banked-vs-lost rules with no extra plumbing.
import { SALVAGE_DROP_CHANCE, salvageAmount } from '../../data/shop.js';
import { scatterOffset } from '../../data/hexgrid.js';
import { Audio } from '../../audio/index.js';
import { DEPTH } from './shared.js';

const SALVAGE_COLOR = 0xf5c542;   // gold/amber — reads distinct from the powerup palette
const PICKUP_RADIUS = 26;
const PICKUP_TTL = 15000;
const BOB_PERIOD = 1300;
const BOB_AMPLITUDE = 1.5;   // #228: smaller/calmer bounce than the powerup beacon's 4px
// #88: same small scatter radius as powerups.js (arena/powerups.js DROP_SCATTER_RADIUS) so a
// kill that drops both a powerup AND salvage spreads them apart rather than stacking.
const DROP_SCATTER_RADIUS = 30;

export const SalvageMixin = {
  _initSalvage() {
    this.salvage = [];   // dropped SCRAP pickups awaiting pickup: { x, y, amount, ttl, age, view }
  },

  // Roll the drop chance and, on success, drop a SCRAP pickup at an enemy's death position.
  // Called from the kill path (combat.js), same call site as _maybeDropPowerup.
  _maybeDropSalvage(x, y) {
    if (Math.random() >= SALVAGE_DROP_CHANCE) return;
    const amount = salvageAmount();
    // #88: scatter the ideal drop point (same treatment as powerups.js spawnPowerup) so a kill
    // that drops both salvage and a powerup at the same spot spreads them apart, then (#73)
    // snap to reachable ground in case the scatter — or the kill site itself, e.g. a flyer over
    // water — landed somewhere the player can't walk to. `_reachableDropPos` lives on
    // PowerupsMixin but both mixins compose onto the same ArenaScene prototype.
    const scattered = scatterOffset(x, y, DROP_SCATTER_RADIUS);
    const pos = this._reachableDropPos ? this._reachableDropPos(scattered.x, scattered.y) : scattered;
    const view = this._makeSalvageView(pos.x, pos.y);
    this.salvage.push({ x: pos.x, y: pos.y, amount, ttl: PICKUP_TTL, age: 0, view });
  },

  // A small spinning gold diamond over a ground glow — a lighter beacon than the powerup one
  // (a passive currency trickle, not a big timed-buff moment) but still readable at a glance.
  // #228 (playtest feedback): pushed clearly below the powerup beacon's size/brightness/bounce
  // rather than just marginally under it — scrap should read as a quiet currency trickle, not
  // another "big pickup" beacon.
  _makeSalvageView(x, y) {
    const glow = this.add.ellipse(0, 6, 20, 8, SALVAGE_COLOR, 0.14);
    const ring = this.add.circle(0, 0, 7, SALVAGE_COLOR, 0.1).setStrokeStyle(2, SALVAGE_COLOR, 0.6);
    const gem = this.add.rectangle(0, 0, 6, 6, SALVAGE_COLOR, 1).setAngle(45).setStrokeStyle(1, 0xffffff, 0.7);
    const c = this.add.container(x, y, [glow, ring, gem]);
    // #99: same WORLD_UI tier as the objective/powerup beacons — a pickup should always read
    // clearly, not get buried under whichever unit happens to walk near it.
    c.setDepth(DEPTH.WORLD_UI);
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
      v.y = s.y + Math.sin(t * Math.PI * 2) * BOB_AMPLITUDE;
      v._gem.rotation += delta * 0.0014;
      v._ring.rotation -= delta * 0.001;
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
    Audio.ui('scrapPickup');   // #178: distinct currency/coin-ish chime
    this._floatText(this.px, this.py - 34, `+${s.amount} SCRAP`, '#f5c542');
  },
};
