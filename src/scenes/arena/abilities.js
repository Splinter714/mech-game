// Arena-side ability wiring (#506) — advances every mounted ability's pure state machine
// (data/abilityState.js) each frame and dispatches on a fresh press. This replaced the old
// hardcoded `_handleDash` in firing.js: Dash is now just the 'dash' effect kind, mounted like
// any other ability, and this file has zero Dash-specific code — later ability kinds
// (shield-burst/drone-launcher/jump-blast/cloak/smoke) add their own `effect` case without
// touching the state machine or the input plumbing.
import { getAbility } from '../../data/abilities.js';
import { initialAbilityState, canActivate, activateAbility, updateAbilityState, breakAbility } from '../../data/abilityState.js';
import { ABILITY_SLOTS } from '../../data/anatomy.js';
import { damageInRadius } from '../../data/aoe.js';
import { nearestInterceptTarget } from '../../data/interceptor.js';
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
const MECH_PART_KEYS = ['hull', 'shldL', 'shldR', 'armL', 'armR', 'turret'];
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
//
// #500 (fifth pass — owner playtest, TWICE, still saw legs bleeding through the torso): this
// constant is now applied EXACTLY ONCE — to the single flattened RenderTexture image
// (`scenes/arena/cloakFlatten.js`), never to `player.view` (the container) itself. Applying it at
// the container level (the ORIGINAL implementation here) was the actual root cause of the
// bleed-through: a Phaser container multiplies its own alpha into every sibling sprite as it
// draws them independently, which is a second, uncontrollable source of translucency on top of
// whatever each part's own texture already carries — no per-part texture alpha can prevent a
// translucent sibling from letting whatever's behind it (in local z-order) show through. See
// cloakFlatten.js's header for the full explanation and the fix (flatten first at full opacity —
// real occlusion — then dim the flattened result once).
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
// texture is, so it always matches the mech's live damage state). `active` false restores every
// swapped part to the exact texture key it had before cloaking. Guarded per-part (`?.`) so a
// hand-rolled test double's partial view (or a shoulder/arm currently missing after part loss — see
// anatomy.js) never throws. Deliberately does NOT touch `player.marker` — the co-op ground
// identity ring (coop.js) — which lives entirely outside `player.view` and is never in scope of
// this loop at all, so the ring keeps its own player colour while the mech greys out around it.
//
// #500 (fifth pass): this used to also set the CONTAINER's own alpha to CLOAK_ALPHA/1 here — that
// was the actual root cause of the leg/torso bleed-through the owner kept seeing (see CLOAK_ALPHA's
// comment above). Translucency is now applied exactly once, to the flattened RenderTexture image
// `scenes/arena/cloakFlatten.js` builds and shows in the container's place every frame cloak is
// active — this function's job is purely the per-part texture swap (the individual "ghostly wire-
// frame" look), not the overall see-through-ness.
function setCloakVisual(scene, player, active) {
  const view = player.view;
  if (!view) return;
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
  // #500: has THIS player actually put a shot out since the last ability tick? `fireWeapon`
  // (firing.js) raises the latch on a real shot — any of the four weapon triggers, any weapon,
  // including a released charge — and this consumes it. In co-op each player carries its own
  // latch on its own object, so only the cloaked player's OWN fire can break their own cloak.
  //
  // A latch consumed HERE rather than a break called straight from the fire path, on purpose:
  // every ability state transition then still happens in exactly one place, which is what keeps
  // the per-effect deactivate edge below (and with it Cloak's own visual teardown) working
  // unchanged for a break. The cost is that the break lands on the NEXT frame's tick, since
  // ArenaScene.update ticks abilities before firing — one frame, ~16ms, invisible in play.
  const fired = !!player.weaponFired;
  player.weaponFired = false;
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
    // #500: an until-broken effect (Cloak) ends the moment its owner fires, and only THEN starts
    // its cooldown — `breakAbility` (data/abilityState.js) is the whole of that. Gated on
    // `wasActive` so a cloak activated on this very frame can't be broken by a shot that went out
    // before it existed: the latch is always a frame old by construction (see above), and without
    // this, pressing cloak while a trigger is already held would drop it instantly.
    if (def.breaksOnFire && fired && wasActive && next.active) {
      next = breakAbility(next, { cooldown: def.cooldown });
    }
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
        // Was silent-but-for-damage — `burstAoeAt` itself has no visual, so with no enemies in
        // range the whole ability read as doing nothing. Reuses Jump Blast's shockwave FX.
        scene._aoeBlastFx?.(player.x, player.y, def.radius, 0x5ec8e0);
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
      // #500: purely a visual on the edges — `isPlayerStealthed`/`cloakBlocksTarget`
      // (scenes/arena/stealth.js) are what actually suppress noise-aggro and block the enemy
      // firing-lane raycast while `next.active` is true; nothing to spawn or tick here.
      // `setCloakVisual` (above) is the genuine desaturation + translucency, and the flattened
      // RenderTexture that carries it (cloakFlatten.js) is torn down off the same `active` flag
      // at the end of this same frame.
      //
      // #500 (playtest follow-up): the deactivate edge is now reached by the fire-break above
      // rather than by a burst running out — the effect never expires on its own any more — but
      // it is the SAME edge, so nothing here had to change.
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
    } else if (def.effect === 'antiMissile') {
      // #494/#546: Anti-Missile Defense, converted from a passive always-on core-slot pick to an
      // active burst-window ability — same edge cues as every other ability, plus a per-frame
      // scan-and-destroy WHILE the burst window (`next.active`) is open, replacing the old
      // always-on single-target scan that used to live in projectiles.js's `_updateInterceptors`.
      if (next.active && !wasActive) Audio.ui('sprintOn');
      else if (!next.active && wasActive) Audio.ui('sprintOff');
      if (next.active) {
        // Since this is now a limited burst window rather than an always-on single-shot gate, it
        // destroys EVERY incoming enemy round in range each frame it's active, not just the
        // nearest one — repeatedly asking `nearestInterceptTarget` (data/interceptor.js, the same
        // reusable target-selection primitive the old passive version used) against a shrinking
        // candidate list until nothing more is in range, rather than a fresh distance sort.
        const incoming = scene.projectiles.filter((p) => p.owner === 'enemy' && !p.dead);
        let target;
        while ((target = nearestInterceptTarget(player.x, player.y, def.range, incoming))) {
          target.dead = true;
          target.stopTrajectorySfx?.();
          // #527: its own dedicated FX (combat.js `_interceptFx`), not `_impactFx` — see that
          // method's own comment for why reusing the generic per-weapon impact spark read as
          // "nothing visibly happening" in the original #494 build.
          scene._interceptFx?.(player.x, player.y, target.x, target.y);
          incoming.splice(incoming.indexOf(target), 1);
        }
      }
    }
  }
}

// #500 (playtest follow-up): break an ACTIVE Cloak because its wearer just died. A dead player's
// abilities stop ticking entirely (ArenaScene.update skips `_handleAbilities` for them), so with
// no `duration` left to expire there is nothing else that could ever clear the state — a player
// who dies mid-sneak would respawn still flagged cloaked, i.e. permanently unhittable by the
// enemy LOS raycast and still wearing the grey wireframe. Runs the same texture restore the
// normal deactivate edge does; the flattened stand-in is handled by cloakFlatten.js, which
// treats a dead player as uncloaked. Silent on purpose — the death explosion is the cue.
export function breakCloakOnDeath(scene, player) {
  for (const slot of ABILITY_SLOTS) {
    const abilityId = player.mech?.abilityMounts?.[slot];
    const def = abilityId && getAbility(abilityId);
    if (def?.effect !== 'cloak') continue;
    const state = player.abilityStates?.[slot];
    if (!state?.active) continue;
    player.abilityStates[slot] = breakAbility(state, { cooldown: def.cooldown });
    setCloakVisual(scene, player, false);
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
