// #423 — Run-stats accumulator + reducer (phase 1, pure data layer, NO Phaser).
//
// Phase 2 (arena wiring) feeds this a stream of events during a run and drives its clock with
// `tick(dtMs, …)`; `reduce()` turns the raw counters into the derived metrics the stats screen
// and the copyable text export render. Everything here is pure and injected-time — it NEVER
// calls Date.now() or Math.random(); the arena passes time in via `tick`, and every event is
// stamped against the internally-advanced clock.
//
// ── EVENT API (what phase 2 calls) ──────────────────────────────────────────────────────────
//   const run = createRunStats({ biome, chassis, loadout });   // loadout = [weaponId, …]
//
//   // TIME — call once per frame BEFORE that frame's events so they stamp at the right time.
//   run.tick(dtMs, { inCombat } = {})   // advances clock + duration; accrues combat time while
//                                       //   combat is "hot" (recent damage either way, or the
//                                       //   optional inCombat override forces it on this frame)
//
//   // PLAYER WEAPONS (weaponId = base weapon id; playerId optional, for future per-player split)
//   run.shotFired(weaponId, playerId)              // one trigger pull; also accrues firing time
//   run.shotHit(weaponId, targetKind, damage)      // that pull connected (accuracy numerator)
//   run.damageDealt({ weaponId, targetKind, amount, killed, overkill })  // damage you applied
//   run.reloadStart(weaponId)                       // a reload began (counts one reload)
//   run.reloadEnd(weaponId, ms)                     // a reload finished, lasting `ms`
//
//   // ENEMIES
//   run.enemySpawned(enemyKind)                     // one unit of this kind entered the run
//   run.enemyShotFired(enemyKind)                   // that kind pulled a trigger
//   run.enemyShotHit(enemyKind)                     // …and connected on you
//   run.damageTaken({ enemyKind, weaponId, amount })// damage that kind did to you
//   run.enemyEngaged(enemyKind, ms)                 // per-unit alive-and-aware time (DPS denom)
//   run.enemyKill(enemyKind, ttlMs)                 // one unit died; ttlMs = its time-to-kill
//
//   // GLOBAL
//   run.powerup(type)                               // a powerup was collected
//   run.death(playerId)                             // a player died
//   run.respawn(playerId)                           // a player respawned
//
//   const report = run.reduce();                    // derived metrics (see shape below)
//
// ── LOCKED DEFINITIONS (issue #423) ──────────────────────────────────────────────────────────
//   Combat time  — a recent-damage-either-way clock: combat is "on" while damage flowed in
//                  EITHER direction within the last COMBAT_WINDOW_MS. Accrued during ticks.
//   Firing time  — sum of active cycle windows: each shotFired occupies pullIntervalMs of firing
//                  time; RELOAD time is a SEPARATE bucket, excluded from firing time.
//   Enemy per-unit effective DPS — damage that kind dealt ÷ that kind's aggregate engaged time.
//   Landing ratio — Effective Sustained DPS ÷ Theoretical Sustained DPS (both averaged over
//                  firing+reload, so the pairing is apples-to-apples: the gap is purely "did the
//                  shots connect", not a cadence/denominator mismatch).

import {
  burstDps, sustainedDps, damagePerPull, pullIntervalMs, weaponTheory,
} from './weaponStats.js';
import { getWeapon } from './weapons.js';

// Combat is "hot" for this long after the last damage in either direction.
export const COMBAT_WINDOW_MS = 3000;

function div(a, b) { return b > 0 ? a / b : 0; }
const perSec = (dmg, ms) => div(dmg, ms / 1000);

function weaponBucket() {
  return {
    shotsFired: 0, hits: 0, damageDealt: 0, overkill: 0,
    firingTimeMs: 0, reloads: 0, reloadTimeMs: 0,
  };
}
function enemyBucket() {
  return {
    spawned: 0, killed: 0, ttkSumMs: 0, engagedMs: 0,
    shotsFired: 0, hits: 0, damageToYou: 0, damageToKind: 0, overkill: 0,
  };
}

export function createRunStats(meta = {}) {
  const state = {
    meta: {
      biome: meta.biome ?? null,
      chassis: meta.chassis ?? null,
      loadout: Array.isArray(meta.loadout) ? [...meta.loadout] : [],
    },
    clockMs: 0,
    durationMs: 0,
    combatTimeMs: 0,
    lastDamageMs: null,      // clock time of the most recent damage (either direction)
    totalDealt: 0,
    totalTaken: 0,
    deaths: 0,
    respawns: 0,
    powerups: {},            // type -> count
    weapons: {},             // weaponId -> weaponBucket
    enemies: {},             // enemyKind -> enemyBucket
  };

  const wb = (id) => (state.weapons[id] ??= weaponBucket());
  const eb = (k) => (state.enemies[k] ??= enemyBucket());
  const markDamage = () => { state.lastDamageMs = state.clockMs; };

  const api = {
    get state() { return state; },

    tick(dtMs = 0, { inCombat = false } = {}) {
      if (!(dtMs > 0)) return api;
      state.clockMs += dtMs;
      state.durationMs += dtMs;
      const recentlyDamaged = state.lastDamageMs != null
        && (state.clockMs - state.lastDamageMs) <= COMBAT_WINDOW_MS;
      if (inCombat || recentlyDamaged) state.combatTimeMs += dtMs;
      return api;
    },

    shotFired(weaponId, _playerId) {
      const b = wb(weaponId);
      b.shotsFired += 1;
      const w = getWeapon(weaponId);
      if (w) b.firingTimeMs += pullIntervalMs(w);   // each pull occupies one cycle window
      return api;
    },
    shotHit(weaponId, _targetKind, _damage) {
      wb(weaponId).hits += 1;                        // damage is booked via damageDealt
      return api;
    },
    damageDealt({ weaponId, targetKind, amount = 0, killed = false, overkill = 0 } = {}) {
      state.totalDealt += amount;
      if (weaponId != null) {
        const b = wb(weaponId);
        b.damageDealt += amount;
        b.overkill += overkill;
      }
      if (targetKind != null) {
        const e = eb(targetKind);
        e.damageToKind += amount;
        e.overkill += overkill;
      }
      void killed;   // kill counts + TTK come from enemyKill (authoritative, no double-count)
      markDamage();
      return api;
    },
    reloadStart(weaponId) { wb(weaponId).reloads += 1; return api; },
    reloadEnd(weaponId, ms = 0) { wb(weaponId).reloadTimeMs += ms; return api; },

    enemySpawned(enemyKind) { eb(enemyKind).spawned += 1; return api; },
    enemyShotFired(enemyKind) { eb(enemyKind).shotsFired += 1; return api; },
    enemyShotHit(enemyKind) { eb(enemyKind).hits += 1; return api; },
    damageTaken({ enemyKind, weaponId, amount = 0 } = {}) {
      void weaponId;
      state.totalTaken += amount;
      if (enemyKind != null) eb(enemyKind).damageToYou += amount;
      markDamage();
      return api;
    },
    enemyEngaged(enemyKind, ms = 0) { eb(enemyKind).engagedMs += ms; return api; },
    enemyKill(enemyKind, ttlMs = 0) {
      const e = eb(enemyKind);
      e.killed += 1;
      e.ttkSumMs += ttlMs;
      return api;
    },

    powerup(type) {
      if (type != null) state.powerups[type] = (state.powerups[type] ?? 0) + 1;
      return api;
    },
    death() { state.deaths += 1; return api; },
    respawn() { state.respawns += 1; return api; },

    reduce() { return reduceRun(state); },
  };
  return api;
}

// ── The pure reducer ─────────────────────────────────────────────────────────────────────────
export function reduceRun(state) {
  const combatMs = state.combatTimeMs;

  const totalHits = Object.values(state.weapons).reduce((s, b) => s + b.hits, 0);
  const totalShots = Object.values(state.weapons).reduce((s, b) => s + b.shotsFired, 0);

  const weapons = {};
  for (const [id, b] of Object.entries(state.weapons)) {
    const w = getWeapon(id);
    const theoBurst = w ? burstDps(w) : 0;
    const theoSustained = w ? sustainedDps(w) : 0;
    const effBurst = perSec(b.damageDealt, b.firingTimeMs);
    const effSustained = perSec(b.damageDealt, b.firingTimeMs + b.reloadTimeMs);
    const effCombat = perSec(b.damageDealt, combatMs);
    weapons[id] = {
      id,
      name: w?.name ?? id,
      shotsFired: b.shotsFired,
      hits: b.hits,
      accuracy: div(b.hits, b.shotsFired),
      damageDealt: b.damageDealt,
      overkill: b.overkill,
      firingTimeMs: b.firingTimeMs,
      reloads: b.reloads,
      reloadTimeMs: b.reloadTimeMs,
      effectiveBurstDps: effBurst,
      effectiveSustainedDps: effSustained,
      effectiveCombatDps: effCombat,
      theoreticalBurstDps: theoBurst,
      theoreticalSustainedDps: theoSustained,
      // Landing ratio: how much of the stat-sheet sustained output actually connected.
      landingRatio: div(effSustained, theoSustained),
    };
  }

  const enemies = {};
  for (const [kind, e] of Object.entries(state.enemies)) {
    enemies[kind] = {
      kind,
      // per-unit
      avgTtkMs: div(e.ttkSumMs, e.killed),
      weaponAccuracy: div(e.hits, e.shotsFired),
      effectiveDps: perSec(e.damageToYou, e.engagedMs),   // ÷ alive-and-aware time
      effectiveHp: div(e.damageToKind, e.killed),         // avg damage to down one unit
      // aggregate
      spawned: e.spawned,
      killed: e.killed,
      damageToYou: e.damageToYou,
      threatShare: div(e.damageToYou, state.totalTaken),
      damageToKind: e.damageToKind,
      overkill: e.overkill,
    };
  }

  return {
    meta: { ...state.meta },
    durationMs: state.durationMs,
    combatTimeMs: combatMs,
    totalDealt: state.totalDealt,
    totalTaken: state.totalTaken,
    accuracy: div(totalHits, totalShots),
    shotsFired: totalShots,
    hits: totalHits,
    deaths: state.deaths,
    respawns: state.respawns,
    powerups: { ...state.powerups },
    weapons,
    enemies,
  };
}

// Re-exported so phase 2 / the export layer can reach the theory numbers from one import.
export { weaponTheory, damagePerPull, pullIntervalMs };
