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
  POWERUPS, dropChanceForMaxHp, pickPowerupType, isInstant, durationMs, buffModifiers,
} from '../../data/powerups.js';
import { pixelToHex, hexToPixel, axialKey, nearestHex, scatterOffset } from '../../data/hexgrid.js';
import { isPassable } from '../../data/terrain.js';
import { Audio } from '../../audio/index.js';
import { DEPTH } from './shared.js';

const PICKUP_RADIUS = 26;        // px — how close the player must get to grab a collectible
const PICKUP_TTL = 15000;        // ms — a dropped collectible lingers this long, then fades
const BOB_PERIOD = 1400;         // ms — collectible hover-bob cycle
// #88: small random scatter applied to a drop's kill-site spawn point before the #73
// reachable-ground snap, so simultaneous/nearby drops don't stack on the exact same pixel.
// ~30px keeps the scatter well inside "still clearly at this kill site" (a hex is 48px) while
// being comfortably bigger than PICKUP_RADIUS so two scattered drops usually don't overlap.
const DROP_SCATTER_RADIUS = 30;

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
    // #88: scatter the ideal drop point a small random distance first, so a kill that drops
    // multiple things (or several close-together kills) spreads them apart instead of
    // stacking on the same pixel...
    const scattered = scatterOffset(x, y, DROP_SCATTER_RADIUS);
    // #73: ...then, enemies (esp. flyers) can die over deep water, inside walls, or beyond the
    // world edge, where the player can never walk to the drop (and the scatter above could
    // itself wander into one of those). Relocate to the nearest REACHABLE ground so it's
    // always collectible; the drop stays as close to the (scattered) kill point as possible.
    const pos = this._reachableDropPos(scattered.x, scattered.y);
    const view = this._makePowerupView(pos.x, pos.y, p);
    const pk = { x: pos.x, y: pos.y, type: typeId, ttl: PICKUP_TTL, age: 0, view };
    this.powerups.push(pk);
    return pk;
  },

  // #73: snap a drop position to the nearest place the player can actually reach — inside the
  // world disc and on passable ground (not deep water / impassable terrain / off-map). If the
  // requested spot is already reachable it's returned unchanged; otherwise we search outward
  // ring-by-ring from the death hex for the closest passable tile and use its centre. If (very
  // unlikely) nothing passable is found nearby, fall back to the always-open world centre so a
  // drop is NEVER stranded.
  _reachableDropPos(x, y) {
    if (this.terrain && this._blocked && !this._blocked(x, y)) return { x, y };
    const start = pixelToHex(x, y);
    const ok = (q, r) => isPassable(this.terrain?.get(axialKey(q, r)));
    const hex = nearestHex(start, ok, (this.worldRadius ?? 20) * 2) ?? { q: 0, r: 0 };
    return hexToPixel(hex.q, hex.r);
  },

  // Roll the drop chance and, on success, drop a powerup at an enemy's death position. Called
  // from the kill path (combat.js). Kept here so the drop odds + spawn live in one place.
  // #90: the odds now scale with `maxHp`, the killed enemy's max hit points (a uniform
  // difficulty signal present on both Mech and the non-mech HpBody) — see
  // `dropChanceForMaxHp` in data/powerups.js for the curve/bounds.
  _maybeDropPowerup(x, y, maxHp) {
    if (Math.random() < dropChanceForMaxHp(maxHp)) this.spawnPowerup(x, y);
  },

  // The collectible's look: a high-contrast beacon so it's easy to spot across the dark arena.
  // Layered bottom→top: a flat ground glow puddle (sits on the terrain), a vertical light beam
  // rising off it, a big soft pulsing halo, a bright spinning ring, and a hot near-white core in
  // the powerup's colour. Built as a container so the whole beacon bobs, pulses and spins, and
  // tears down cleanly on pickup/expiry. Everything is tinted with the per-type `p.color`.
  _makePowerupView(x, y, p) {
    // Flat ground puddle — an ellipse squashed on Y so it reads as light pooled on the floor,
    // NOT bobbing with the rest (kept at the base). Two rings for a soft edge.
    const glowOuter = this.add.ellipse(0, 6, 60, 22, p.color, 0.16);
    const glowInner = this.add.ellipse(0, 6, 34, 13, p.color, 0.28);
    // Vertical light beam rising off the drop — a tall thin triangle, brightest at the base.
    const beam = this.add.triangle(0, 0, -7, 4, 7, 4, 0, -46, p.color, 0.22);
    // Big soft halo that pulses — the main "there's something here" signal.
    const halo = this.add.circle(0, 0, 22, p.color, 0.28);
    // Bright spinning ring outline.
    const ring = this.add.circle(0, 0, 13).setStrokeStyle(3, p.color, 1);
    // Hot core — near-white centre so it punches against dark ground, edged in the type colour.
    const core = this.add.rectangle(0, 0, 12, 12, p.color, 1).setAngle(45).setStrokeStyle(2, 0xffffff, 0.9);
    const spark = this.add.rectangle(0, 0, 5, 5, 0xffffff, 0.95).setAngle(45);
    const c = this.add.container(x, y, [glowOuter, glowInner, beam, halo, ring, core, spark]);
    // #99: same WORLD_UI tier as the objective marker/salvage beacon — a timed-buff pickup is
    // meant to be an eye-catching beacon, so it should never get lost under a passing unit.
    c.setDepth(DEPTH.WORLD_UI);
    c._halo = halo; c._core = core; c._ring = ring; c._beam = beam;
    c._glow = [glowOuter, glowInner]; c._spark = spark;
    return c;
  },

  // Per-frame: bob/pulse live collectibles, expire old ones, and grab any the player touches.
  _updatePowerups(delta) {
    if (!this.powerups) return;
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pk = this.powerups[i];
      pk.age += delta;
      pk.ttl -= delta;
      // Bob + pulse + spin. The container bobs; the ground glow is counter-offset so it stays
      // pooled on the floor while the beacon rises and falls above it.
      const t = pk.age / BOB_PERIOD;
      const bob = Math.sin(t * Math.PI * 2) * 4;
      const v = pk.view;
      v.y = pk.y + bob;
      // Fast, high-contrast pulse: the halo swells and brightens on the beat so it visibly
      // "breathes" against the dark ground; the core pumps a touch out of phase for life.
      const pulse = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * Math.PI * 4));  // 0..1 on the beat
      v._halo.setScale(0.85 + 0.5 * pulse).setAlpha(0.18 + 0.34 * pulse);
      v._core.setScale(0.92 + 0.12 * Math.sin(t * Math.PI * 4 + 1));
      v._ring.setScale(0.95 + 0.18 * pulse);
      v._ring.rotation += delta * 0.003;           // slow spin on the ring
      v._spark.rotation -= delta * 0.006;
      v._beam.setScale(1, 0.9 + 0.25 * pulse).setAlpha(0.14 + 0.18 * pulse);
      // Ground glow stays on the floor (counter the bob) and shimmers with the pulse.
      for (const g of v._glow) { g.y = 6 - bob; g.setScale(0.9 + 0.2 * pulse); }
      // Fade out in the last second before expiry.
      if (pk.ttl < 1000) v.setAlpha(Math.max(0, pk.ttl / 1000));

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
