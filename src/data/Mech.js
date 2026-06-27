// Generic mech model. A mech is a chassis (weight class + per-location stats +
// movement tuning) filled with mounted items. All chassis/weapon differences come
// from data (chassis/, weapons.js), so the model itself stays small. Pure logic only
// (no Phaser) so the damage/kill rules and build math are fully unit-tested
// (Mech.test.js); the arena/garage drive the model and render it.

import { getChassis } from './chassis/index.js';
import { LOCATIONS, MOUNT_LOCATIONS, partDestroyed, mechDestroyed } from './anatomy.js';
import { isWeapon } from './items.js';
import { getWeapon } from './weapons.js';
import { getEquipment } from './equipment.js';
import * as loadout from './loadout.js';

const BASE_HEAT_CAP = 30;
const BASE_DISSIPATION = 1; // baseline heat shed per second, before heat sinks

export class Mech {
  constructor(data = {}) {
    this.chassisId = data.chassisId ?? 'medium';
    this._chassis = getChassis(this.chassisId);
    this.name = data.name ?? this._chassis.name;

    // Mounted items per location (array of item ids).
    this.mounts = {};
    for (const loc of LOCATIONS) this.mounts[loc] = [...(data.mounts?.[loc] ?? [])];

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

    this.heat = data.heat ?? 0;
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
    if (destroyed && locationId === 'head') this.parts.cockpit.structure = 0;
    return { applied: amount, destroyed, location: locationId, partDestroyedNow: p.structure <= 0 };
  }

  isPartDestroyed(locationId) { return partDestroyed(this.parts[locationId]); }
  isDestroyed() { return mechDestroyed(this.parts); }

  // Mobility multiplier from the legs: 1 with both, 0.5 with one, 0 with none.
  legFactor() {
    const l = this.isPartDestroyed('leftLeg') ? 0 : 0.5;
    const r = this.isPartDestroyed('rightLeg') ? 0 : 0.5;
    return l + r;
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
    if (res.ok) this.mounts[loc].push(itemId);
    return res;
  }

  unmount(loc, index) { return this.mounts[loc].splice(index, 1)[0]; }

  usedSlots(loc) { return loadout.usedSlots(this.mounts, loc); }
  slotCapacity(loc) { return loadout.slotCapacity(this._chassis, loc); }
  freeSlots(loc) { return loadout.freeSlots(this._chassis, this.mounts, loc); }
  validate() { return loadout.validateLoadout(this._chassis, this.mounts); }

  // ── Weapons & heat ────────────────────────────────────────────────────────
  // Every mounted weapon with its resolved stats and whether it's online (its part
  // is intact). A weapon in a destroyed part goes offline.
  weapons() {
    const out = [];
    for (const loc of MOUNT_LOCATIONS) {
      this.mounts[loc].forEach((id, index) => {
        if (isWeapon(id)) {
          out.push({ location: loc, index, id, weapon: getWeapon(id), online: !this.isPartDestroyed(loc) });
        }
      });
    }
    return out;
  }

  onlineWeapons() { return this.weapons().filter((w) => w.online); }

  // Heat shed per second: baseline + every intact heat sink.
  dissipation() {
    let d = BASE_DISSIPATION;
    for (const loc of LOCATIONS) {
      if (this.isPartDestroyed(loc)) continue;
      for (const id of this.mounts[loc]) {
        const e = getEquipment(id);
        if (e?.type === 'heatSink') d += e.dissipation;
      }
    }
    return d;
  }

  heatCapacity() { return BASE_HEAT_CAP; }

  // Restore a mech to pristine condition (used when deploying a fresh build).
  repairAll() {
    for (const loc of LOCATIONS) {
      const p = this.parts[loc];
      p.armor = p.maxArmor;
      p.structure = p.maxStructure;
    }
    this.heat = 0;
  }

  toJSON() {
    const mounts = {};
    const damage = {};
    for (const loc of LOCATIONS) {
      mounts[loc] = [...this.mounts[loc]];
      damage[loc] = { armor: this.parts[loc].armor, structure: this.parts[loc].structure };
    }
    return { chassisId: this.chassisId, name: this.name, mounts, damage, heat: this.heat };
  }
}
