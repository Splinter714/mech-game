// A lightweight single-pool damageable body for NON-mech enemies (turrets, tanks, drones,
// helicopters). Pure logic (no Phaser) so it's fully unit-tested and can be swapped in
// wherever the arena expects the small "body interface" a Mech exposes.
//
// Why a shim instead of `if (kind === 'tank')` everywhere: the arena's damage / hit-detection
// / HUD code all talk to an enemy through the SAME handful of methods — `isDestroyed()`,
// `applyDamage(loc, amount)`, `partHealthFraction(loc)`, `name`, plus reading `.parts` (to map
// a world hit-point to a nearest body location) and `repairAll()`. Mech implements those; so
// does this. Backing a non-mech unit with an HpBody therefore lets `_damageEnemyAt`, the
// hitscan/projectile hit loops, `_resetEnemies`, and the HUD alive-count all work UNCHANGED.
//
// #246: the model is ONE hp pool, but now optionally layered like a Mech — a flat ARMOR pool
// (absorbs before hp) and a full-unit SHIELD (absorbs before armor), both purely data-driven
// per enemy kind (`enemyKinds.js`'s `armor`/`shield` fields), so a kind can be configured as
// HP-only, HP+armor, HP+shield, or all three with no per-kind branching in this file. Both
// default to "absent" (armor 0, shield max 0) so every existing kind that doesn't opt in is
// byte-for-byte unchanged. The body still presents its pool as a small map of named "parts"
// (each a {armor, hp, ...} record like a Mech part) so the arena's nearest-part damage mapping
// still has locations to iterate over — every part shares the one underlying pool, so a hit
// anywhere chips the whole unit and zeroing its hp kills the unit. The caller supplies the part
// layout (positions in mech-local design coords) so art + hit mapping line up;
// `partHealthFraction` returns the whole-unit health for every part (they're one pool), which
// is exactly what the damage-visual code wants (the unit greys out uniformly as it dies).
import { createShield, damageShield, tickShield as tickShieldState, fillShield, shieldFraction, shieldPresent } from './shield.js';

// Build the parts map from a layout spec: { locId: { x, y, w, h } }. Each part carries the
// FULL unit hp as its max so a single part's health fraction reads the whole-unit health.
function makeParts(layout, hp) {
  const parts = {};
  for (const loc of Object.keys(layout)) {
    parts[loc] = { maxArmor: 0, maxHp: hp, armor: 0, hp, ...layout[loc] };
  }
  return parts;
}

export class HpBody {
  // `def` is one entry from the enemy-kind registry:
  //   { name, hp, armor, shield, parts: { locId: {x,y,w,h} } }  (x/y/w/h in mech-local design
  //   coords). `armor` (#246, optional, default 0) is a flat pool that absorbs damage before
  //   hp — the non-mech analogue of a Mech's per-location armor, but a single unit-wide pool
  //   since HpBody has no separate per-location tracking. `shield` (optional) is
  //   { max } (pause+regen are shared constants in shield.js since #382) — absent/zero `max`
  //   means this kind has no shield at all.
  constructor(def = {}) {
    this.kind = 'body';
    this.name = def.name ?? 'Contact';
    this.maxHp = def.hp ?? 40;
    this.hp = this.maxHp;
    this.maxArmor = Math.max(0, def.armor ?? 0);
    this.armor = this.maxArmor;
    this.shield = createShield(def.shield);
    this._layout = def.parts ?? { core: { x: 0, y: 0, w: 20, h: 20 } };
    this.parts = makeParts(this._layout, this.maxHp);
    this._syncParts();
  }

  // #106: total health across EVERY layer an attacker has to chew through — hp (structure) +
  // armor + shield — mirroring `Mech.toughness` so the powerup drop curve (data/powerups.js)
  // rates a vehicle and a mech on the same scale. Before this existed the drop curve read
  // `.maxHp`, which here is ONLY the hp pool: a tank's 40-point armor and the gunship's
  // 30-point shield were invisible, systematically under-rating vehicles against mechs (whose
  // `maxHp` already summed armor+structure). `maxHp` itself is deliberately left alone — the
  // HUD and other readers want "the hp pool," not the whole stack.
  get toughness() {
    return this.maxHp + this.maxArmor + Math.max(0, this.shield?.max ?? 0);
  }

  // The location ids this body exposes (what the arena's damage mapper iterates).
  locations() { return Object.keys(this._layout); }

  // ── Body interface (mirrors Mech) ──────────────────────────────────────────
  isDestroyed() { return this.hp <= 0; }

  // Any hit chips the single shared pool, through the SAME layer order as Mech (#246):
  // shield -> armor -> hp. `locationId` is accepted (for interface parity / nearest-part FX
  // placement) but every part draws from the one pool, so where you hit doesn't change the
  // total — it just changes where the damage number floats up. Returns a Mech-shaped result
  // so combat.js feedback code (destroyed? shielded? armor just broke?) works without a
  // special case. `weaponCategory` is the same forward-compat seam as Mech.applyDamage — see
  // data/shield.js `layerMultiplier` (not implemented this pass, every category = 1.0x).
  applyDamage(locationId, amount, weaponCategory) {
    if (amount <= 0 || this.hp <= 0) {
      return {
        applied: 0, destroyed: false, location: locationId, partDestroyedNow: this.hp <= 0,
        shieldAbsorbed: 0, shielded: false, armorBrokeNow: false,
      };
    }
    const shieldRes = damageShield(this.shield, amount);
    const overflow = shieldRes.overflow;
    if (overflow <= 0) {
      this._syncParts();
      return {
        applied: 0, destroyed: false, location: locationId, partDestroyedNow: false,
        shieldAbsorbed: shieldRes.absorbed, shielded: true, armorBrokeNow: false,
      };
    }
    const before = this.hp;
    const armorBefore = this.armor;
    const armorHit = Math.min(this.armor, overflow);
    this.armor -= armorHit;
    const toHp = overflow - armorHit;
    this.hp = Math.max(0, this.hp - toHp);
    this._syncParts();
    const destroyed = this.hp <= 0 && before > 0;   // this hit is what killed it
    const armorBrokeNow = armorBefore > 0 && this.armor <= 0;
    return {
      applied: overflow, destroyed, location: locationId, partDestroyedNow: this.hp <= 0,
      shieldAbsorbed: shieldRes.absorbed, shielded: false, armorBrokeNow,
    };
  }

  // Whole-unit health fraction (0..1), armor + hp combined — same for every location — it's
  // one pool — which makes the unit fade/battered-swap uniformly as it dies (the mech art keys
  // off this per part).
  partHealthFraction() {
    const max = this.maxArmor + this.maxHp;
    return max > 0 ? (this.armor + this.hp) / max : 0;
  }

  isPartDestroyed() { return this.hp <= 0; }

  // "is this unit still wearing plating?" — the flat-pool analogue of `Mech.hasArmor(loc)`.
  // (#300 keyed the vehicle's plated art off this; #472 removed that visual, so this is now a
  // pure model query.) A Mech answers this PER LOCATION (one arm can be stripped while the other isn't); an
  // HpBody has ONE unit-wide armor pool, so the answer is the same for every location — the
  // `locationId` argument exists only for interface parity (callers can pass one or not). That
  // means a vehicle's plating is all-or-nothing across the whole unit, which is exactly what the
  // underlying model says: there is no such thing as "the tank's left side armor is gone."
  hasArmor() { return this.armor > 0; }

  // ── Full-unit shield (#246, mirrors Mech) ──────────────────────────────────
  shieldFraction() { return shieldFraction(this.shield); }
  hasShield() { return shieldPresent(this.shield); }
  tickShield(dt) { tickShieldState(this.shield, dt); }

  // Push the current pool values into every part's `armor`/`hp` so any reader that inspects the
  // raw part records (rather than partHealthFraction) still sees the live health.
  _syncParts() {
    for (const loc of Object.keys(this.parts)) {
      this.parts[loc].armor = this.armor;
      this.parts[loc].hp = this.hp;
    }
  }

  // Restore to full (used by the arena's reset control): hp, armor, and shield (clearing any
  // post-hit regen pause) all top back up.
  repairAll() {
    this.hp = this.maxHp;
    this.armor = this.maxArmor;
    this.shield.pauseRemaining = 0;
    fillShield(this.shield);
    this._syncParts();
  }

  // No-ops so a non-mech body is drop-in wherever a Mech is lightly poked. These units carry
  // no weapons-as-mounts / abilities / ammo through the Mech model — their firing is driven by
  // the per-kind AI from data (enemyKinds.js), not the Mech weapon pipeline.
  regenAmmo() {}
  onlineWeapons() { return []; }
  readyWeapons() { return []; }
  weapons() { return []; }
  abilities() { return []; }
}
