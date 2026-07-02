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
// The model is deliberately simple: ONE hit-point pool. But it presents that pool as a small
// map of named "parts" (each a {armor, structure, ...} record like a Mech part) so the arena's
// nearest-part damage mapping still has locations to iterate over — every part shares the one
// underlying pool, so a hit anywhere chips the whole unit and zeroing it kills the unit. The
// caller supplies the part layout (positions in mech-local design coords) so art + hit mapping
// line up; `partHealthFraction` returns the whole-unit health for every part (they're one pool),
// which is exactly what the damage-visual code wants (the unit greys out uniformly as it dies).

// Build the parts map from a layout spec: { locId: { x, y, w, h } }. Each part carries the
// FULL unit hp as its max so a single part's health fraction reads the whole-unit health.
function makeParts(layout, hp) {
  const parts = {};
  for (const loc of Object.keys(layout)) {
    parts[loc] = { maxArmor: 0, maxStructure: hp, armor: 0, structure: hp, ...layout[loc] };
  }
  return parts;
}

export class HpBody {
  // `def` is one entry from the enemy-kind registry:
  //   { name, hp, parts: { locId: {x,y,w,h} } }  (x/y/w/h in mech-local design coords)
  constructor(def = {}) {
    this.kind = 'body';
    this.name = def.name ?? 'Contact';
    this.maxHp = def.hp ?? 40;
    this.hp = this.maxHp;
    this._layout = def.parts ?? { core: { x: 0, y: 0, w: 20, h: 20 } };
    this.parts = makeParts(this._layout, this.maxHp);
  }

  // The location ids this body exposes (what the arena's damage mapper iterates).
  locations() { return Object.keys(this._layout); }

  // ── Body interface (mirrors Mech) ──────────────────────────────────────────
  isDestroyed() { return this.hp <= 0; }

  // Any hit chips the single shared pool. `locationId` is accepted (for interface parity /
  // future per-part armour) but every part draws from the one pool, so where you hit doesn't
  // change the total — it just changes where the damage number floats up. Returns a Mech-shaped
  // result so combat.js feedback code (destroyed? part broke?) works without a special case.
  applyDamage(locationId, amount) {
    if (amount <= 0 || this.hp <= 0) {
      return { applied: 0, destroyed: false, location: locationId, partDestroyedNow: this.hp <= 0 };
    }
    const before = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    this._syncParts();
    const destroyed = this.hp <= 0 && before > 0;   // this hit is what killed it
    return { applied: amount, destroyed, location: locationId, partDestroyedNow: this.hp <= 0 };
  }

  // Whole-unit health fraction (0..1). Same for every location — it's one pool — which makes
  // the unit fade/battered-swap uniformly as it dies (the mech art keys off this per part).
  partHealthFraction() {
    return this.maxHp > 0 ? this.hp / this.maxHp : 0;
  }

  isPartDestroyed() { return this.hp <= 0; }

  // Push the current pool value into every part's `structure` so any reader that inspects the
  // raw part records (rather than partHealthFraction) still sees the live health.
  _syncParts() {
    for (const loc of Object.keys(this.parts)) this.parts[loc].structure = this.hp;
  }

  // Restore to full (used by the arena's reset control).
  repairAll() {
    this.hp = this.maxHp;
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
