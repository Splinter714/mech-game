// #269 §6/§7 (issue: base population rework) — pure helpers for WAKE ROUTING: which of a base's
// docked units sortie out vs. hold ground once it wakes, and when is a base considered cleared?
// No Phaser here (mirrors data/awareness.js, data/alertTower.js) — scenes/arena/bases.js is the
// thin scene-side wiring that calls these with real world positions/enemy records.
//
// #284: WHICH base a completed alert-tower countdown wakes used to be resolved here too
// (`nearestBaseTo`, pure straight-line distance from the tower's position to each base's centre)
// but that could disagree with a tower's actual gap ownership on a curving spine — removed once
// `placeGapTowers` (data/worldgen.js) started threading each tower's own linked `baseId` straight
// through to the scene-side wake trigger (`scenes/arena/bases.js` `_triggerAlert`), which no
// longer needs to re-derive it geometrically at all.

// #7: fast/mobile kinds sortie toward the player the instant their base wakes; slow/defensive
// kinds hold their dock position and just become combat-active there. A single maxSpeed
// threshold (rather than a per-kind flag) keeps this data-driven off the SAME `move.maxSpeed`
// every kind already carries (enemyKinds.js) — no new per-kind field needed, per the issue's own
// suggestion. 100 px/s sits cleanly between the fastest "slow" kind (infantry, 48) and the
// slowest "fast" kind (drone, 150) — turret (0) and tank (52) and carrier (38) all read as
// heavy/rooted; drone (150) and helicopter (210) both clearly read as light/mobile. Owner:
// tunable if a future kind's speed lands awkwardly close to this line.
export const FAST_WAKE_SPEED_THRESHOLD = 100;

export function isFastWakeKind(kindDef, threshold = FAST_WAKE_SPEED_THRESHOLD) {
  return (kindDef?.move?.maxSpeed ?? 0) >= threshold;
}

// #269 playtest follow-up (objective sequencing): a base is "cleared" once every enemy tagged
// with its `baseId` (dormant or awakened, doesn't matter — same rule `_allBasesCleared` uses run-
// wide) is dead. Dead enemies are pruned out of the live `enemies` array the same tick they die
// (#87 `_removeEnemy`), so "no enemy left with this baseId" is already the right check, no
// separate per-base HP bookkeeping needed. `baseId == null` (no base at all, or a bad id) reads
// as cleared — nothing left to wait on. Mirrors `_allBasesCleared` in scenes/arena/bases.js but
// scoped to ONE base instead of every base, so the mission objective can sequence through bases
// one at a time (see scenes/arena/mission.js `_targetCurrentBase`).
export function isBaseCleared(baseId, enemies) {
  if (baseId == null) return true;
  if (!enemies || !enemies.length) return true;
  return !enemies.some((e) => e.baseId === baseId);
}

// ── #356: WHAT IT TAKES TO CLEAR A BASE ──────────────────────────────────────────────────────
// Jackson, 2026-07-19: "the mission shouldn't be fully complete until all enemies are dead at the
// last objective; this might need more interim objectives of destroying all enemies and docks at
// each base before moving to the next base maybe?" — answered as BOTH: the run does not complete
// while enemies remain alive at the final objective, AND every base must be cleared of enemies and
// docks before progressing.
//
// The whole design problem here is #326: it removed every dock reinforcement cap, so a standing
// dock produces enemies FOREVER. "Kill every enemy at this base" is therefore not a requirement
// that can settle while a single dock still stands — a player handed a live kill count would watch
// it tick back up. So the requirement is ORDERED, and the order is the point: the player is only
// ever shown ONE step at a time, and the enemy count is not shown — does not exist as a goal —
// until the last dock is down. Killing docks is what MAKES clearing possible, and the UI says so
// in that order rather than presenting an unachievable tally up front.
//
// The three steps, in the order they're surfaced:
//   1. `objective` — the base's objective hex still stands. Unchanged from the old rule; this is
//      still what the marker points at and what latches the base's gates open (#355).
//   2. `docks`     — the objective is down but N docks still stand. Kill the docks. Reinforcement
//      is still flowing; that's fine, because the player isn't being asked to out-kill it yet.
//   3. `enemies`   — every dock is down, so the base's population is now FINITE and strictly
//      decreasing. Only now is a kill count shown, and only now can it reach zero.
// Then `clear`, which is the ONLY state that lets the objective advance to the next base (and,
// for every base at once, ends the run as a win).
//
// Pure: the caller supplies `objectiveDestroyed` (scenes/arena/mission.js `isBaseObjectiveDestroyed`)
// and an `isDockStanding` predicate, because "is this hex still standing" is a `buildingHp`
// question the scene owns. A dock hex collapses out of `buildingHp` the instant it dies, exactly
// like the objective hex — so both halves read from the same one-way world fact and no new
// bookkeeping is introduced.
export const CLEAR_OBJECTIVE = 'objective';
export const CLEAR_DOCKS = 'docks';
export const CLEAR_ENEMIES = 'enemies';
export const CLEAR_DONE = 'clear';

export function baseClearState(base, { objectiveDestroyed = false, isDockStanding = () => false, enemies = [] } = {}) {
  // No base at all reads as cleared — nothing left to wait on, same convention as
  // `isBaseCleared`/`isBaseObjectiveDestroyed` (guards the run's "index ran past the last base"
  // and pre-`_buildWorld` cases).
  if (!base) return { step: CLEAR_DONE, docksLeft: 0, enemiesLeft: 0, cleared: true };
  const docksLeft = (base.docks ?? []).filter((d) => isDockStanding(d)).length;
  const enemiesLeft = (enemies ?? []).filter((e) => e.baseId === base.id).length;
  const step = !objectiveDestroyed ? CLEAR_OBJECTIVE
    : docksLeft > 0 ? CLEAR_DOCKS
      : enemiesLeft > 0 ? CLEAR_ENEMIES
        : CLEAR_DONE;
  return { step, docksLeft, enemiesLeft, cleared: step === CLEAR_DONE };
}

// The player-facing line for a clear state. Lives here, next to the rule it describes, so the HUD
// stays a renderer and the "never show a kill count while docks stand" guarantee is enforced by
// the same code that decides the step rather than by a second, drift-prone copy in the HUD.
export function baseClearLabel(state) {
  switch (state?.step) {
    case CLEAR_OBJECTIVE: return 'DESTROY THE OBJECTIVE';
    case CLEAR_DOCKS: return `DESTROY THE DOCKS  (${state.docksLeft} LEFT)`;
    case CLEAR_ENEMIES: return `ELIMINATE THE GARRISON  (${state.enemiesLeft} LEFT)`;
    default: return 'BASE CLEAR';
  }
}

// ── #371: WHAT THE OBJECTIVE INDICATOR POINTS AT RIGHT NOW ────────────────────────────────────
// Jackson, playtest 2026-07-20: "the actual objective indicator should spread to all items that
// need to be destroyed after the standard 'objective' is destroyed; a little objective hex on all
// remaining enemies, and building-sized ones on the docks".
//
// The whole point is that this must never disagree with the HUD line. So it is not a parallel
// rule: it is a projection of the SAME `baseClearState` result that `baseClearLabel` renders.
// One step is surfaced at a time, in #356's order, and the enemy set is deliberately empty while
// any dock stands — the same discipline that keeps a kill count off the HUD until the last dock
// is down (a base with 7 live enemies and a standing dock marks the DOCKS, never the 7).
//
// Late spawns are marked, by construction: the sets are derived fresh from the live `enemies`
// array every call rather than snapshotted when marking begins, so a dock's last wave or a
// carrier's (#328) endless drones all pick up markers as they appear. The enemy set can GROW
// during the `enemies` step and that is intended — an unmarked straggler is the failure mode this
// whole issue exists to prevent, so there is no cap.
//
// `size` names the visual weight the scene should draw, keeping that decision out of the renderer:
//   'objective' — the single hex marker, unchanged (step 1)
//   'building'  — dock-sized markers (step 2)
//   'small'     — a little hex per enemy (step 3)
export const MARK_OBJECTIVE = 'objective';
export const MARK_BUILDING = 'building';
export const MARK_SMALL = 'small';

export function baseMarkTargets(state, base, { isDockStanding = () => false, enemies = [] } = {}) {
  switch (state?.step) {
    case CLEAR_OBJECTIVE:
      // The objective hex itself is still the one and only marker; the scene already owns it.
      return { size: MARK_OBJECTIVE, showObjective: true, docks: [], enemies: [] };
    case CLEAR_DOCKS:
      return {
        size: MARK_BUILDING,
        showObjective: false,
        docks: (base?.docks ?? []).filter((d) => isDockStanding(d)),
        enemies: [],
      };
    case CLEAR_ENEMIES:
      return {
        size: MARK_SMALL,
        showObjective: false,
        docks: [],
        enemies: (enemies ?? []).filter((e) => e.baseId === base?.id),
      };
    default:
      // Cleared (or no base): nothing is required, so nothing is marked. The scene keeps its own
      // "CLEARED" treatment of the original marker — that is a win banner, not a requirement.
      return { size: null, showObjective: true, docks: [], enemies: [] };
  }
}
