// Chassis registry. Each weight class is a plain config (light/medium/heavy.js);
// makeChassis expands it into full per-location stats so the config files stay short
// and declarative. Mirrors the horse game's species registry: adding a chassis is a
// new config + one entry here, no model changes.

import { LOCATIONS, LOCATION_INFO } from '../anatomy.js';
import { LIGHT_CONFIG } from './light.js';
import { MEDIUM_CONFIG } from './medium.js';
import { HEAVY_CONFIG } from './heavy.js';
// #240: the boss's stat block. Registered here like any other chassis (one config + one entry,
// per the standing convention) — it's simply never offered to the player, since the garage's
// chassis switcher is disabled and rosters.js force-migrates every player mech onto 'medium'.
import { COLOSSUS_CONFIG } from './colossus.js';

// Relative bulk of each damage-tracked location, used to distribute armor + HP (#246:
// renamed from "structure" — plain language, same layering) from the chassis' baseline
// stats. #128: head/cockpit/centerTorso dropped out of LOCATIONS (cosmetic only now, no
// armor/HP), so they no longer need a factor.
// #230: torso factor bumped 0.75 -> 0.85 (arm left at 0.6, so the HP ratio moves from
// ~1.25x to ~1.42x an arm's health). Paired with easing combat.js's player-hit weighting
// from 2:1 to 1.5:1 torso:arm, the two changes together bring torsos' effective
// destruction rate (hits-needed, factoring in how much more often they're hit) within
// ~6% of an arm's instead of torsos dying ~1.6x faster — see _damagePlayerAt for the math.
const FACTORS = {
  leftTorso: 0.85, rightTorso: 0.85,
  leftArm: 0.6, rightArm: 0.6,
};

// Expand a chassis config into a full definition with per-location slots/armor/HP
// and movement tuning (radians precomputed from the human-friendly degrees).
export function makeChassis(cfg) {
  const locations = {};
  for (const id of LOCATIONS) {
    const info = LOCATION_INFO[id];
    const f = FACTORS[id];
    locations[id] = {
      maxArmor: info.internal ? 0 : Math.round(cfg.baseArmor * f),
      maxHp: Math.max(1, Math.round(cfg.baseHp * f)),
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
  [LIGHT_CONFIG, MEDIUM_CONFIG, HEAVY_CONFIG, COLOSSUS_CONFIG].map((cfg) => [cfg.id, makeChassis(cfg)]),
);

export const CHASSIS_IDS = Object.keys(CHASSIS);

export function getChassis(id) {
  return CHASSIS[id] ?? CHASSIS.medium;
}
