// Arena run mixin (#64, reworked #269) — wires the pure Run model (data/run.js) into the live
// arena.
//
// #269 (issue: base population rework) retires the old fixed-5-stage squad-draw system
// entirely: there is no more "stage advance" event, no squad respawn on mission-complete, and
// no per-stage escalation. What's left, kept deliberately simple per the issue's own framing:
//   - Mission objectives ("destroy this outpost") still work exactly as before, fully decoupled
//     from enemy spawning — clearing one banks currency and immediately picks a fresh one
//     (`_pickNextObjective`, this file), same as always, just with no squad attached.
//   - The run's real win condition is now "every base's docked units destroyed" (dormant or
//     awakened — scenes/arena/bases.js `_allBasesCleared`), checked every frame.
//   - Player death still ends the run as a loss, same as before.
import {
  makeRun, advanceObjective, winRun, endRunOnDeath, isRunOver,
} from '../../data/run.js';
import { makeMission } from '../../data/mission.js';
import { RUN_CURRENCY_KEY } from '../../data/events.js';
import { saveRunCurrency } from '../../data/save.js';
import { pickFarObjective, FAR_OBJECTIVE_MIN_DIST, spineProgressHexOf } from '../../data/worldgen.js';
import { pixelToHex } from '../../data/hexgrid.js';

const RUN_OVER_DELAY = 3200;           // ms the WIN/DEAD banner holds before returning to garage

export const RunMixin = {
  // One-time init from ArenaScene.create(), AFTER _buildWorld()/_initMission() have set up the
  // first objective's mission the normal way. Continues the in-progress run from the registry
  // (set by a prior objective-clear within this same session) or starts a fresh one —
  // GarageScene's deploy() clears any stale run before starting the arena, so "no run in the
  // registry" always means "start clean".
  _initRun() {
    this.run = this.registry.get('run') ?? makeRun();
    this.registry.set('run', this.run);
    this._runAdvancing = false;   // guards against double-triggering the win/death transition
  },

  // Per-frame (called from update(), after _updateMission()). Feeds the mission model a real
  // death signal, watches for the mission completing (→ bank currency + pick a fresh objective)
  // or every base being cleared (→ win the run) or the player dying (→ end the run), and
  // republishes `this.run` so HudScene can read it.
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

    // #269 §8: the real win condition — every base's docked units destroyed. Checked every
    // frame regardless of mission state (an outpost objective and a base are independent).
    if (this._allBasesCleared()) { this._endRun('won'); return; }

    if (this.mission && this.mission.status === 'complete') this._advanceObjective();
  },

  // Mission cleared: bank the objective's currency and immediately pick + start a fresh one
  // within the SAME already-built terrain (#111 — the map is never rebuilt mid-run). No squad
  // spawn happens here any more — enemies live only inside bases (see scenes/arena/bases.js),
  // fully decoupled from objective-clearing.
  _advanceObjective() {
    this.run = advanceObjective(this.run);
    this.registry.set('run', this.run);
    this._pickNextObjective();
  },

  // #269: retired the old near→far, stage-indexed escalation (`lateFraction`/
  // `pickStageObjective`) — every later objective now uses the SAME strict farthest-candidate
  // pick `_initMission` (mission.js) uses for the first one, measured along the spine so it's
  // still a real trek down the corridor, just without a stage-indexed ramp.
  _pickNextObjective() {
    const hexKeys = this._objectiveHexKeys();
    const progressOf = (q, r) => spineProgressHexOf(this._spine, q, r);
    const playerHex = pixelToHex(this.px, this.py);
    // If every outpost in the whole map has already been destroyed, seed a fresh one somewhere
    // far from the player rather than leaving the run without an objective (mirrors the old
    // #81 fallback, `_spawnOutpostAt`).
    this.objectiveHex = pickFarObjective(hexKeys, playerHex, FAR_OBJECTIVE_MIN_DIST, null, progressOf)
      ?? this._spawnOutpostAt(playerHex.q, playerHex.r);
    this.mission = makeMission('assault');
    this.registry.set('mission', this.mission);
    if (this._objectiveMarker) { this._objectiveMarker.destroy(); this._objectiveMarker = null; }
    if (this.objectiveHex) this._makeObjectiveMarker(this.objectiveHex);
  },

  // Terminal run state (win or death): republish, bank the run's currency into the persistent
  // save-adjacent registry value the garage reads, show a banner, and return to the garage after
  // a beat. Clears `run` from the registry so the NEXT deploy starts clean.
  _endRun(status) {
    this._runAdvancing = true;
    this.run = status === 'dead' ? endRunOnDeath(this.run) : winRun(this.run);
    this.registry.set('run', this.run);

    const banked = (this.registry.get(RUN_CURRENCY_KEY) || 0) + this.run.currency;
    this.registry.set(RUN_CURRENCY_KEY, banked);
    saveRunCurrency(banked);
    this.registry.set('lastRunResult', { status: this.run.status, currency: this.run.currency });

    const won = this.run.status === 'won';
    const label = won ? 'RUN COMPLETE' : 'RUN OVER';
    const color = won ? '#7bd17b' : '#e2533a';
    this.registry.set('runOverBanner', { label, color, currency: this.run.currency });

    this.time.delayedCall(RUN_OVER_DELAY, () => {
      this.registry.set('run', null);
      this.registry.set('runOverBanner', null);
      this.toGarage();
    });
  },
};
