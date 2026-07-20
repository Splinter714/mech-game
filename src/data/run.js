// Run model (#64, reworked #269) — pure roguelite run-loop state, no Phaser.
//
// #269 (issue: base population rework) RETIRES the old fixed 5-stage squad-draw system
// entirely: `squadForStage`/`EARLY_POOL`/`LATE_POOL`/`STAGE_COUNT`/
// `SQUAD_BASE`/`SQUAD_GROWTH`/`lateFraction`/`stageDescriptor`/`advanceStage` are all GONE.
// (#344: enemies.js's `DEFAULT_SQUAD` and its `_spawnSquad()` consumer outlived this note as a
// genuinely dead path — exported and wired as a default arg, but never called. Both now deleted,
// so this paragraph's list is finally true of everything it names.)
// Enemies are no longer squad-dropped off-camera near the player on mission-complete — they're
// placed once, at world-gen time, dormant, inside real bases (data/worldgen.js `placeBases`),
// woken by an alert tower's countdown (data/alertTower.js, scenes/arena/bases.js). There is no
// more "next stage" event to sequence at all.
//
// What a run now IS, kept deliberately simple per the issue's own framing ("keep it SIMPLE...
// rather than over-engineering a new progression system nobody asked for yet"): the player
// clears standing outpost objectives (data/mission.js, unchanged — "destroy this outpost" still
// works exactly as before, just fully decoupled from enemy spawning) one after another for
// currency, while separately working toward the real win condition — every base's objective hex
// destroyed (#269 playtest follow-up — scenes/arena/bases.js `_allObjectivesDestroyed`) — or the
// run ends on player death. A real multi-objective/base-gated progression curve (base walls, forced order,
// etc.) is out of scope here — see issue #269 section 4, explicitly deferred.

// Currency awarded per objective cleared, scaling up with how many have already been cleared
// this run (a flat base plus a per-objective bonus, same simple curve the old per-stage payout
// used) so a longer run keeps paying out more as it goes.
export const CURRENCY_BASE = 50;
export const CURRENCY_PER_OBJECTIVE = 25;

export function currencyForObjective(objectivesCleared) {
  return CURRENCY_BASE + CURRENCY_PER_OBJECTIVE * objectivesCleared;
}

// ── Run lifecycle ────────────────────────────────────────────────────────────────────────
// A fresh run: no objectives cleared yet, no currency banked, active.
export function makeRun() {
  return { objectivesCleared: 0, currency: 0, status: 'active' };
}

// Pure transition: an objective was destroyed — bank its currency and count it. No-ops (returns
// the run unchanged) if the run isn't active (sticky terminal status, mirrors mission.js). Never
// ends the run by itself — winning is a separate signal (`winRun`, driven by "every base's
// objective hex destroyed" — scenes/arena/bases.js `_allObjectivesDestroyed`), since objective-
// clearing and base-clearing are now two independent tracks (mission objectives were always
// separate from enemy squads even before #269; that separation just becomes explicit now that
// there's no more "clear the stage" event to conflate them under).
export function advanceObjective(run) {
  if (run.status !== 'active') return run;
  const earned = currencyForObjective(run.objectivesCleared);
  return { ...run, currency: run.currency + earned, objectivesCleared: run.objectivesCleared + 1 };
}

// Pure transition: every base's docked units are destroyed — the run is WON. Sticky/no-op once
// terminal.
export function winRun(run) {
  if (run.status !== 'active') return run;
  return { ...run, status: 'won' };
}

// Pure transition: the player died — end the run as a loss. Sticky/no-op once terminal.
export function endRunOnDeath(run) {
  if (run.status !== 'active') return run;
  return { ...run, status: 'dead' };
}

export function isRunOver(run) {
  return run.status === 'won' || run.status === 'dead';
}
