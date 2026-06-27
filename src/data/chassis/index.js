// Chassis registry. Each weight class is a plain config (light/medium/heavy.js);
// makeChassis expands it into full per-location stats so the config files stay short
// and declarative. Mirrors the horse game's species registry: adding a chassis is a
// new config + one entry here, no model changes.

import { LOCATIONS, LOCATION_INFO } from '../anatomy.js';
import { LIGHT_CONFIG } from './light.js';
import { STRIKER_CONFIG } from './striker.js';
import { MEDIUM_CONFIG } from './medium.js';
import { HEAVY_CONFIG } from './heavy.js';
import { ASSAULT_CONFIG } from './assault.js';

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
      // Linear feel.
      accel: m.accel,           // px/s² while throttling
      maxSpeed: m.maxSpeed,     // px/s top speed (forward)
      turnRate: m.turnRate,     // rad/s the legs/chassis can rotate
      // Turret feel.
      turretSlew: m.turretSlew, // rad/s the weapon mount tracks toward the aim
      turretArc: m.turretArcDeg * Math.PI / 180, // max deviation (half-arc) from chassis facing
      // Stompy gait.
      stepInterval: m.stepInterval, // ms between footfalls at full speed
      stepBob: m.stepBob,           // px of body lurch per step
    },
  };
}

// Built registry: weight-class id → full chassis def.
export const CHASSIS = Object.fromEntries(
  [LIGHT_CONFIG, STRIKER_CONFIG, MEDIUM_CONFIG, HEAVY_CONFIG, ASSAULT_CONFIG].map((cfg) => [cfg.id, makeChassis(cfg)]),
);

export const CHASSIS_IDS = Object.keys(CHASSIS);

export function getChassis(id) {
  return CHASSIS[id] ?? CHASSIS.medium;
}
