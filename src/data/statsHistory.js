// #423 — Cross-run stats history. A rolling last-N of committed runs in localStorage, mirroring
// save.js's inject-nothing-global pattern but made fully testable by injecting the storage and
// clock (phase 2 passes the real localStorage / Date.now; tests pass fakes). No Phaser.
//
// Commit rule (locked, issue #423): a DEATH or WIN run always commits; a MANUALLY-ended run
// (G / Select-B → toGarage() with a live run) commits ONLY if it lasted >= MANUAL_MIN_DURATION_MS
// — sub-10s manual exits are throwaway and discarded. `shouldCommitRun` is the pure gate; phase 2
// calls it, then `commit()` if it passes.

export const HISTORY_LIMIT = 20;                 // rolling last-N committed runs
export const MANUAL_MIN_DURATION_MS = 10_000;    // manual-end runs shorter than this are discarded
// v2 (#432): the reduced enemy shape gained raw pooling counters (ttkSumMs/ttkCount/engagedMs/
// shotsFired/hits). Old v1 entries only stored pre-averaged avgTtkMs, so they can't be pooled
// exactly — bump the key so stale entries are dropped rather than corrupting the ALL-RUNS view.
export const HISTORY_STORAGE_KEY = 'mech-game-stats-history-v2';

// Pure gate — reason in { 'death', 'win', 'manual' }.
export function shouldCommitRun(run, { reason } = {}) {
  if (reason === 'death' || reason === 'win') return true;
  if (reason === 'manual') return (run?.durationMs ?? 0) >= MANUAL_MIN_DURATION_MS;
  return false;   // unknown reason → never commit
}

// Factory: everything localStorage-touching lives behind an injected `storage` + `now`, so the
// module never reaches for a global and tests stay hermetic. Defaults wire to the real browser.
export function makeStatsHistory({
  storage = (typeof localStorage !== 'undefined' ? localStorage : null),
  now = () => Date.now(),
  key = HISTORY_STORAGE_KEY,
  limit = HISTORY_LIMIT,
} = {}) {
  function list() {
    try {
      const raw = storage?.getItem(key);
      const arr = raw != null ? JSON.parse(raw) : null;
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function write(entries) {
    try {
      storage?.setItem(key, JSON.stringify(entries));
    } catch {
      // storage blocked/unavailable — history just doesn't persist this session.
    }
  }

  // Commit a finished run's reduced report. Returns { committed, entries }. A skipped run
  // (fails shouldCommitRun) leaves history untouched. Newest-first, pruned to `limit`.
  function commit(run, { reason } = {}) {
    if (!shouldCommitRun(run, { reason })) return { committed: false, entries: list() };
    const entry = { id: now(), reason, run };
    const entries = [entry, ...list()].slice(0, limit);
    write(entries);
    return { committed: true, entries, entry };
  }

  // Load one committed entry by id (the `now()` timestamp stamped at commit); null if missing.
  function load(id) {
    return list().find((e) => e.id === id) ?? null;
  }

  function clear() { write([]); }

  // #440 — delete ONE committed entry by id, leaving the rest untouched and in newest-first
  // order. Returns the surviving entries. A missing id is a no-op (still returns the list).
  function remove(id) {
    const entries = list().filter((e) => e.id !== id);
    write(entries);
    return entries;
  }

  return { list, commit, load, clear, remove };
}
