// Gameplay SFX — the procedural cues for firing, impacts, abilities, footfalls, and
// explosions, factored out of AudioEngine. Each cue is a small function that drives the
// engine's synth primitives (`e.tone`/`e.noise` on the `e.sfx` bus); the dispatchers
// (`fire`/`impact`/`ability`) route through a CUE REGISTRY keyed by archetype rather than an
// if/else chain, so **adding a cue = a new function + one appended registry line.** The
// engine keeps the public facade (guards + `_resume`) and delegates here.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── Fire cues (per weapon archetype) ──────────────────────────────────────────────────
function flameHiss(e) {                                   // flamethrower hiss
  e.noise(e.sfx, { dur: 0.16, gain: 0.10, type: 'bandpass', freq: 1100, freqEnd: 600, q: 0.6 });
}
function laserZap(e, weapon) {                             // bright saw sweeping down + a square sub
  const stream = weapon.delivery?.pattern === 'stream';
  const base = clamp(1000 - weapon.damage * 11, 180, 1300);
  e.tone(e.sfx, { type: 'sawtooth', freq: base * 2.4, freqEnd: base, dur: stream ? 0.07 : 0.15, gain: 0.13, attack: 0.001 });
  e.tone(e.sfx, { type: 'square', freq: base * 1.0, freqEnd: base * 0.6, dur: stream ? 0.06 : 0.10, gain: 0.06 });
}
function napalmThunk(e) {                                  // napalm canister thunk
  e.tone(e.sfx, { type: 'triangle', freq: 130, freqEnd: 60, dur: 0.16, gain: 0.22 });
  e.noise(e.sfx, { dur: 0.10, gain: 0.12, type: 'lowpass', freq: 700 });
}
function gunCrack(e, weapon) {                             // sharp noise transient over a low thump
  const stream = weapon.delivery?.pattern === 'stream';
  e.noise(e.sfx, { dur: stream ? 0.045 : 0.11, gain: stream ? 0.10 : 0.26, type: 'highpass', freq: 1600, freqEnd: 700, attack: 0.0008 });
  e.tone(e.sfx, { type: 'triangle', freq: stream ? 220 : 170, freqEnd: 55, dur: stream ? 0.05 : 0.13, gain: stream ? 0.07 : 0.20 });
}
function missileWhoosh(e) {                                // ignition + rising whoosh
  e.noise(e.sfx, { dur: 0.34, gain: 0.16, type: 'bandpass', freq: 480, freqEnd: 1700, q: 0.7, attack: 0.02 });
  e.tone(e.sfx, { type: 'sawtooth', freq: 200, freqEnd: 440, dur: 0.22, gain: 0.05 });
}
function meleeWindup(e) {                                  // servo wind-up (the clang lands on impact)
  e.noise(e.sfx, { dur: 0.16, gain: 0.10, type: 'bandpass', freq: 700, freqEnd: 1500, q: 1.2 });
}

// Keyed first by delivery.kind (so 'flame'/'fire' override their category), then by category.
// An archetype with no cue is silent (matches the original fall-through — e.g. support).
export const FIRE_CUES = {
  flame: flameHiss,
  fire: napalmThunk,
  energy: laserZap,
  ballistic: gunCrack,
  missile: missileWhoosh,
  melee: meleeWindup,
};

export function fire(e, weapon) {
  const d = weapon.delivery || {};
  const cue = FIRE_CUES[d.kind] ?? FIRE_CUES[weapon.category];
  if (cue) cue(e, weapon);
}

// ── Impact cues (per ordnance type) — big ordnance routes to an explosion. ──────────────
function plasmaImpact(e) {                                 // electric sizzle + low splat
  e.noise(e.sfx, { dur: 0.18, gain: 0.14, type: 'bandpass', freq: 2200, freqEnd: 900, q: 1.4 });
  e.tone(e.sfx, { type: 'square', freq: 240, freqEnd: 80, dur: 0.12, gain: 0.10 });
}
function beamImpact(e) {                                   // brief scorch tick
  e.noise(e.sfx, { dur: 0.06, gain: 0.10, type: 'highpass', freq: 2600, freqEnd: 1400 });
}
function flameImpact(e) {
  e.noise(e.sfx, { dur: 0.12, gain: 0.07, type: 'lowpass', freq: 900 });
}
function slugImpact(e) {                                   // ballistic slug: a metallic clank
  e.noise(e.sfx, { dur: 0.05, gain: 0.18, type: 'highpass', freq: 2000, freqEnd: 800 });
  e.tone(e.sfx, { type: 'triangle', freq: 320, freqEnd: 120, dur: 0.06, gain: 0.10 });
}
const blast = (e) => explosion(e, 0.55);

export const IMPACT_CUES = {
  missile: blast,
  fire: blast,
  plasma: plasmaImpact,
  beam: beamImpact,
  flame: flameImpact,
  slug: slugImpact,
};

export function impact(e, kind) {
  (IMPACT_CUES[kind] ?? IMPACT_CUES.slug)(e);
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
