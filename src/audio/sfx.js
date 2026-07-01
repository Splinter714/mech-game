// Gameplay SFX — the procedural cues for firing, impacts, abilities, footfalls, and
// explosions, factored out of AudioEngine. Weapon fire/trajectory/impact cues are DATA (a
// per-weapon table of tunable layers in sfxParams.js, edited live by the Weapon Lab sound
// panel) played back by the generic playLayers() — **add/retune a weapon's sound = edit its
// entry in sfxParams.js, not a new function.** Ability/footstep/explosion cues are still
// small dedicated functions; they're not weapon-specific. The engine keeps the public
// facade (guards + `_resume`) and delegates here.
import { playLayers, startLoopLayers } from './sfxLayers.js';
import { HELD_SFX } from './sfxParams.js';

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
// startLoopLayers for the actual node-graph lifecycle). Returns null if there's no HELD_SFX
// entry for this weapon, or the engine isn't ready.
export function startHeld(e, weaponId) {
  const cfg = HELD_SFX[weaponId];
  if (!cfg || !e.ready) return null;
  return startLoopLayers(e, e.sfx, [cfg]);
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

// Explosion (#36) — death / part break-off. `scale` 0.4..1.2 sizes the blast.
export function explosion(e, scale = 1) {
  const s = clamp(scale, 0.3, 1.4);
  e.tone(e.sfx, { type: 'sine', freq: 140 * s, freqEnd: 30, dur: 0.5 * s, gain: 0.34, attack: 0.003 });   // sub-bass punch
  e.noise(e.sfx, { dur: 0.6 * s, gain: 0.28, type: 'lowpass', freq: 1400, freqEnd: 180, attack: 0.002 }); // wide body
  e.noise(e.sfx, { dur: 0.08, gain: 0.14, type: 'highpass', freq: 2200 });                                // high crack
}
