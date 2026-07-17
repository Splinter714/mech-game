// #264 — positional audio: pure distance-falloff + stereo-pan math for world-anchored SFX
// (weapon fire, impacts, explosions). No Phaser, no Web Audio here — this is just arithmetic
// on two (x, y) points (a sound's source and the listener, which is always the player's own
// `this.px`/`this.py`), so it's plain unit-testable data like the rest of `src/data/`. The
// audio layer (audio/sfx.js) is the only thing that turns these numbers into real GainNode/
// StereoPannerNode values.
//
// Replaces the old flat, non-distance-based `ENEMY_FIRE_GAIN_SCALE` stopgap in
// audio/fireCues.js (#200), which existed only because there was no positional concept at all
// yet — see that file's history for the "very slightly quieter" workaround this supersedes.

// ── Distance falloff ───────────────────────────────────────────────────────────────────────
// NEAR_DISTANCE: inside this radius, a sound plays at full volume with no falloff at all — the
// player's own muzzle, a point-blank melee hit, an outpost collapsing right under the mech.
// Small enough that it only covers "basically on top of the listener," not general close-range
// combat (which should already read distance).
export const NEAR_DISTANCE = 100;

// MAX_AUDIBLE_DISTANCE: beyond this, gain is clamped at FLOOR_GAIN and drops no further. Picked
// to comfortably cover the game's longest weapon engagement envelope (missile-class ranges top
// out around ~1750px, hexgrid.js's HEX_SIZE=48 and the arena's worldRadius put the whole
// playable area at roughly that same scale) so a shot landing at the far edge of ANY weapon's
// range is still attenuated smoothly rather than having already hit the floor.
export const MAX_AUDIBLE_DISTANCE = 1800;

// FLOOR_GAIN: the floor a far-off sound clamps to instead of fading to true silence. A hard cut
// to 0 reads as a bug/pop when something is merely far away rather than off-map; a small
// audible floor keeps distant combat present as ambience (you can tell a fight is happening
// somewhere) without it competing with what's actually near the player.
export const FLOOR_GAIN = 0.12;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Ease-out-quadratic falloff between NEAR_DISTANCE and MAX_AUDIBLE_DISTANCE: gain drops
// quickly just past the near radius (where distance differences are most perceptually
// meaningful — is this shot near me or not) and levels off more gently as it approaches the
// floor, rather than a straight linear ramp (which reads as fading too evenly/synthetically)
// or a true inverse-square curve (which crushes everything past a short distance to near-
// silence well before MAX_AUDIBLE_DISTANCE, defeating the point of a generous floor).
export function distanceGain(sourceX, sourceY, listenerX, listenerY) {
  const dx = sourceX - listenerX;
  const dy = sourceY - listenerY;
  const dist = Math.hypot(dx, dy);
  if (dist <= NEAR_DISTANCE) return 1;
  if (dist >= MAX_AUDIBLE_DISTANCE) return FLOOR_GAIN;
  const t = (dist - NEAR_DISTANCE) / (MAX_AUDIBLE_DISTANCE - NEAR_DISTANCE);
  const eased = 1 - t * t; // 1 -> 0 as t goes 0 -> 1, easing out (fast drop, slow tail)
  return FLOOR_GAIN + eased * (1 - FLOOR_GAIN);
}

// ── Stereo pan ─────────────────────────────────────────────────────────────────────────────
// This is a fixed top-down camera with no listener rotation (the arena camera doesn't spin
// with the player's facing/turret — it stays screen-up), so panning only ever needs to read
// the source's SCREEN-SPACE horizontal offset from the listener; the vertical (y) offset and
// the player's facing angle are both irrelevant to the pan image, unlike a first-person/
// rotating-listener game.
//
// PAN_RANGE_PX: the horizontal offset (px) at which pan reaches a hard ±1 (fully
// left/right). Kept fairly tight — most engagements happen within a few hundred px — so
// side-fire actually images left/right instead of everything reading as dead-center until a
// target is almost off-screen.
export const PAN_RANGE_PX = 500;

export function stereoPan(sourceX, _sourceY, listenerX, _listenerY) {
  const dx = sourceX - listenerX;
  const p = dx / PAN_RANGE_PX;
  return Math.max(-1, Math.min(1, p));
}
