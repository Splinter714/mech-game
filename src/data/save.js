// localStorage persistence for the garage. The per-roster config (storage keys,
// model class, default builds) lives in ./rosters.js so this file stays generic —
// adding a saved-build slot or a new roster is one entry there, not a new loader.
// `makeRoster` is the generic load/save factory.

import { ROSTERS } from './rosters.js';

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
