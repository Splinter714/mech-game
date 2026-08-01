// Mission model — pure objective + win/lose logic, no Phaser. A Mission is a data-configured
// objective the arena evaluates each frame against a small state snapshot. Adding a mission
// type = one entry in MISSION_TYPES (mirrors the weapon/chassis data-driven convention); the
// arena decides how to fill the state snapshot each type reads.
import { CLEAR_STRUCTURES, CLEAR_ENEMIES } from './bases.js';

export const MISSION_TYPES = {
  // #66: originally "destroy a designated enemy outpost hex." #269 playtest follow-up
  // (objective sequencing) repointed this at bases instead — the arena now feeds
  // `objectiveDestroyed` from "is the current target base cleared" (every enemy tagged with its
  // baseId dead, data/bases.js `isBaseCleared`) rather than from a single hex leaving
  // `buildingHp`. The model itself doesn't care what "the objective" concretely is — it just
  // reads one boolean flag — so no field rename was needed to make this switch.
  assault: {
    id: 'assault',
    name: 'Assault',
    objective: 'Clear the enemy base',
    // Won the moment the current objective base is cleared.
    isComplete: (s) => !!s.objectiveDestroyed,
  },
  // Future entries (each is one object here + the arena filling its state fields):
  //   elimination — all enemies dead:            isComplete: (s) => s.enemiesTotal > 0 && s.enemiesAlive === 0
  //   survival    — hold for a timer / N waves:  isComplete: (s) => s.elapsed >= s.holdFor
  //   escort/extraction — reach/protect a point.
};

export const DEFAULT_MISSION = 'assault';

export function makeMission(typeId = DEFAULT_MISSION) {
  const type = MISSION_TYPES[typeId];
  if (!type) throw new Error(`unknown mission type: ${typeId}`);
  return { typeId, name: type.name, objective: type.objective, status: 'active' };
}

// Pure transition: given a mission and a state snapshot, return the resulting status
// ('active' | 'complete' | 'failed'). A terminal status is sticky (never re-opens).
//
// Objective-only for now (#66): the model DOES fail a mission on player death, but the arena
// doesn't feed a real death yet — the deploy survivability buffer keeps the player alive, and
// tuning that (so 'failed' can actually fire) is deferred to the run loop (#64).
export function evaluateMission(mission, state = {}) {
  if (mission.status !== 'active') return mission.status;
  if (state.playerDead) return 'failed';
  const type = MISSION_TYPES[mission.typeId];
  if (type && type.isComplete(state)) return 'complete';
  return 'active';
}

// ── #605: NAMED MISSION PHASES ────────────────────────────────────────────────────────────────
// The objective readout already names the current TARGET ("DESTROY 3 STRUCTURES", data/bases.js
// `baseClearLabel`) but never the STAGE — a player reading it knows what to shoot and not where
// they are in the sortie. This adds the stage, as a name.
//
// Deliberately NOT a parallel state machine (the issue is explicit about this): a phase is a pure
// PROJECTION of state the arena already tracks — the base's `baseClearState` step, whether the
// base has woken (`_wokenBases`, scenes/arena/bases.js), and the objective's position in the
// base sequence (`_objectiveBaseIndex` / `this.bases.length`). Nothing here can drift out of
// agreement with the requirement line, because both are rendered from the same `clear` result.
//
// Why these four:
//   APPROACH — the base has not woken, so the player is still driving on an unalerted compound.
//              This is a real, distinctly-played stage (the dormant-base approach is the whole
//              point of #269's wake system) and it is the one the old readout hid completely:
//              it showed a destroy-list for a fight that had not started.
//   ASSAULT  — engaged, structures still standing. The objective hex and every dock, any order
//              (#384). An OPEN dock still counts as standing (it is only mid-cycle, not rubble —
//              see `baseClearStateOf`), so this phase does not end just because doors parted.
//   SWEEP    — every structure is down, so the garrison is finite and strictly decreasing. EVERY
//              enemy tagged to the base holds this phase open, emplaced turrets included: the
//              #391 "can't chase you, doesn't count" exemption was REVERSED in live playtest on
//              2026-07-29, because a base you are about to own should not still have a live gun
//              in it. The name has to promise a full sweep, not a chase.
//   SECURED  — the base is clear. The mission advances to the next base from here (run.js
//              `_pickNextObjective`), or the run ends as a win when there is no next base.
//
// The post-clear outpost-build decision is NOT a phase here — that is #473's retained half and
// waits on #512, so SECURED deliberately says nothing about what you may build on the wreckage.
export const PHASE_APPROACH = 'approach';
export const PHASE_ASSAULT = 'assault';
export const PHASE_SWEEP = 'sweep';
export const PHASE_SECURED = 'secured';

const PHASE_NAMES = {
  [PHASE_APPROACH]: 'APPROACH',
  [PHASE_ASSAULT]: 'ASSAULT',
  [PHASE_SWEEP]: 'SWEEP',
  [PHASE_SECURED]: 'SECURED',
};

// `clear` is a data/bases.js `baseClearState` result; `awake` is "has this base woken" (the arena
// passes `_wokenBases.has(base.id)`); `baseNumber`/`baseCount` place it in the sequence.
//
// `awake` is checked LAST, not first: a player who picks a structure apart from outside detection
// range has genuinely not been noticed yet, and calling that APPROACH is honest — but a base whose
// structures are already all down is past approaching by any reading, so the step wins the tie.
export function missionPhase({ clear, awake = false, baseNumber = 0, baseCount = 0 } = {}) {
  const step = clear?.step;
  let id = PHASE_SECURED;
  if (step === CLEAR_ENEMIES) id = PHASE_SWEEP;
  else if (step === CLEAR_STRUCTURES) id = awake ? PHASE_ASSAULT : PHASE_APPROACH;
  return { id, name: PHASE_NAMES[id], baseNumber, baseCount };
}

// The player-facing stage line, rendered above the requirement line. Kept next to the rule (same
// reason `baseClearLabel` lives next to `baseClearState`) so the HUD stays a renderer.
// `BASE 2/5` is the sequence position — bases are cleared strictly in index order, so this is a
// real progress readout and not just an id. Falls back to the bare phase name if the caller has
// no sequence to report (a base count of 0 only happens pre-worldgen).
export function missionPhaseLabel(phase) {
  if (!phase) return '';
  const seq = phase.baseCount > 0 ? `BASE ${phase.baseNumber}/${phase.baseCount} — ` : '';
  return `${seq}${phase.name ?? ''}`;
}
