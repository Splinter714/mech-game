// Gameplay SFX — the procedural cues for firing, impacts, abilities, footfalls, and
// explosions, factored out of AudioEngine. Weapon fire/trajectory/impact cues are DATA (a
// per-weapon table of tunable layers in sfxParams.js, edited live by the Weapon Lab sound
// panel) played back by the generic playLayers() — **add/retune a weapon's sound = edit its
// entry in sfxParams.js, not a new function.** Ability/footstep/explosion cues are still
// small dedicated functions; they're not weapon-specific. The engine keeps the public
// facade (guards + `_resume`) and delegates here.
import { playLayers, startLoopLayers } from './sfxLayers.js';
import { hasHeldSfx } from './sfxParams.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Dial the one-shot trajectory cue's gain down for the sustained loop — up to 6 can play at
// once (Swarm Rack); tune here.
const TRAJECTORY_LOOP_GAIN_SCALE = 0.6;

export function fire(e, weapon) {
  playLayers(e, e.sfx, e.getSfxParams(weapon.id).fire);
}

export function trajectory(e, weaponId) {
  const p = e.getSfxParams(weaponId);
  if (p.trajectory) playLayers(e, e.sfx, p.trajectory);
}

export function impact(e, weaponId) {
  playLayers(e, e.sfx, e.getSfxParams(weaponId).impact);
}

// ── Held/looping fire sound (#53) — flamethrower/beamLaser use ONE continuous source
// instead of a retriggered one-shot burst every cadence tick (see sfxLayers.js's
// startLoopLayers for the actual node-graph lifecycle). Reuses the weapon's own `fire`
// layers (same live, tunable data the Weapon Lab panel's sliders control) rather than a
// separate table, so tuning `fire` actually retunes what you hear while holding the button.
// Gated on hasHeldSfx — every weapon has `fire` layers now, but only flamethrower/beamLaser
// actually use the held/loop dispatch; everyone else fires one-shots.
export function startHeld(e, weaponId) {
  if (!hasHeldSfx(weaponId) || !e.ready) return null;
  const layers = e.getSfxParams(weaponId).fire;
  if (!layers || !layers.length) return null;
  return startLoopLayers(e, e.sfx, layers);
}

// ── Per-projectile in-flight loop (#56) — missiles/lobbed weapons get a continuous
// trajectory cue for the round's actual flight time instead of one fixed-duration one-shot.
// Reuses the weapon's existing `trajectory` layers (looped, gain scaled down since several
// can play at once — e.g. Swarm Rack's 6 simultaneous missiles) rather than a new data table.
export function startTrajectory(e, weaponId) {
  const layers = e.getSfxParams(weaponId).trajectory;
  if (!layers || !layers.length || !e.ready) return null;
  return startLoopLayers(e, e.sfx, layers, TRAJECTORY_LOOP_GAIN_SCALE);
}

// ── Ability cues (jump-jet dash vs. bubble-shield raise). ───────────────────────────────
function dashCue(e) {                                      // thruster burst: rising filtered noise + pitch lift
  e.noise(e.sfx, { dur: 0.3, gain: 0.18, type: 'bandpass', freq: 400, freqEnd: 1800, q: 0.6, attack: 0.01 });
  e.tone(e.sfx, { type: 'sawtooth', freq: 180, freqEnd: 520, dur: 0.26, gain: 0.07 });
}
function shieldCue(e) {                                    // shimmering power-up: two detuned bell tones
  e.tone(e.sfx, { type: 'sine', freq: 520, freqEnd: 780, dur: 0.5, gain: 0.10, attack: 0.02 });
  e.tone(e.sfx, { type: 'sine', freq: 523, freqEnd: 784, dur: 0.5, gain: 0.08, attack: 0.02 });
}

export const ABILITY_CUES = { dash: dashCue, shield: shieldCue };

export function ability(e, kind) {
  ABILITY_CUES[kind]?.(e);
}

// ── One-shot cues (no variants). ────────────────────────────────────────────────────────
// Footfall (#34) — a heavy low thud; alternating feet shift pitch slightly. Throttled so a
// fast gait can't machine-gun the sound (throttle state lives on the engine).
export function footstep(e, foot = 0) {
  const t = e._now();
  if (t - e._lastStepSound < 0.07) return;
  e._lastStepSound = t;
  e.tone(e.sfx, { type: 'sine', freq: foot ? 78 : 66, freqEnd: 38, dur: 0.16, gain: 0.30, attack: 0.002 });
  e.noise(e.sfx, { dur: 0.09, gain: 0.08, type: 'lowpass', freq: 320 }); // dirt/servo crunch
}

// Explosion (#36, tunable data per #100) — death / part break-off. `scale` 0.3..1.6 sizes the
// blast (`deathScaleFor`, scenes/arena/shared.js, drives this for a kill; a couple of fixed
// calls elsewhere — a part breaking off, the player's own MECH DOWN — pass a flat intensity).
// The cue's BASE sound now lives in sfxParams.js's `deathExplosion` entry (same tunable-layer
// table every weapon's sound uses — Weapon Lab-style data, not a hardcoded function), so it's
// editable through the identical getSfxParams/setSfxParam/resetSfxParams plumbing. `scale`
// additionally reshapes each layer at trigger time: louder, longer (more sustain = more
// "boominess"), and pitched DOWN (lower frequency = more bass/boomy) for a bigger kill — a
// heavy mech should sound noticeably bigger AND lower than a drone, not just louder.
export function explosion(e, scale = 1) {
  const s = clamp(scale, 0.3, 1.6);
  const layers = e.getSfxParams('deathExplosion').fire;
  playLayers(e, e.sfx, layers.map((l) => scaleExplosionLayer(l, s)));
}

// Reshape one death-explosion layer by the kill's size factor `s` (see explosion() above).
// Pure — no engine/context reads — so it's trivially unit-testable in isolation.
export function scaleExplosionLayer(l, s) {
  const out = { ...l };
  if (out.dur != null) out.dur = out.dur * s;                                    // more sustain = boomier
  if (out.gain != null && out.gain > 0) out.gain = out.gain * (0.7 + 0.3 * s);   // louder for a bigger kill
  if (out.freq != null) out.freq = out.freq / s;                                 // lower pitch = more bass
  if (out.freqEnd != null) out.freqEnd = out.freqEnd / s;
  return out;
}
