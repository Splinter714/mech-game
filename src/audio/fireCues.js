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
import { TRAJECTORY_DELAY, hasHeldSfx } from './sfxParams.js';

// Schedule the one-shot fire + trajectory audio cues for a single trigger pull.
//
//   scene   — the Phaser scene (for scene.time.delayedCall).
//   weapon  — the full weapon object (Audio.fire wants the weapon; the trajectory cue
//             wants weapon.id).
//   plan    — the weapon's emission plan from planEmissions(weapon); its `shots` array's
//             per-shot `delay` (ms) drives the burst retriggers.
//   audible — whether audio should play at all. The arena always plays (pass true); the
//             Lab only plays for the selected card (pass this._isAudible(card)). Gating
//             here rather than at the call site keeps the retrigger + trajectory scheduling
//             (which both need the same gate) in one place.
//
// A held/looping weapon (flamethrower / beam laser, hasHeldSfx) gets its sound entirely
// from its loop (started/stopped by each scene's edge detection), so this schedules nothing
// for it — no per-tick one-shot cue that would stutter over the loop.
export function scheduleFireCues(scene, weapon, plan, audible) {
  if (!audible || hasHeldSfx(weapon.id)) return;

  // t=0: the fire cue for the immediate (delay:0) shot(s). Every shot that fires
  // simultaneously at delay:0 (spread fans, cluster salvos, flamethrower spray) shares this
  // one cue — no stacking N at once.
  Audio.fire(weapon);
  // A brief "now it's airborne" flavor cue, a beat after the fire cue — a no-op for any
  // weapon with no trajectory layers defined (instant hitscan, short-range bullets, etc).
  scene.time.delayedCall(TRAJECTORY_DELAY, () => Audio.trajectory(weapon.id));

  // Retrigger the fire cue for sub-shots that land LATER than the trigger pull (#55) — a
  // burst weapon's later pulses (Pulse Laser, Streak Pod) each need their own cue aligned to
  // their flash/spawn, since the t=0 cue above only covers the delay:0 shot.
  for (const s of plan.shots) {
    if (s.delay > 0) scene.time.delayedCall(s.delay, () => Audio.fire(weapon));
  }
}
