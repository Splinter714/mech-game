// Boss battle (#240) — the pure model, no Phaser. Everything about how the boss is DISMANTLED
// lives here so it's unit-testable; scenes/arena/boss.js is the thin live wiring.
//
// Jackson picked "all of the above" for what dismantling does, so all three compose:
//   1. Destroying a limb removes THAT limb's weapon. This falls straight out of the existing
//      Mech model — a destroyed location's mounts go offline, so `readyWeapons()` stops
//      returning them and mechArt.js already draws the part as a stump with its weapon gone.
//      No new mechanism at all; the boss just has one distinct weapon per limb (BOSS_DEF).
//   2. Losing a part ESCALATES what survives (`bossEscalation`) — the remaining guns cycle
//      faster and spray wider, so taking a limb raises the stakes instead of only lowering
//      the incoming damage.
//   3. The limbs are PLATING over a vulnerable core (`BossMech` below). While the plating
//      holds, the core is sealed: damage that lands on already-destroyed limb space is simply
//      absorbed. Once CORE_EXPOSE_AT limbs are gone the core is open and is the ONLY thing
//      that can actually kill it.
//
// The kill rule is therefore the core, NOT the normal mech rule (anatomy.js `mechDestroyed`,
// "both side torsos gone") — `BossMech.isDestroyed()` overrides it. That's deliberate: under
// the normal rule the fight would end the instant the second torso fell, which is exactly the
// moment the core is supposed to OPEN.

import { Mech } from './Mech.js';
import { LOCATIONS } from './anatomy.js';

// On-screen size as a multiple of the player's medium mech. Jackson picked the largest option
// offered ("you're an ant"), so this is a full 10x LINEAR multiple — ~100x the footprint area.
// Consumed by scenes/arena/shared.js (`mechDispUnit`) and the boss mixin's view/texture build.
export const BOSS_SCALE = 10;

// The boss's plating — the four damage-tracked mech locations, each carrying ONE weapon. Named
// here (rather than reusing LOCATIONS directly at call sites) so "which parts are plating" is a
// single named concept the tests and the HUD markers can both read.
export const BOSS_PLATING = [...LOCATIONS];

// How many of the four plates must be destroyed before the core is exposed. 3 of 4: the last
// plate is still standing when the kill window opens, so the endgame is a real choice — finish
// the fourth limb (removing one more gun) or dive straight for the core while it still shoots.
export const CORE_EXPOSE_AT = 3;

// The core's own health pool, and how much of a still-sealed hit the plating absorbs (all of
// it — sealed means sealed; a "chip damage" fraction was considered and rejected as it would
// let a patient player skip the dismantle entirely).
export const CORE_MAX_HP = 900;

// Escalation curve. Each destroyed plate multiplies the surviving weapons' cooldowns by
// (1 - ESCALATION_PER_LIMB), floored at ESCALATION_CADENCE_FLOOR, and widens their spray.
// At 0 limbs lost it's exactly the weapons' own tuning (multiplier 1.0, base jitter); at 3
// lost — the moment the core opens — the survivors cycle at ~55% of their normal interval and
// spray ~3x wider, so the kill window is also the most dangerous stretch of the fight.
export const ESCALATION_PER_LIMB = 0.15;
export const ESCALATION_CADENCE_FLOOR = 0.45;
export const ESCALATION_JITTER_BASE = 0.035;   // rad of aim spray at full health
export const ESCALATION_JITTER_PER_LIMB = 0.03;
// Once this many plates are gone the survivors also fire one EXTRA emission per volley
// (delivery `count`), so the escalation reads visually, not just as a faster tick.
export const ESCALATION_EXTRA_COUNT_AT = 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// How many of the boss's four plates are destroyed. Works on any Mech-shaped object.
export function limbsDestroyed(mech) {
  return BOSS_PLATING.filter((loc) => mech.isPartDestroyed(loc)).length;
}

// Is the core open? Pure over the destroyed-limb COUNT (not the mech) so the threshold rule
// itself is testable in isolation.
export function coreExposed(destroyedCount) {
  return destroyedCount >= CORE_EXPOSE_AT;
}

// The escalation profile for a given number of destroyed plates. `cadenceScale` multiplies a
// weapon's fire interval (lower = faster), `aimJitter` is radians of random spray added per
// shot, `extraCount` is added to the delivery's emission count.
export function bossEscalation(destroyedCount) {
  const n = clamp(destroyedCount, 0, BOSS_PLATING.length);
  return {
    stage: n,
    cadenceScale: Math.max(ESCALATION_CADENCE_FLOOR, 1 - ESCALATION_PER_LIMB * n),
    aimJitter: ESCALATION_JITTER_BASE + ESCALATION_JITTER_PER_LIMB * n,
    extraCount: n >= ESCALATION_EXTRA_COUNT_AT ? 1 : 0,
  };
}

// ── Summons (#240: "RARE small-enemy waves as breathing room only") ────────────────────────
// Jackson was explicit that the interest has to come from the boss itself, so this is
// deliberately a side dish: nothing at all until the player has actually taken a limb (the
// opening duel is pure boss), then a small mixed wave on a long interval, hard-capped at
// BOSS_SUMMON_MAX_WAVES for the whole fight. The composition is a couple of drones plus one
// tank — enough to change the rhythm and force the player to break off circling for a moment,
// nowhere near enough to become the threat.
export const BOSS_SUMMON_INTERVAL_MS = 30000;
export const BOSS_SUMMON_MAX_WAVES = 3;
export const BOSS_SUMMON_WAVE = ['drone', 'drone', 'drone', 'tank'];

// Should a wave go out this frame? Pure so the cadence rules (needs a limb down, respects the
// interval, respects the cap) are testable without a scene clock.
export function shouldSummon({ elapsedSinceLastMs, wavesSoFar, destroyedCount }) {
  if (wavesSoFar >= BOSS_SUMMON_MAX_WAVES) return false;
  if (destroyedCount < 1) return false;
  return elapsedSinceLastMs >= BOSS_SUMMON_INTERVAL_MS;
}

// ── The boss's loadout ─────────────────────────────────────────────────────────────────────
// One weapon per plate, each with a distinct job, so blowing a specific limb off visibly
// removes a specific pressure — that's what makes rule (1) legible instead of just "less DPS":
//   rightArm  Cluster Salvo  — the long-reach salvo that punishes you for sitting at range.
//   leftArm   Repeater       — the close-in suppressing stream that punishes you for hugging it.
//   rightTorso Napalm Lobber — ARCING: burns the ground you're standing on, no line-of-sight
//                              needed, so hard cover alone never fully saves you.
//   leftTorso  Plasma Arc    — ARCING: the heavy siege lob, the shot you have to keep moving to
//                              avoid.
// Both arcing guns live on the TORSOS (the tougher plates) on purpose: the two easy-to-reach
// arm plates are the direct-fire ones, so the early fight rewards stripping the guns that need
// line-of-sight, and the late fight is a bombardment you out-manoeuvre.
export const BOSS_DEF = {
  chassisId: 'colossus',
  name: 'Bastion Prime',
  mounts: {
    rightArm: ['clusterRocket'],
    leftArm: ['machineGun'],
    rightTorso: ['napalm'],
    leftTorso: ['plasmaCannon'],
  },
};

// The boss's Mech: an ordinary Mech (so per-location armor/HP, mounting, ammo, the destroyed-
// part art path and every existing combat call site work unchanged) with the plating/core rule
// layered on top.
export class BossMech extends Mech {
  constructor(data = BOSS_DEF) {
    super(data);
    this.core = { max: CORE_MAX_HP, hp: CORE_MAX_HP };
  }

  limbsDestroyed() { return limbsDestroyed(this); }
  coreExposed() { return coreExposed(this.limbsDestroyed()); }
  coreFraction() { return this.core.max > 0 ? this.core.hp / this.core.max : 0; }
  escalation() { return bossEscalation(this.limbsDestroyed()); }

  // Damage routing. A hit aimed at a LIVE plate behaves exactly like a normal mech hit. A hit
  // that lands on plate space already destroyed is the core shot: it only lands if the core is
  // actually exposed, otherwise the wreckage absorbs it entirely.
  //
  // Why route on "is this plate already dead" rather than adding a separate core hitbox: the
  // arena's hit mapping (shared.js `resolveHitLocation`) already redirects a hit away from a
  // destroyed part toward the nearest LIVE one, so while any plate survives a stray shot can't
  // accidentally be counted as a core hit — it gets redirected to real plating first. Only once
  // everything nearby is wreckage does a hit resolve here at all.
  applyDamage(locationId, amount, weaponCategory) {
    const alreadyDead = this.isPartDestroyed(locationId);
    if (!alreadyDead) return super.applyDamage(locationId, amount, weaponCategory);
    if (amount <= 0) return this._coreResult(locationId, 0);
    if (!this.coreExposed()) return this._coreResult(locationId, 0, { absorbed: true });
    const applied = Math.min(this.core.hp, amount);
    this.core.hp -= applied;
    return this._coreResult(locationId, applied, { core: true });
  }

  _coreResult(locationId, applied, extra = {}) {
    return {
      applied, destroyed: false, location: locationId, partDestroyedNow: true,
      shieldAbsorbed: 0, shielded: false, armorBrokeNow: false, ...extra,
    };
  }

  // The boss dies when its CORE is gone — never from the ordinary "both side torsos" mech kill
  // rule, which would otherwise end the fight at the exact moment the core opens.
  isDestroyed() { return this.core.hp <= 0; }

  repairAll() {
    super.repairAll();
    this.core.hp = this.core.max;
  }
}
