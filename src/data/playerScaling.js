import { isEnemyKind } from './enemyKinds.js';

// #350 — CO-OP DIFFICULTY: how much MORE the world fields per additional player.
//
// Jackson (2026-07-19) chose the lever: co-op should be HARDER than solo, and the lever is enemy
// COUNT. Explicitly NOT tougher enemies (spongier fights read as worse, not harder) and NOT faster
// dock reinforcement (#326 already removed every dock cap, so docks produce forever — compounding
// that risks a spiral).
//
// Jackson (2026-07-20) set the number: "Double enemies should be good for coop." So the factor is
// 2x at two players. That is expressed here as a PER-PLAYER factor rather than a two-player
// boolean, because #348 capped play at two only for now and was built to allow more later
// (data/players.js `MAX_PLAYERS`). The straight-line reading of "2x at two" is one extra world's
// worth of enemies per extra player:
//
//     1 player  -> 1x   (solo is EXACTLY unchanged — the whole point of the identity below)
//     2 players -> 2x
//     3 players -> 3x   (untested, but it is what the rule says; a curve can replace this
//                        function's body without touching a single call site)
//
// THE PLAYTEST DIAL IS THIS FUNCTION. Everything else in the file is plumbing around it.
//
// Deliberately NOT compensating for run length. Jackson drew that line himself: player-count
// scaling and run length are separate axes, and if runs feel long he will tune that globally for
// every player count at once. So nothing here shortens a run to offset the extra bodies, and
// nothing here reacts to #356's per-base clearing requirement.
// FRAME COST — the flag, not a measurement rig. Counted analytically over 40 seeded worlds
// (`placeBases` dock counts + `TOWER_PATROL_TIERS` sizes) at the time this landed:
//   worst single base   35 dormant bodies solo  ->  70 at two players
//   whole world        ~97 dormant bodies solo  -> ~194 at two players
//   largest patrol      11 solo                 ->  22 at two players
// #326 measured a peak of ~109 LIVE entities in a long fight; two-player co-op roughly doubles
// both the standing population and any fight's live count. #321/#340 established the game is
// sensitive to entity counts and draw work, so if co-op drops frames, this factor is the first
// dial to turn — nothing about the rule below assumes it stays at a straight 2x.
//
// WHAT IS SCALED (all three in scenes/arena/bases.js, all read from the LIVE player roster at the
// moment of spawning rather than baked in at world-gen time):
//   * tower PATROLS      — #357's `towerPatrolComposition` list, repeated per player.
//   * base GARRISONS     — each dock's body count (worldgen.js `dockCountFor`).
//   * dock SWARM sizes   — same seam: a swarm dock's count IS `DOCK_SWARM_COUNT`, so it scales
//                          with the garrison and needs no separate rule.
//   * dock RESUPPLY waves— wave SIZE only, so a doubled base does not thin back to solo strength
//                          over a long fight. The resupply CADENCE is untouched on purpose.
//
// WHAT IS DELIBERATELY NOT SCALED:
//   * Enemy HP/armour/damage — the rejected "tougher enemies" lever.
//   * Dock resupply cadence — the rejected "faster reinforcement" lever (#326 removed all caps).
//   * The NUMBER of docks, wall turrets, gates, bases or alert towers. These are STRUCTURES, not
//     bodies: their counts come out of wall-span and corridor geometry (worldgen.js `assignGates`
//     / `assignWallTurrets` / `placeBases`), and since #356 every dock is itself a required kill
//     for base clearing. Doubling them would double the number of OBJECTIVES rather than the
//     number of enemies, which is a run-length change — the axis Jackson explicitly separated
//     from this one.
//   * Powerup drops, friendly fire, and shared buffs. Both were confirmed intended as-is and
//     already push in the opposite direction; counting them here would double-count them.
export function enemyCountFactor(playerCount) {
  const n = Math.max(1, Math.floor(playerCount) || 1);
  return n;
}

// Scale a SPAWN COUNT (how many bodies come out of one dock, one wave, one cluster).
//
// `Math.round` rather than floor/ceil so a non-integer factor — if the dial above ever becomes a
// curve like `1 + 0.75 * (n - 1)` — lands on the nearest whole body instead of systematically
// shaving one off. The `max(1, ...)` floor means scaling can never ERASE a population; a dock that
// fields one tank solo still fields at least one tank at any player count.
//
// At playerCount 1 this is the exact identity `count`, which is what keeps solo bit-identical.
export function scaleEnemyCount(count, playerCount) {
  const c = Math.max(0, Math.floor(count) || 0);
  if (c === 0) return 0;
  return Math.max(1, Math.round(c * enemyCountFactor(playerCount)));
}

// Scale ONE DOCK'S wave size — the garrison or resupply burst a single dock emits in one event.
//
// #389 (owner: "They can resupply whenever, but not two mechs at a time from one dock resupply"):
// a large/heavy MECH dock is a SINGLE-body dock (`dockCountFor` returns 1 for every mech loadout),
// so the straight `scaleEnemyCount` above would field TWO mechs at once at two players — which is
// exactly the doubled-up spawn the owner saw and rejected. Co-op difficulty for a mech dock is
// meant to come from resupplying MORE OFTEN over the fight (its wave CADENCE is already the shared
// lever, and #326 removed every dock cap), never from two heavy mechs erupting from one hex in a
// single event. So a mech dock's wave is PINNED to one body regardless of player count.
//
// SWARM docks (drone / infantry — `isEnemyKind` is true for both) are deliberately untouched: a
// `DOCK_SWARM_COUNT` burst of 3-HP bodies IS the intended set-piece and doubling it to a bigger
// cloud is the whole point of the count lever. Non-mech single-body vehicle docks (tank, helicopter,
// carrier) also keep the ordinary scaling — the owner's decision is specifically about MECHS.
//
// A dock's kind is a MECH loadout exactly when it is NOT a non-mech `ENEMY_KINDS` id — the same
// `isEnemyKind` split `spawnDockCluster` uses to route between `_spawnMech` and `_spawnKind`.
//
// At playerCount 1 this is `scaleEnemyCount`'s identity for every kind, so solo stays bit-identical.
export function scaleDockWave(kindId, count, playerCount) {
  const scaled = scaleEnemyCount(count, playerCount);
  if (!isEnemyKind(kindId)) return Math.min(1, scaled);   // #389: a mech dock never emits two at once
  return scaled;
}

// Scale a COMPOSITION — a flat list of type ids, like #357's `towerPatrolComposition`.
//
// The list is REPEATED whole rather than having some entries duplicated and others not, so the
// MIX is preserved exactly: a tier that is "4 infantry, 2 tanks, 3 drones" becomes "8 infantry,
// 4 tanks, 6 drones" at two players, not a patrol that has drifted toward whichever kind the
// rounding favoured. Keeping the ratio intact matters because #357's tiers ARE the escalation
// curve — co-op should face a bigger version of the same patrol, not a differently-shaped one.
//
// Returns a fresh array (the callers' tier tables are shared constants). At playerCount 1 this is
// a plain copy of the input — solo composition unchanged, including order.
export function scaleComposition(list, playerCount) {
  const src = Array.isArray(list) ? list : [];
  const reps = enemyCountFactor(playerCount);
  const out = [];
  for (let i = 0; i < reps; i++) out.push(...src);
  return out;
}
