// Arena run mixin (#64) — wires the pure Run model (data/run.js) into the live arena: starts
// or continues a run at create(), feeds the mission model a REAL playerDead signal now that
// the deploy survivability buffer is tuned down, and sequences stage advance (mission
// complete → a new objective (#111: within the SAME already-built terrain — no more per-stage
// map regeneration) + a bigger/tougher squad in the SAME arena session, continuing from
// wherever the player is — no teleport) and run-over (player destroyed OR final stage cleared
// → banner, bank currency, return to garage) after a short beat so the banners read. Methods
// use `this` (the ArenaScene); composed onto the prototype via Object.assign, same as the
// other mixins.
import {
  makeRun, advanceStage, endRunOnDeath, isRunOver, stageDescriptor, lateFraction,
} from '../../data/run.js';
import { makeMission } from '../../data/mission.js';
import { RUN_CURRENCY_KEY } from '../../data/events.js';
import { saveRunCurrency } from '../../data/save.js';
import { pixelToHex } from '../../data/hexgrid.js';
import { pickStageObjective, pickFarObjective, FAR_OBJECTIVE_MIN_DIST } from '../../data/worldgen.js';

const STAGE_TRANSITION_DELAY = 3000;   // ms after mission-complete before the next stage loads
const RUN_OVER_DELAY = 3200;           // ms the WIN/DEAD banner holds before returning to garage

export const RunMixin = {
  // One-time init from ArenaScene.create(), AFTER _buildWorld()/_initMission() have set up the
  // first stage's mission the normal way. Continues the in-progress run from the registry (set
  // by a prior stage advance within this same session) or starts a fresh one — GarageScene's
  // deploy() clears any stale run before starting the arena, so "no run in the registry" always
  // means "start clean at stage 0".
  _initRun() {
    this.run = this.registry.get('run') ?? makeRun();
    this.registry.set('run', this.run);
    this._runAdvancing = false;   // guards against double-triggering the stage/over transitions
  },

  // Per-frame (called from update(), after _updateMission()). Feeds the mission model a real
  // death signal, watches for the mission completing (→ advance the run) or the player dying
  // (→ end the run), and republishes `this.run` so HudScene can read stage/status.
  _updateRun() {
    if (!this.run || this._runAdvancing) return;

    if (this.mech.isDestroyed()) {
      if (this.mission && this.mission.status === 'active') {
        // Re-evaluate the mission with the real death signal so it flips to 'failed' too (the
        // pure model already supports this — see data/mission.js evaluateMission).
        this.mission.status = 'failed';
        this.registry.set('mission', this.mission);
      }
      this._endRun('dead');
      return;
    }

    if (this.mission && this.mission.status === 'complete') this._advanceRun();
  },

  // Mission cleared: bank the stage's currency, move to the next stage (or WIN if that was the
  // last one), and — if the run is still active — place the new stage's objective right away
  // (playtest 2026-07-10 point 3: waiting for the whole transition beat read as the map not
  // opening up until an arbitrary delay had passed) while still holding the harder squad's
  // spawn + stage-label beat until after "MISSION COMPLETE" has had a moment to read.
  _advanceRun() {
    this._runAdvancing = true;
    this.run = advanceStage(this.run);
    this.registry.set('run', this.run);

    if (isRunOver(this.run)) {
      this._endRun('won');
      return;
    }

    this._pickNextStageObjective();

    const label = stageDescriptor(this.run.stageIndex).label;
    this._floatText(this.px, this.py - 60, `${label} INCOMING`, '#5ec8e0');
    this.time.delayedCall(STAGE_TRANSITION_DELAY, () => this._spawnNextStageSquad());
  },

  // #111: pick stage N's objective + start its mission IMMEDIATELY on mission-complete — no
  // scene restart, no forced trip to the garage, and (playtest 2026-07-10 point 3) no waiting
  // on STAGE_TRANSITION_DELAY first. Unlike the old #81 incremental-growth system, the terrain
  // itself is NEVER rebuilt here — the whole run's map was already built once at deploy
  // (`ArenaScene.create()` → `_buildWorld()`); stage advance only reassigns `this.objectiveHex`
  // within it and spawns a bigger/tougher squad (see `_spawnNextStageSquad`, which runs after
  // the short readability beat). Player position, surviving enemies, and every hex of terrain
  // are all untouched by this — the "no teleport" guarantee is now trivially true since
  // nothing about the world changes under the player's feet.
  //
  // #138 (playtest: "the map still feels huge, especially on initial deploy"): the objective
  // distance now scales with `lateFraction(stageIndex)` — the SAME curve data/run.js already
  // uses for squad-composition escalation — via `pickStageObjective`, so early stages stay near
  // and only later stages reach out toward the old always-farthest behavior.
  _pickNextStageObjective() {
    const desc = stageDescriptor(this.run.stageIndex);
    this._pendingStageDesc = desc;   // handed to _spawnNextStageSquad after the beat

    const playerHex = pixelToHex(this.px, this.py);
    // The world's `buildingHp` map (hexKey → remaining HP) holds every outpost still standing
    // across the WHOLE pre-built map (a destroyed outpost — including a past stage's objective
    // — leaves this map for good, so later stages naturally can't re-pick it). If every outpost
    // in the whole map has been destroyed by this point in the run, seed a fresh one somewhere
    // far from the player rather than leaving the stage without an objective. The strict
    // farthest-candidate fallback (`pickFarObjective`) is kept for that edge case (and the case
    // where the stage-aware pick comes back empty) rather than leaving a stage without one.
    const hexKeys = [...this.buildingHp.keys()];
    const frac = lateFraction(this.run.stageIndex);
    this.objectiveHex = pickStageObjective(hexKeys, playerHex, frac, FAR_OBJECTIVE_MIN_DIST)
      ?? this._spawnOutpostAt(playerHex.q, playerHex.r)
      ?? pickFarObjective(hexKeys, playerHex, FAR_OBJECTIVE_MIN_DIST);
    this.mission = makeMission(desc.missionTypeId);
    this.registry.set('mission', this.mission);
    if (this._objectiveMarker) { this._objectiveMarker.destroy(); this._objectiveMarker = null; }
    if (this.objectiveHex) this._makeObjectiveMarker(this.objectiveHex);
  },

  // The harder squad (per data/run.js escalation curve), dropped off-screen same as the opening
  // squad — held back until after the "MISSION COMPLETE"/"STAGE N INCOMING" beat so a fresh wave
  // doesn't ambush the player mid-banner, even though the new objective was already picked
  // instantly in `_pickNextStageObjective`. #105 (playtest 2026-07-10): clearing the objective
  // and reaching the next stage must NOT wipe out enemies still alive from the just-finished
  // stage — only ADD the new squad on top of whatever's still standing. (#71's old "destroy +
  // clear this.enemies" step here was about cleaning up DEAD enemies' leftover sprites/textures
  // across stages; that's now handled the instant a kill registers by #87's `_removeEnemy`, so
  // live enemies are never the ones piling up and this array is safe to leave untouched.)
  _spawnNextStageSquad() {
    const desc = this._pendingStageDesc;
    this._pendingStageDesc = null;
    // Belt-and-suspenders: every real kill tears its corpse down + prunes it out of
    // `this.enemies` synchronously (combat.js `_damageEnemyAt` → `_removeEnemy`), so in normal
    // play nothing dead should still be sitting in the array — but if a dead-but-not-yet-removed
    // entry ever does slip through, don't carry THAT over as a lingering corpse.
    this.enemies = this.enemies.filter((e) => {
      if (e.mech.isDestroyed()) { this._destroyEnemy(e); return false; }
      return true;
    });
    // The HUD's "N/M" counter (`_enemiesSpawnedThisStage`) is reseeded to the current survivor
    // count — rather than reset to 0 — so `_spawnSquad`'s per-spawn increments land on "this
    // stage's whole active roster" (survivors + new squad), not just the new squad's size.
    this._enemiesSpawnedThisStage = this.enemies.length;
    this._spawnSquad(desc.squad);

    this._floatText(this.px, this.py - 40, desc.label, '#7bd17b');
    this._runAdvancing = false;
  },

  // Terminal run state (win or death): republish, bank the run's currency into the persistent
  // save-adjacent registry value the garage reads (full spend/shop UI is #65's job — this issue
  // just needs the number banked and visible), show a banner, and return to the garage after a
  // beat. Clears `run` from the registry so the NEXT deploy starts clean at stage 0.
  _endRun(status) {
    this._runAdvancing = true;
    if (status === 'dead') this.run = endRunOnDeath(this.run);
    this.registry.set('run', this.run);

    const banked = (this.registry.get(RUN_CURRENCY_KEY) || 0) + this.run.currency;
    this.registry.set(RUN_CURRENCY_KEY, banked);
    saveRunCurrency(banked);
    this.registry.set('lastRunResult', { status: this.run.status, currency: this.run.currency });

    const won = this.run.status === 'won';
    const label = won ? 'RUN COMPLETE' : 'RUN OVER';
    const color = won ? '#7bd17b' : '#e2533a';
    this._floatText(this.px, this.py - 50, label, color);
    this.registry.set('runOverBanner', { label, color, currency: this.run.currency });

    this.time.delayedCall(RUN_OVER_DELAY, () => {
      this.registry.set('run', null);
      this.registry.set('runOverBanner', null);
      this.toGarage();
    });
  },
};
