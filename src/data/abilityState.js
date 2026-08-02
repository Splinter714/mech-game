// Generic ability activation state machine (#506) — a single-shot burst on a cooldown,
// generalized from the old data/dash.js (Dash is now just the first entry in the ability
// registry, data/abilities.js, that plugs its own cooldown/duration into this). Pure state
// machine, no Phaser, no per-ability knowledge: every ability kind (dash, and later shield-
// burst/drone-launcher/jump-blast/cloak/smoke) reuses this exact math.

// A fresh ability slot: inactive, no burst in progress, ready immediately (no cooldown).
export function initialAbilityState() {
  return { active: false, burstRemaining: 0, cooldown: 0 };
}

// True when the ability can be triggered right now: not already mid-burst, not on cooldown.
export function canActivate(state) {
  return !state.active && state.cooldown <= 0;
}

// Resolve a press into a new state. No-ops (returns the SAME state, not a copy) if the
// ability isn't ready yet, so a spammed press while waiting is silently ignored rather than
// queued or restarting the burst.
//
// #500: an ability declared with NO `duration` (null — Cloak) is an UNTIL-BROKEN effect rather
// than a timed burst. Two things fall out of that, and both are expressed right here so nothing
// downstream needs a second notion of "active":
//   - `burstRemaining: Infinity` — `updateAbilityState`'s countdown below is unchanged and simply
//     can never reach 0, so the burst window stays open with no upper cap. Every duration-driven
//     ability (Drone Launcher, Smoke Screen, the movement bursts) is untouched by this.
//   - the cooldown clock is deliberately NOT started here. It starts when the effect actually
//     BREAKS (`breakAbility`), which for a hold with no cap is the only instant worth measuring
//     "ready again in Ns" from — an activation-start clock would already have expired part-way
//     through any sneak of real length.
export function activateAbility(state, { cooldown, duration }) {
  if (!canActivate(state)) return state;
  if (duration == null) return { active: true, burstRemaining: Infinity, cooldown: 0 };
  return { active: true, burstRemaining: duration, cooldown };
}

// #500: end an ACTIVE burst RIGHT NOW — the until-broken counterpart to letting `duration` run
// out — and start its cooldown from this instant. A no-op (returns the SAME state) when nothing
// is active, so a caller can apply it unconditionally on whatever event breaks the effect.
export function breakAbility(state, { cooldown }) {
  if (!state.active) return state;
  return { active: false, burstRemaining: 0, cooldown };
}

// Advance `{ active, burstRemaining, cooldown }` by `dt` seconds. Never mutates the input.
export function updateAbilityState(state, dt) {
  let { active, burstRemaining, cooldown } = state;
  if (active) {
    burstRemaining = Math.max(0, burstRemaining - dt);
    if (burstRemaining <= 0) active = false;
  }
  if (cooldown > 0) cooldown = Math.max(0, cooldown - dt);
  return { active, burstRemaining, cooldown };
}
