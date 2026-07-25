// Arena-side ability wiring (#506) — advances every mounted ability's pure state machine
// (data/abilityState.js) each frame and dispatches on a fresh press. This replaced the old
// hardcoded `_handleDash` in firing.js: Dash is now just the 'dash' effect kind, mounted like
// any other ability, and this file has zero Dash-specific code — later ability kinds
// (shield-burst/drone-launcher/jump-blast/cloak/smoke) add their own `effect` case without
// touching the state machine or the input plumbing.
import { getAbility } from '../../data/abilities.js';
import { initialAbilityState, canActivate, activateAbility, updateAbilityState } from '../../data/abilityState.js';
import { ABILITY_SLOTS } from '../../data/anatomy.js';
import { Audio } from '../../audio/index.js';

// A fresh `{ [slot]: abilityState }` map for a newly-created player.
export function initAbilityStates() {
  const states = {};
  for (const slot of ABILITY_SLOTS) states[slot] = initialAbilityState();
  return states;
}

// Advance every ability slot this player has something mounted in: trigger on a fresh press
// (gated by the shared cooldown/burst rules), tick the state machine, and let each effect kind
// react to its own active/inactive edge. Called once per player per frame from firing.js.
export function updateAbilities(intent, delta, player) {
  const dt = delta / 1000;
  for (const slot of ABILITY_SLOTS) {
    const abilityId = player.mech.abilityMounts?.[slot];
    const def = abilityId && getAbility(abilityId);
    if (!def) continue;
    const state = player.abilityStates[slot];
    const wasActive = state.active;
    let next = state;
    if (intent.ability?.[slot] && canActivate(next)) {
      next = activateAbility(next, { cooldown: def.cooldown, duration: def.duration });
    }
    next = updateAbilityState(next, dt);
    player.abilityStates[slot] = next;

    // Stage 1 implements exactly one effect kind — 'dash' just needs the state machine's
    // active flag (locomotion.js reads it via hasActiveEffect below); the cue below reuses the
    // existing "movement ability engaged/disengaged" sound, same as the old dash bind did.
    if (def.effect === 'dash') {
      if (next.active && !wasActive) Audio.ui('sprintOn');
      else if (!next.active && wasActive) Audio.ui('sprintOff');
    }
  }
}

// True if this player currently has an active mounted ability whose effect is `name` — e.g.
// locomotion's speed multiplier asks for 'dash' without caring which face button it's bound to,
// or indeed whether the player equipped it at all.
export function hasActiveEffect(player, name) {
  for (const slot of ABILITY_SLOTS) {
    const abilityId = player.mech.abilityMounts?.[slot];
    const def = abilityId && getAbility(abilityId);
    if (def?.effect === name && player.abilityStates[slot]?.active) return true;
  }
  return false;
}
