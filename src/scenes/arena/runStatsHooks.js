// #423 phase 2 — the arena's RUN-STATS wiring. A thin mixin (composed onto ArenaScene like every
// other arena concern) that owns the run-stats accumulator (data/runStats.js) for one sortie and
// exposes the small seam methods the rest of the arena calls to emit events. All the real metric
// math lives in the pure data layer; this file is just the plumbing between live combat and it.
//
// The accumulator is created per-sortie in create() (`_initRunStats`), ticked once at the TOP of
// update() (`_statsTick`, before that frame's events so they stamp against the right clock), fed
// events from the fire/hit/damage/kill/spawn/powerup paths, and committed to history exactly once
// on run end via `_commitRunStats` — guarded so a death that then auto-returns to the garage does
// not double-count.
import { createRunStats } from '../../data/runStats.js';
import { makeStatsHistory, shouldCommitRun } from '../../data/statsHistory.js';
import { remainingDurability, overkillFor } from '../../data/runStatsCombat.js';
import { AWARE } from '../../data/awareness.js';
import { RELOAD_SECONDS } from '../../data/Mech.js';

export const RunStatsMixin = {
  // One-time init from ArenaScene.create(), after the player mech is known. Builds a fresh
  // accumulator stamped with this sortie's biome/chassis/loadout, and resets the per-sortie
  // bookkeeping (pull-hit dedupe set, reload-transition watch, the commit-once latch). Tolerant
  // of the arena test doubles, which never call this — every seam below no-ops on a null accumulator.
  _initRunStats(playerMech) {
    const loadout = (() => {
      try { return playerMech?.weapons?.().map((w) => w.id) ?? []; } catch { return []; }
    })();
    this.runStats = createRunStats({
      biome: this.biomeId ?? this.registry?.get?.('arenaBiome') ?? null,
      chassis: playerMech?.chassis?.name ?? playerMech?.chassisId ?? null,
      loadout,
    });
    this._statHitPulls = new Set();   // pull ids that have already scored a hit (accuracy dedupe)
    this._statPullSeq = 0;            // monotonic trigger-pull id
    this._reloadWatch = {};           // `${playerId}:${loc}:${index}` → was-reloading last frame
    this._statsCommitted = false;     // commit-once latch (double-commit guard)
    this._statsHistory ??= makeStatsHistory({});
  },

  // Top-of-frame clock advance + the per-frame accruals that ride on it. Called FIRST in update()
  // so this frame's fire/damage events stamp against the advanced clock. Combat time is derived
  // inside the accumulator from recent-damage-either-way, so nothing extra is passed here — feeding
  // the damage events (below) is what keeps that clock hot.
  _statsTick(deltaMs) {
    const run = this.runStats;
    if (!run) return;
    run.tick(deltaMs);
    // Per-unit alive-and-aware time — the denominator of each enemy kind's effective DPS. Accrue
    // this frame's delta onto every live, AWARE enemy's kind (last frame's awareness; one frame of
    // lag is immaterial over a run).
    for (const e of this.enemies ?? []) {
      if (e?.awareness === AWARE && !e.mech?.isDestroyed?.()) {
        run.enemyEngaged(e._statKind ?? e.kind ?? 'mech', deltaMs);
      }
    }
    // Reload buckets — watch each live player's weapons for a not-reloading → reloading edge
    // (a reload began) and the reverse (it finished). #402 reloads are a fixed, uninterruptible
    // lockout, so a completed one always lasted its full period.
    for (const p of this.players ?? []) {
      if (!p?.mech?.weapons) continue;
      let list; try { list = p.mech.weapons(); } catch { continue; }
      for (const w of list) {
        const key = `${p.id ?? 0}:${w.location}:${w.index}`;
        const was = this._reloadWatch[key] || false;
        const now = !!w.reloading;
        if (now && !was) run.reloadStart(w.id);
        else if (!now && was) run.reloadEnd(w.id, (w.reloadMax ?? RELOAD_SECONDS) * 1000);
        this._reloadWatch[key] = now;
      }
    }
  },

  // A player pulled a trigger (one magazine round). Returns a fresh pull id the caller threads to
  // this pull's emissions so a hit can be attributed back to it exactly once (accuracy).
  _statShotFired(weaponId, player) {
    if (!this.runStats) return null;
    const pullId = ++this._statPullSeq;
    this.runStats.shotFired(weaponId, player?.id ?? 0);
    return pullId;
  },

  // A player emission connected with an enemy. `pullId` may be null (a DOT tick / a source with no
  // discrete pull) — those still book damage but never a pull-level "hit". The first connecting
  // emission of a given pull scores the hit; later ones (other pellets, other targets) only add
  // damage, so accuracy stays a true 0..1 per-pull ratio.
  _statPlayerHit(weaponId, pullId, targetKind, amount, killed, overkill) {
    const run = this.runStats;
    if (!run || weaponId == null) return;
    if (pullId != null) {
      if (!this._statHitPulls.has(pullId)) {
        this._statHitPulls.add(pullId);
        run.shotHit(weaponId, targetKind, amount);
      }
    } else {
      run.shotHit(weaponId, targetKind, amount);
    }
    run.damageDealt({ weaponId, targetKind, amount, killed, overkill });
  },

  // Damage the player took, attributed to the enemy kind (and weapon) that dealt it. Also books the
  // enemy shot as a connecting hit (enemy accuracy is per-emission — a coarser number than the
  // player's pull-level accuracy, which is fine: it is only a rough "how often does this kind land").
  _statPlayerHurt(enemyKind, weaponId, amount) {
    const run = this.runStats;
    if (!run) return;
    if (enemyKind != null) run.enemyShotHit(enemyKind);
    run.damageTaken({ enemyKind, weaponId, amount });
  },

  // The two enemy-lifecycle seams, plus the small global events.
  _statEnemySpawned(e, kind) {
    e._statKind = kind;
    e._bornAt = this.time?.now ?? 0;
    this.runStats?.enemySpawned(kind);
  },
  _statEnemyFired(e) { this.runStats?.enemyShotFired(e?._statKind ?? e?.kind ?? 'mech'); },
  _statEnemyKilled(e) {
    if (!this.runStats) return;
    const ttl = Math.max(0, (this.time?.now ?? 0) - (e?._bornAt ?? this.time?.now ?? 0));
    this.runStats.enemyKill(e?._statKind ?? e?.kind ?? 'mech', ttl);
  },
  _statPowerup(type) { this.runStats?.powerup(type); },
  _statDeath(player) { this.runStats?.death(player?.id ?? 0); },
  _statRespawn(player) { this.runStats?.respawn(player?.id ?? 0); },

  // Overkill for a player killing blow, from the durability that was standing before the hit.
  _statOverkill(damage, remainingBefore, killed) { return overkillFor(damage, remainingBefore, killed); },
  _statRemaining(mech) { return remainingDurability(mech); },

  // Terminal: reduce the run and commit it to history, at most once. `reason` in
  // {'death','win','manual'} — death/win always commit; a manual exit only if it lasted long
  // enough (the pure gate, shouldCommitRun). The latch means a death that then auto-returns to the
  // garage (its RUN_OVER_DELAY timer calling toGarage() with reason 'manual') commits ONCE.
  _commitRunStats(reason) {
    if (this._statsCommitted || !this.runStats) return;
    this._statsCommitted = true;
    const report = this.runStats.reduce();
    if (!shouldCommitRun(report, { reason })) return;   // sub-10s manual exit: discarded
    try { this._statsHistory.commit(report, { reason }); } catch { /* storage blocked — skip */ }
  },
};
