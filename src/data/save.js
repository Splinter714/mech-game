// localStorage persistence for the garage. The per-roster config (storage keys,
// model class, default builds) lives in ./rosters.js so this file stays generic —
// adding a saved-build slot or a new roster is one entry there, not a new loader.
// `makeRoster` is the generic load/save factory.

import { ROSTERS } from './rosters.js';
import { RUN_CURRENCY_KEY } from './events.js';
import { STARTING_UNLOCKED } from './shop.js';
import { BIOME_IDS } from './biomes.js';

export function makeRoster({ storageKey, Model, defaultRoster, migrate }) {
  function readSaved() {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) ?? {}) : {};
    } catch {
      return {};
    }
  }

  function save(all) {
    const out = {};
    for (const key of Object.keys(all)) out[key] = all[key].toJSON();
    try {
      localStorage.setItem(storageKey, JSON.stringify(out));
    } catch {
      // localStorage blocked/unavailable — the game still plays this session.
    }
  }

  function load() {
    const roster = defaultRoster();
    const saved = readSaved();
    const all = {};
    // Merge defaults UNDER saved data so an older save inherits any newly added field
    // while saved values still win.
    for (const key of Object.keys(roster)) {
      let merged = { ...roster[key], ...saved[key] };
      // Optional per-roster migration applied AFTER the merge, so it can override even an
      // explicit saved value (e.g. #248's chassis lock forcing an old save's chassisId).
      if (migrate) merged = migrate(merged);
      all[key] = new Model(merged);
    }
    save(all); // seed immediately so a first run writes the defaults (or a migration change)
    return all;
  }

  return { load, save };
}

const ROSTER_API = Object.fromEntries(
  Object.entries(ROSTERS).map(([id, cfg]) => [id, makeRoster(cfg)]),
);

// Every roster as { id, registryKey, load, save } so BootScene can seed the registry
// generically and any system can save by roster id.
export const ROSTER_SPECIES = Object.entries(ROSTERS).map(([id, cfg]) => ({
  id, registryKey: cfg.registryKey, load: ROSTER_API[id].load, save: ROSTER_API[id].save,
}));

export const loadAllMechs = () => ROSTER_API.mech.load();
export const saveAllMechs = (all) => ROSTER_API.mech.save(all);

export function resetAllMechs() {
  try {
    localStorage.removeItem(ROSTERS.mech.storageKey);
  } catch {
    // nothing to clear
  }
}

// #64: the player's banked run currency (meta-progression pool, persists across runs AND
// page reloads). Full spend/shop UI is #65's job — this is just enough to bank + display a
// number. Mirrors the roster pattern (localStorage-backed, defaults to 0, never throws).
const RUN_CURRENCY_STORAGE_KEY = 'mech-game-run-currency-v1';

export function loadRunCurrency() {
  try {
    const raw = localStorage.getItem(RUN_CURRENCY_STORAGE_KEY);
    const n = raw != null ? Number(JSON.parse(raw)) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function saveRunCurrency(amount) {
  try {
    localStorage.setItem(RUN_CURRENCY_STORAGE_KEY, JSON.stringify(amount));
  } catch {
    // localStorage blocked/unavailable — the game still plays this session.
  }
}

// #65: the player's permanently-unlocked catalog (meta-progression, persists across runs AND
// page reloads, mirrors the run-currency pattern above). Stored as an id array; loaded back as
// a Set. The starting kit is always folded in on load so an old/corrupt save can never leave a
// fresh deploy un-buildable.
const UNLOCKED_STORAGE_KEY = 'mech-game-unlocked-v1';

export function loadUnlocked() {
  try {
    const raw = localStorage.getItem(UNLOCKED_STORAGE_KEY);
    const arr = raw != null ? JSON.parse(raw) : null;
    const set = new Set(Array.isArray(arr) ? arr : STARTING_UNLOCKED);
    for (const id of STARTING_UNLOCKED) set.add(id);
    return set;
  } catch {
    return new Set(STARTING_UNLOCKED);
  }
}

export function saveUnlocked(set) {
  try {
    localStorage.setItem(UNLOCKED_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage blocked/unavailable — the game still plays this session.
  }
}

// #240: which biomes the player has SUCCESSFULLY finished a run in — the boss-arena unlock
// condition. "Successfully finished" means the run ended as a WIN (every base's objective
// destroyed, then returned to the garage alive); a run that ends in the player's death never
// marks anything (see scenes/arena/run.js `_endRun`, the single call site — it only calls
// `markBiomeCleared` on the 'won' branch).
//
// Same localStorage shape/spirit as the unlocked-catalog block above: stored as a plain id
// array, loaded back as a Set, never throws, and unknown/stale ids (a biome removed from
// data/biomes.js since the save was written) are filtered out on load so `allBiomesCleared`
// can't be satisfied by junk. Persisting the SET of ids (rather than a bare count) is what
// makes "one run in EACH of the 5" checkable rather than "5 runs anywhere."
const BIOME_CLEARS_STORAGE_KEY = 'mech-game-biome-clears-v1';

export function loadClearedBiomes() {
  try {
    const raw = localStorage.getItem(BIOME_CLEARS_STORAGE_KEY);
    const arr = raw != null ? JSON.parse(raw) : null;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((id) => BIOME_IDS.includes(id)));
  } catch {
    return new Set();
  }
}

export function saveClearedBiomes(set) {
  try {
    localStorage.setItem(BIOME_CLEARS_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage blocked/unavailable — the game still plays this session.
  }
}

// Record one biome as cleared and persist it. Idempotent (clearing the same biome twice is a
// no-op) and ignores an unknown id outright, so a caller can pass whatever `biomeId` the arena
// happened to be built with without pre-validating it. Returns the updated set.
export function markBiomeCleared(biomeId) {
  const set = loadClearedBiomes();
  if (!BIOME_IDS.includes(biomeId)) return set;
  set.add(biomeId);
  saveClearedBiomes(set);
  return set;
}

// The boss-arena unlock condition (#240): one successful run in EVERY biome. Pure over the
// passed set so it's testable without localStorage; defaults to the saved set for callers that
// just want the live answer. NOTE: the DEV override ("the Boss Arena option is always available
// on the dev server") deliberately lives at the UI call site (GarageScene), NOT here — this
// stays the honest production rule so tests and the saved state can't be confused by it.
export function allBiomesCleared(cleared = loadClearedBiomes()) {
  return BIOME_IDS.every((id) => cleared.has(id));
}

export { RUN_CURRENCY_KEY };
