// Generic mech model. A mech is a chassis (weight class + per-location stats +
// movement tuning) filled with mounted items. All chassis/weapon differences come
// from data (chassis/, weapons.js), so the model itself stays small. Pure logic only
// (no Phaser) so the damage/kill rules and build math are fully unit-tested
// (Mech.test.js); the arena/garage drive the model and render it.

import { getChassis } from './chassis/index.js';
import { LOCATIONS, MOUNT_LOCATIONS, ABILITY_SLOTS, DESTROY_CASCADE, partDestroyed, mechDestroyed } from './anatomy.js';
import { isWeapon, getItem } from './items.js';
import { getWeapon } from './weapons.js';
import { getEquipment } from './equipment.js';
import * as loadout from './loadout.js';

export class Mech {
  constructor(data = {}) {
    this.chassisId = data.chassisId ?? 'medium';
    this._chassis = getChassis(this.chassisId);
    this.name = data.name ?? this._chassis.name;

    // Mounted items per location (array of item ids). Unknown ids — e.g. equipment
    // removed from the catalog since an old build was saved — are dropped so stale
    // saves load cleanly instead of crashing the renderer.
    this.mounts = {};
    for (const loc of LOCATIONS) {
      this.mounts[loc] = (data.mounts?.[loc] ?? []).filter((id) => getItem(id));
    }

    // Per-weapon ammo: a parallel array to mounts[loc] holding each weapon's current
    // magazine (null = unlimited / non-weapon). Runtime combat state, so it isn't
    // serialized — it starts full and tops back up over time (see regenAmmo).
    this._initAmmo();

    // Per-location health: armor (outer) + structure (inner). Restored from saved
    // `damage` if present, else full from the chassis.
    this.parts = {};
    for (const loc of LOCATIONS) {
      const def = this._chassis.locations[loc];
      const saved = data.damage?.[loc];
      this.parts[loc] = {
        maxArmor: def.maxArmor,
        maxStructure: def.maxStructure,
        armor: saved?.armor ?? def.maxArmor,
        structure: saved?.structure ?? def.maxStructure,
      };
    }
  }

  // Magazine capacity for an item id (null = unlimited or non-weapon).
  _ammoCap(id) {
    const w = getWeapon(id);
    return w && w.ammoMax != null ? w.ammoMax : null;
  }

  // (Re)build the ammo arrays so each weapon starts with a full magazine.
  _initAmmo() {
    this.ammo = {};
    for (const loc of LOCATIONS) this.ammo[loc] = this.mounts[loc].map((id) => this._ammoCap(id));
  }

  get chassis() { return this._chassis; }
  get weightClass() { return this._chassis.weightClass; }
  get movement() { return this._chassis.movement; }

  // ── Damage & destruction ──────────────────────────────────────────────────
  // Apply `amount` damage to a location: armor absorbs first, the rest cuts into
  // structure. Structure at 0 = the part is destroyed; destroying the head also
  // destroys the cockpit inside it. Returns a small result for feedback/FX.
  applyDamage(locationId, amount) {
    const p = this.parts[locationId];
    if (!p || amount <= 0) return { applied: 0, destroyed: false, location: locationId };
    const before = p.structure;
    const armorHit = Math.min(p.armor, amount);
    p.armor -= armorHit;
    const toStructure = amount - armorHit;
    p.structure = Math.max(0, p.structure - toStructure);
    const destroyed = p.structure <= 0 && before > 0;
    if (destroyed) this._cascadeDestroy(locationId);
    return { applied: amount, destroyed, location: locationId, partDestroyedNow: p.structure <= 0 };
  }

  // Destroy the locations that depend on `loc` (a side torso takes its arm, the head
  // takes the cockpit), recursively, zeroing their armor + structure so their mounts go
  // offline too.
  _cascadeDestroy(loc) {
    for (const dep of DESTROY_CASCADE[loc] ?? []) {
      const dp = this.parts[dep];
      if (dp && dp.structure > 0) {
        dp.armor = 0;
        dp.structure = 0;
        this._cascadeDestroy(dep);
      }
    }
  }

  isPartDestroyed(locationId) { return partDestroyed(this.parts[locationId]); }
  isDestroyed() { return mechDestroyed(this.parts); }

  // Mobility multiplier. Legs aren't targetable any more, so mobility is always full;
  // kept as a hook in case a future effect (immobilize, EMP) wants to scale it.
  legFactor() {
    return 1;
  }

  // Fraction of a part's total health remaining (armor + structure), 0..1 — used for
  // damage visuals (a part swaps to a battered/destroyed drawing as this drops).
  partHealthFraction(locationId) {
    const p = this.parts[locationId];
    if (!p) return 0;
    const max = p.maxArmor + p.maxStructure;
    return max > 0 ? (p.armor + p.structure) / max : 0;
  }

  // ── Mounting / build ──────────────────────────────────────────────────────
  canMount(loc, itemId) { return loadout.canMount(this._chassis, this.mounts, loc, itemId); }

  mount(loc, itemId) {
    const res = this.canMount(loc, itemId);
    if (res.ok) {
      this.mounts[loc].push(itemId);
      this.ammo[loc].push(this._ammoCap(itemId));
    }
    return res;
  }

  unmount(loc, index) {
    this.ammo[loc].splice(index, 1);
    return this.mounts[loc].splice(index, 1)[0];
  }

  usedSlots(loc) { return loadout.usedSlots(this.mounts, loc); }
  slotCapacity(loc) { return loadout.slotCapacity(this._chassis, loc); }
  freeSlots(loc) { return loadout.freeSlots(this._chassis, this.mounts, loc); }
  validate() { return loadout.validateLoadout(this._chassis, this.mounts); }
  // A build is deployable only when it's legal AND every skill slot is filled.
  isComplete() { return this.validate().ok && MOUNT_LOCATIONS.every((loc) => this.usedSlots(loc) > 0); }

  // ── Weapons & ammo ────────────────────────────────────────────────────────
  // Every mounted weapon with its resolved stats, whether it's online (its part is
  // intact), its current ammo (null = unlimited), and whether it's ready to fire
  // (online AND has a round chambered).
  weapons() {
    const out = [];
    for (const loc of MOUNT_LOCATIONS) {
      this.mounts[loc].forEach((id, index) => {
        if (isWeapon(id)) {
          const online = !this.isPartDestroyed(loc);
          const ammo = this.ammo[loc][index];
          out.push({
            location: loc, index, id, weapon: getWeapon(id), online, ammo,
            ready: online && (ammo == null || ammo >= 1),
          });
        }
      });
    }
    return out;
  }

  onlineWeapons() { return this.weapons().filter((w) => w.online); }
  readyWeapons() { return this.weapons().filter((w) => w.ready); }

  // Activated abilities mounted in the ability slots (head / centre torso), each with
  // its bound location so the arena can map a button press to it.
  abilities() {
    const out = [];
    for (const loc of ABILITY_SLOTS) {
      const id = this.mounts[loc][0];
      if (id && !isWeapon(id)) out.push({ location: loc, id, equip: getEquipment(id) });
    }
    return out;
  }

  // Spend `n` rounds from a weapon's magazine (no-op for unlimited weapons).
  consumeAmmo(loc, index, n = 1) {
    if (this.ammo[loc]?.[index] != null) {
      this.ammo[loc][index] = Math.max(0, this.ammo[loc][index] - n);
    }
  }

  // Top every magazine back up over time at the weapon's regen rate.
  regenAmmo(dt) {
    for (const loc of LOCATIONS) {
      this.mounts[loc].forEach((id, i) => {
        if (this.ammo[loc][i] == null) return;
        const w = getWeapon(id);
        this.ammo[loc][i] = Math.min(w.ammoMax, this.ammo[loc][i] + w.ammoRegen * dt);
      });
    }
  }

  // Scale every location's max armor + structure by `mult` (and refill to the new max).
  // Opt-in and applied at instantiation time — NOT in the shared chassis data — so it
  // affects only the mech it's called on. The arena uses this to give the PLAYER a large
  // survivability buffer without touching enemies (who share the same chassis configs).
  boostHealth(mult) {
    for (const loc of LOCATIONS) {
      const p = this.parts[loc];
      p.maxArmor = Math.round(p.maxArmor * mult);
      p.maxStructure = Math.round(p.maxStructure * mult);
      p.armor = p.maxArmor;
      p.structure = p.maxStructure;
    }
  }

  // Instant proportional armor repair (#60 Armor Patch powerup): restore a fraction of
  // EACH damaged location's MISSING armor (maxArmor - armor), so every location that has
  // lost armor gets some back scaled to what it's missing. Structure is untouched (this
  // patches the outer plating only). Returns the total armor restored, for feedback.
  repairArmor(frac) {
    let restored = 0;
    for (const loc of LOCATIONS) {
      const p = this.parts[loc];
      const missing = p.maxArmor - p.armor;
      if (missing <= 0) continue;
      const add = missing * frac;
      p.armor = Math.min(p.maxArmor, p.armor + add);
      restored += add;
    }
    return restored;
  }

  // Restore a mech to pristine condition (used when deploying a fresh build): full
  // health and full magazines.
  repairAll() {
    for (const loc of LOCATIONS) {
      const p = this.parts[loc];
      p.armor = p.maxArmor;
      p.structure = p.maxStructure;
    }
    this._initAmmo();
  }

  toJSON() {
    const mounts = {};
    const damage = {};
    for (const loc of LOCATIONS) {
      mounts[loc] = [...this.mounts[loc]];
      damage[loc] = { armor: this.parts[loc].armor, structure: this.parts[loc].structure };
    }
    return { chassisId: this.chassisId, name: this.name, mounts, damage };
  }
}
