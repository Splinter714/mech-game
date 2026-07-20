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

// ── #356/#384: WHAT IT TAKES TO CLEAR A BASE ─────────────────────────────────────────────────
// Jackson, 2026-07-19: "the mission shouldn't be fully complete until all enemies are dead at the
// last objective; this might need more interim objectives of destroying all enemies and docks at
// each base before moving to the next base maybe?" — answered as BOTH: the run does not complete
// while enemies remain alive at the final objective, AND every base must be cleared of enemies and
// docks before progressing.
//
// The whole design problem here is #326: it removed every dock reinforcement cap, so a standing
// dock produces enemies FOREVER. "Kill every enemy at this base" is therefore not a requirement
// that can settle while a single dock still stands — a player handed a live kill count would watch
// it tick back up. So the enemy count is not shown — does not exist as a goal — until the last
// dock is down. Killing docks is what MAKES clearing possible, and the UI reflects that.
//
// #384 (Jackson, playtest 2026-07-20: "I want the first phase of marked objectives at each base to
// be the docks and the objective, not just the objective; mark all of those at once", and on kill
// order: "objective + docks any order, but gates still need objective") collapsed #356's first two
// ORDERED steps (objective, then docks) into ONE any-order phase. Two phases now:
//   1. `structures` — the objective hex AND every dock, destroyable in ANY order, all marked at
//      once from the start. Phase 1 is done only when the objective is down AND no dock stands.
//   2. `enemies`    — every structure is down, so the base's population is now FINITE and strictly
//      decreasing. Only now is a kill count shown, and only now can it reach zero.
// Then `clear`, which is the ONLY state that lets the objective advance to the next base (and,
// for every base at once, ends the run as a win).
//
// THE SPLIT THAT MUST NOT BE MERGED (#384): #355's gates-lock-open still latches on the OBJECTIVE
// hex dying ALONE, NOT on all of phase 1 — that latch is `isBaseObjectiveDestroyed`
// (scenes/arena/mission.js), a DIFFERENT predicate from "phase 1 complete" (which also needs the
// docks). Killing the objective while docks stand opens the gates but does not finish phase 1;
// killing a dock while the objective stands does neither. Do NOT repoint the gate latch here.
//
// Pure: the caller supplies `objectiveDestroyed` (scenes/arena/mission.js `isBaseObjectiveDestroyed`)
// and an `isDockStanding` predicate, because "is this hex still standing" is a `buildingHp`
// question the scene owns. A dock hex collapses out of `buildingHp` the instant it dies, exactly
// like the objective hex — so both halves read from the same one-way world fact and no new
// bookkeeping is introduced.
export const CLEAR_STRUCTURES = 'structures';
export const CLEAR_ENEMIES = 'enemies';
export const CLEAR_DONE = 'clear';

export function baseClearState(base, { objectiveDestroyed = false, isDockStanding = () => false, enemies = [] } = {}) {
  // No base at all reads as cleared — nothing left to wait on, same convention as
  // `isBaseCleared`/`isBaseObjectiveDestroyed` (guards the run's "index ran past the last base"
  // and pre-`_buildWorld` cases).
  if (!base) return { step: CLEAR_DONE, objectiveStanding: false, docksLeft: 0, structuresLeft: 0, enemiesLeft: 0, cleared: true };
  const objectiveStanding = !objectiveDestroyed;
  const docksLeft = (base.docks ?? []).filter((d) => isDockStanding(d)).length;
  const enemiesLeft = (enemies ?? []).filter((e) => e.baseId === base.id).length;
  // Phase 1's remaining tally: the objective (0 or 1) plus every standing dock, in ANY order.
  const structuresLeft = (objectiveStanding ? 1 : 0) + docksLeft;
  const step = structuresLeft > 0 ? CLEAR_STRUCTURES
    : enemiesLeft > 0 ? CLEAR_ENEMIES
      : CLEAR_DONE;
  return { step, objectiveStanding, docksLeft, structuresLeft, enemiesLeft, cleared: step === CLEAR_DONE };
}

// The player-facing line for a clear state. Lives here, next to the rule it describes, so the HUD
// stays a renderer and the "never show a kill count while a structure stands" guarantee is enforced
// by the same code that decides the step rather than by a second, drift-prone copy in the HUD.
//
// Phase 1 names exactly what is still standing (objective and/or N docks) so an any-order sweep
// reads right whichever piece the player takes first — and, per #356's discipline, never shows a
// garrison count while any structure remains.
export function baseClearLabel(state) {
  switch (state?.step) {
    case CLEAR_STRUCTURES: {
      const parts = [];
      if (state.objectiveStanding) parts.push('OBJECTIVE');
      if (state.docksLeft > 0) parts.push(`${state.docksLeft} DOCK${state.docksLeft === 1 ? '' : 'S'}`);
      return `DESTROY THE BASE  (${parts.join(' + ')})`;
    }
    case CLEAR_ENEMIES: return `ELIMINATE THE GARRISON  (${state.enemiesLeft} LEFT)`;
    default: return 'BASE CLEAR';
  }
}

// ── #371/#384: WHAT THE OBJECTIVE INDICATOR POINTS AT RIGHT NOW ───────────────────────────────
// Jackson, playtest 2026-07-20: "the actual objective indicator should spread to all items that
// need to be destroyed after the standard 'objective' is destroyed; a little objective hex on all
// remaining enemies, and building-sized ones on the docks" — then, same day (#384): "mark all of
// those at once", the objective and the docks together from the start, destroyable in any order.
//
// The whole point is that this must never disagree with the HUD line. So it is not a parallel
// rule: it is a projection of the SAME `baseClearState` result that `baseClearLabel` renders.
// One PHASE is surfaced at a time, and the enemy set is deliberately empty while any structure
// (objective or dock) stands — the same discipline that keeps a kill count off the HUD until the
// last structure is down (a base with 7 live enemies and a standing dock marks the DOCK, never
// the 7).
//
// Phase 1 marks the objective AND every standing dock at once. `showObjective` follows the
// objective's OWN state (`objectiveStanding`), not the whole phase — so once the objective hex
// falls its big beacon drops even while docks are still being marked, and the docks keep their
// building markers until the last one is gone. This is the same any-order composition as the HUD
// label: whichever piece the player takes first, the markers track exactly what still stands.
//
// Late spawns are marked, by construction: the sets are derived fresh from the live `enemies`
// array every call rather than snapshotted when marking begins, so a dock's last wave or a
// carrier's (#328) endless drones all pick up markers as they appear. The enemy set can GROW
// during the `enemies` step and that is intended — an unmarked straggler is the failure mode this
// whole issue exists to prevent, so there is no cap.
//
// `size` names the coarse visual weight for the phase (the scene draws the objective beacon and
// the building/small markers itself; this is descriptive, kept out of the renderer's decisions):
//   'structures' — objective beacon + dock-sized markers (phase 1)
//   'small'       — a little hex per enemy (phase 2)
export const MARK_STRUCTURES = 'structures';
export const MARK_SMALL = 'small';

export function baseMarkTargets(state, base, { isDockStanding = () => false, enemies = [] } = {}) {
  switch (state?.step) {
    case CLEAR_STRUCTURES:
      // Objective beacon shown iff the objective itself still stands; building markers on every
      // standing dock. Both at once — any order.
      return {
        size: MARK_STRUCTURES,
        showObjective: state.objectiveStanding !== false,
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

// #371 playtest follow-up ("small objective hexes are not on the right position for the wall
// turrets"): how far ABOVE a marked enemy its little hex floats.
//
// The 26px lift was calibrated for units that sit in a HEX — a tank, a drone, a mech, all of them
// centred on open ground with room overhead, where floating the hex clear of the sprite keeps it
// off the #370 shield outline. A wall gun is not that unit. #310 mounts it with
// TURRET_MOUNT_OFFSET_PX = 0, i.e. its view container is anchored EXACTLY on the span midpoint,
// dead centre of the 14px wall band (and #337 v3 draws it, with its wall, on DEPTH.WALLS). It is
// also the smallest unit on the field — `scale: 0.34` against the sentry's 0.42 precisely so it
// doesn't swamp the line it rides.
//
// So a screen-up lift is wrong for it twice over. It floats ~19px of empty space above a ~13px
// sprite, and — because the lift is screen-up while a span can run at any of six orientations —
// it slides OFF the wall line onto whichever neighbouring hex happens to be upward, reading as a
// marker on the hex beside the gun rather than on the gun. Zero lift puts the 6px hex centred on
// the mount, sitting neatly within the 14px band, matching the anchor the view actually uses.
//
// Keyed on `spanKey` (bases.js `_spawnWallTurrets`) because that IS the "I am emplaced on a wall
// span" fact — it is set for exactly the wall guns and nothing else, and it is deliberately
// separate from `dockKey` so it can never be confused with a hex-keyed unit.
export const ENEMY_MARK_LIFT = 26;

export function enemyMarkLift(enemy) {
  return enemy?.spanKey != null ? 0 : ENEMY_MARK_LIFT;
}
