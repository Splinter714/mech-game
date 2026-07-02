// Chassis registry. Each weight class is a plain config (light/medium/heavy.js);
// makeChassis expands it into full per-location stats so the config files stay short
// and declarative. Mirrors the horse game's species registry: adding a chassis is a
// new config + one entry here, no model changes.

import { LOCATIONS, LOCATION_INFO } from '../anatomy.js';
import { LIGHT_CONFIG } from './light.js';
import { MEDIUM_CONFIG } from './medium.js';
import { HEAVY_CONFIG } from './heavy.js';

// Relative bulk of each location, used to distribute armor + structure from the
// chassis' center-torso baseline. The cockpit is internal (no armor), tiny structure.
const FACTORS = {
  head: 0.4, cockpit: 0.18, centerTorso: 1,
  leftTorso: 0.75, rightTorso: 0.75,
  leftArm: 0.6, rightArm: 0.6,
};

// Expand a chassis config into a full definition with per-location slots/armor/
// structure and movement tuning (radians precomputed from the human-friendly degrees).
export function makeChassis(cfg) {
  const locations = {};
  for (const id of LOCATIONS) {
    const info = LOCATION_INFO[id];
    const f = FACTORS[id];
    locations[id] = {
      maxArmor: info.internal ? 0 : Math.round(cfg.baseArmor * f),
      maxStructure: Math.max(1, Math.round(cfg.baseStructure * f)),
    };
  }
  const m = cfg.movement;
  return {
    id: cfg.id,
    name: cfg.name,
    weightClass: cfg.weightClass,
    art: cfg.art,
    locations,
    movement: {
      // Linear feel — accel and decel are SEPARATE so the mech carries momentum (#3):
      // spool up at `accel`, coast down at the (lower) `decel` when you ease off/reverse.
      accel: m.accel,               // px/s² while throttling toward the stick target
      decel: m.decel ?? m.accel,    // px/s² while bleeding speed (defaults to accel if unset)
      maxSpeed: m.maxSpeed,         // px/s top speed (forward)
      turnRate: m.turnRate,         // rad/s the legs/chassis can rotate
      // Turret feel.
      turretSlew: m.turretSlew, // rad/s the weapon mount tracks toward the aim
      turretArc: m.turretArcDeg * Math.PI / 180, // max deviation (half-arc) from chassis facing
      // Stompy gait + footfall.
      stepInterval: m.stepInterval, // ms between footfalls at full speed
      stepBob: m.stepBob,           // px of body lurch per step
      footShake: m.footShake ?? 0,  // px of step-synced camera kick (weight cue; 0 = none)
    },
  };
}

// Built registry: weight-class id → full chassis def.
export const CHASSIS = Object.fromEntries(
  [LIGHT_CONFIG, MEDIUM_CONFIG, HEAVY_CONFIG].map((cfg) => [cfg.id, makeChassis(cfg)]),
);

export const CHASSIS_IDS = Object.keys(CHASSIS);

export function getChassis(id) {
  return CHASSIS[id] ?? CHASSIS.medium;
}
