// Sprint (#188) — originally a fixed, always-available movement ability every mech had,
// hardcoded to L3/Space, replacing the old mountable "ability" slot (jumpJet dash /
// bubbleShield). Sprint is NOT mounted/equipped — no catalog entry, no loadout slot.
//
// #261: there is NO player trigger for Sprint any more — L3/Space became the Dash
// (data/dash.js). Sprint survives purely as Overclock's speed boost: the powerup
// force-activates it for its duration (arena/firing.js `_handleSprint`, which is the only
// caller left). Its old toggle/hold input resolvers were removed with the input path.
// Pure state machine here (no Phaser) so the drain/regen math is fully unit-tested; the arena
// scene (arena/firing.js, arena/locomotion.js's speed multiplier) just calls these.
//
// Mechanic: while active, a fuel resource drains and movement speed is boosted; while
// inactive, fuel regenerates. Fuel hitting empty forces sprint off automatically. (Overclock
// skips the fuel math entirely while it is holding Sprint on — see `_handleSprint`.)

// Speed multiplier while sprinting. #189: Overclock (the timed powerup, #60) no longer has
// its own moveMult — it force-activates Sprint instead, so this is now the SOLE speed-boost
// value in the game, whether Sprint is on because the player pressed the toggle or because
// Overclock is holding it on for its duration (see arena/firing.js `_handleSprint`).
export const SPRINT_SPEED_MULT = 1.5;

// Fuel capacity, in seconds of continuous sprint at the drain rate below (1 fuel unit = 1
// second of sprinting). ~3.5s is enough to matter tactically (cross a gap, disengage) without
// letting sprint just become the new baseline movement speed.
export const SPRINT_FUEL_MAX = 3.5;

// Fuel units drained per second while active (1 = fuel is directly "seconds of sprint left").
export const SPRINT_DRAIN_RATE = 1;

// Fuel units regenerated per second while inactive. Deliberately slower than the drain rate
// (half) so sprint reads as a real resource to manage — burn 3.5s, wait ~7s to fully refill —
// rather than something spammable on a short cooldown.
export const SPRINT_REGEN_RATE = 0.5;

// A fresh sprint state: starts inactive with a full tank.
export function initialSprintState(cap = SPRINT_FUEL_MAX) {
  return { active: false, fuel: cap };
}

// Advance `{ active, fuel }` by `dt` seconds: drains while active (forcing `active` false
// the instant the tank hits empty), regenerates while inactive (capped at `cap`). Returns a
// new state object; never mutates the input.
export function updateSprintFuel(state, dt, {
  cap = SPRINT_FUEL_MAX, drainRate = SPRINT_DRAIN_RATE, regenRate = SPRINT_REGEN_RATE,
} = {}) {
  let { active, fuel } = state;
  if (active) {
    fuel = Math.max(0, fuel - drainRate * dt);
    if (fuel <= 0) active = false;
  } else {
    fuel = Math.min(cap, fuel + regenRate * dt);
  }
  return { active, fuel };
}
