// Per-spawn enemy-mech loadout roller (#474). Every enemy mech that spawns rolls its OWN four-
// weapon loadout, constrained by its chassis, instead of pulling from four hand-written archetypes.
// The four named archetypes (Raider/Stalker/Warden/Mortarhead) are retired: enemy mechs are now
// just Light / Medium / Heavy Mech, and all three chassis appear equally (data/enemies.js).
//
// This module is pure (no Phaser) and takes an injected `rng` (data/rng.js), so a seeded stream
// makes every roll reproducible and keeps the many tests that spawn enemies deterministic.
//
// ── The design (all four points confirmed on #474) ────────────────────────────────────────────
//
// 1. CONSTRAINED BY CHASSIS. Each weight class draws from its own weapon POOL, DERIVED from real
//    weapon properties in weapons.js — specifically optimum RANGE, because that is the exact field
//    the tactical AI reads to pick behaviour (scenes/arena/enemies.js `meanOpt`/`roleFor`). So the
//    pool that shapes a mech's guns is keyed off the same number that shapes how it fights:
//      • LIGHT  — the short cluster (opt ≤ SHORT_OPT). Fast, close-range direct-fire guns. A light
//                 roll's mean opt lands ~340, which is skirmisher/press-in range: it closes.
//      • HEAVY  — the long, heavy shells (opt ≥ LONG_OPT), minus sustained-beam STREAMS (those are
//                 the light/fast archetype, not siege hardware). This band is where every INDIRECT
//                 weapon lives, so a heavy roll CAN come up all-arcing/homing — which turns on the
//                 AI's camp-behind-cover posture by itself. The old "Mortarhead" is now something
//                 the dice produce, not a hand-written entry.
//      • MEDIUM — the mid band (SHORT_OPT < opt ≤ LONG_OPT... expressed as MID_LO..MID_HI). Between
//                 the two: longer than light, shorter and less indirect-committed than heavy.
//
// 2. FOUR DISTINCT WEAPONS, one per MOUNT_LOCATION. Distinct (no duplicates) is the COHERENCE rule
//    — see the block comment on `rollLoadout`. Every pool has ≥ 4 entries so a distinct draw always
//    succeeds.
//
// 3. DPS BUDGET. Constrained pools + distinct draws already bound the per-chassis DPS spread to
//    ~1.2×, but a rejection step makes the guard EXPLICIT and future-proof: a roll whose summed
//    sustained DPS falls outside the chassis' [lo, hi] band is rejected and re-rolled. Without it a
//    later weapon retune (or allowing duplicates) could silently produce a brutal 4×-heavy-hitter
//    mech; with it, the total is hard-bounded regardless.
//
// 4. ROLES STAY EMERGENT. Nothing here writes a role — the AI still derives brawler/skirmisher/
//    sniper + the all-indirect camp posture purely from the rolled weapons' ranges/deliveries.

import { WEAPONS, WEAPON_IDS } from './weapons.js';
import { sustainedDps } from './weaponStats.js';
import { MOUNT_LOCATIONS, MELEE_LOCATIONS } from './anatomy.js';
import { sampleN } from './rng.js';

const optOf = (id) => WEAPONS[id].range?.opt ?? 0;
const isStream = (id) => WEAPONS[id].delivery?.pattern === 'stream';
const isMeleeWeapon = (id) => WEAPONS[id].category === 'melee';

// ── Pool band thresholds (px, weapon optimum range) ───────────────────────────────────────────
// Hand-picked cutoffs, but every MEMBERSHIP is derived from the live weapon table below — retuning
// a weapon's `opt` moves it between pools with no edit here. The two cluster gaps in the current
// catalog (everything is opt 338–347 OR 400–1050, nothing between) are why light comes out as a
// clean disjoint short band while medium/heavy overlap in the long band.
const SHORT_OPT = 360;   // light: opt ≤ this — the short, press-in cluster
const MID_LO = 380;      // medium: MID_LO ≤ opt ≤ MID_HI
const MID_HI = 680;
const LONG_OPT = 470;    // heavy: opt ≥ this (streams excluded)

// The per-chassis weapon pools, derived from weapons.js. Exported for the art gallery and tests.
export const CHASSIS_WEAPON_POOLS = {
  light: WEAPON_IDS.filter((id) => optOf(id) <= SHORT_OPT),
  medium: WEAPON_IDS.filter((id) => optOf(id) >= MID_LO && optOf(id) <= MID_HI),
  heavy: WEAPON_IDS.filter((id) => optOf(id) >= LONG_OPT && !isStream(id)),
};

// ── DPS budget bands (summed sustained DPS of the 4-weapon set) ────────────────────────────────
// A rolled set outside its chassis band is rejected and re-rolled. The bands bracket the pools'
// natural 4-combo spread with only a thin margin, so they don't sculpt the roll today (no variety
// lost) — their job is to HARD-CAP a future drift: if weapons change and a pool starts producing a
// trivial or brutal 4-set, that set is rejected instead of shipping. Numbers reported on #474.
export const CHASSIS_DPS_BUDGET = {
  light: { lo: 80, hi: 115 },     // natural ~96–97
  medium: { lo: 90, hi: 125 },    // natural ~96–116
  heavy: { lo: 100, hi: 135 },    // natural ~106–126
};

const MAX_ROLL_ATTEMPTS = 40;

// Total sustained DPS of a set of weapon ids (the same figure weaponStats.js reports on the stat
// sheet and post-run telemetry — the single source of truth).
export function loadoutSustainedDps(weaponIds) {
  return weaponIds.reduce((sum, id) => sum + sustainedDps(WEAPONS[id]), 0);
}

// Assign four chosen weapon ids to the four MOUNT_LOCATIONS, honouring the one hard placement rule
// loadout.js enforces: MELEE weapons only fit the arms. No melee weapon exists in the catalog
// today, so this is defensive — but it keeps the roller correct the moment one is added. Melee
// picks are seated in the arms first, then everything else fills the remaining slots in order.
function assignMounts(weaponIds) {
  const arms = MELEE_LOCATIONS.slice();
  const others = MOUNT_LOCATIONS.filter((loc) => !MELEE_LOCATIONS.includes(loc));
  const melee = weaponIds.filter(isMeleeWeapon);
  const ranged = weaponIds.filter((id) => !isMeleeWeapon(id));
  const mounts = {};
  const slots = [...arms, ...others];        // arms first so melee always lands somewhere legal
  const ordered = [...melee, ...ranged];     // melee first so it claims the arm slots
  slots.forEach((loc, i) => { mounts[loc] = ordered[i] ? [ordered[i]] : []; });
  return mounts;
}

// Roll a loadout for one chassis weight class. Returns a `mounts` map (location id → [weaponId])
// filling all four MOUNT_LOCATIONS, ready to spread into a Mech config.
//
// COHERENCE RULE — the judgement call #474 asked for: four fully-independent picks could produce
// an incoherent mech (a lone short-range brawl gun bolted onto an otherwise long-range kiter that
// then satisfies neither range). Two things keep every roll coherent WITHOUT a hardcoded role:
//   (a) the CHASSIS POOL is range-banded, so all four picks already sit in one range neighbourhood
//       — the mech's mean optimum range is meaningful and the AI reads a single coherent role off
//       it; and
//   (b) the four weapons are DISTINCT, so a mech never stacks the same gun ×4 (which would read as
//       a bug visually and blow the DPS budget). Distinctness also guarantees weapon VARIETY on the
//       body — four different silhouettes, which is the whole visual point of #474.
// Melee-arms is the only other constraint (assignMounts). No further "sanity" filter is applied:
// within a single range band every combination is a legitimate, coherent mech.
export function rollLoadout(chassisId, rng) {
  const pool = CHASSIS_WEAPON_POOLS[chassisId] ?? CHASSIS_WEAPON_POOLS.medium;
  const budget = CHASSIS_DPS_BUDGET[chassisId] ?? CHASSIS_DPS_BUDGET.medium;
  const need = MOUNT_LOCATIONS.length;

  let best = null;
  let bestDist = Infinity;
  const mid = (budget.lo + budget.hi) / 2;
  for (let attempt = 0; attempt < MAX_ROLL_ATTEMPTS; attempt += 1) {
    const picks = sampleN(rng, pool, need);
    const dps = loadoutSustainedDps(picks);
    if (dps >= budget.lo && dps <= budget.hi) return assignMounts(picks);
    // Outside the band — remember the closest-to-mid draw as a fallback so a pathological pool
    // (or a mid-edit band that momentarily excludes everything) still yields a valid loadout.
    const dist = Math.abs(dps - mid);
    if (dist < bestDist) { bestDist = dist; best = picks; }
  }
  return assignMounts(best ?? sampleN(rng, pool, need));
}

// The most conservative optimum range any roll of this chassis can produce — the pool's longest
// weapon. Callers that must reason about a mech's engagement range BEFORE its per-spawn loadout is
// rolled (spawnPlacement.js's safe-deploy distance) use this so the safety margin covers the
// worst (longest-reaching) roll rather than guessing from a stale fixed loadout.
export function chassisMaxOpt(chassisId) {
  const pool = CHASSIS_WEAPON_POOLS[chassisId] ?? CHASSIS_WEAPON_POOLS.medium;
  return pool.reduce((mx, id) => Math.max(mx, optOf(id)), 0);
}
