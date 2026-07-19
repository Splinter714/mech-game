// Arena salvage mixin (#65) — SCRAP pickups dropped by some destroyed enemies, distinct from
// the timed-buff powerups (arena/powerups.js) but rolled at the same kill site and drawn with
// the same "world-space collectible" shape (a bobbing/pulsing container) for visual consistency.
// A pickup adds straight into the LIVE run currency (this.run.currency, the same pool
// arena/run.js banks on stage-clear / loses on death), so it shows in the HUD SCRAP readout
// immediately and follows #64's existing banked-vs-lost rules with no extra plumbing.
import { SALVAGE_DROP_CHANCE, salvageAmount } from '../../data/shop.js';
import { scatterOffset } from '../../data/hexgrid.js';
import { DROP_SCATTER_RADIUS } from '../../data/dropPlacement.js';
import { Audio } from '../../audio/index.js';
import { DEPTH } from './shared.js';

const SALVAGE_COLOR = 0xf5c542;   // gold/amber — reads distinct from the powerup palette
export const PICKUP_RADIUS = 26;
// #226: a small magnetic pull — once the player gets this close, an uncollected drop drifts
// toward them each frame instead of sitting still until touched.
// Playtest follow-up (#226): the original 80px radius felt too tight — Jackson asked for
// 2-4x; landed on 3x (240px) as the middle-ground default. At that larger radius the old
// edge speed (0.15px/ms) took ~3x longer to close the full distance (same absolute speed,
// 3x the distance), so both speeds are bumped up proportionally-ish to keep the drift feeling
// snappy rather than sluggish over the wider capture area.
export const MAGNET_RADIUS = 240;
export const MAGNET_MIN_SPEED = 0.25;   // px/ms at the outer edge of the magnet radius
export const MAGNET_MAX_SPEED = 0.6;    // px/ms right on top of the player — the drift accelerates in
const BOB_PERIOD = 1300;
const BOB_AMPLITUDE = 1.5;   // #228: smaller/calmer bounce than the powerup beacon's 4px
// #88: the scatter radius is shared with powerups (#336 moved the constant into
// data/dropPlacement.js) so a kill that drops both a powerup AND salvage spreads them apart
// rather than stacking, and both stay tame enough not to cross a wall.

export const SalvageMixin = {
  _initSalvage() {
    this.salvage = [];   // dropped SCRAP pickups awaiting pickup: { x, y, amount, age, view }
  },

  // Roll the drop chance and, on success, drop a SCRAP pickup at an enemy's death position.
  // Called from the kill path (combat.js), same call site as _maybeDropPowerup.
  _maybeDropSalvage(x, y, flying = false) {
    if (Math.random() >= SALVAGE_DROP_CHANCE) return;
    const amount = salvageAmount();
    // #88: scatter the ideal drop point (same treatment as powerups.js spawnPowerup) so a kill
    // that drops both salvage and a powerup at the same spot spreads them apart, then (#73)
    // snap to reachable ground in case the scatter — or the kill site itself, e.g. a flyer over
    // water — landed somewhere the player can't walk to. `_reachableDropPos` lives on
    // PowerupsMixin but both mixins compose onto the same ArenaScene prototype.
    // #336: anchored to the kill's own side of any wall (the player's, for a flyer) so scrap
    // never lands through a base wall either.
    const scattered = scatterOffset(x, y, DROP_SCATTER_RADIUS);
    const ref = this._dropSideRef ? this._dropSideRef(x, y, flying) : null;
    const pos = this._reachableDropPos ? this._reachableDropPos(scattered.x, scattered.y, ref) : scattered;
    const view = this._makeSalvageView(pos.x, pos.y);
    this.salvage.push({ x: pos.x, y: pos.y, amount, age: 0, view });
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

  // Per-frame: bob/spin live drops, grab any the player touches. Dropped SCRAP never
  // expires (#229) — it persists until collected.
  _updateSalvage(delta) {
    if (!this.salvage) return;
    for (let i = this.salvage.length - 1; i >= 0; i--) {
      const s = this.salvage[i];
      s.age += delta;

      // #226: magnetic drift — inside MAGNET_RADIUS (but before actual pickup range) the drop's
      // world position (s.x/s.y) creeps toward the player each frame, accelerating as it closes
      // in. This only moves the underlying position; the bob/spin below is layered on top of it
      // each frame, so the two never fight — the drop bobs while it drifts, same as while still.
      const dx = this.px - s.x, dy = this.py - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0 && dist <= MAGNET_RADIUS) {
        const closeness = 1 - dist / MAGNET_RADIUS;   // 0 at the outer edge, →1 near the player
        const speed = MAGNET_MIN_SPEED + (MAGNET_MAX_SPEED - MAGNET_MIN_SPEED) * closeness;
        const step = Math.min(dist, speed * delta);
        s.x += (dx / dist) * step;
        s.y += (dy / dist) * step;
      }

      const t = s.age / BOB_PERIOD;
      const v = s.view;
      v.x = s.x;
      v.y = s.y + Math.sin(t * Math.PI * 2) * BOB_AMPLITUDE;
      v._gem.rotation += delta * 0.0014;
      v._ring.rotation -= delta * 0.001;

      if (Math.hypot(this.px - s.x, this.py - s.y) <= PICKUP_RADIUS) {
        this._collectSalvage(s);
        v.destroy();
        this.salvage.splice(i, 1);
        continue;
      }
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
  },
};
