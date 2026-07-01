// Per-weapon SFX parameters — the tunable data behind the Weapon Lab's sound panel. Each
// weapon gets up to three stages: `fire` (trigger pull), `trajectory` (a brief in-flight
// flavor cue, fired a beat after launch — only weapons with a noticeable flight time have
// one), and `impact` (on landing). Each stage is an array of layers (see sfxLayers.js); a
// layer is `{ kind: 'tone' | 'noise', ...e.tone()/e.noise() fields }`.
//
// These defaults were ported 1:1 from the old archetype-keyed cues in sfx.js (computed at
// each weapon's actual damage/pattern) so the game sounds IDENTICAL until someone moves a
// slider. **Add a weapon = give it an entry here** (or it falls back to DEFAULT_SFX).

// Ballistic fire cue (#54): two tone layers (a low thud + a higher ring) and two noise
// layers (a highpass crack + a bandpass body) — four independently tunable layers instead
// of one tone + one noise, so the Weapon Lab panel gets four knob-pairs for autocannon/
// shotgun. `machineGun` keeps its own bespoke layers (unaffected by this).
const gunCrackLayers = (stream) => [
  { kind: 'noise', type: 'highpass', freq: 1600, freqEnd: 700, dur: stream ? 0.045 : 0.11, gain: stream ? 0.10 : 0.26, attack: 0.0008 },
  { kind: 'noise', type: 'bandpass', freq: 900, freqEnd: 500, q: 1.1, dur: stream ? 0.05 : 0.12, gain: stream ? 0.05 : 0.12, attack: 0.001 },
  { kind: 'tone', type: 'triangle', freq: stream ? 220 : 170, freqEnd: 55, dur: stream ? 0.05 : 0.13, gain: stream ? 0.07 : 0.20, attack: 0.004 },
  { kind: 'tone', type: 'square', freq: stream ? 440 : 340, freqEnd: 150, dur: stream ? 0.035 : 0.08, gain: stream ? 0.03 : 0.08, attack: 0.002 },
];
const laserZapLayers = (weapon, stream) => {
  const base = Math.max(180, Math.min(1300, 1000 - weapon.damage * 11));
  return [
    { kind: 'tone', type: 'sawtooth', freq: base * 2.4, freqEnd: base, dur: stream ? 0.07 : 0.15, gain: 0.13, attack: 0.001 },
    { kind: 'tone', type: 'square', freq: base, freqEnd: base * 0.6, dur: stream ? 0.06 : 0.10, gain: 0.06, attack: 0.004 },
  ];
};
const missileWhooshLayers = () => [
  { kind: 'noise', type: 'bandpass', freq: 480, freqEnd: 1700, q: 0.7, dur: 0.34, gain: 0.16, attack: 0.02 },
  { kind: 'tone', type: 'sawtooth', freq: 200, freqEnd: 440, dur: 0.22, gain: 0.05, attack: 0.004 },
];
const blastLayers = (scale) => [
  { kind: 'tone', type: 'sine', freq: 140 * scale, freqEnd: 30, dur: 0.5 * scale, gain: 0.34, attack: 0.003 },
  { kind: 'noise', type: 'lowpass', freq: 1400, freqEnd: 180, dur: 0.6 * scale, gain: 0.28, attack: 0.002 },
  { kind: 'noise', type: 'highpass', freq: 2200, dur: 0.08, gain: 0.14, attack: 0.002 },
];

// Every noise layer always gets a `q` (defaulting to the engine's own 0.8) even if the
// original archetype cue never used one — a lowpass/highpass layer with no `q` set doesn't
// need it for that filter type, but the Weapon Lab panel lets you switch a layer's filter
// type freely (bandpass/notch DO care about `q`), so the slider needs a value to start from.
function addQDefaults(stages) {
  for (const layers of Object.values(stages)) {
    for (const layer of layers) if (layer.kind === 'noise' && layer.q == null) layer.q = 0.8;
  }
  return stages;
}
function withQDefaults(weapons) {
  for (const stages of Object.values(weapons)) addQDefaults(stages);
  return weapons;
}

export const DEFAULT_SFX = withQDefaults({
  // ── energy ──
  pulseLaser: {
    fire: laserZapLayers({ damage: 16 / 5 }, false),
    impact: [{ kind: 'noise', type: 'highpass', freq: 2600, freqEnd: 1400, dur: 0.06, gain: 0.10, attack: 0.002 }],
  },
  beamLaser: {
    fire: laserZapLayers({ damage: 2 }, true),
    impact: [{ kind: 'noise', type: 'highpass', freq: 2600, freqEnd: 1400, dur: 0.06, gain: 0.10, attack: 0.002 }],
  },
  railLance: {
    fire: laserZapLayers({ damage: 34 }, false),
    impact: [{ kind: 'noise', type: 'highpass', freq: 2600, freqEnd: 1400, dur: 0.06, gain: 0.10, attack: 0.002 }],
  },
  plasmaCannon: {
    fire: laserZapLayers({ damage: 18 }, false),
    trajectory: [{ kind: 'noise', type: 'bandpass', freq: 900, freqEnd: 1500, q: 0.8, dur: 0.18, gain: 0.06, attack: 0.01 }],
    impact: [
      { kind: 'noise', type: 'bandpass', freq: 2200, freqEnd: 900, q: 1.4, dur: 0.18, gain: 0.14, attack: 0.002 },
      { kind: 'tone', type: 'square', freq: 240, freqEnd: 80, dur: 0.12, gain: 0.10, attack: 0.004 },
    ],
  },
  flamethrower: {
    // Shorter/quieter than the old pulsed cue (dur 0.16/gain 0.10) — this now retriggers
    // every ~45ms as a continuous stream, so a long decay would smear into a muddy drone.
    fire: [{ kind: 'noise', type: 'bandpass', freq: 1100, freqEnd: 600, q: 0.6, dur: 0.08, gain: 0.08, attack: 0.002 }],
    impact: [{ kind: 'noise', type: 'lowpass', freq: 900, dur: 0.12, gain: 0.07, attack: 0.002 }],
  },

  // ── ballistic ──
  autocannon: {
    fire: gunCrackLayers(false),
    impact: [
      { kind: 'noise', type: 'highpass', freq: 2000, freqEnd: 800, dur: 0.05, gain: 0.18, attack: 0.002 },
      { kind: 'tone', type: 'triangle', freq: 320, freqEnd: 120, dur: 0.06, gain: 0.10, attack: 0.004 },
    ],
  },
  machineGun: {
    fire: [
      { kind: 'noise', type: 'bandpass', freq: 1300, freqEnd: 20, dur: 0.36, gain: 0.2, attack: 0, q: 0.45 },
      { kind: 'tone', type: 'sawtooth', freq: 45, freqEnd: 20, dur: 0.155, gain: 0.3, attack: 0.04 },
    ],
    impact: [
      { kind: 'noise', type: 'bandpass', freq: 1275, freqEnd: 20, dur: 0.005, gain: 0.05, attack: 0, q: 0.1 },
      { kind: 'tone', type: 'sine', freq: 610, freqEnd: 20, dur: 0.005, gain: 0.2, attack: 0 },
    ],
  },
  shotgun: {
    fire: gunCrackLayers(false),
    impact: [
      { kind: 'noise', type: 'highpass', freq: 2000, freqEnd: 800, dur: 0.05, gain: 0.18, attack: 0.002 },
      { kind: 'tone', type: 'triangle', freq: 320, freqEnd: 120, dur: 0.06, gain: 0.10, attack: 0.004 },
    ],
  },
  napalm: {
    fire: [
      { kind: 'tone', type: 'triangle', freq: 130, freqEnd: 60, dur: 0.16, gain: 0.22, attack: 0.004 },
      { kind: 'noise', type: 'lowpass', freq: 700, dur: 0.10, gain: 0.12, attack: 0.002 },
    ],
    trajectory: [{ kind: 'noise', type: 'bandpass', freq: 350, freqEnd: 250, q: 0.9, dur: 0.22, gain: 0.05, attack: 0.02 }],
    impact: blastLayers(0.55),
  },

  // ── missile ──
  swarmRack: {
    fire: missileWhooshLayers(),
    trajectory: [{ kind: 'noise', type: 'bandpass', freq: 600, freqEnd: 900, q: 0.8, dur: 0.20, gain: 0.05, attack: 0.02 }],
    impact: blastLayers(0.55),
  },
  streakPod: {
    fire: missileWhooshLayers(),
    trajectory: [{ kind: 'noise', type: 'bandpass', freq: 600, freqEnd: 900, q: 0.8, dur: 0.20, gain: 0.05, attack: 0.02 }],
    impact: blastLayers(0.55),
  },
  clusterRocket: {
    fire: missileWhooshLayers(),
    trajectory: [{ kind: 'noise', type: 'bandpass', freq: 600, freqEnd: 900, q: 0.8, dur: 0.20, gain: 0.05, attack: 0.02 }],
    impact: blastLayers(0.55),
  },
});

// ── Held/looping SFX (#53) ──────────────────────────────────────────────────────────────
// Hold-to-fire, continuous weapons (cycleTime: 0, pattern: 'stream') don't retrigger a
// one-shot burst every cadence tick — instead they get ONE continuous source that starts
// on button-down and stops on button-up (see AudioEngine.startHeld/stopHeld + sfx.js's
// startHeld). This is a separate table (not nested under a weapon's fire/trajectory/impact
// stages) since it's a fundamentally different playback lifecycle (loop, not one-shot decay)
// — the Weapon Lab panel doesn't expose it yet (out of scope; edit these by hand).
export const HELD_SFX = {
  // Flamethrower: a filtered-noise roar — bandpass noise centered in the "fire" range,
  // wide-ish Q so it reads as a breathy gout rather than a whistle.
  flamethrower: { kind: 'noise', type: 'bandpass', freq: 700, q: 0.5, gain: 0.14 },
  // Beam Laser: a sustained tone hum — sawtooth for a buzzy energy-weapon timbre.
  beamLaser: { kind: 'tone', type: 'sawtooth', freq: 320, gain: 0.10 },
};

// Cheap lookup for firing.js: does this weapon use a held/looping sound instead of a
// per-shot one-shot fire cue?
export function hasHeldSfx(weaponId) {
  return !!HELD_SFX[weaponId];
}

// ms after the fire cue before the trajectory ("now it's airborne") cue plays — shared by
// the arena and the Weapon Lab preview so the timing feels identical in both.
export const TRAJECTORY_DELAY = 90;

// localStorage persistence for the Weapon Lab sound panel's tuning, so a reload doesn't
// lose it. Merges saved values UNDER the current defaults (field by field, layer by layer)
// so a save from before a weapon/field was added still loads safely — anything the save
// doesn't cover falls back to the shipped default rather than going missing.
const STORAGE_KEY = 'mech-game-sfx-params-v1';

export function loadSfxParams() {
  let saved = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    saved = raw ? (JSON.parse(raw) ?? {}) : {};
  } catch {
    saved = {};
  }
  const merged = {};
  for (const weaponId of Object.keys(DEFAULT_SFX)) {
    const def = DEFAULT_SFX[weaponId];
    const sav = saved[weaponId] || {};
    const entry = {};
    for (const stage of Object.keys(def)) {
      const savedLayers = sav[stage] || [];
      entry[stage] = def[stage].map((layer, i) => ({ ...layer, ...savedLayers[i] }));
    }
    merged[weaponId] = entry;
  }
  return merged;
}

export function saveSfxParams(params) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  } catch {
    // localStorage blocked/unavailable — tuning still works this session.
  }
}

// Fallback for a weapon id with no entry above (keeps the panel/engine safe for any future
// weapon added without sound design yet) — the old default ballistic crack + slug clank.
export const FALLBACK_SFX = addQDefaults({
  fire: gunCrackLayers(false),
  impact: [
    { kind: 'noise', type: 'highpass', freq: 2000, freqEnd: 800, dur: 0.05, gain: 0.18, attack: 0.002 },
    { kind: 'tone', type: 'triangle', freq: 320, freqEnd: 120, dur: 0.06, gain: 0.10, attack: 0.004 },
  ],
});
