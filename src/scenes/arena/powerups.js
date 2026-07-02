// Arena powerups mixin (#60) — world-space collectibles that grant timed combat buffs.
// Methods use `this` (the ArenaScene); composed onto the prototype via Object.assign. The
// PURE logic (the powerup table, weighted pick, buff-overlay math, armor-repair calc) lives
// in data/powerups.js and is unit-tested; this file owns only the Phaser-side concerns:
// spawning/drawing the collectible, player collision, activation, the per-type countdown, and
// exposing the current buff modifiers to the firing/movement code paths.
//
// The overlay is `this.activePowerups` — a map { typeId → remaining ms } living on the scene,
// NEVER a mutation of the Mech, so buffs expire cleanly. `_buffMods()` collapses it (via the
// pure buffModifiers) into the multipliers/flags the other mixins read. Stacking is one-per-
// type: a duplicate pickup of an active type just refreshes its remaining time.
import {
  POWERUPS, DROP_CHANCE, pickPowerupType, isInstant, durationMs, buffModifiers,
} from '../../data/powerups.js';
import { Audio } from '../../audio/index.js';

const PICKUP_RADIUS = 26;        // px — how close the player must get to grab a collectible
const PICKUP_TTL = 15000;        // ms — a dropped collectible lingers this long, then fades
const BOB_PERIOD = 1400;         // ms — collectible hover-bob cycle

export const PowerupsMixin = {
  // One-time init from ArenaScene.create(). Overlay state + the graphics layer collectibles
  // are drawn on. Kept separate from the world so it can be cleared/redrawn each frame.
  _initPowerups() {
    this.activePowerups = {};        // typeId → remaining ms (only live buffs; expired pruned)
    this.powerups = [];              // dropped collectibles awaiting pickup: { x, y, type, ttl, age, view }
    this.powerupFx = this.add.graphics();   // (unused sink kept for symmetry; sprites are containers)
  },

  // Source-agnostic drop: place a world-space collectible of a weighted-random type at (x, y).
  // Enemy death calls this; a future facility / world resource can call the same entry point.
  spawnPowerup(x, y, typeId = pickPowerupType()) {
    const p = POWERUPS[typeId];
    if (!p) return null;
    const view = this._makePowerupView(x, y, p);
    const pk = { x, y, type: typeId, ttl: PICKUP_TTL, age: 0, view };
    this.powerups.push(pk);
    return pk;
  },

  // Roll the drop chance and, on success, drop a powerup at an enemy's death position. Called
  // from the kill path (combat.js). Kept here so the drop odds + spawn live in one place.
  _maybeDropPowerup(x, y) {
    if (Math.random() < DROP_CHANCE) this.spawnPowerup(x, y);
  },

  // The collectible's look: a small glowing diamond in the powerup's colour with a soft halo,
  // built as a container so it can bob + pulse and be destroyed cleanly on pickup/expiry.
  _makePowerupView(x, y, p) {
    const halo = this.add.circle(0, 0, 16, p.color, 0.18);
    const ring = this.add.circle(0, 0, 11).setStrokeStyle(2, p.color, 0.9);
    const core = this.add.rectangle(0, 0, 11, 11, p.color, 0.95).setAngle(45);
    const c = this.add.container(x, y, [halo, ring, core]);
    c._halo = halo; c._core = core;
    return c;
  },

  // Per-frame: bob/pulse live collectibles, expire old ones, and grab any the player touches.
  _updatePowerups(delta) {
    if (!this.powerups) return;
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pk = this.powerups[i];
      pk.age += delta;
      pk.ttl -= delta;
      // Bob + pulse.
      const t = pk.age / BOB_PERIOD;
      pk.view.y = pk.y + Math.sin(t * Math.PI * 2) * 3;
      const pulse = 0.85 + 0.15 * Math.sin(t * Math.PI * 4);
      pk.view._core.setScale(pulse);
      pk.view._halo.setScale(pulse);
      // Fade out in the last second before expiry.
      if (pk.ttl < 1000) pk.view.setAlpha(Math.max(0, pk.ttl / 1000));

      // Pickup: player within grab radius.
      if (Math.hypot(this.px - pk.x, this.py - pk.y) <= PICKUP_RADIUS) {
        this._activatePowerup(pk.type);
        pk.view.destroy();
        this.powerups.splice(i, 1);
        continue;
      }
      if (pk.ttl <= 0) { pk.view.destroy(); this.powerups.splice(i, 1); }
    }

    // Count down every active timed buff; prune the expired.
    for (const id of Object.keys(this.activePowerups)) {
      this.activePowerups[id] -= delta;
      if (this.activePowerups[id] <= 0) delete this.activePowerups[id];
    }
    this.registry.set('activePowerups', { ...this.activePowerups });
  },

  // Apply a picked-up powerup. Instant types (Armor Patch) resolve immediately and never enter
  // the active set; timed types set/refresh their per-type countdown (one-per-type stacking).
  _activatePowerup(typeId) {
    const p = POWERUPS[typeId];
    if (!p) return;
    Audio.ability?.('shield');   // reuse a bright pickup blip; a bespoke cue is a later polish
    if (isInstant(typeId)) {
      this._applyInstantPowerup(typeId);
    } else {
      this.activePowerups[typeId] = durationMs(typeId);   // set OR refresh
    }
    const col = '#' + p.color.toString(16).padStart(6, '0');
    this._floatText(this.px, this.py - 34, p.label, col);
  },

  // Instant powerup effects (no timer). Currently just Armor Patch: whole-mech proportional
  // repair of missing armor (delegates the per-location math to the model / pure calc).
  _applyInstantPowerup(typeId) {
    if (typeId === 'armorPatch') {
      const restored = this.mech.repairArmor(POWERUPS.armorPatch.repairFrac);
      if (restored > 0) this._floatText(this.px, this.py - 20, `+${Math.round(restored)} armor`, '#8ad0ff');
    }
  },

  // The current buff overlay collapsed to plain multipliers/flags (see data/powerups.js
  // buffModifiers). Cached per-frame so the several read sites (firing, movement, turret,
  // regen) don't recompute. Call `_refreshBuffMods()` once per update tick before they run.
  _refreshBuffMods() {
    this._buffModsCache = buffModifiers(this.activePowerups || {});
    return this._buffModsCache;
  },
  _buffMods() {
    return this._buffModsCache || buffModifiers(this.activePowerups || {});
  },
};
