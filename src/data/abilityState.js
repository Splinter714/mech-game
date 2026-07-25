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
export function activateAbility(state, { cooldown, duration }) {
  if (!canActivate(state)) return state;
  return { active: true, burstRemaining: duration, cooldown };
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
