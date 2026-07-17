// Fire-cue scheduling — the SINGLE place that decides WHEN to play the one-shot fire
// and trajectory audio cues for one trigger pull, shared by the live arena
// (scenes/arena/firing.js) and the Weapon Lab preview (ui/weaponCardList.js) so the two
// can never drift.
//
// The delivery sim (data/delivery.js `planEmissions`) already owns WHAT one trigger pull
// emits — including a burst weapon's delayed sub-shots. But *scheduling the audio cues*
// (calling Audio.fire / Audio.trajectory at the right moments) was re-implemented in each
// scene and drifted: the arena retriggers Audio.fire for each delayed burst sub-shot (so a
// 5-pulse Pulse Laser plays 5 fire cues aligned to its 5 beam flashes), while the Lab only
// played one. This unit is the arena's (correct) behaviour, extracted so both call it.
//
// It needs `scene.time.delayedCall` to schedule the per-pulse retriggers and the trajectory
// cue, so it can't live in the pure/headless delivery.js — it belongs in the audio layer.
//
// The actual SHOT EMISSION (spawning the projectile / drawing the beam / muzzle+aim), the
// held-loop start/stop edge detection, and the per-projectile in-flight trajectory LOOP all
// genuinely differ between the scenes (or are already handled there) and stay per-scene —
// only this one-shot fire+trajectory cue scheduling is shared here.

import { Audio } from './index.js';
import { TRAJECTORY_DELAY, hasHeldSfx, WEAPON_TRAJECTORY_SOUNDS_ENABLED } from './sfxParams.js';
// #224 (temporary): WEAPON_TRAJECTORY_SOUNDS_ENABLED lives in sfxParams.js — see the
// comment there for the full list of gated call sites and how to revert.

// #200 playtest follow-up (RETIRED by #264 — see below): enemy weapon fire (routed through
// this same scheduler — see scenes/arena/enemies.js's _fireVehicleWeapon and the mech-enemy
// fire loop in _updateEnemy) was reported as sounding exactly as loud as the player's own
// fire, which read oddly since it's the player's mech the camera/ears are anchored to. At the
// time there was no distance-based attenuation anywhere in the audio layer (no listener/
// emitter position concept at all — every SFX call was a flat (weaponId[, params]) call with
// no world position threaded through), so a flat, small gain reduction applied only to
// enemy-sourced cues (`ENEMY_FIRE_GAIN_SCALE`, 0.85) was the proportionate stopgap fix.
//
// #264: real positional audio now exists (data/positionalAudio.js's distanceGain/stereoPan,
// wired into audio/sfx.js) — the actual problem the stopgap was approximating (enemy fire
// should sound like it's coming from wherever the enemy actually is, which is usually farther
// from the player/listener than the player's own muzzle) is now solved for real, so the flat
// multiplier is retired rather than kept as an extra multiplier on top: enemy fire already
// gets genuinely quieter with real distance, and unlike the flat 0.85 it also gets LOUDER for
// a nearby enemy, which the old approximation could never do. See scenes/arena/enemies.js's
// two scheduleFireCues call sites, which now pass a `pos` (below) instead of a gainScale.

// Schedule the one-shot fire + trajectory audio cues for a single trigger pull.
//
//   scene     — the Phaser scene (for scene.time.delayedCall).
//   weapon    — the full weapon object (Audio.fire wants the weapon; the trajectory cue
//               wants weapon.id).
//   plan      — the weapon's emission plan from planEmissions(weapon); its `shots` array's
//               per-shot `delay` (ms) drives the burst retriggers.
//   audible   — whether audio should play at all. The arena always plays (pass true); the
//               Lab only plays for the selected card (pass this._isAudible(card)). Gating
//               here rather than at the call site keeps the retrigger + trajectory scheduling
//               (which both need the same gate) in one place.
//   gainScale — #200: optional uniform volume multiplier for every cue this call schedules
//               (default 1, i.e. unchanged) — still available as a generic knob, just no
//               longer populated by the retired ENEMY_FIRE_GAIN_SCALE.
//   pos       — #264: optional `{ x, y, listenerX, listenerY }` world-position pair for real
//               distance falloff + stereo pan (see audio/sfx.js's positionalBus). The two
//               enemy call sites (scenes/arena/enemies.js) pass the firer's muzzle position
//               plus the player's current position as listener; the player's own call site
//               (scenes/arena/firing.js) leaves this at the default null — the player IS the
//               listener, so there's nothing for positional audio to do there (full volume,
//               centered, which is already exactly correct).
//
// A held/looping weapon (flamethrower / beam laser, hasHeldSfx) gets its sound entirely
// from its loop (started/stopped by each scene's edge detection), so this schedules nothing
// for it — no per-tick one-shot cue that would stutter over the loop.
export function scheduleFireCues(scene, weapon, plan, audible, gainScale = 1, pos = null) {
  if (!audible || hasHeldSfx(weapon.id)) return;

  // t=0: the fire cue for the immediate (delay:0) shot(s). Every shot that fires
  // simultaneously at delay:0 (spread fans, cluster salvos, flamethrower spray) shares this
  // one cue — no stacking N at once.
  Audio.fire(weapon, gainScale, pos);
  // A brief "now it's airborne" flavor cue, a beat after the fire cue — a no-op for any
  // weapon with no trajectory layers defined (instant hitscan, short-range bullets, etc).
  // #224 (temporary): trajectory cue disabled, see WEAPON_TRAJECTORY_SOUNDS_ENABLED above.
  if (WEAPON_TRAJECTORY_SOUNDS_ENABLED) {
    scene.time.delayedCall(TRAJECTORY_DELAY, () => Audio.trajectory(weapon.id, gainScale, pos));
  }

  // Retrigger the fire cue for sub-shots that land LATER than the trigger pull (#55) — a
  // burst weapon's later pulses (Pulse Laser, Streak Pod) each need their own cue aligned to
  // their flash/spawn, since the t=0 cue above only covers the delay:0 shot. Reuses the same
  // `pos` snapshotted at the trigger pull rather than recomputing per sub-shot — the firer
  // moves negligibly across one burst's ~300ms span, so this is a fine approximation.
  for (const s of plan.shots) {
    if (s.delay > 0) scene.time.delayedCall(s.delay, () => Audio.fire(weapon, gainScale, pos));
  }
}
