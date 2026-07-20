// Arena run mixin (#64, reworked #269) — wires the pure Run model (data/run.js) into the live
// arena.
//
// #269 (issue: base population rework) retires the old fixed-5-stage squad-draw system
// entirely: there is no more "stage advance" event, no squad respawn on mission-complete, and
// no per-stage escalation. What's left, kept deliberately simple per the issue's own framing:
//   - Mission objectives now sequence through bases in index order ("clear base N" — see
//     mission.js `_targetCurrentBase`), fully decoupled from enemy spawning — clearing one banks
//     currency and immediately advances to the next base (`_pickNextObjective`, this file).
//   - The run's real win condition is now "every base's objective hex destroyed" (#269 playtest
//     follow-up — scenes/arena/bases.js `_allObjectivesDestroyed`, mirroring the same per-base
//     rule mission.js's `_updateMission` uses), checked every frame. Reaching the last base's
//     objective and clearing it necessarily satisfies this too, so in practice the win check
//     below (`_allObjectivesDestroyed`) fires before `_pickNextObjective` ever runs off the end
//     of `this.bases`.
//   - Player death still ends the run as a loss, same as before.
import {
  makeRun, advanceObjective, winRun, endRunOnDeath, isRunOver,
} from '../../data/run.js';
import { RUN_CURRENCY_KEY } from '../../data/events.js';
import { saveRunCurrency } from '../../data/save.js';
import { allPlayersDeadIn } from './players.js';

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

    // #347: the run ends on death only when EVERY player is down. With one player that is
    // exactly the old `this.mech.isDestroyed()` check; with two it is where phase 2's
    // spectate-vs-respawn decision (#335 open question 5) plugs in, rather than in the mission
    // bookkeeping below.
    if (allPlayersDeadIn(this)) {
      if (this.mission && this.mission.status === 'active') {
        // Re-evaluate the mission with the real death signal so it flips to 'failed' too (the
        // pure model already supports this — see data/mission.js evaluateMission).
        this.mission.status = 'failed';
        this.registry.set('mission', this.mission);
      }
      this._endRun('dead');
      return;
    }

    // #269 playtest follow-up ("objectives aren't clearing until I kill all units at the base"):
    // the real win condition is every base's OBJECTIVE HEX destroyed (mission.js
    // `isBaseObjectiveDestroyed` — same rule the per-base mission check uses, via
    // `_allObjectivesDestroyed`), not just every enemy dead (`_allBasesCleared`, kept around as
    // a distinct, separately-tested concept but no longer what ends the run). Checked every
    // frame regardless of mission state (an outpost objective and a base are independent).
    // #356 (Jackson: "the mission shouldn't be fully complete until all enemies are dead at the
    // last objective"): the win check is now the FULL per-base clear — objective, then every dock,
    // then every remaining enemy of that base — for every base (`_allBasesFullyCleared`), not the
    // weaker "every objective hex destroyed" (`_allObjectivesDestroyed`, still live as #355's
    // gate-latch rule). Blowing the last objective hex therefore no longer ends the run while its
    // garrison is still shooting at you.
    if (this._allBasesFullyCleared()) { this._endRun('won'); return; }

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

  // #269 playtest follow-up (objective sequencing): retired the old arbitrary-farthest-outpost
  // pick entirely — the next objective is just "the next base by index." `_targetCurrentBase`
  // (mission.js) does the actual work (marker, mission, registry publish) and already handles
  // running off the end of `this.bases` (every base cleared) by clearing the objective/marker,
  // which is correct here too — `_updateRun`'s `_allObjectivesDestroyed()` check ends the run as
  // a win before this can ever be reached with no bases left anyway.
  _pickNextObjective() {
    this._objectiveBaseIndex += 1;
    this._targetCurrentBase();
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

    // Refs #281: keep a handle on this timer so a manual return-to-garage (toGarage(), called
    // directly by the G key / Select-B pad exit — see toGarage()'s own comment) can cancel it.
    // Without this, a manual exit before the timer fires left it dangling: it would go off
    // later — after the player had already started a new run — and clobber that fresh state by
    // nulling `run`/`runOverBanner` and forcing a second, unwanted toGarage() transition.
    this._runOverTimer = this.time.delayedCall(RUN_OVER_DELAY, () => {
      this._runOverTimer = null;
      this.registry.set('run', null);
      this.toGarage();
    });
  },
};
