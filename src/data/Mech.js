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
  grantTempShield, shieldTotalHp, shieldTotalMax,
} from './shield.js';

// #402: the RELOAD period (seconds) — how long a weapon slot is locked out while it reloads,
// after which its magazine comes back FULL. Two things start it:
//   * AUTO — a magazine drained to exactly 0 reloads itself (consumeAmmo below);
//   * MANUAL — the player triggers it early on R3/F to top a mag off before it runs dry
//     (reloadAllWeapons below, driven from arena/firing.js).
//
// #402 (owner decision): RELOAD IS THE ONLY REFILL PATH. There is NO passive between-shots trickle
// anymore — a weapon's ammo stays exactly where firing left it until a reload completes, then snaps
// to a full magazine. Sustained fire is balanced purely by MAGAZINE SIZE (`ammoMax` in weapons.js):
// burst-before-reload = ammoMax ÷ fire rate. So the old continuous-regen economy (#372/#376/#377,
// `ammoRegen`) is gone from the player model; each weapon's `ammoMax` was re-tuned so a held trigger
// fires a few seconds before the reload beat.
//
// DELIBERATELY a FLAT duration, not tied to magazine size: a big magazine already costs more UPTIME
// to burn through, so also making its reload longer would double-penalise it. One flat, fast beat
// (1s) reads as a snappy magazine swap. One dial: raise it to make reloading a heavier commitment.
export const RELOAD_SECONDS = 2;

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
    // (or per-enemy) config: { max } (pause+regen are shared constants in shield.js since #382);
    // absent/zero `max` means this mech
    // has no native shield at all (most enemy mechs — see data/enemies.js). The arena gives
    // the PLAYER a real baseline (see ArenaScene's deploy path) and the Shield powerup
    // (data/powerups.js) instantly fills + temporarily boosts whatever's configured here.
    this.shield = createShield(data.shield);
  }

  // Magazine capacity for an item id (null = unlimited or non-weapon).
  _ammoCap(id) {
    const w = getWeapon(id);
    return w && w.ammoMax != null ? w.ammoMax : null;
  }

  // (Re)build the ammo arrays so each weapon starts with a full magazine. `reload` is a
  // parallel array (same shape/indexing as `ammo[loc]`) holding remaining RELOAD seconds
  // per slot — 0 means "not reloading" (ammo just sits still, no trickle). Runtime-only, like ammo.
  _initAmmo() {
    this.ammo = {};
    this.reload = {};
    for (const loc of MOUNT_LOCATIONS) {
      this.ammo[loc] = this.mounts[loc].map((id) => this._ammoCap(id));
      this.reload[loc] = this.mounts[loc].map(() => 0);
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
  // would silently change unrelated behaviour. Reads the BASE shield capacity only (`shield.max`),
  // never the #381 temporary pool, so a Shield powerup can't inflate a unit's rated toughness —
  // `shield.max` stays fixed at the base value while the temp pool lives entirely in `shield.temp`.
  get toughness() {
    return this.maxHp + Math.max(0, this.shield?.max ?? 0);
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

  // #401 follow-up: the locations currently showing bare internals — alive (not a stump) but
  // stripped of armor plating. These are EXACTLY the segments mechArt draws with
  // `exposedInternals`. Snapshot this BEFORE an armor repair (Armor Patch powerup); if any of
  // them regains armor afterward, `hasArmor(loc)` flips back true and the mech must re-raster so
  // the clean plating returns (the damage reskin gate only fires when armor BREAKS, not when it's
  // restored). Pure, so the "should we re-raster after repair?" decision is unit-testable.
  exposedArmorLocations() {
    return LOCATIONS.filter((loc) => !this.isPartDestroyed(loc) && !this.hasArmor(loc));
  }

  // ── Full-mech shield (#246) ────────────────────────────────────────────────
  // Apply damage straight to the shield only (used by callers that already resolved which
  // layer a hit should hit — kept for symmetry/tests; normal combat goes through applyDamage,
  // which already checks the shield first).
  applyShieldDamage(amount) {
    return damageShield(this.shield, amount);
  }
  shieldFraction() { return shieldFraction(this.shield); }
  hasShield() { return shieldPresent(this.shield); }
  // #381: total current hp / capacity INCLUDING the temporary pool — what the HUD bar and the
  // in-world glow read so both GROW with a live temp pool and shrink as it is spent.
  shieldTotalHp() { return shieldTotalHp(this.shield); }
  shieldTotalMax() { return shieldTotalMax(this.shield); }

  // Passive per-frame upkeep: shield regen (with its brief post-hit pause) and the #381 temporary
  // pool's own expiry countdown — both live in data/shield.js's `tickShield` now, so there is one
  // place that knows the regen ceiling stays at base `max` and the temp pool never recharges.
  // Called once per frame alongside regenAmmo (dt in seconds, same convention).
  tickShield(dt) {
    tickShieldState(this.shield, dt);
  }

  // #381: the temp pool's remaining wall-clock expiry, in ms — 0 when no pool is live. Since the
  // shield powerup now grants the pool with NO finite expiry (it persists until spent), this reads
  // Infinity while a pool is live. Retained for symmetry/HUD readouts; the free-ammo window is
  // tracked separately in the scene's `activePowerups`.
  get tempShieldRemainingMs() {
    return (this.shield?.temp || 0) > 0 ? Math.max(0, this.shield.tempExpiryMs || 0) : 0;
  }

  // Shield powerup pickup (#381, reworked from #246/#271's capacity/regen multiplier): grant an
  // expendable TEMPORARY shield pool of `amount` ON TOP of the base max, and top the base shield
  // to full. The pool PERSISTS UNTIL SPENT by incoming damage — the shield powerup passes no
  // `durationMs`, so it never time-expires; only damage drains it. The base `max` (and the shared
  // regen rate) is never touched, so the regen ceiling stays put and the temp pool sits outside the regen
  // path entirely. #417: sequential pickups ADD their full pool ON TOP, UNCAPPED (grantTempShield
  // sums, not maxes) — stacking Shields grows the shell without limit. Works even on a mech with no
  // native shield config.
  grantTempShield(amount, durationMs) {
    grantTempShield(this.shield, amount, durationMs);
  }

  // Set/replace this mech's native shield config at runtime (fresh, full, no lingering temp pool).
  // Opt-in and applied outside the shared chassis/enemy data: the arena uses this to give the
  // PLAYER a baseline shield (see ArenaScene's PLAYER_SHIELD) without touching the
  // constructor-time `data.shield` every mech (including enemy mechs) is built from. Idempotent:
  // calling it again (e.g. once per redeploy) just re-establishes the same config from scratch.
  // (#324 note: the player's armor/hp buffer used to be applied the same way, via `boostHealth`;
  // it now lives in the chassis data, and this shield config is the last such deploy-time patch.)
  configureShield(config) {
    this.shield = createShield(config);
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
      this.reload[loc].push(0);
    }
    return res;
  }

  unmount(loc, index) {
    this.ammo[loc].splice(index, 1);
    this.reload[loc].splice(index, 1);
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
          // #402: a slot mid-RELOAD can't fire even if ammo somehow reads >0 — the reload gate
          // supersedes the ammo check. `reload` is the remaining lockout seconds; `reloadMax` is
          // the full period, so a HUD/indicator can draw the reload's progress fraction.
          const reload = this.reload[loc][index] ?? 0;
          out.push({
            location: loc, index, id, weapon: getWeapon(id), online, ammo,
            reload, reloadMax: RELOAD_SECONDS, reloading: reload > 0,
            ready: online && reload <= 0 && (ammo == null || ammo >= 1),
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
      // #402: draining a slot to exactly empty AUTO-triggers its reload. Guarded by `before > 0`
      // so repeatedly firing an already-dry weapon (a trigger held past empty) doesn't keep
      // resetting the reload timer back to full each frame.
      if (after === 0 && before > 0) this.reload[loc][index] = RELOAD_SECONDS;
    }
  }

  // #402: begin a MANUAL reload of ONE weapon slot — the player topping a magazine off before it
  // runs dry (arena/firing.js, R3/F). Locks the slot out for RELOAD_SECONDS, then regenAmmo below
  // refills it to full. No-op — returning false — for an unlimited weapon, a slot already
  // reloading, or one already full (nothing to gain by paying the lockout). Returns true when a
  // reload actually started, so the caller can gate feedback on "something happened."
  reloadWeapon(loc, index) {
    const cap = this._ammoCap(this.mounts[loc]?.[index]);
    if (cap == null) return false;                          // unlimited / non-weapon: never reloads
    if ((this.reload[loc]?.[index] ?? 0) > 0) return false; // already reloading
    if (this.ammo[loc][index] >= cap) return false;         // already full
    this.reload[loc][index] = RELOAD_SECONDS;
    return true;
  }

  // #402: the manual-reload BUTTON — reload every eligible weapon on this mech at once (see
  // reloadWeapon for eligibility). Returns how many slots actually began reloading. Per-mech, so
  // in co-op each player reloads only their OWN weapons (firing.js reads that player's controls).
  reloadAllWeapons() {
    let started = 0;
    for (const loc of MOUNT_LOCATIONS) {
      this.mounts[loc].forEach((_id, i) => { if (this.reloadWeapon(loc, i)) started += 1; });
    }
    return started;
  }

  // Per-frame ammo upkeep: a slot mid-RELOAD counts its timer down and snaps to a FULL magazine the
  // moment it expires (#402). That is the ONLY way ammo comes back — #402 removed the passive
  // between-shots trickle, so a slot that ISN'T reloading holds its ammo exactly where firing left
  // it (sustained fire is balanced by magazine size instead; see weapons.js). Name kept as
  // `regenAmmo` since the arena/enemy update paths call it.
  regenAmmo(dt) {
    for (const loc of MOUNT_LOCATIONS) {
      this.mounts[loc].forEach((id, i) => {
        if (this.ammo[loc][i] == null) return;   // unlimited: never reloads
        if (this.reload[loc][i] > 0) {
          const r = Math.max(0, this.reload[loc][i] - dt);
          this.reload[loc][i] = r;
          if (r === 0) this.ammo[loc][i] = getWeapon(id).ammoMax;   // reload complete → full mag
        }
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
  // health, full shield (any lingering #381 temporary pool from a prior sortie is cleared first so
  // it can't leak across a redeploy), and full magazines.
  repairAll() {
    for (const loc of LOCATIONS) {
      const p = this.parts[loc];
      p.armor = p.maxArmor;
      p.hp = p.maxHp;
    }
    this.shield.temp = 0;
    this.shield.tempExpiryMs = 0;
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
