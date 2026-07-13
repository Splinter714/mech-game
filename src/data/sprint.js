// Sprint (#188) — a fixed, always-available movement ability every mech has, hardcoded to
// L3/Space. It replaced the old mountable "ability" slot (jumpJet dash / bubbleShield):
// Sprint is NOT mounted/equipped — no catalog entry, no loadout slot, nothing to choose.
// Pure state machine here (no Phaser) so the drain/regen/toggle math is fully unit-tested;
// the arena scene (arena/firing.js's sprint handling, arena/locomotion.js's speed multiplier)
// just calls these.
//
// Mechanic: press L3/Space to TOGGLE sprint on/off (not hold-to-sprint). While active, a
// fuel resource drains and movement speed is boosted; while inactive, fuel regenerates.
// Fuel hitting empty forces sprint off automatically, and it can't be toggled back on until
// at least some fuel has regenerated (no minimum threshold beyond "more than zero").

// Speed multiplier while sprinting. Overclock (the timed powerup, #60) uses moveMult: 1.35
// as its "noticeable but not absurd" reference point for a RARE buff; Sprint can afford to
// be more dramatic since it's an always-available core mechanic the player pays for with a
// depleting resource rather than a timed pickup, not a stacked bonus on top of one.
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

// Resolve a toggle press into the new `active` state. Turning OFF always succeeds. Turning
// ON is refused when the tank is fully empty (can't sprint on empty) — otherwise any fuel
// above 0 is enough to re-engage.
export function toggleSprint(active, fuel) {
  if (active) return false;
  return fuel > 0;
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
