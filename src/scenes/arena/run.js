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
import {
  RUN_CURRENCY_KEY, OUTPOSTS_KEY, DEEP_MISSIONS_WON_KEY, REGIONAL_BASES_KEY,
} from '../../data/events.js';
import {
  saveRunCurrency, saveOutposts, saveDeepMissionsWon, saveRegionalBases,
} from '../../data/save.js';
import { claimOutpost } from '../../data/outposts.js';
import { establishRegionalBase } from '../../data/regionalBases.js';
import { allPlayersDeadIn } from './players.js';

const RUN_OVER_DELAY = 3200;           // ms the WIN/DEAD banner holds before returning to garage
// #517: how long the post-clear "establish this base?" choice stays up before defaulting to
// "leave it uncaptured and move on" — long enough to notice and act on mid-fight, short enough
// that a real-time action game never feels like it stalled waiting on a menu.
const BASE_CAPTURE_CHOICE_MS = 6000;

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

  // Mission cleared: present the #517 post-clear CHOICE (establish this base, or leave it and
  // move on) before banking currency and picking + starting the next objective within the SAME
  // already-built terrain (#111 — the map is never rebuilt mid-run). No squad spawn happens here
  // any more — enemies live only inside bases (see scenes/arena/bases.js), fully decoupled from
  // objective-clearing.
  _advanceObjective() {
    this._presentBaseCaptureChoice();
  },

  // #517: the post-clear choice — establish this base as an outpost/regional base, or leave it
  // uncaptured and move on. Same opt-in pattern as #512's repair outposts (not yet built — this
  // only lays the hook; `_establishBase` below is the entire "establish" side of it, with no
  // repair-outpost mechanics assumed). Skipped for a base that's ALREADY captured — world.js's
  // #518 wiring auto-clears an already-owned base the instant it's targeted (no docks, no
  // objective hex left to destroy), so there's nothing new to decide and re-prompting would be
  // asking the player to re-confirm a base they established sorties ago.
  _presentBaseCaptureChoice() {
    const base = (this.bases ?? [])[this._objectiveBaseIndex];
    if (!base || base.captured) { this._finishObjectiveAdvance(null); return; }
    this._pendingCaptureBase = base;
    this._captureChoiceActive = true;
    this.registry.set('baseCaptureChoice', { baseId: base.id });
    this._captureChoiceTimer = this.time.delayedCall(
      BASE_CAPTURE_CHOICE_MS, () => this._resolveBaseCaptureChoice(false),
    );
  },

  // #517: the player's answer. `establish` true means "yes, hold this base"; false covers both
  // an explicit decline and the choice window timing out unanswered — both read as "leave it and
  // move on". Guarded on `_captureChoiceActive` (not the registry flag — that's null both before a
  // choice starts and after it resolves, which can't tell "never started" from "already answered"
  // apart) against a double-resolve, since the timer callback and `_onInteractPressed` are the two
  // independent callers that can both fire.
  _resolveBaseCaptureChoice(establish) {
    if (!this._captureChoiceActive) return;
    this._captureChoiceActive = false;
    this._captureChoiceTimer?.remove(false);
    this._captureChoiceTimer = null;
    this.registry.set('baseCaptureChoice', null);
    const base = this._pendingCaptureBase;
    this._pendingCaptureBase = null;
    this._finishObjectiveAdvance(establish ? base : null);
  },

  // #517: the interact press (ArenaScene keydown-T / pad A — pad A was left explicitly reserved
  // for "a generic interact we may need", see Controls.js) is the ONLY thing that can turn a
  // pending choice into "establish". No-op when nothing is pending, so mashing the interact key
  // outside the choice window does nothing.
  _onInteractPressed() {
    if (this._captureChoiceActive) this._resolveBaseCaptureChoice(true);
  },

  // Bank the objective's currency and move on to the next base, having already decided (or
  // skipped deciding, for a base with nothing to decide) whether to establish `establishedBase`.
  // The one funnel every `_advanceObjective` path — choice accepted, choice declined/timed out,
  // no base to ask about, an already-captured base — ends at.
  _finishObjectiveAdvance(establishedBase) {
    if (establishedBase) this._establishBase(establishedBase);
    this.run = advanceObjective(this.run);
    this.registry.set('run', this.run);
    this._pickNextObjective();
  },

  // #517/#511/#512: the "establish" half of the choice — claims the base as an outpost (the same
  // claim-and-persist pipeline #511/#512 built; `type` still just alternates resource/repair by
  // base index, since neither type has real mechanics yet — #297's income/range-extension
  // formulas are still open design questions, unchanged by this issue) AND, if this biome has no
  // regional base yet, makes THIS the biome's regional base (data/regionalBases.js
  // `establishRegionalBase` — a no-op if one already exists, so a base established later in the
  // same biome really is just an ordinary outpost, per the issue's own framing).
  _establishBase(base) {
    const deployCount = this.registry.get('deployCount') || 0;
    const id = `outpost-${deployCount}-${base.id}`;
    const type = this._objectiveBaseIndex % 2 === 0 ? 'resource' : 'repair';
    const outposts = this.registry.get(OUTPOSTS_KEY) ?? [];
    const nextOutposts = claimOutpost(outposts, {
      id, type, coord: base.center, biomeId: this.biomeId, baseId: base.id,
    });
    if (nextOutposts !== outposts) {
      this.registry.set(OUTPOSTS_KEY, nextOutposts);
      saveOutposts(nextOutposts);
    }
    const regionalBases = this.registry.get(REGIONAL_BASES_KEY) ?? [];
    const nextRegional = establishRegionalBase(regionalBases, {
      biomeId: this.biomeId, baseId: base.id, coord: base.center,
    });
    if (nextRegional !== regionalBases) {
      this.registry.set(REGIONAL_BASES_KEY, nextRegional);
      saveRegionalBases(nextRegional);
    }
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
    // #423: commit this sortie's telemetry to history — a death or a win ALWAYS commits (and sets
    // the commit-once latch, so the RUN_OVER_DELAY timer's later toGarage() manual-commit no-ops).
    this._commitRunStats?.(status === 'dead' ? 'death' : 'win');

    const banked = (this.registry.get(RUN_CURRENCY_KEY) || 0) + this.run.currency;
    this.registry.set(RUN_CURRENCY_KEY, banked);
    saveRunCurrency(banked);
    this.registry.set('lastRunResult', { status: this.run.status, currency: this.run.currency });

    const won = this.run.status === 'won';
    const label = won ? 'RUN COMPLETE' : 'RUN OVER';
    const color = won ? '#7bd17b' : '#e2533a';
    this.registry.set('runOverBanner', { label, color, currency: this.run.currency });

    // #514: winning a run launched as a deep mission (MissionSelectScene's "DEEP STRIKE" offer)
    // unlocks the next biome. `deepMission` is set unconditionally by launchMission.js each
    // deploy, so a loss or an ordinary explore run never falsely credits one.
    if (won && this.registry.get('deepMission')) {
      const n = (this.registry.get(DEEP_MISSIONS_WON_KEY) || 0) + 1;
      this.registry.set(DEEP_MISSIONS_WON_KEY, n);
      saveDeepMissionsWon(n);
    }

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
