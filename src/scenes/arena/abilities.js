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

// The six mech part-sprite names on a mech view (locomotion.js `_makeMechView`) — mirrors
// shieldOutline.js's own `SHIELD_MECH_PART_KEYS` (same list), kept as a separate local constant
// rather than importing it: shieldOutline.js pulls in the real `phaser` package at module scope,
// and this file is imported by several ability unit tests (stealth.test.js, abilityTrigger.test.js,
// this file's own test) that run under vitest's plain node environment with no Phaser mock —
// importing shieldOutline.js here would break all of them the same way enemies.js's own
// `import Phaser` already requires a stub in carrierDeploy.test.js/dormantWake.test.js.
const MECH_PART_KEYS = ['hull', 'torL', 'torR', 'armL', 'armR', 'turret'];

// #500 (owner playtest: "should be more greyscale/phantom-esque" — a flat alpha fade alone
// didn't read as a stealth effect, just a faded-out mech). A near-neutral, cool-toned grey TINT
// on every part sprite desaturates the mech's own palette toward grey (Phaser `setTint`
// multiplies each pixel's colour, so a saturated body panel reads flat and washed-out under it)
// while the container alpha keeps it translucent — together that's the "ghostly, drained of
// colour" read instead of just "the same mech, fainter." Deliberately NOT a WebGL-only postFX
// grayscale pipeline: this repo's smoke/test harness can force the Canvas renderer (`?canvas`),
// where postFX doesn't run at all (see shieldOutline.js's header for the same constraint) — tint
// is a basic texture op supported by both renderers, so this works everywhere the game does.
export const CLOAK_TINT = 0xaab4bd;   // pale steel-blue-grey — desaturates without going pitch dark
export const CLOAK_ALPHA = 0.45;      // up from the old flat 0.35: dim enough to read as translucent,
                                       // bright enough that the tint (the actual "greyscale" cue) is visible

// Apply/clear Cloak's visual on a player's mech view: a grey tint on every part sprite (the
// container itself has no paintable pixels of its own to tint) plus the container's own alpha for
// translucency. `active` false restores the mech to its normal colours/opacity. Guarded per-part
// (`?.`) so a hand-rolled test double's partial view (or a torso/arm currently missing after part
// loss — see anatomy.js) never throws.
function setCloakVisual(player, active) {
  const view = player.view;
  if (!view) return;
  view.setAlpha?.(active ? CLOAK_ALPHA : 1);
  for (const part of MECH_PART_KEYS) {
    const sprite = view[part];
    if (!sprite) continue;
    if (active) sprite.setTint?.(CLOAK_TINT);
    else sprite.clearTint?.();
  }
}

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
      // Both edges now play `_aoeBlastFx` (combat.js) — a radius-sized shockwave + camera shake
      // — so BOTH halves have a real "you felt that" beat instead of a silent speed change: a
      // smaller cool-toned pop at launch (telegraphs the leap), a full-radius warm-toned blast
      // at landing (the actual damage). Guarded with `?.` so the pure state-machine tests in
      // abilityEffects.test.js (whose fake scene has no combat/camera stack) stay unaffected.
      if (next.active && !wasActive) {
        scene._aoeBlastFx?.(player.x, player.y, def.radius * 0.55, 0xbfe8ff);
        Audio.ui('sprintOn');
      } else if (!next.active && wasActive) {
        burstAoeAt(scene, player, player.x, player.y, def.radius, def.damage);
        scene._aoeBlastFx?.(player.x, player.y, def.radius, 0xffcf8a);
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
    } else if (def.effect === 'cloak') {
      // #500: purely a visual on the edges — `isPlayerStealthed` (scenes/arena/stealth.js)
      // is what actually suppresses noise-aggro while `next.active` is true; nothing to spawn or
      // tick here. `setCloakVisual` (above) is the greyscale/phantom tint + translucency.
      if (next.active && !wasActive) {
        setCloakVisual(player, true);
        Audio.ui('sprintOn');
      } else if (!next.active && wasActive) {
        setCloakVisual(player, false);
        Audio.ui('sprintOff');
      }
    } else if (def.effect === 'smokeScreen') {
      // #507: same activate/deactivate-edge spawn/despawn pattern as Drone Launcher — the
      // cloud's lifetime rides this SAME burst window (`duration` = how long it lingers).
      if (next.active && !wasActive) {
        scene._spawnSmokeCloud?.(player, def.radius);
        Audio.ui('sprintOn');
      } else if (!next.active && wasActive) {
        scene._despawnSmokeCloud?.(player);
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
