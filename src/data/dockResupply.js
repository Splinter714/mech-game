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
// will plausibly see a dock reopen and cycle a fresh unit more than once. #326 then removed the
// per-dock lifetime cap that used to be paired with this, so the cadence now compounds for the
// whole fight rather than being spent after three cycles. Owner: tunable via playtest.
export const DOCK_RESUPPLY_COOLDOWN_MS = 18000;

// #326: THERE IS NO LIFETIME BUDGET. A dock reinforces indefinitely, at the cadence above, until
// it is DESTROYED. The old `DOCK_RESUPPLY_MAX_PER_DOCK` (3 — bodies after #323, fires before it)
// is gone entirely, as is #314's one-swarm-per-base cap and #323's first-resupply-only swarm
// guard. Jackson: "do we need reinforcement caps in the game at all? for any unit type? I don't
// think so" and, on the per-base swarm cap, "drop it — let bases have several".
//
// This is a design change, not just a deleted constant. While reinforcements ran dry on their own,
// IGNORING a dock was viable — you could out-wait it. Now the only thing that stops a dock is
// blowing its closed dome open (`dockClosed`, 200 HP, #313 — see `spendDockResupply` below, which
// is now the ONLY path to retirement). That makes docks the real objective and gives the player a
// genuine choice against the objective hex (#269): grind the docks, or rush the objective and
// leave.
//
// What deliberately DOES stay is all the PACING machinery, which is about rhythm rather than
// budget: the ±15% cooldown jitter and 0.8-1.0 phase offset below (#311/#323), and the `cleared` gate
// in `tickDockResupply` (a dock can't fire into its own occupied hex). Those are what keep an
// uncapped dock a steady drumbeat instead of a firehose — an occupied dock simply holds at zero
// until its last body leaves the pad, so pressure self-limits at roughly one wave per dock at a
// time no matter how long the fight runs.

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
//
// #323 playtest follow-up (Jackson: "docks are correctly refilling at different times from one
// another, but it seems like their actual cooldowns are massively different in some cases"). The
// desync worked; its MAGNITUDE was the problem. A phase band of 0.5-1.0 made the FIRST refill
// after a base wakes land anywhere in ~7.7-20.7s — a 2.7x spread — while every later cycle
// recharges to the dock's own interval, a mild ±15% (15.3-20.7s). Two docks could therefore open
// 13 seconds apart and then settle into near-identical cadences, which reads as "these docks have
// wildly different cooldowns," not as "these docks are offset from each other."
//
// Narrowed to 0.8-1.0. The first refill now lands in ~12.2-20.7s and, more importantly, the phase
// term itself contributes only a 1.25x spread against the interval jitter's 1.35x — so the
// opening cycle's spread is now the same order as the steady-state spread the player then
// experiences for the rest of the fight. That consistency is what makes it read as stagger rather
// than inconsistency: no dock is ever dramatically faster than its neighbour, they are just
// offset. Still a real desync — up to ~4s of separation on the first cycle, comfortably enough to
// break the synchronized pulse #311 was fixing. Owner: tunable.
export const DOCK_RESUPPLY_PHASE_MIN = 0.8;
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
  // #326: `count` survives the budget's removal as a pure LIFETIME TALLY — nothing gates on it any
  // more (it's telemetry: "how many waves has this dock sent?"). What gates now is `retired`, set
  // only by `spendDockResupply` when the dock is destroyed.
  return { remainingMs: startMs, count: 0, cooldownMs: jittered, startMs, retired: false };
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
// #326: the ONE terminal condition is `retired` (the dock was destroyed). There is no longer any
// lifetime budget — an intact dock cycles forever. Pure: always returns a NEW state object, never
// mutates `state`.
export function tickDockResupply(
  state, { awake, cleared, dt }, cooldownMs = DOCK_RESUPPLY_COOLDOWN_MS,
) {
  // #311: a state built by `makeDockResupplyState` carries its OWN jittered interval; the
  // `cooldownMs` argument is only the fallback for a hand-rolled/legacy state that lacks one.
  // Everything below (the recharge after firing, the dormant hold) uses the per-dock value so a
  // dock keeps its own cadence for its whole lifetime rather than snapping back to the constant.
  const cd = state.cooldownMs ?? cooldownMs;
  // The value an un-started dock sits at — its #311 phase offset, or a full cooldown for a state
  // that predates the phase roll.
  const unstartedMs = state.startMs ?? cd;
  // #326: RETIRED — the dock was destroyed. Every further tick is a no-op forever. This also
  // strips any stale `ready` from the tick that just fired (this is the very next call after that
  // one) so the caller never re-reads `ready: true` a second time and double-spawns.
  if (state.retired) {
    return { remainingMs: state.remainingMs, count: state.count, cooldownMs: cd, startMs: unstartedMs, retired: true };
  }
  if (!awake) {
    // Base hasn't woken yet — hold at its unstarted value rather than ticking or draining; the
    // countdown only ever runs once the base is awake.
    if (!state.remainingMs || state.remainingMs === unstartedMs) return { ...state, ready: false };
    return { remainingMs: unstartedMs, count: state.count, cooldownMs: cd, startMs: unstartedMs, retired: false };
  }
  const remainingMs = Math.max(0, state.remainingMs - Math.max(0, dt) * 1000);
  if (remainingMs <= 0) {
    // Cooldown has fully elapsed. Only actually fire once the dock is genuinely clear — spawning
    // into an occupied hex isn't possible. If still occupied, hold at 0 (already-elapsed) rather
    // than restarting the cooldown, so resupply fires the instant `cleared` goes true with no
    // extra wait.
    // #326: this `cleared` gate is now doing much heavier lifting than it used to. With no
    // lifetime budget, it is the mechanism that stops an uncapped dock becoming a firehose — a
    // dock that just dumped a 10-strong swarm cannot cycle again until every one of those bodies
    // has left or died, so a base's standing pressure is bounded by its docks' CURRENT waves, not
    // by elapsed time. It is why "indefinite" doesn't mean "unbounded".
    if (!cleared) return { remainingMs: 0, count: state.count, cooldownMs: cd, startMs: unstartedMs, retired: false };
    // Recharges to this dock's OWN interval (#311), not the shared constant — no phase re-roll:
    // the docks are already out of step by now and re-rolling each cycle would only add churn.
    // #326: `count` is incremented as a lifetime wave tally only — nothing is being spent.
    return { remainingMs: cd, count: state.count + 1, cooldownMs: cd, startMs: unstartedMs, retired: false, ready: true };
  }
  return { remainingMs, count: state.count, cooldownMs: cd, startMs: unstartedMs, retired: false };
}

// #269 Part 2 ("dock open/closed states"): a CLOSED dock is destructible — destroying it must
// permanently retire its ability to ever resupply again. Scenes/arena/bases.js hooks this into
// world.js's generic destructible-terrain collapse path (`_damageBuildingAt` →
// `_onTerrainCollapsed`) rather than adding dock-specific destruction handling there.
//
// #326: this is now the ONLY way a dock ever stops. Where it used to be an optional shortcut past
// a budget that would have run out anyway, destroying the dome is the player's entire lever on
// reinforcements — so the flag it sets is deliberately a dedicated, unambiguous `retired: true`
// rather than the old trick of forcing `count` up to a cap. `remainingMs`/`count` are carried
// through unchanged (both irrelevant once retired, and `count` stays honest as a lifetime tally).
export function spendDockResupply(state) {
  return {
    remainingMs: state.remainingMs, count: state.count,
    cooldownMs: state.cooldownMs, startMs: state.startMs, retired: true,
  };
}
