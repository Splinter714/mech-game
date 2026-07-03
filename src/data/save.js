// localStorage persistence for the garage. The per-roster config (storage keys,
// model class, default builds) lives in ./rosters.js so this file stays generic —
// adding a saved-build slot or a new roster is one entry there, not a new loader.
// `makeRoster` is the generic load/save factory.

import { ROSTERS } from './rosters.js';
import { RUN_CURRENCY_KEY } from './events.js';
import { STARTING_UNLOCKED } from './shop.js';

export function makeRoster({ storageKey, Model, defaultRoster }) {
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
      all[key] = new Model({ ...roster[key], ...saved[key] });
    }
    save(all); // seed immediately so a first run writes the defaults
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

export { RUN_CURRENCY_KEY };
