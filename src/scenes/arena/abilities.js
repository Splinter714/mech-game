// Arena-side ability wiring (#506) — advances every mounted ability's pure state machine
// (data/abilityState.js) each frame and dispatches on a fresh press. This replaced the old
// hardcoded `_handleDash` in firing.js: Dash is now just the 'dash' effect kind, mounted like
// any other ability, and this file has zero Dash-specific code — later ability kinds
// (shield-burst/drone-launcher/jump-blast/cloak/smoke) add their own `effect` case without
// touching the state machine or the input plumbing.
import { getAbility } from '../../data/abilities.js';
import { initialAbilityState, canActivate, activateAbility, updateAbilityState } from '../../data/abilityState.js';
import { ABILITY_SLOTS } from '../../data/anatomy.js';
import { damageInRadius } from '../../data/aoe.js';
import { otherLivePlayers } from './players.js';
import { Audio } from '../../audio/index.js';

// A fresh `{ [slot]: abilityState }` map for a newly-created player.
export function initAbilityStates() {
  const states = {};
  for (const slot of ABILITY_SLOTS) states[slot] = initialAbilityState();
  return states;
}

// #490/#498: a non-aimed AoE burst centered on (x, y) — shared by every ability effect that
// wants one, through the same per-owner damage dispatch every weapon hit uses (so co-op's
// friendly-fire-on rule isn't duplicated). Hits every living enemy in radius, plus any OTHER
// live player caught in the blast (never the caster).
function burstAoeAt(scene, caster, x, y, radius, damage) {
  const enemies = scene.enemies.filter((e) => !e.mech.isDestroyed());
  for (const hit of damageInRadius(x, y, radius, damage, enemies)) {
    scene._damageEnemyAt(hit.target, hit.target.x, hit.target.y, hit.amount, 0x5ec8e0, false, {});
  }
  for (const hit of damageInRadius(x, y, radius, damage, otherLivePlayers(scene, caster))) {
    scene._damagePlayerAt(hit.amount, hit.target, {});
  }
}

// Advance every ability slot this player has something mounted in: trigger on a fresh press
// (gated by the shared cooldown/burst rules), tick the state machine, and let each effect kind
// react to its own active/inactive edge. Called once per player per frame from firing.js.
export function updateAbilities(scene, intent, delta, player) {
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

    // Stage 1 implements 'dash' — its state machine's active flag is all locomotion.js needs
    // (via activeSpeedMult below); the cue reuses the existing "movement ability engaged/
    // disengaged" sound, same as the old dash bind did.
    if (def.effect === 'dash') {
      if (next.active && !wasActive) Audio.ui('sprintOn');
      else if (!next.active && wasActive) Audio.ui('sprintOff');
    } else if (def.effect === 'shieldBurst') {
      // #490: fires the instant it activates — no movement, no "arrival" to wait for.
      if (next.active && !wasActive) {
        burstAoeAt(scene, player, player.x, player.y, def.radius, def.damage);
        Audio.ui('sprintOn');
      }
    } else if (def.effect === 'jumpBlast') {
      // #498: the movement burst itself rides activeSpeedMult (locomotion.js) exactly like
      // Dash; the blast fires on the OPPOSITE edge — active→inactive, i.e. once the burst has
      // actually carried the player to wherever they land, not at the moment of the press.
      if (next.active && !wasActive) {
        Audio.ui('sprintOn');
      } else if (!next.active && wasActive) {
        burstAoeAt(scene, player, player.x, player.y, def.radius, def.damage);
        Audio.ui('sprintOff');
      }
    } else if (def.effect === 'droneLauncher') {
      // #497: the drone's own lifetime rides this SAME burst window (`next.active`) — spawn on
      // activation, despawn the instant the burst ends, whether that's from running out its
      // `duration` or (scenes/arena/friendlyDrones.js) the owner dying mid-flight.
      if (next.active && !wasActive) {
        scene._spawnFriendlyDrone?.(player);
        Audio.ui('sprintOn');
      } else if (!next.active && wasActive) {
        scene._despawnFriendlyDrone?.(player);
        Audio.ui('sprintOff');
      }
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

// The active speed multiplier from a player's mounted abilities matching `name`, or 1 if none is
// active — generalizes hasActiveEffect for movement-burst effects (dash, jumpBlast, ...) so a
// new one doesn't need its own hardcoded constant threaded into locomotion.js.
export function activeSpeedMult(player, name) {
  for (const slot of ABILITY_SLOTS) {
    const abilityId = player.mech.abilityMounts?.[slot];
    const def = abilityId && getAbility(abilityId);
    if (def?.effect === name && player.abilityStates[slot]?.active) return def.speedMult ?? 1;
  }
  return 1;
}
