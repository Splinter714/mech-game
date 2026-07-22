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
//   run.enemyKill(enemyKind, ttlMs)                 // one unit died; ttlMs = its time-to-kill —
//                                                   //   FIRST PLAYER DAMAGE → death (NOT lifetime).
//                                                   //   ttlMs == null ⇒ this unit was never damaged
//                                                   //   by the player (crush / objective) → the kill
//                                                   //   still counts, but is EXCLUDED from avg TTK.
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
//   Firing time  — sum of ACTIVE cycle windows: each shotFired occupies at most one pullIntervalMs,
//                  but only until the NEXT voluntary pull if that came sooner — a weapon tapped
//                  slower than its cadence is not "busy" through the idle gap, so each shot
//                  contributes min(cycleTime, gap-to-next-shot). The LAST shot contributes its full
//                  cycle, capped at the run's end. RELOAD time is a SEPARATE bucket, excluded here.
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
    // #423 bug3: firing time is accrued lazily. `firingTimeMs` holds the FINALIZED windows of every
    // shot except the currently-pending last one; `lastShotMs`/`pendingIntervalMs` describe that
    // pending shot, finalized (capped at run end) only at reduce time. See shotFired below.
    firingTimeMs: 0, lastShotMs: null, pendingIntervalMs: 0,
    reloads: 0, reloadTimeMs: 0,
  };
}
function enemyBucket() {
  return {
    // #423 bug2: ttkCount is how many kills had a MEASURABLE time-to-kill (a first-player-hit stamp);
    // a crush/undamaged kill increments `killed` but not this, so it's the honest TTK denominator.
    spawned: 0, killed: 0, ttkSumMs: 0, ttkCount: 0, engagedMs: 0,
    shotsFired: 0, hits: 0, damageToYou: 0, damageToKind: 0, overkill: 0,
    // #440: CROSS-ATTRIBUTED damage — total damage dealt to the player by units THIS kind
    // spawned (a carrier's drones). Additive, kept SEPARATE from `damageToYou`/threat share:
    // the spawned unit's own direct damage still lands in ITS bucket, so folding this into the
    // spawner's threat share would double-count it. 0 for kinds that never spawn anything.
    spawnedDamage: 0,
    // #440: the LINKAGE for the spawner sub-row — the stat kind that SPAWNED units of THIS kind
    // (e.g. `droneBrood`'s spawnerKind is `carrier`). Recorded on first spawn/hit; stays null for a
    // kind nothing spawned. Display nests this bucket's stats as a sub-row under its spawner.
    spawnerKind: null,
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
      const iv = w ? pullIntervalMs(w) : 0;
      // #423 bug3: FINALIZE the previous shot's active window now that we know when the next pull
      // came — it was firing/busy for at most its own cycle, but only up to THIS shot if that
      // arrived sooner (a slowly-tapped weapon isn't busy through the idle gap it left). Stamp
      // against the internally-advanced clock (the arena ticks before feeding this frame's events).
      if (b.lastShotMs != null) {
        const gap = Math.max(0, state.clockMs - b.lastShotMs);
        b.firingTimeMs += Math.min(b.pendingIntervalMs, gap);
      }
      b.lastShotMs = state.clockMs;
      b.pendingIntervalMs = iv;
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

    enemySpawned(enemyKind, spawnerKind = null) {
      const e = eb(enemyKind);
      e.spawned += 1;
      // #440: record the spawner linkage so display can nest this kind's stats as a sub-row under
      // its spawner (e.g. `droneBrood` → `carrier`). Stamped on first spawn; later spawns are no-ops.
      if (spawnerKind != null && e.spawnerKind == null) e.spawnerKind = spawnerKind;
      return api;
    },
    enemyShotFired(enemyKind) { eb(enemyKind).shotsFired += 1; return api; },
    enemyShotHit(enemyKind) { eb(enemyKind).hits += 1; return api; },
    damageTaken({ enemyKind, weaponId, amount = 0, spawnerKind = null } = {}) {
      void weaponId;
      state.totalTaken += amount;
      if (enemyKind != null) eb(enemyKind).damageToYou += amount;
      // #440: if the attacker was SPAWNED by another unit, ALSO credit this damage to the
      // spawner's kind as a separate `spawnedDamage` figure. Additive — the direct
      // `damageToYou` above is untouched, so threat share never double-counts. eb() ensures the
      // spawner gets a bucket even if it dealt zero direct damage itself (a pure carrier).
      if (spawnerKind != null) eb(spawnerKind).spawnedDamage += amount;
      // #440: also stamp the reverse linkage on the SPAWNED kind's own bucket (a backstop in case
      // its stat kind was never seen through enemySpawned with a spawnerKind), so the sub-row can
      // still nest it under its spawner. Idempotent.
      if (enemyKind != null && spawnerKind != null && eb(enemyKind).spawnerKind == null) {
        eb(enemyKind).spawnerKind = spawnerKind;
      }
      markDamage();
      return api;
    },
    enemyEngaged(enemyKind, ms = 0) { eb(enemyKind).engagedMs += ms; return api; },
    enemyKill(enemyKind, ttlMs = null) {
      const e = eb(enemyKind);
      e.killed += 1;
      // #423 bug2: a real time-to-kill (first player hit → death) feeds the average; a null ttl (the
      // unit was never player-damaged — crushed/objective/suicide) counts as a kill but not a TTK
      // sample, so lifetime never leaks into the average.
      if (ttlMs != null && ttlMs >= 0) { e.ttkSumMs += ttlMs; e.ttkCount += 1; }
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
    // #423 bug3: finalize the still-pending last shot — its full cycle, capped at the run's end
    // (the elapsed time since it fired) — and add it to the finalized windows for the real firing time.
    const pendingFiring = b.lastShotMs != null
      ? Math.min(b.pendingIntervalMs, Math.max(0, state.clockMs - b.lastShotMs))
      : 0;
    const firingMs = b.firingTimeMs + pendingFiring;
    // #440: Real DPS is based on USEFUL damage (total minus overkill) — overkill is wasted
    // damage that didn't contribute to a kill, so it shouldn't inflate the effective figures.
    const usefulDamage = Math.max(0, b.damageDealt - b.overkill);
    const effBurst = perSec(usefulDamage, firingMs);
    const effSustained = perSec(usefulDamage, firingMs + b.reloadTimeMs);
    const effCombat = perSec(usefulDamage, combatMs);
    weapons[id] = {
      id,
      name: w?.name ?? id,
      shotsFired: b.shotsFired,
      hits: b.hits,
      accuracy: div(b.hits, b.shotsFired),
      damageDealt: b.damageDealt,
      overkill: b.overkill,
      firingTimeMs: firingMs,
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
      // #423 bug2: averaged over kills that actually had a first-player-hit stamp, not all kills.
      avgTtkMs: div(e.ttkSumMs, e.ttkCount),
      // #423 bug1: at most one hit is booked per enemy shot upstream (per-shot-id dedupe in the
      // arena wiring), so this is a true fraction; the min() is a by-construction backstop.
      weaponAccuracy: Math.min(1, div(e.hits, e.shotsFired)),
      effectiveDps: perSec(e.damageToYou, e.engagedMs),   // ÷ alive-and-aware time
      effectiveHp: div(e.damageToKind, e.killed),         // avg damage to down one unit
      // aggregate
      spawned: e.spawned,
      killed: e.killed,
      damageToYou: e.damageToYou,
      threatShare: div(e.damageToYou, state.totalTaken),
      // #440: damage dealt to you by units this kind SPAWNED (separate from threat share).
      spawnedDamage: e.spawnedDamage,
      // #440: the spawner-linkage label, carried through so display can nest this kind under it.
      spawnerKind: e.spawnerKind ?? null,
      damageToKind: e.damageToKind,
      overkill: e.overkill,
      // #432 RAW COUNTERS — kept in the reduced shape so ALL-RUNS pooling recomputes metrics
      // from summed counts, not by averaging pre-averaged per-run numbers. avgTtkMs alone loses
      // the sample count, so the raw ttk pair (sum + count), engaged time, and enemy shots/hits
      // all ride along.
      engagedMs: e.engagedMs,
      ttkSumMs: e.ttkSumMs,
      ttkCount: e.ttkCount,
      shotsFired: e.shotsFired,
      hits: e.hits,
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

// ── #432 ALL RUNS — pooled aggregate across every stored run ────────────────────────────────────
// Takes the array of REDUCED run reports (statsHistory stores `{ id, reason, run }`; pass the
// `.run`s) and POOLS THE RAW COUNTS, then recomputes every ratio from the summed counters — NOT
// an average of per-run metrics. Overall accuracy = Σhits/Σshots; per-weapon eBurst =
// Σdamage/Σfiring; eSustained = Σdamage/Σ(firing+reload); eCombat = Σdamage/Σcombat; enemy TTK =
// ΣttkSumMs/ΣttkCount; effectiveDps = ΣdamageToYou/ΣengagedMs; threatShare = ΣdamageToYou/Σtaken.
// Theoretical DPS is static per weapon (from weaponStats) — reused as-is; landing ratio recomputes
// from the pooled effective/theoretical. The output matches reduceRun's shape so the SAME
// runStatsText renderer and Copy path work on it. Never divides by zero (div/perSec guard).
export function aggregateRuns(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && typeof r === 'object');

  // Global pooled totals.
  const g = {
    durationMs: 0, combatTimeMs: 0, totalDealt: 0, totalTaken: 0,
    shotsFired: 0, hits: 0, deaths: 0, respawns: 0,
  };
  const powerups = {};
  // Pooled per-weapon and per-enemy raw buckets, keyed by id/kind.
  const wPool = {};   // id -> { shotsFired, hits, damageDealt, overkill, firingTimeMs, reloads, reloadTimeMs }
  const ePool = {};   // kind -> { spawned, killed, damageToYou, damageToKind, overkill, engagedMs, ttkSumMs, ttkCount, shotsFired, hits }

  for (const run of list) {
    g.durationMs += run.durationMs ?? 0;
    g.combatTimeMs += run.combatTimeMs ?? 0;
    g.totalDealt += run.totalDealt ?? 0;
    g.totalTaken += run.totalTaken ?? 0;
    g.shotsFired += run.shotsFired ?? 0;
    g.hits += run.hits ?? 0;
    g.deaths += run.deaths ?? 0;
    g.respawns += run.respawns ?? 0;
    for (const [k, v] of Object.entries(run.powerups ?? {})) powerups[k] = (powerups[k] ?? 0) + (v ?? 0);

    for (const w of Object.values(run.weapons ?? {})) {
      const b = (wPool[w.id] ??= {
        shotsFired: 0, hits: 0, damageDealt: 0, overkill: 0,
        firingTimeMs: 0, reloads: 0, reloadTimeMs: 0,
      });
      b.shotsFired += w.shotsFired ?? 0;
      b.hits += w.hits ?? 0;
      b.damageDealt += w.damageDealt ?? 0;
      b.overkill += w.overkill ?? 0;
      b.firingTimeMs += w.firingTimeMs ?? 0;
      b.reloads += w.reloads ?? 0;
      b.reloadTimeMs += w.reloadTimeMs ?? 0;
    }

    for (const e of Object.values(run.enemies ?? {})) {
      const b = (ePool[e.kind] ??= {
        spawned: 0, killed: 0, damageToYou: 0, spawnedDamage: 0, damageToKind: 0, overkill: 0,
        engagedMs: 0, ttkSumMs: 0, ttkCount: 0, shotsFired: 0, hits: 0, spawnerKind: null,
      });
      if (b.spawnerKind == null && e.spawnerKind != null) b.spawnerKind = e.spawnerKind;   // #440
      b.spawned += e.spawned ?? 0;
      b.killed += e.killed ?? 0;
      b.damageToYou += e.damageToYou ?? 0;
      b.spawnedDamage += e.spawnedDamage ?? 0;   // #440: pooled cross-attributed spawn damage
      b.damageToKind += e.damageToKind ?? 0;
      b.overkill += e.overkill ?? 0;
      b.engagedMs += e.engagedMs ?? 0;
      b.ttkSumMs += e.ttkSumMs ?? 0;
      b.ttkCount += e.ttkCount ?? 0;
      b.shotsFired += e.shotsFired ?? 0;
      b.hits += e.hits ?? 0;
    }
  }

  const weapons = {};
  for (const [id, b] of Object.entries(wPool)) {
    const w = getWeapon(id);
    const theoBurst = w ? burstDps(w) : 0;
    const theoSustained = w ? sustainedDps(w) : 0;
    // #440: Real DPS numerator is USEFUL damage (total minus overkill).
    const usefulDamage = Math.max(0, b.damageDealt - b.overkill);
    const effSustained = perSec(usefulDamage, b.firingTimeMs + b.reloadTimeMs);
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
      effectiveBurstDps: perSec(usefulDamage, b.firingTimeMs),
      effectiveSustainedDps: effSustained,
      effectiveCombatDps: perSec(usefulDamage, g.combatTimeMs),
      theoreticalBurstDps: theoBurst,
      theoreticalSustainedDps: theoSustained,
      landingRatio: div(effSustained, theoSustained),
    };
  }

  const enemies = {};
  for (const [kind, e] of Object.entries(ePool)) {
    enemies[kind] = {
      kind,
      avgTtkMs: div(e.ttkSumMs, e.ttkCount),
      weaponAccuracy: Math.min(1, div(e.hits, e.shotsFired)),
      effectiveDps: perSec(e.damageToYou, e.engagedMs),
      effectiveHp: div(e.damageToKind, e.killed),
      spawned: e.spawned,
      killed: e.killed,
      damageToYou: e.damageToYou,
      threatShare: div(e.damageToYou, g.totalTaken),
      spawnedDamage: e.spawnedDamage,   // #440
      spawnerKind: e.spawnerKind ?? null,   // #440
      damageToKind: e.damageToKind,
      overkill: e.overkill,
      engagedMs: e.engagedMs,
      ttkSumMs: e.ttkSumMs,
      ttkCount: e.ttkCount,
      shotsFired: e.shotsFired,
      hits: e.hits,
    };
  }

  return {
    // Marks this as the pooled view; the text renderer switches its header on it.
    runCount: list.length,
    meta: { biome: null, chassis: null, loadout: [] },
    durationMs: g.durationMs,
    combatTimeMs: g.combatTimeMs,
    totalDealt: g.totalDealt,
    totalTaken: g.totalTaken,
    accuracy: div(g.hits, g.shotsFired),
    shotsFired: g.shotsFired,
    hits: g.hits,
    deaths: g.deaths,
    respawns: g.respawns,
    powerups,
    weapons,
    enemies,
  };
}

// Re-exported so phase 2 / the export layer can reach the theory numbers from one import.
export { weaponTheory, damagePerPull, pullIntervalMs };
