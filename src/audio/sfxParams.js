// Per-weapon SFX parameters — the tunable data behind the Weapon Lab's sound panel. Each
// weapon gets up to three stages: `fire` (trigger pull), `trajectory` (a brief in-flight
// flavor cue, fired a beat after launch — only weapons with a noticeable flight time have
// one), and `impact` (on landing). Each stage is an array of layers (see sfxLayers.js); a
// layer is `{ kind: 'tone' | 'noise', ...e.tone()/e.noise() fields }`.
//
// Every weapon's `fire` stage has exactly 2 tone + 2 noise layers, even if a weapon only
// ever used one kind — the unused ones sit at gain 0 (silent) so the panel's knob layout is
// identical across weapons, and there's always somewhere to grow a sound without adding a
// new layer slot. (Held/looping weapons — flamethrower, beamLaser — are the same 4-layer
// shape; startHeld just loops whichever layers are non-zero instead of decaying them out.)
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
// Every weapon's `fire` stage has exactly 2 tone + 2 noise layers, so every weapon's sound
// panel has the same knob layout — weapons that only ever used one kind get the other kind
// added at gain 0 (silent until tuned) rather than left out.
const laserZapLayers = (weapon, stream) => {
  const base = Math.max(180, Math.min(1300, 1000 - weapon.damage * 11));
  return [
    { kind: 'tone', type: 'sawtooth', freq: base * 2.4, freqEnd: base, dur: stream ? 0.07 : 0.15, gain: 0.13, attack: 0.001 },
    { kind: 'tone', type: 'square', freq: base, freqEnd: base * 0.6, dur: stream ? 0.06 : 0.10, gain: 0.06, attack: 0.004 },
    { kind: 'noise', type: 'highpass', freq: 1800, freqEnd: 900, dur: 0.06, gain: 0, attack: 0.001, q: 0.8 },
    { kind: 'noise', type: 'bandpass', freq: 1000, freqEnd: 600, dur: 0.08, gain: 0, attack: 0.002, q: 1.0 },
  ];
};
const missileWhooshLayers = () => [
  { kind: 'noise', type: 'bandpass', freq: 480, freqEnd: 1700, q: 0.7, dur: 0.34, gain: 0.16, attack: 0.02 },
  { kind: 'tone', type: 'sawtooth', freq: 200, freqEnd: 440, dur: 0.22, gain: 0.05, attack: 0.004 },
  { kind: 'noise', type: 'highpass', freq: 1200, freqEnd: 600, dur: 0.1, gain: 0, attack: 0.002, q: 0.8 },
  { kind: 'tone', type: 'square', freq: 300, freqEnd: 500, dur: 0.12, gain: 0, attack: 0.004 },
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

// ── Destruction explosion (#107): a FEW discrete size categories ────────────────────────
// #100 gave the death-explosion cue a single entry (`deathExplosion` below) continuously
// scaled at trigger time (see `scaleExplosionLayer`, driven by `deathScaleFor`) but no Weapon
// Lab UI to tune it. Rather than exposing that one continuous scale as a slider, the KILL
// explosion is split into a few discrete SIZE CATEGORIES — each its OWN entry in this same
// DEFAULT_SFX table (`deathExplosionSmall/Medium/Large/Massive`, defined alongside
// `deathExplosion` below), independently tunable through the exact same
// getSfxParams/setSfxParam/resetSfxParams plumbing every real weapon already uses — no new
// persistence/API needed. `deathExplosion` itself (continuous) is untouched, still driving
// the other two `Audio.explosion()` callers (a part breaking off, the player's own MECH DOWN)
// which #107 leaves alone; only the per-kill boom (`Audio.deathExplosion`, scenes/arena/
// combat.js `_deathFx`) switches to a category lookup (`explosionCategoryFor`, shared.js).
export const EXPLOSION_CATEGORIES = ['small', 'medium', 'large', 'massive'];
export const EXPLOSION_CATEGORY_LABEL = {
  small: 'Small (drone / infantry)',
  medium: 'Medium (tank / turret / light mech)',
  large: 'Large (medium mech)',
  massive: 'Massive (heavy mech)',
};
const EXPLOSION_CATEGORY_SCALE = { small: 0.65, medium: 0.85, large: 1.15, massive: 1.55 };
const EXPLOSION_CATEGORY_SFX_ID = {
  small: 'deathExplosionSmall', medium: 'deathExplosionMedium',
  large: 'deathExplosionLarge', massive: 'deathExplosionMassive',
};
// The sfxParams (DEFAULT_SFX) key tunable for a given category — falls back to 'medium' for
// an unrecognized category rather than throwing.
export function explosionSfxId(category) {
  return EXPLOSION_CATEGORY_SFX_ID[category] ?? EXPLOSION_CATEGORY_SFX_ID.medium;
}

// Reshape one death-explosion layer by a size factor `s`: more sustain (boomier), louder, and
// pitched DOWN (lower frequency = more bass) for a bigger blast. Pure — no engine/context
// reads — so it's trivially unit-testable; used both by the continuous `explosion(scale)`
// path (sfx.js) and to bake the four discrete category defaults below from one base recipe.
export function scaleExplosionLayer(l, s) {
  const out = { ...l };
  if (out.dur != null) out.dur = out.dur * s;                                    // more sustain = boomier
  if (out.gain != null && out.gain > 0) out.gain = out.gain * (0.7 + 0.3 * s);   // louder for a bigger kill
  if (out.freq != null) out.freq = out.freq / s;                                 // lower pitch = more bass
  if (out.freqEnd != null) out.freqEnd = out.freqEnd / s;
  return out;
}

// The base death-explosion layer recipe (#100) — `deathExplosion` below uses it verbatim
// (continuously rescaled at trigger time by the two non-kill callers); the four discrete
// categories bake a fixed representative scale into their OWN independent copy via
// scaleExplosionLayer, so tuning one category's sliders never touches another's (or the
// continuous `deathExplosion` entry).
const DEATH_EXPLOSION_LAYERS = [
  { kind: 'tone', type: 'sine', freq: 140, freqEnd: 30, dur: 0.5, gain: 0.34, attack: 0.003 },     // sub-bass punch (boominess)
  { kind: 'noise', type: 'lowpass', freq: 1400, freqEnd: 180, dur: 0.6, gain: 0.28, attack: 0.002 }, // wide body
  { kind: 'noise', type: 'highpass', freq: 2200, dur: 0.08, gain: 0.14, attack: 0.002 },             // high crack
  { kind: 'tone', type: 'square', freq: 90, freqEnd: 35, dur: 0.3, gain: 0, attack: 0.004 },         // silent — open slot for tuning
];

export const DEFAULT_SFX = withQDefaults({
  // ── energy ──
  pulseLaser: {
    // Bespoke SHORT laser tick (do NOT revert to laserZapLayers). The pulse laser fires a
    // 5-shot burst 75ms apart (weapons.js wubOn 25 + wubOff 50); the shared laserZapLayers'
    // 0.15s/0.10s tones outlast that gap and smear the 5 flashes into one continuous buzz.
    // Each zap here is a crisp ~0.05s "pew" (comfortably under the 75ms gap) with a fast
    // attack, so all 5 read as distinct ticks aligned to the 5 beam flashes. Same laser
    // timbre as laserZapLayers (sawtooth + square, descending freq→freqEnd sweep) at
    // base≈964.8 (1000 − 3.2·11); the 2 noise layers stay gain 0, matching that helper's
    // output. Keeps the 2-tone + 2-noise shape every weapon uses.
    fire: [
      { kind: 'tone', type: 'sawtooth', freq: 2316, freqEnd: 965, dur: 0.05, gain: 0.13, attack: 0.001 },
      { kind: 'tone', type: 'square', freq: 965, freqEnd: 579, dur: 0.04, gain: 0.06, attack: 0.001 },
      { kind: 'noise', type: 'highpass', freq: 1800, freqEnd: 900, dur: 0.045, gain: 0, attack: 0.001, q: 0.8 },
      { kind: 'noise', type: 'bandpass', freq: 1000, freqEnd: 600, dur: 0.045, gain: 0, attack: 0.002, q: 1.0 },
    ],
    impact: [{ kind: 'noise', type: 'highpass', freq: 2600, freqEnd: 1400, dur: 0.06, gain: 0.10, attack: 0.002 }],
  },
  beamLaser: {
    // Held/looping (#53) — hand-tuned via the Weapon Lab sound panel. The held loop opens with
    // a START PITCH SWELL (#): each audible layer bends UP a ~fifth then settles back to its
    // held pitch over ~340ms — the "bwaaah…hhhwww" spin-up — instead of a flat hum. `bend.to`
    // is a multiplier of `freq`, `bend.dur` the total swell time in seconds (see sfxLayers.js).
    fire: [
      { kind: 'tone', type: 'sawtooth', freq: 45, freqEnd: 20, dur: 0.005, gain: 0.15, attack: 0, bend: { to: 1.5, dur: 0.34 } },
      { kind: 'tone', type: 'sawtooth', freq: 20, freqEnd: 20, dur: 0.005, gain: 0.15, attack: 0, bend: { to: 1.5, dur: 0.34 } },
      { kind: 'noise', type: 'bandpass', freq: 1395, freqEnd: 20, dur: 0.005, gain: 0.05, attack: 0, q: 4.6000000000000005, bend: { to: 1.3, dur: 0.34 } },
      { kind: 'noise', type: 'bandpass', freq: 1490, freqEnd: 20, dur: 0.005, gain: 0.05, attack: 0, q: 4.15, bend: { to: 1.3, dur: 0.34 } },
    ],
    impact: [{ kind: 'noise', type: 'highpass', freq: 2600, freqEnd: 1400, dur: 0.06, gain: 0, attack: 0.002, q: 0.8 }],
  },
  railLance: {
    fire: laserZapLayers({ damage: 34 }, false),
    impact: [{ kind: 'noise', type: 'highpass', freq: 2600, freqEnd: 1400, dur: 0.06, gain: 0.10, attack: 0.002 }],
  },
  // #117: plasmaLance — its own tuned cue, not a beamLaser/plasmaCannon reuse. Fire uses the
  // shared laser-zap tone/noise layers (heavier — damage 20 pulls the base pitch down a touch
  // vs plasmaCannon's 18), plus (originally) a trajectory hum, and a punchier impact than
  // plasmaCannon's to read as a heavier bolt. #125: the weapon's actual per-bolt damage dropped
  // to 2 (traded for a 20/sec stream cadence), but this cue's `damage: 20` is deliberately left
  // as-is — it's a tone-shaping input for the fire pitch, not read from the live weapon, and
  // keeping it preserves the heavier bolt sound that's part of the "look" Jackson wants kept.
  // The per-round `trajectory` HUM LOOP was dropped in the same pass: firing.js starts one
  // independent oscillator loop per projectile (stopped only at that round's impact/expiry, see
  // `_spawnProjectile`/fireWeapon's trajectory-loop wiring), and at a ~1s flight time with a new
  // bolt every 50ms that would stack ~15-20 overlapping hum loops during sustained fire — a wall
  // of noise, not a rapid-fire read. Every other `pattern: 'stream'` projectile weapon
  // (Repeater/machineGun) already has no per-round trajectory hum for the same reason; Plasma
  // Lance now matches that convention. The one-shot per-bolt fire crack (below) still plays
  // every tick via scheduleFireCues, so the rapid cadence still reads audibly.
  plasmaLance: {
    fire: laserZapLayers({ damage: 20 }, false),
    impact: [
      { kind: 'noise', type: 'bandpass', freq: 2000, freqEnd: 800, q: 1.3, dur: 0.2, gain: 0.16, attack: 0.002 },
      { kind: 'tone', type: 'square', freq: 210, freqEnd: 70, dur: 0.14, gain: 0.12, attack: 0.004 },
    ],
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
    // Held/looping (#53) — layer 1 is the audible sustained roar (matches the old separate
    // HELD_SFX entry so the sound didn't change when it was unified into `fire`); the other
    // 3 are silent until tuned. Sliders here now genuinely control the loop, not a dead cue.
    fire: [
      { kind: 'noise', type: 'bandpass', freq: 700, dur: 0.08, gain: 0.14, attack: 0.002, q: 0.5 },
      { kind: 'noise', type: 'highpass', freq: 1400, freqEnd: 600, dur: 0.06, gain: 0, attack: 0.001, q: 0.8 },
      { kind: 'tone', type: 'sawtooth', freq: 180, freqEnd: 120, dur: 0.08, gain: 0, attack: 0.004 },
      { kind: 'tone', type: 'square', freq: 260, freqEnd: 150, dur: 0.06, gain: 0, attack: 0.004 },
    ],
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
    // Bespoke layers (kept — do not revert to gunCrackLayers). Muted 2nd noise/2nd tone
    // slots added so this has the same 2-noise + 2-tone shape as autocannon/shotgun (#54);
    // gain 0 until tuned, everything else untouched.
    fire: [
      { kind: 'noise', type: 'bandpass', freq: 1300, freqEnd: 20, dur: 0.36, gain: 0.2, attack: 0, q: 0.45 },
      { kind: 'noise', type: 'highpass', freq: 1600, freqEnd: 700, dur: 0.045, gain: 0, attack: 0.0008 },
      { kind: 'tone', type: 'sawtooth', freq: 45, freqEnd: 20, dur: 0.155, gain: 0.3, attack: 0.04 },
      { kind: 'tone', type: 'square', freq: 440, freqEnd: 150, dur: 0.035, gain: 0, attack: 0.002 },
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
      { kind: 'tone', type: 'square', freq: 200, freqEnd: 100, dur: 0.1, gain: 0, attack: 0.004 },
      { kind: 'noise', type: 'highpass', freq: 1500, freqEnd: 700, dur: 0.05, gain: 0, attack: 0.001, q: 0.8 },
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

  // ── death / part-break explosion (#100) ──────────────────────────────────────────────
  // Not a weapon — the death-explosion cue (Audio.explosion, `sfx.js` explosion()) used to be
  // a hand-written function with hardcoded numbers. Giving it an entry in this SAME table
  // (rather than a parallel data structure) means it's tunable through the identical
  // load/save/reset plumbing every weapon's sound already goes through (loadSfxParams,
  // AudioEngine.setSfxParam/getSfxParams/resetSfxParams, localStorage persistence) with zero
  // new code — `deathExplosion` is just another key of DEFAULT_SFX. Same 2-tone + 2-noise `fire`
  // shape as every weapon (see the file header): layer 0 is the sub-bass "boominess" punch
  // (the low-frequency component + its own decay length is exactly the knob #100 asked for),
  // layer 1 the wide filtered-noise body, layer 2 the sharp high-frequency crack, layer 3 an
  // extra tone slot left silent (gain 0) for future tuning, matching every other weapon's shape.
  // `sfx.js` explosion() reads this table and additionally scales gain/dur/freq by the killed
  // enemy's size (`deathScaleFor`, shared.js) at trigger time — see `scaleExplosionLayer`.
  deathExplosion: {
    fire: DEATH_EXPLOSION_LAYERS.map((l) => ({ ...l })),
  },

  // ── discrete size categories (#107) — see the comment above EXPLOSION_CATEGORIES. Each is
  // its own DEFAULT_SFX entry (single `fire` stage, same 2-tone + 2-noise shape as
  // `deathExplosion`), baked from that same base recipe at a representative starting scale so
  // the categories still visibly graduate small→massive before anyone touches a slider.
  deathExplosionSmall: {
    fire: DEATH_EXPLOSION_LAYERS.map((l) => scaleExplosionLayer(l, EXPLOSION_CATEGORY_SCALE.small)),
  },
  deathExplosionMedium: {
    fire: DEATH_EXPLOSION_LAYERS.map((l) => scaleExplosionLayer(l, EXPLOSION_CATEGORY_SCALE.medium)),
  },
  deathExplosionLarge: {
    fire: DEATH_EXPLOSION_LAYERS.map((l) => scaleExplosionLayer(l, EXPLOSION_CATEGORY_SCALE.large)),
  },
  deathExplosionMassive: {
    fire: DEATH_EXPLOSION_LAYERS.map((l) => scaleExplosionLayer(l, EXPLOSION_CATEGORY_SCALE.massive)),
  },
});

// ── Held/looping SFX (#53) ──────────────────────────────────────────────────────────────
// Hold-to-fire, continuous weapons (cycleTime: 0, pattern: 'stream') don't retrigger a
// one-shot burst every cadence tick — instead they get ONE continuous source that starts on
// button-down and stops on button-up (see AudioEngine.startHeld/stopHeld + sfx.js's
// startHeld). The loop's SOUND now comes from the weapon's own `fire` layers (same data the
// Weapon Lab panel's sliders control — startLoopLayers just ignores the one-shot-only fields
// like dur/attack), so tuning `fire` genuinely retunes the loop. This set is only the
// membership flag: which weapons use the held/loop dispatch instead of a per-shot one-shot.
const HELD_WEAPONS = new Set(['flamethrower', 'beamLaser']);

// Cheap lookup for firing.js: does this weapon use a held/looping sound instead of a
// per-shot one-shot fire cue?
export function hasHeldSfx(weaponId) {
  return HELD_WEAPONS.has(weaponId);
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
      // Only merge a saved layer onto a default layer at the SAME index if they're the same
      // kind (tone vs. noise) — a layer count/order change (e.g. a new default layer
      // inserted) would otherwise splice a stale tone layer's fields onto a noise layer's
      // slot (kind/type included), silently turning it into the wrong kind of sound.
      entry[stage] = def[stage].map((layer, i) => {
        const sl = savedLayers[i];
        return sl && sl.kind === layer.kind ? { ...layer, ...sl } : { ...layer };
      });
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
