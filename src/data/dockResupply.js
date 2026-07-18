// #269 §3 "rare multi-spawn exception" (playtest follow-up, issue: base population rework) —
// pure state machine for a DOCK occasionally producing ONE MORE unit after its originally-
// assigned unit(s) are all destroyed. Mirrors data/alertTower.js's shape (a small pure tick
// function + tunable constants, no Phaser) — scenes/arena/bases.js is the thin scene-side
// wiring that calls this with real per-frame eligibility (is the dock actually cleared right
// now? is its base awake?) and plays the doors-open/rise/doors-close FX + spawns the unit when
// a tick reports `ready: true`.
//
// Explicitly scoped to DOCK hexes only (never `turretEmplacement` — a stationary turret
// refilling itself doesn't fit "reinforcements rolling out of a bay").

// Cooldown once a dock becomes eligible (cleared + base awake) before it resupplies. #269
// playtest follow-up: the original 45s "rare exception" cadence read as a one-off surprise
// rather than something felt during an assault — Jackson explicitly asked for resupply to
// feel "more frequent/present during a base assault, not a rare one-off." 18s: still long
// enough that clearing a dock and immediately re-engaging its base doesn't feel like an
// instant respawn in your face, but short enough that a multi-dock base fight (which
// realistically runs well past 18s once you're fighting through several docks + a turret)
// will plausibly see a dock reopen and cycle a fresh unit more than once. Paired with the
// higher `DOCK_RESUPPLY_MAX_PER_DOCK` below so the faster cadence isn't wasted hitting a cap
// of 1. Owner: tunable via playtest.
export const DOCK_RESUPPLY_COOLDOWN_MS = 18000;

// How many extra units a single dock can ever produce over its lifetime, beyond its original
// assignment. #269 playtest follow-up: with the cooldown above cut roughly in half, keeping
// this at 1 would still cap the whole mechanic at exactly one bonus unit ever — the shorter
// cooldown would never actually matter beyond the first reopen. Raised to 3 so a dock that
// stays contested (player keeps clearing it, base stays awake) can meaningfully escalate
// across a sustained assault instead of going quiet after a single extra unit. Not raised
// further: a dock is also destructible once closed (see `spendDockResupply` below) and gets
// permanently retired if destroyed mid-cycle, so in practice most docks won't ever reach a
// high cap anyway — 3 gives "escalating" room without turning an uncontested dock into an
// infinite farm spot. Owner: tunable via playtest (issue explicitly allows 1-2, judgement
// call to go slightly above that given the cooldown change).
export const DOCK_RESUPPLY_MAX_PER_DOCK = 3;

// Fresh per-dock resupply state: full cooldown remaining, no resupplies spent yet.
export function makeDockResupplyState(cooldownMs = DOCK_RESUPPLY_COOLDOWN_MS) {
  return { remainingMs: cooldownMs, count: 0 };
}

// Advance one tick for a single dock. `eligible` — is this dock BOTH cleared (every unit ever
// spawned from it, original assignment or a prior resupply, is dead) AND does it belong to an
// AWAKE base right now (§2 of the mechanic: a dormant/never-triggered base's cleared dock must
// NOT resupply). The cooldown only counts down while `eligible` is true — clearing the dock
// starts the clock, but the clock doesn't run (or leak progress) before that. Once `count` hits
// `maxPerDock`, every further tick is a no-op forever (`ready` stays false) — the dock is spent.
// Pure: always returns a NEW state object, never mutates `state`.
export function tickDockResupply(
  state, { eligible, dt }, cooldownMs = DOCK_RESUPPLY_COOLDOWN_MS, maxPerDock = DOCK_RESUPPLY_MAX_PER_DOCK,
) {
  // Spent — strip any stale `ready` from the tick that just fired (this is the very next call
  // after that one) so the caller never re-reads `ready: true` a second time and double-spawns.
  if (state.count >= maxPerDock) return { remainingMs: state.remainingMs, count: state.count };
  if (!eligible) {
    // Not currently eligible (still has a live unit, or its base hasn't woken) — hold at full
    // cooldown rather than ticking or draining; the countdown only ever runs while cleared+awake.
    if (!state.remainingMs || state.remainingMs === cooldownMs) return state;
    return { remainingMs: cooldownMs, count: state.count };
  }
  const remainingMs = Math.max(0, state.remainingMs - Math.max(0, dt) * 1000);
  if (remainingMs <= 0) return { remainingMs: cooldownMs, count: state.count + 1, ready: true };
  return { remainingMs, count: state.count };
}

// #269 Part 2 ("dock open/closed states"): a CLOSED dock is destructible — destroying it must
// permanently retire its ability to ever resupply again, even if it hadn't reached
// `maxPerDock` yet (a real tactical choice: blow the dome open before it can pop out
// reinforcements). Scenes/arena/bases.js hooks this into world.js's generic destructible-
// terrain collapse path (`_damageBuildingAt` → `_onTerrainCollapsed`) rather than adding
// dock-specific destruction handling there. Pure: forces `count` to `maxPerDock` so every future
// `tickDockResupply` call hits the already-spent early return above and forever reports
// `ready: false`; `remainingMs` is carried through unchanged (irrelevant once spent).
export function spendDockResupply(state, maxPerDock = DOCK_RESUPPLY_MAX_PER_DOCK) {
  return { remainingMs: state.remainingMs, count: maxPerDock };
}
