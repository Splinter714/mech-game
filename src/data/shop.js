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

// #453 TEMPORARY FULL UNLOCK — every weapon is available from the start, in PRODUCTION as well
// as dev (dev already skipped the grind via the `import.meta.env.DEV` branch in GarageScene).
// The shop/economy is left completely intact underneath: this only widens what `loadUnlocked()`
// hands back (data/save.js), so nothing is ever written to localStorage and no save is touched.
// TO REVERT: flip this to `false` (or delete it and its one use in data/save.js) — the SCRAP
// grind comes straight back, including for anyone who played while it was on.
export const UNLOCK_ALL = true;

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
};

const DEFAULT_COST = 100;

export function costOf(id) {
  return SHOP_COSTS[id] ?? DEFAULT_COST;
}

// Every item that CAN be gated by the shop (every weapon id). Used to validate the starting
// set / build a fresh locked-by-default set.
export const SHOPPABLE_IDS = [...WEAPON_IDS];

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
