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
// slowest "fast" kind (drone, 150) — turret (0) and tank (52) and quadruped (38) all read as
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
