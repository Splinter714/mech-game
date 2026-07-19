// Generic mech model. A mech is a chassis (weight class + per-location stats +
// movement tuning) filled with mounted items. All chassis/weapon differences come
// from data (chassis/, weapons.js), so the model itself stays small. Pure logic only
// (no Phaser) so the damage/kill rules and build math are fully unit-tested
// (Mech.test.js); the arena/garage drive the model and render it.

import { getChassis } from './chassis/index.js';
import { LOCATIONS, MOUNT_LOCATIONS, DESTROY_CASCADE, partDestroyed, mechDestroyed } from './anatomy.js';
import { isWeapon, getItem } from './items.js';
import { getWeapon } from './weapons.js';
import * as loadout from './loadout.js';
import {
  createShield, damageShield, tickShield as tickShieldState, fillShield, shieldFraction, shieldPresent,
} from './shield.js';

// #238: how long (seconds) a weapon slot is locked out after its magazine is fully
// drained — a per-slot "empty click" penalty distinct from the old always-on trickle
// regen. Tunable in one place; 3s sits in the middle of the 2-4s range the design asked
// for (long enough to read as a real cost, short enough not to feel like a full stall).
export const AMMO_EMPTY_COOLDOWN = 3;

export class Mech {
  constructor(data = {}) {
    this.chassisId = data.chassisId ?? 'medium';
    this._chassis = getChassis(this.chassisId);
    this.name = data.name ?? this._chassis.name;

    // Mounted items per location (array of item ids). Unknown ids — e.g. a weapon
    // removed from the catalog since an old build was saved — are dropped so stale
    // saves load cleanly instead of crashing the renderer. Iterates MOUNT_LOCATIONS,
    // the four weapon slots (#188: centerTorso is no longer one — see anatomy.js).
    this.mounts = {};
    for (const loc of MOUNT_LOCATIONS) {
      this.mounts[loc] = (data.mounts?.[loc] ?? []).filter((id) => getItem(id));
    }

    // Per-weapon ammo: a parallel array to mounts[loc] holding each weapon's current
    // magazine (null = unlimited / non-weapon). Runtime combat state, so it isn't
    // serialized — it starts full and tops back up over time (see regenAmmo).
    this._initAmmo();

    // Per-location health: armor (outer) + HP (inner — #246 renamed from "structure",
    // plain language, same layering). Restored from saved `damage` if present, else full
    // from the chassis. Only LOCATIONS (the damage-tracked set) get an entry —
    // head/cockpit/centerTorso are cosmetic-only (#128) and never appear in `parts`.
    this.parts = {};
    for (const loc of LOCATIONS) {
      const def = this._chassis.locations[loc];
      const saved = data.damage?.[loc];
      this.parts[loc] = {
        maxArmor: def.maxArmor,
        maxHp: def.maxHp,
        armor: saved?.armor ?? def.maxArmor,
        hp: saved?.hp ?? def.maxHp,
      };
    }

    // #246: full-MECH shield — one pool for the whole mech (not per location), sitting in
    // front of the per-location armor+hp stack above. `data.shield` is the chassis-baseline
    // (or per-enemy) config: { max, regenPerSec, pauseMs }; absent/zero `max` means this mech
    // has no native shield at all (most enemy mechs — see data/enemies.js). The arena gives
    // the PLAYER a real baseline (see ArenaScene's deploy path) and the Shield powerup
    // (data/powerups.js) instantly fills + temporarily boosts whatever's configured here.
    this.shield = createShield(data.shield);
    // Set only while a timed Shield-powerup boost is active (see boostShield/_clearShieldBoost
    // below) — remembers the PRE-boost base so reverting on expiry is exact, never compounding
    // across repeated pickups. (#324: `boostHealth` and its parallel baseMaxArmor/baseMaxHp
    // capture are gone — the player's durability is plain chassis data now — so this is the only
    // remaining "multiply a max, remember the base, revert exactly" mechanism in the model.)
    this._shieldBoost = null;
  }

  // Magazine capacity for an item id (null = unlimited or non-weapon).
  _ammoCap(id) {
    const w = getWeapon(id);
    return w && w.ammoMax != null ? w.ammoMax : null;
  }

  // (Re)build the ammo arrays so each weapon starts with a full magazine. `cooldown` is a
  // parallel array (same shape/indexing as `ammo[loc]`) holding remaining lockout seconds
  // per slot — 0 means "not on cooldown, regen proceeds normally." Runtime-only, like ammo.
  _initAmmo() {
    this.ammo = {};
    this.cooldown = {};
    for (const loc of MOUNT_LOCATIONS) {
      this.ammo[loc] = this.mounts[loc].map((id) => this._ammoCap(id));
      this.cooldown[loc] = this.mounts[loc].map(() => 0);
    }
  }

  get chassis() { return this._chassis; }
  get weightClass() { return this._chassis.weightClass; }
  get movement() { return this._chassis.movement; }

  // Total max hit points across every location (armor + structure summed) — one scalar
  // "how tough is this build" figure (light ≈266, medium ≈416, heavy ≈616 at base chassis
  // stats). #90: gives callers (e.g. the powerup drop-chance scaling) a `.maxHp` uniform
  // with the non-mech `HpBody.maxHp`, so difficulty-scaled logic doesn't need to branch on
  // enemy kind.
  get maxHp() {
    return LOCATIONS.reduce((sum, loc) => sum + this.parts[loc].maxArmor + this.parts[loc].maxHp, 0);
  }

  // #106: the canonical "how much total health does a kill represent" figure — EVERY damage
  // layer the attacker has to chew through, structure + armor + shield, in the SAME units for
  // every body type (Mech and the non-mech HpBody both expose it, so difficulty-scaled logic —
  // the powerup drop curve, data/powerups.js — never branches on enemy kind). Deliberately a
  // SEPARATE accessor from `maxHp` above rather than a redefinition of it: `maxHp` already has
  // other consumers (the HUD's per-part bars, shared.js's death-explosion sizing) whose current
  // meaning is fine, and `maxHp` on HpBody means only its single hp pool — so widening either
  // would silently change unrelated behaviour. Reads the PRE-BOOST shield capacity when a
  // Shield powerup is live (`_shieldBoost.baseMax`), so a temporary buff can't inflate a unit's
  // rated toughness.
  get toughness() {
    const shieldMax = this._shieldBoost?.baseMax ?? (this.shield?.max ?? 0);
    return this.maxHp + Math.max(0, shieldMax);
  }

  // ── Damage & destruction ──────────────────────────────────────────────────
  // Apply `amount` damage to a location, through the FULL layer stack in order (#246):
  //   1) the full-mech SHIELD (this.shield) absorbs first, if present and > 0 — a shield hit
  //      never touches armor/hp at all unless it breaks mid-hit (overflow).
  //   2) the location's ARMOR absorbs next.
  //   3) the location's HP takes whatever's left; HP at 0 destroys the part (cascading to
  //      dependent locations — a side torso takes its arm with it).
  // `weaponCategory` is an optional forward-compat seam (#246 decision: architect for a future
  // category-vs-layer bonus — e.g. energy strong vs shields — WITHOUT implementing one now).
  // Every category currently resolves to a 1.0 multiplier at every layer (see data/shield.js
  // `layerMultiplier`), so passing it (or not) has no behavioral effect yet.
  applyDamage(locationId, amount, weaponCategory) {
    const p = this.parts[locationId];
    if (!p || amount <= 0) {
      return {
        applied: 0, destroyed: false, location: locationId,
        partDestroyedNow: p ? partDestroyed(p) : false, shieldAbsorbed: 0, shielded: false,
      };
    }
    const shieldRes = damageShield(this.shield, amount);
    this._maybeFinalizeExpiredShieldBoost();
    const overflow = shieldRes.overflow;
    if (overflow <= 0) {
      return {
        applied: 0, destroyed: false, location: locationId, partDestroyedNow: partDestroyed(p),
        shieldAbsorbed: shieldRes.absorbed, shielded: true, armorBrokeNow: false,
      };
    }
    const beforeHp = p.hp;
    const armorBefore = p.armor;
    const armorHit = Math.min(p.armor, overflow);
    p.armor -= armorHit;
    const toHp = overflow - armorHit;
    p.hp = Math.max(0, p.hp - toHp);
    const destroyed = p.hp <= 0 && beforeHp > 0;
    if (destroyed) this._cascadeDestroy(locationId);
    // #246 (mech-art armor overlay): did THIS hit strip the location's last armor? Distinct from
    // `destroyed` (which tracks HP) — a part can lose its armor plating well before it's
    // actually destroyed, and the art wants to reskin exactly on that crossing (see combat.js).
    const armorBrokeNow = armorBefore > 0 && p.armor <= 0;
    return {
      applied: overflow, destroyed, location: locationId, partDestroyedNow: p.hp <= 0,
      shieldAbsorbed: shieldRes.absorbed, shielded: false, armorBrokeNow,
    };
  }

  // Destroy the locations that depend on `loc` (a side torso takes its arm, the head
  // takes the cockpit), recursively, zeroing their armor + hp so their mounts go
  // offline too.
  _cascadeDestroy(loc) {
    for (const dep of DESTROY_CASCADE[loc] ?? []) {
      const dp = this.parts[dep];
      if (dp && dp.hp > 0) {
        dp.armor = 0;
        dp.hp = 0;
        this._cascadeDestroy(dep);
      }
    }
  }

  // Untracked locations (head/cockpit/centerTorso — cosmetic only since #128) have no
  // `parts` entry and can never be destroyed; only damage-tracked LOCATIONS can.
  isPartDestroyed(locationId) {
    const p = this.parts[locationId];
    return p ? partDestroyed(p) : false;
  }
  isDestroyed() { return mechDestroyed(this.parts); }

  // Mobility multiplier. Legs aren't targetable any more, so mobility is always full;
  // kept as a hook in case a future effect (immobilize, EMP) wants to scale it.
  legFactor() {
    return 1;
  }

  // Fraction of a part's total health remaining (armor + hp), 0..1 — used for
  // damage visuals (a part swaps to a battered/destroyed drawing as this drops).
  partHealthFraction(locationId) {
    const p = this.parts[locationId];
    if (!p) return 0;
    const max = p.maxArmor + p.maxHp;
    return max > 0 ? (p.armor + p.hp) / max : 0;
  }

  // Does this location still have its armor plating (> 0), armor-only — independent of
  // hp/destroyed state? #246: drives the mech-art armor-shell overlay (mechArt.js) so the
  // player can SEE at a glance which segments have been stripped of armor, even though the
  // part still has hp left and isn't destroyed. False for untracked/unknown locations.
  hasArmor(locationId) {
    const p = this.parts[locationId];
    return !!p && p.armor > 0;
  }

  // ── Full-mech shield (#246) ────────────────────────────────────────────────
  // Apply damage straight to the shield only (used by callers that already resolved which
  // layer a hit should hit — kept for symmetry/tests; normal combat goes through applyDamage,
  // which already checks the shield first).
  applyShieldDamage(amount) {
    const res = damageShield(this.shield, amount);
    this._maybeFinalizeExpiredShieldBoost();
    return res;
  }
  shieldFraction() { return shieldFraction(this.shield); }
  hasShield() { return shieldPresent(this.shield); }

  // Passive per-frame upkeep: shield regen (with its brief post-hit pause) and, if a timed
  // Shield-powerup boost is active, counting its remaining duration down. Called once per
  // frame alongside regenAmmo (dt in seconds, same convention).
  //
  // #271: when the boost timer runs out, the elevated capacity does NOT snap back to base
  // instantly — it persists as a depleting-only buffer (`_shieldBoost.expired = true`) until
  // damage brings `shield.hp` down to (or below) the pre-boost base max. Only then does it
  // actually clamp `shield.max`/`regenPerSec` back to base and clear `_shieldBoost`. While
  // expired-but-not-yet-decayed, regen is capped at base max (never regens back into the
  // decaying extra) — see `_tickExpiredShieldBoost`.
  tickShield(dt) {
    if (this._shieldBoost && !this._shieldBoost.expired) {
      this._shieldBoost.remainingMs -= dt * 1000;
      if (this._shieldBoost.remainingMs <= 0) this._shieldBoost.expired = true;
    }
    if (this._shieldBoost && this._shieldBoost.expired) {
      this._tickExpiredShieldBoost(dt);
    } else {
      tickShieldState(this.shield, dt);
    }
  }

  // Shield powerup pickup (#246 decision: BOTH effects, the strongest version) — instantly
  // fills the shield to 100% of its (possibly boosted) capacity AND multiplies max capacity +
  // regen rate by `mult` for `durationMs`. A duplicate pickup mid-boost just refreshes the
  // timer against the SAME captured pre-boost base, so it never compounds across repeated
  // pickups. No-op on a mech with no native shield at all.
  //
  // #271: this also covers a duplicate pickup mid-decay (after the previous boost's timer
  // expired but `shield.hp` hasn't drained back to base yet) — `_shieldBoost` is still around
  // in its "expired" sub-state at that point, so this just un-expires it and refreshes the
  // timer against the SAME original `baseMax`/`baseRegenPerSec`, same as the still-active case.
  boostShield(mult, durationMs) {
    if (!shieldPresent(this.shield)) return;
    if (!this._shieldBoost) {
      this._shieldBoost = {
        mult, remainingMs: durationMs, expired: false,
        baseMax: this.shield.max, baseRegenPerSec: this.shield.regenPerSec,
      };
    } else {
      this._shieldBoost.remainingMs = durationMs;
      this._shieldBoost.expired = false;
    }
    this.shield.max = Math.round(this._shieldBoost.baseMax * mult);
    this.shield.regenPerSec = this._shieldBoost.baseRegenPerSec * mult;
    fillShield(this.shield);
  }

  // Depleting-only buffer tick, once the boost timer has expired but `shield.hp` is still above
  // the pre-boost base max. Mirrors `tickShield`'s hit-pause handling from shield.js, but caps
  // any regen at `baseMax` (never regens into the decaying extra) and only actually regens once
  // hp has already dropped to base or below.
  _tickExpiredShieldBoost(dt) {
    const { baseMax, baseRegenPerSec } = this._shieldBoost;
    if (this.shield.pauseRemaining > 0) {
      this.shield.pauseRemaining = Math.max(0, this.shield.pauseRemaining - dt * 1000);
    } else if (this.shield.hp <= baseMax) {
      this.shield.hp = Math.min(baseMax, this.shield.hp + baseRegenPerSec * dt);
    }
    this._maybeFinalizeExpiredShieldBoost();
  }

  // If a shield boost has expired and `shield.hp` has (now) drained down to its pre-boost base
  // max or below, finalize the clamp back to base max/base regen and clear `_shieldBoost`
  // entirely — same end state as the old instant-snap `_clearShieldBoost`, just reached only
  // once the extra capacity has actually been used up (#271), rather than the instant the timer
  // ran out. Called both from the passive tick (regen/pause path) and right after any hit that
  // damages the shield, so a hit that drains straight through the buffer in one shot finalizes
  // immediately rather than waiting for the next frame's tick.
  _maybeFinalizeExpiredShieldBoost() {
    if (!this._shieldBoost?.expired) return;
    const { baseMax, baseRegenPerSec } = this._shieldBoost;
    if (this.shield.hp > baseMax) return;
    this.shield.max = baseMax;
    this.shield.regenPerSec = baseRegenPerSec;
    this._shieldBoost = null;
  }

  _clearShieldBoost() {
    this.shield.max = this._shieldBoost.baseMax;
    this.shield.regenPerSec = this._shieldBoost.baseRegenPerSec;
    this.shield.hp = Math.min(this.shield.hp, this.shield.max);
    this._shieldBoost = null;
  }

  // Set/replace this mech's native shield config at runtime (fresh, full, no lingering boost).
  // Opt-in and applied outside the shared chassis/enemy data: the arena uses this to give the
  // PLAYER a baseline shield (see ArenaScene's PLAYER_SHIELD) without touching the
  // constructor-time `data.shield` every mech (including enemy mechs) is built from. Idempotent:
  // calling it again (e.g. once per redeploy) just re-establishes the same config from scratch.
  // (#324 note: the player's armor/hp buffer used to be applied the same way, via `boostHealth`;
  // it now lives in the chassis data, and this shield config is the last such deploy-time patch.)
  configureShield(config) {
    this.shield = createShield(config);
    this._shieldBoost = null;
  }

  // ── Mounting / build ──────────────────────────────────────────────────────
  canMount(loc, itemId) { return loadout.canMount(this._chassis, this.mounts, loc, itemId); }

  // Which location (if any) currently holds `itemId`.
  locationOf(itemId) { return loadout.locationOf(this.mounts, itemId); }

  // Mount `itemId` into `loc`. An item only ever occupies ONE slot at a time (#84): if it's
  // already mounted somewhere else, mounting it here MOVES it — the old slot is vacated
  // rather than left with a duplicate.
  mount(loc, itemId) {
    const res = this.canMount(loc, itemId);
    if (res.ok) {
      const prevLoc = this.locationOf(itemId);
      if (prevLoc && prevLoc !== loc) this.unmount(prevLoc, this.mounts[prevLoc].indexOf(itemId));
      this.mounts[loc].push(itemId);
      this.ammo[loc].push(this._ammoCap(itemId));
      this.cooldown[loc].push(0);
    }
    return res;
  }

  unmount(loc, index) {
    this.ammo[loc].splice(index, 1);
    this.cooldown[loc].splice(index, 1);
    return this.mounts[loc].splice(index, 1)[0];
  }

  usedSlots(loc) { return loadout.usedSlots(this.mounts, loc); }
  slotCapacity(loc) { return loadout.slotCapacity(this._chassis, loc); }
  freeSlots(loc) { return loadout.freeSlots(this._chassis, this.mounts, loc); }
  validate() { return loadout.validateLoadout(this._chassis, this.mounts); }
  // A build is deployable only when it's legal AND every weapon slot is filled.
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
          // #238: a slot on cooldown can't fire even if ammo somehow reads >0 (it won't,
          // since cooldown only starts on a drain-to-0), so this is really "cooldown
          // supersedes the ammo check" — kept explicit for clarity.
          const cooldown = this.cooldown[loc][index] ?? 0;
          out.push({
            location: loc, index, id, weapon: getWeapon(id), online, ammo, cooldown,
            ready: online && cooldown <= 0 && (ammo == null || ammo >= 1),
          });
        }
      });
    }
    return out;
  }

  onlineWeapons() { return this.weapons().filter((w) => w.online); }
  readyWeapons() { return this.weapons().filter((w) => w.ready); }

  // Spend `n` rounds from a weapon's magazine (no-op for unlimited weapons). `n` need not be
  // an integer — #235: Overdrive spends a fractional amount (cycleMult, e.g. 0.5) per shot to
  // offset its faster fire rate, so this deliberately does plain subtraction with no
  // rounding/truncation; magazines can sit at fractional values and still compare/display fine.
  consumeAmmo(loc, index, n = 1) {
    if (this.ammo[loc]?.[index] != null) {
      const before = this.ammo[loc][index];
      const after = Math.max(0, before - n);
      this.ammo[loc][index] = after;
      // #238: draining a slot to exactly empty starts its cooldown lockout. Guarded by
      // `before > 0` so repeatedly firing an already-dry weapon (e.g. a trigger held past
      // empty) doesn't keep resetting the timer back to full each frame.
      if (after === 0 && before > 0) this.cooldown[loc][index] = AMMO_EMPTY_COOLDOWN;
    }
  }

  // Top every magazine back up over time at the weapon's regen rate — UNLESS that slot is
  // on cooldown (#238), in which case this just counts the cooldown timer down instead;
  // ammo stays pinned at 0 until the timer expires, then normal regen resumes next tick.
  regenAmmo(dt) {
    for (const loc of MOUNT_LOCATIONS) {
      this.mounts[loc].forEach((id, i) => {
        if (this.ammo[loc][i] == null) return;
        if (this.cooldown[loc][i] > 0) {
          this.cooldown[loc][i] = Math.max(0, this.cooldown[loc][i] - dt);
          return;
        }
        const w = getWeapon(id);
        this.ammo[loc][i] = Math.min(w.ammoMax, this.ammo[loc][i] + w.ammoRegen * dt);
      });
    }
  }

  // Instant proportional armor repair (#60 Armor Patch powerup): restore a fraction of
  // EACH damaged location's MISSING armor (maxArmor - armor), so every location that has
  // lost armor gets some back scaled to what it's missing. HP is untouched (this
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
  // health, full shield (any lingering timed boost from a prior sortie is cleared first so
  // it can't leak across a redeploy), and full magazines.
  repairAll() {
    for (const loc of LOCATIONS) {
      const p = this.parts[loc];
      p.armor = p.maxArmor;
      p.hp = p.maxHp;
    }
    if (this._shieldBoost) this._clearShieldBoost();
    this.shield.pauseRemaining = 0;
    fillShield(this.shield);
    this._initAmmo();
  }

  toJSON() {
    const mounts = {};
    const damage = {};
    for (const loc of MOUNT_LOCATIONS) mounts[loc] = [...this.mounts[loc]];
    for (const loc of LOCATIONS) damage[loc] = { armor: this.parts[loc].armor, hp: this.parts[loc].hp };
    return { chassisId: this.chassisId, name: this.name, mounts, damage };
  }
}
