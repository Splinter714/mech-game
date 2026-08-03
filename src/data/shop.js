// Shop economy (#65) — a flat, permanent-unlock catalog spent against the player's banked
// SCRAP (data/save.js loadRunCurrency/saveRunCurrency, the meta-progression pool #64 already
// wired up). Unlocking an item is a one-time purchase: it never re-locks and costs nothing
// further to mount. Upgrade tiers (damage/ammo/cooldown) are a clean follow-up, not built here.
//
// **Add a shop item = one entry in SHOP_COSTS.** Anything not listed defaults to
// DEFAULT_COST so a newly-added weapon is never silently free.
import { WEAPON_IDS } from './weapons.js';

// The default roster's starting loadout (rosters.js) — these must ALWAYS be unlocked, or a
// fresh save couldn't deploy at all. Also the smoke test's baseline build. #188: jumpJet
// dropped out (equipment.js removed — Sprint is a hardcoded built-in, never unlocked/bought).
export const STARTING_UNLOCKED = ['autocannon', 'pulseLaser', 'clusterRocket', 'machineGun'];

// Costs are pitched against the run's stage payout curve (50 + 25*stageIndex per stage,
// data/run.js) — early/cheap unlocks clear in a run or two, heavier late-game weapons take
// several. Starting-kit items are listed at 0 for completeness (they're never actually locked).
export const SHOP_COSTS = {
  autocannon: 0, pulseLaser: 0, clusterRocket: 0, machineGun: 0,
  shotgun: 75, streakPod: 90,
  flamethrower: 125, napalm: 140, swarmRack: 150,
  // #118: plasmaLance graduated off the shelved list. Priced between shotgun/streakPod and
  // beamLaser — it's a strong 2-slot heavy hitter (~20 sustained dps, long range) but not the
  // flagship beamLaser (175) tier. #125: reworked to a rapid projectile stream (fireRate 20,
  // damage 2/bolt) still landing at ~20 sustained dps — price unchanged.
  plasmaLance: 150,
  beamLaser: 175, railLance: 225, plasmaCannon: 250,
  // #627: Charge Beam is both of its parents in one mount (Charge Lance's charge + release, plus
  // Beam Laser's sustained beam once focused), so it prices above both — over beamLaser's 175 and
  // well over chargeLance, which is unlisted and therefore sits at DEFAULT_COST (100). Under
  // railLance's 225: it's a hybrid with a real cost of entry (a 1.6s spin-up before a single beam
  // tick lands, and a charge that eats a fifth of the magazine), not a flagship.
  chargeBeam: 200,
};

const DEFAULT_COST = 100;

export function costOf(id) {
  return SHOP_COSTS[id] ?? DEFAULT_COST;
}

// Every item that CAN be gated by the shop (every weapon id). Used to validate the starting
// set / build a fresh locked-by-default set.
export const SHOPPABLE_IDS = [...WEAPON_IDS];

// #297: the unlock mechanism itself (costOf/canAfford/SHOPPABLE_IDS above, loadUnlocked/
// saveUnlocked in save.js) was already id-agnostic — nothing in it actually cares what an id
// NAMES, only the catalog ever listed was weapons. `kindOf` tags what KIND of thing an
// unlockable id is, defaulting to 'weapon' for anything not explicitly overridden — so every
// existing (and future) weapon id, including ones added to weapons.js by other in-flight work,
// is automatically 'weapon' with no matching entry needed here. A later stage folds in a
// non-weapon unlock (chassis, outpost building type, passive, ability) by tagging ITS ids in
// KIND_OVERRIDES and adding them to whatever list feeds a shoppable catalog — the cost/afford/
// persist plumbing above doesn't change. Empty today: no non-weapon unlockable exists yet.
const KIND_OVERRIDES = {};

export function kindOf(id) {
  return KIND_OVERRIDES[id] ?? 'weapon';
}

// Salvage drops (#65): a small SCRAP pickup dropped at some destroyed enemies' positions,
// separate from the timed-buff powerups (data/powerups.js) but rolled at the same kill site.
export const SALVAGE_DROP_CHANCE = 0.35;
export const SALVAGE_MIN = 5;
export const SALVAGE_MAX = 15;

// `rng` is injectable so the amount is deterministically testable.
export function salvageAmount(rng = Math.random) {
  return SALVAGE_MIN + Math.floor(rng() * (SALVAGE_MAX - SALVAGE_MIN + 1));
}

// Pure afford/purchase check: given a Set of unlocked ids and a SCRAP balance, can `id` be
// bought? (Already-unlocked items are trivially "affordable" — nothing to buy.)
export function canAfford(id, balance) {
  return balance >= costOf(id);
}
