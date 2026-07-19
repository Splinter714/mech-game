// #269 §3 "rare multi-spawn exception" (playtest follow-up, issue: base population rework) —
// pure state machine for a DOCK occasionally producing ONE MORE unit after its originally-
// assigned unit(s) are all destroyed. Mirrors data/alertTower.js's shape (a small pure tick
// function + tunable constants, no Phaser) — scenes/arena/bases.js is the thin scene-side
// wiring that calls this every tick with `awake` (is the dock's base awake?) and `cleared` (is
// the dock actually vacated right now?) tracked separately, and plays the doors-open/rise/
// doors-close FX + spawns the unit when a tick reports `ready: true`.
//
// Explicitly scoped to DOCK hexes only — a stationary turret refilling itself doesn't fit
// "reinforcements rolling out of a bay", so no other base structure participates.

// Cooldown, counted down once a dock's base is awake, before it resupplies. #269
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

// #311: per-dock cooldown variance. Every dock used to share the flat constant above AND to be
// constructed/woken in the same pass, so a base's docks stayed perfectly in phase for a whole
// fight — reinforcements arrived as one synchronized pulse instead of a trickle. Jackson:
// "docks should have slight randomization in cooldown so they don't all happen quite so
// simultaneously." ±15% of the baseline, i.e. ~15.3-20.7s. Deliberately small: it's a
// de-synchronizer, not a re-tune of the 18s cadence reasoned about above. Owner: tunable.
export const DOCK_RESUPPLY_COOLDOWN_JITTER = 0.15;

// #311, and the more important half of the fix: each dock also starts at a RANDOM POINT IN ITS
// OWN CYCLE rather than every dock beginning at a full cooldown. Interval variance alone still
// has all docks fire together on the first cycle and only drift apart slowly over many minutes —
// a random starting phase desynchronizes them on the very first resupply, which is the actual
// symptom reported. The band is 0.5-1.0 of the dock's own cooldown rather than a full 0-1: the
// baseline's own reasoning above is explicit that resupply must not feel like "an instant
// respawn in your face", and a uniform 0-1 phase would let a dock pop a fresh unit a second or
// two after its base wakes. 0.5-1.0 gives a first resupply somewhere in ~7.7-20.7s — plenty of
// spread to break the lockstep, with a real floor before anything can reappear. Owner: tunable.
export const DOCK_RESUPPLY_PHASE_MIN = 0.5;
export const DOCK_RESUPPLY_PHASE_MAX = 1;

// Fresh per-dock resupply state, with #311's two per-dock rolls baked in at construction:
// a jittered `cooldownMs` (the interval THIS dock will use for every future cycle, carried on the
// state so `tickDockResupply` reuses it rather than falling back to the flat constant) and a
// randomized starting `remainingMs` (its phase). `rng` is injected — pass a seeded generator
// (worldgen.js `mulberry32`) so a seeded run stays reproducible; defaults to `Math.random` for
// callers that don't have one. Stays pure: no module-level RNG state.
export function makeDockResupplyState(cooldownMs = DOCK_RESUPPLY_COOLDOWN_MS, rng = Math.random) {
  const jittered = cooldownMs * (1 + (rng() * 2 - 1) * DOCK_RESUPPLY_COOLDOWN_JITTER);
  const phase = DOCK_RESUPPLY_PHASE_MIN + rng() * (DOCK_RESUPPLY_PHASE_MAX - DOCK_RESUPPLY_PHASE_MIN);
  const startMs = jittered * phase;
  // `startMs` is remembered separately because the `!awake` branch of `tickDockResupply` restores
  // a not-yet-woken dock to its UNSTARTED value — which, post-#311, is this dock's phase offset,
  // not a full cooldown. Without it a single dormant tick would wipe the phase roll.
  return { remainingMs: startMs, count: 0, cooldownMs: jittered, startMs };
}

// Advance one tick for a single dock. Two separate concerns, deliberately split:
//   - `awake` gates whether the cooldown TICKS AT ALL (§2 of the mechanic: a still-dormant/
//     never-triggered base's docks must not be quietly counting down before the player has even
//     discovered it — an intentional earlier design call, left in place). Once a base is awake,
//     the cooldown counts down regardless of `cleared` — it starts as soon as the dock's unit is
//     spawned, not when that unit finally leaves/dies. #269 playtest follow-up: the cooldown's
//     PROGRESS must not be paused or reset just because the original unit is still alive.
//   - `cleared` gates whether a finished cooldown can actually FIRE (`ready: true`). This is a
//     physical necessity, not a design choice — you can't spawn a fresh unit into a hex that's
//     still occupied. If the cooldown reaches zero while the dock is still occupied, the tick
//     holds at `remainingMs: 0` (cooldown fully elapsed, not restarted) and waits for `cleared`
//     to go true on a later tick, at which point it fires immediately with no extra wait.
// Once `count` hits `maxPerDock`, every further tick is a no-op forever (`ready` stays false) —
// the dock is spent. Pure: always returns a NEW state object, never mutates `state`.
export function tickDockResupply(
  state, { awake, cleared, dt }, cooldownMs = DOCK_RESUPPLY_COOLDOWN_MS, maxPerDock = DOCK_RESUPPLY_MAX_PER_DOCK,
) {
  // #311: a state built by `makeDockResupplyState` carries its OWN jittered interval; the
  // `cooldownMs` argument is only the fallback for a hand-rolled/legacy state that lacks one.
  // Everything below (the recharge after firing, the dormant hold) uses the per-dock value so a
  // dock keeps its own cadence for its whole lifetime rather than snapping back to the constant.
  const cd = state.cooldownMs ?? cooldownMs;
  // The value an un-started dock sits at — its #311 phase offset, or a full cooldown for a state
  // that predates the phase roll.
  const unstartedMs = state.startMs ?? cd;
  // Spent — strip any stale `ready` from the tick that just fired (this is the very next call
  // after that one) so the caller never re-reads `ready: true` a second time and double-spawns.
  if (state.count >= maxPerDock) {
    return { remainingMs: state.remainingMs, count: state.count, cooldownMs: cd, startMs: unstartedMs };
  }
  if (!awake) {
    // Base hasn't woken yet — hold at its unstarted value rather than ticking or draining; the
    // countdown only ever runs once the base is awake.
    if (!state.remainingMs || state.remainingMs === unstartedMs) return state;
    return { remainingMs: unstartedMs, count: state.count, cooldownMs: cd, startMs: unstartedMs };
  }
  const remainingMs = Math.max(0, state.remainingMs - Math.max(0, dt) * 1000);
  if (remainingMs <= 0) {
    // Cooldown has fully elapsed. Only actually fire once the dock is genuinely clear — spawning
    // into an occupied hex isn't possible. If still occupied, hold at 0 (already-elapsed) rather
    // than restarting the cooldown, so resupply fires the instant `cleared` goes true with no
    // extra wait.
    if (!cleared) return { remainingMs: 0, count: state.count, cooldownMs: cd, startMs: unstartedMs };
    // Recharges to this dock's OWN interval (#311), not the shared constant — no phase re-roll:
    // the docks are already out of step by now and re-rolling each cycle would only add churn.
    return { remainingMs: cd, count: state.count + 1, cooldownMs: cd, startMs: unstartedMs, ready: true };
  }
  return { remainingMs, count: state.count, cooldownMs: cd, startMs: unstartedMs };
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
  return { remainingMs: state.remainingMs, count: maxPerDock, cooldownMs: state.cooldownMs, startMs: state.startMs };
}
