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
// #187: Shield is a damage-pool buff (see data/powerups.js's `absorbShieldDamage`), not a
// timed one — it's tracked here as `this.shieldPool` (a remaining-damage number) in parallel
// to `this.activePowerups` (remaining-ms). Kept out of `buffModifiers`/`activePowerups` since
// its "is it active" question is "pool > 0", not "time remaining > 0".
import { pixelToHex, hexToPixel, axialKey, nearestHex, scatterOffset } from '../../data/hexgrid.js';
import { isPassable } from '../../data/terrain.js';
import { BOUNDARY_RING_WIDTH } from '../../data/worldgen.js';
import { Audio } from '../../audio/index.js';
import { DEPTH } from './shared.js';

const PICKUP_RADIUS = 26;        // px — how close the player must get to grab a collectible
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
    this.shieldPool = 0;             // #187: remaining Shield absorb capacity (damage points), 0 = inactive
    this.powerups = [];              // dropped collectibles awaiting pickup: { x, y, type, age, view }
    this.powerupFx = this.add.graphics();   // (unused sink kept for symmetry; sprites are containers)
    this._initShieldVisual();        // #205: persistent bubble overlay while shieldPool > 0
  },

  // #205 (playtest follow-up to #187): the Shield powerup had NO persistent visual on the
  // player mech — only a per-hit 'shielded' floating text (combat.js). Draws a translucent
  // bubble/ring, in the powerup's own colour (POWERUPS.shield.color), as CHILDREN of
  // `this.playerView` — the player mech's container (locomotion.js `_makeMechView`) — so the
  // bubble tracks the mech's position (and stompy bob) for free with zero per-frame position
  // math of our own. Added after the mech's own sprites so it draws on top, like a shell around
  // the hull. Starts fully hidden; `_updateShieldVisual` below is the only thing that toggles it.
  _initShieldVisual() {
    const color = POWERUPS.shield.color;
    const fill = this.add.circle(0, 0, 36, color, 0.1).setVisible(false);
    const ring = this.add.circle(0, 0, 36).setStrokeStyle(2.5, color, 0.8).setVisible(false);
    const ringOuter = this.add.circle(0, 0, 41).setStrokeStyle(1.5, color, 0.3).setVisible(false);
    this.playerView.add([fill, ring, ringOuter]);
    this._shieldVisual = { fill, ring, ringOuter, active: false, t: 0 };
  },

  // #205: per-frame bubble upkeep — called once from `_updatePowerups` below (same cadence as
  // the shieldPool bookkeeping it reads). Shows/hides the bubble the instant shieldPool crosses
  // 0↔>0 (pickup / break), and while active scales its opacity with the remaining FRACTION of
  // the pool rather than a flat on/off, so the player gets an at-a-glance "how much is left" read
  // — same spirit as the Sprint fuel bar (HudScene `_updateSprintBar`), just drawn in-world
  // instead of on the HUD since this is a persistent-on-the-mech indicator, not a HUD meter.
  // `this._shieldPeak` is the pool value at the moment of the MOST RECENT pickup (set in
  // `_activatePowerup` below) — since the pool only ever counts down between pickups (never back
  // up on its own), that's exactly the right denominator even when a duplicate pickup stacks the
  // cap past the base `shieldCap` (#187's stacking rule).
  _updateShieldVisual(delta) {
    const sv = this._shieldVisual;
    if (!sv) return;
    const pool = this.shieldPool || 0;
    const active = pool > 0;
    if (active !== sv.active) {
      sv.fill.setVisible(active);
      sv.ring.setVisible(active);
      sv.ringOuter.setVisible(active);
      sv.active = active;
      if (!active) sv.t = 0;
    }
    if (!active) return;
    sv.t += delta;
    const cap = this._shieldPeak || POWERUPS.shield.shieldCap;
    const frac = Math.max(0.15, Math.min(1, pool / cap));
    // Slow ambient hum so an idle bubble still reads as "live" rather than a flat decal.
    const pulse = 0.5 + 0.5 * Math.sin(sv.t * 0.0025);
    sv.fill.setAlpha((0.05 + 0.12 * frac) * (0.85 + 0.3 * pulse));
    sv.ring.setAlpha((0.35 + 0.5 * frac) * (0.85 + 0.2 * pulse));
    sv.ringOuter.setAlpha((0.12 + 0.25 * frac) * (0.85 + 0.2 * pulse));
  },

  // #205: a brief outward pulse on the bubble the instant it actually absorbs a hit — reinforces
  // the 'shielded' floating text (combat.js `_damagePlayerAt`) with something ON the mech itself.
  // Mirrors the tween-driven feel of the existing impact `_burst` primitive (combat.js) without
  // needing its pooled-circle machinery, since this reuses the bubble's own persistent shapes.
  _shieldHitFlash() {
    const sv = this._shieldVisual;
    if (!sv || !sv.active) return;
    sv.ring.setScale(1.3);
    sv.fill.setScale(1.18);
    this.tweens.add({ targets: [sv.ring, sv.fill], scale: 1, duration: 220, ease: 'Quad.out' });
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
    const pk = { x: pos.x, y: pos.y, type: typeId, age: 0, view };
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
    // #158: `worldRadius * 2` alone assumed worldRadius is always much bigger than
    // BOUNDARY_RING_WIDTH (true pre-#158; no longer guaranteed once the playable interior
    // shrinks below the ring's own fixed depth) — see spawnPlacement.js `nearestValidHex`'s
    // matching fix/comment for the full reasoning.
    const searchSteps = (this.worldRadius ?? 20) * 2 + BOUNDARY_RING_WIDTH + 15;
    const hex = nearestHex(start, ok, searchSteps) ?? { q: 0, r: 0 };
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

  // Per-frame: bob/pulse live collectibles, and grab any the player touches. Dropped
  // collectibles never expire (#229) — they persist until collected.
  _updatePowerups(delta) {
    if (!this.powerups) return;
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pk = this.powerups[i];
      pk.age += delta;
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

      // Pickup: player within grab radius.
      if (Math.hypot(this.px - pk.x, this.py - pk.y) <= PICKUP_RADIUS) {
        this._activatePowerup(pk.type);
        pk.view.destroy();
        this.powerups.splice(i, 1);
        continue;
      }
    }

    // Count down every active timed buff; prune the expired.
    for (const id of Object.keys(this.activePowerups)) {
      this.activePowerups[id] -= delta;
      if (this.activePowerups[id] <= 0) delete this.activePowerups[id];
    }
    this.registry.set('activePowerups', { ...this.activePowerups });
    // #187: Shield has no timer to count down — its pool only drains when damage actually
    // lands (see combat.js `damagePlayer`), so just publish the current remaining pool for
    // the HUD each frame.
    this.registry.set('shieldPool', this.shieldPool || 0);
    // #205: keep the on-mech bubble in sync with the pool every frame (show/hide on the
    // 0↔>0 edge, fade with the remaining fraction).
    this._updateShieldVisual(delta);
  },

  // Apply a picked-up powerup. Instant types (Armor Patch) resolve immediately and never enter
  // the active set; Shield ADDS to its remaining damage pool (its own "duplicate refreshes"
  // rule, since it has no time to refresh); everything else is a timed buff that sets/refreshes
  // its per-type countdown (one-per-type stacking).
  _activatePowerup(typeId) {
    const p = POWERUPS[typeId];
    if (!p) return;
    // #196: each powerup type now has its OWN independently-tunable pickup cue (was one
    // shared 'powerupPickup' cue for all five) — dispatch keyed off the actual type picked up.
    Audio.ui('powerupPickup' + typeId[0].toUpperCase() + typeId.slice(1));
    if (isInstant(typeId)) {
      this._applyInstantPowerup(typeId);
    } else if (p.effect === 'shield') {
      // #187: duplicate pickup while already active ADDS to the remaining pool rather than
      // replacing it — mirrors the timed-buff "duplicate refreshes remaining time" pattern,
      // adapted to a damage-remaining pool (accumulate, no cap; the owner can add one via
      // playtest if stacking turns out to be too strong).
      this.shieldPool = (this.shieldPool || 0) + (p.shieldCap ?? 0);
      // #205: remember the pool value at THIS pickup as the bubble's fraction denominator —
      // see `_updateShieldVisual` above for why this (not the base shieldCap) is the right cap
      // once stacking has pushed the pool past it.
      this._shieldPeak = this.shieldPool;
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
