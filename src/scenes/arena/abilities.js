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
import { desaturateTexture, PIVOT_LOCATIONS } from '../../art/mechArt.js';
import { Audio } from '../../audio/index.js';

// The six mech part-sprite names on a mech view (locomotion.js `_makeMechView`) — mirrors
// shieldOutline.js's own `SHIELD_MECH_PART_KEYS` (same list), kept as a separate local constant
// rather than importing it: shieldOutline.js pulls in the real `phaser` package at module scope,
// and this file is imported by several ability unit tests (stealth.test.js, abilityTrigger.test.js,
// this file's own test) that run under vitest's plain node environment with no Phaser mock —
// importing shieldOutline.js here would break all of them the same way enemies.js's own
// `import Phaser` already requires a stub in carrierDeploy.test.js/dormantWake.test.js. (mechArt.js
// is safe to import directly, below — unlike shieldOutline.js it never touches the real `phaser`
// package, it only calls duck-typed methods on whatever `scene` it's handed.)
const MECH_PART_KEYS = ['hull', 'torL', 'torR', 'armL', 'armR', 'turret'];
// Every part EXCEPT the hull: these six textures never change on their own, so this function can
// safely swap them straight to/from their pre-baked `_grey` variant. The hull is the one part
// something ELSE re-picks every frame (locomotion.js `_stepGait` sets `p.view.hull`'s texture to
// the current walk-cycle frame on every gait tick, cloaked or not) — if this function swapped the
// hull's texture too, the very next footstep would silently stomp it back to full colour.
// `_stepGait` is cloak-aware instead (checks `hasActiveEffect(p, 'cloak')` itself) and points
// straight at the matching pre-baked `${key}_hull_${frame}_grey` frame — see its own comment.
const CLOAK_SWAPPABLE_PARTS = MECH_PART_KEYS.filter((p) => p !== 'hull');

// #500 (owner playtest, second pass — the first tint-based cut still read as "has colour": "cloaking
// ability needs to remove color from the mech except for the multiplayer color ring"). A Phaser
// sprite tint is a per-channel MULTIPLY (`out = texture * tint`), which can only dim/colour-cast a
// sprite — it preserves every pixel's hue and saturation exactly, so it can never actually remove
// colour from an already-saturated panel (a player's saturated rim-accent especially). Genuine
// desaturation needs real per-pixel access, which `desaturateTexture` (art/mechArt.js) provides by
// baking a true greyscale `_grey` variant of each part texture via Canvas 2D `getImageData` — see
// its header for why that (not a WebGL postFX pipeline) is what works under both renderers.
export const CLOAK_ALPHA = 0.45;      // dim enough to read as translucent; the desaturation itself
                                       // (not this container alpha) carries the "ghostly" cue, and
                                       // (#500 third pass) `desaturateTexture` now bakes its OWN
                                       // per-part rim outline + extra fill transparency on top of
                                       // this, so the combined look is a lit wireframe silhouette
                                       // rather than a flat grey one.

// #500 (fourth pass, owner playtest on the wireframe rework: "cloak wireframe is pretty good" +
// three follow-ups) — the per-slot muzzle-glow overlay (#433 MUZZLE_GLOW_SUFFIX/drawPartGlow,
// mounted above its part in mechView.js `makeMechParts`) is a small saturated/near-white emissive
// blob on an otherwise-transparent canvas. It's a CHILD of `view`, so CLOAK_ALPHA above already
// dims it along with everything else — but a glow's hot core is baked bright enough that even at
// CLOAK_ALPHA it still pops against the muted, desaturated body around it. Unlike the body (which
// genuinely needs per-pixel desaturation — see desaturate.js's header on why tint can't do that
// for a saturated panel), a small emissive dot reads as "muted" from a plain tint + extra alpha
// just fine, so this stays a cheap sprite-level dim rather than another desaturateTexture bake.
export const CLOAK_GLOW_ALPHA = 0.35;   // stacks multiplicatively with the container's own CLOAK_ALPHA
export const CLOAK_GLOW_TINT = 0x8a8a8a; // mid-grey multiply — knocks the hot core/halo down several notches

// Apply/clear Cloak's visual on a player's mech view: swap every non-hull part sprite to a
// genuinely-desaturated `_grey` texture variant (baked fresh from whatever the part's CURRENT
// texture is, so it always matches the mech's live damage state) plus the container's own alpha
// for translucency. `active` false restores every swapped part to the exact texture key it had
// before cloaking, and restores full opacity. Guarded per-part (`?.`) so a hand-rolled test
// double's partial view (or a torso/arm currently missing after part loss — see anatomy.js) never
// throws. Deliberately does NOT touch `player.marker` — the co-op ground identity ring (coop.js) —
// which lives entirely outside `player.view` and is never in scope of this loop at all, so the
// ring keeps its own player colour while the mech greys out around it.
function setCloakVisual(scene, player, active) {
  const view = player.view;
  if (!view) return;
  view.setAlpha?.(active ? CLOAK_ALPHA : 1);
  for (const part of CLOAK_SWAPPABLE_PARTS) {
    const sprite = view[part];
    if (!sprite?.setTexture) continue;
    if (active) {
      // Remember the exact key this part was showing so deactivation can restore it precisely,
      // even if a reskin (damage) happens later under a DIFFERENT active-cloak texture key.
      const baseKey = sprite._cloakBaseKey ?? sprite.texture?.key;
      if (!baseKey) continue;
      sprite._cloakBaseKey = baseKey;
      sprite.setTexture(desaturateTexture(scene, baseKey));
    } else if (sprite._cloakBaseKey) {
      sprite.setTexture(sprite._cloakBaseKey);
      sprite._cloakBaseKey = null;
    }
  }
  // #500 (fourth pass): mute each mounted weapon's glow overlay alongside the body. Guarded the
  // same way as the part sprites above (`?.`) so a hand-rolled test double's partial/absent
  // `view.glow` never throws — the real mech view always has one overlay per PIVOT_LOCATIONS slot.
  for (const loc of PIVOT_LOCATIONS) {
    const glowSprite = view.glow?.[loc];
    if (!glowSprite?.setAlpha) continue;
    if (active) {
      glowSprite.setAlpha(CLOAK_GLOW_ALPHA);
      glowSprite.setTint?.(CLOAK_GLOW_TINT);
    } else {
      glowSprite.setAlpha(1);
      glowSprite.clearTint?.();
    }
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
      // tick here. `setCloakVisual` (above) is the genuine desaturation + translucency.
      if (next.active && !wasActive) {
        setCloakVisual(scene, player, true);
        Audio.ui('sprintOn');
      } else if (!next.active && wasActive) {
        setCloakVisual(scene, player, false);
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
