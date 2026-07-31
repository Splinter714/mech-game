// Chassis registry. Each weight class is a plain config (light/medium/heavy.js);
// makeChassis expands it into full per-location stats so the config files stay short
// and declarative. Mirrors the horse game's species registry: adding a chassis is a
// new config + one entry here, no model changes.

import { LOCATIONS, LOCATION_INFO } from '../anatomy.js';
import { LIGHT_CONFIG } from './light.js';
import { MEDIUM_CONFIG } from './medium.js';
import { HEAVY_CONFIG } from './heavy.js';
// #299: the player's own medium variant (different stat totals from the enemy medium — see
// mediumPlayer.js). Registered like any other chassis; rosters.js force-migrates player mechs
// onto this id, and nothing in ENEMIES references it.
import { MEDIUM_PLAYER_CONFIG } from './mediumPlayer.js';
// #529: two more COSMETIC-ONLY player chassis variants (same stats as mediumPlayer, different
// art shape) for the Mech Lab's chassis-select tab — see strikerPlayer.js/colossusPlayer.js for
// why they're separate configs rather than an in-place art swap.
import { STRIKER_PLAYER_CONFIG } from './strikerPlayer.js';
import { COLOSSUS_PLAYER_CONFIG } from './colossusPlayer.js';

// Relative bulk of each damage-tracked location, used to distribute armor + HP (#246:
// renamed from "structure" — plain language, same layering) from the chassis' baseline
// stats. #128: head/cockpit/centerTorso dropped out of LOCATIONS (cosmetic only now, no
// armor/HP), so they no longer need a factor.
// #230: shoulder factor bumped 0.75 -> 0.85 (arm left at 0.6, so the HP ratio moves from
// ~1.25x to ~1.42x an arm's health). Paired with easing combat.js's player-hit weighting
// from 2:1 to 1.5:1 shoulder:arm, the two changes together bring the shoulders' effective
// destruction rate (hits-needed, factoring in how much more often they're hit) within
// ~6% of an arm's instead of shoulders dying ~1.6x faster — see _damagePlayerAt for the math.
const FACTORS = {
  leftShoulder: 0.85, rightShoulder: 0.85,
  leftArm: 0.6, rightArm: 0.6,
};

// #299: distribute a WHOLE-CHASSIS total across the damage-tracked locations by FACTORS weight,
// landing on the total EXACTLY. Per-location `Math.round` used to be the rule, which meant the
// summed total was whatever the rounding happened to produce — and because the locations come in
// symmetric pairs (shoulder ×2, arm ×2), a rounded total could only ever be EVEN. #299's table asks
// for odd totals (light armor 75, heavy armor 225), so the distribution now uses largest-
// remainder: floor each share, then hand the leftover points out to the largest fractional parts
// (ties broken by LOCATIONS order, so it's deterministic). At most one point of left/right
// asymmetry results, which is invisible in play and is the price of hitting the number the owner
// actually asked for.
function distribute(total, minEach = 0) {
  const weights = LOCATIONS.map((id) => (LOCATION_INFO[id].internal ? 0 : FACTORS[id]));
  const sumW = weights.reduce((a, b) => a + b, 0);
  const target = Math.max(0, total || 0);
  const ideal = weights.map((w) => (sumW > 0 ? (target * w) / sumW : 0));
  const out = ideal.map((v) => Math.floor(v));
  let left = target - out.reduce((a, b) => a + b, 0);
  const order = ideal
    .map((v, i) => [v - Math.floor(v), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]] += 1;
  return Object.fromEntries(LOCATIONS.map((id, i) => [
    id,
    LOCATION_INFO[id].internal ? 0 : Math.max(minEach, out[i]),
  ]));
}

// Expand a chassis config into a full definition with per-location slots/armor/HP
// and movement tuning (radians precomputed from the human-friendly degrees).
// #299: configs now declare whole-chassis TOTALS (`totalArmor` / `totalHp`) rather than the old
// per-location `baseArmor`/`baseHp` baselines, because the balance table is expressed as totals
// and back-solving a baseline by hand (then hoping the rounding cooperated) was exactly the
// drift this codebase keeps paying for. `sum(locations[*].maxArmor) === totalArmor` is now an
// invariant, proven in chassis.test.js.
export function makeChassis(cfg) {
  const armor = distribute(cfg.totalArmor);
  const hp = distribute(cfg.totalHp, 1);
  const locations = {};
  for (const id of LOCATIONS) {
    locations[id] = { maxArmor: armor[id], maxHp: hp[id] };
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
      // Stompy gait + footfall.
      stepInterval: m.stepInterval, // ms between footfalls at full speed
      stepBob: m.stepBob,           // px of body lurch per step
      footShake: m.footShake ?? 0,  // px of step-synced camera kick (weight cue; 0 = none)
    },
  };
}

// Built registry: weight-class id → full chassis def.
export const CHASSIS = Object.fromEntries(
  [
    LIGHT_CONFIG, MEDIUM_CONFIG, HEAVY_CONFIG,
    MEDIUM_PLAYER_CONFIG, STRIKER_PLAYER_CONFIG, COLOSSUS_PLAYER_CONFIG,
  ].map((cfg) => [cfg.id, makeChassis(cfg)]),
);

export const CHASSIS_IDS = Object.keys(CHASSIS);

// #529: the chassis ids a PLAYER may actually pick in the Mech Lab's chassis-select tab (tab 0)
// — cosmetic-only variants, all sharing mediumPlayer's stat block. In display/cycle order.
// rosters.js's migrate hook uses this to decide whether a saved chassisId is a legal player pick
// (kept as-is) or a stale/enemy one (force-migrated to mediumPlayer).
export const PLAYER_CHASSIS_IDS = ['mediumPlayer', 'strikerPlayer', 'colossusPlayer'];

export function getChassis(id) {
  return CHASSIS[id] ?? CHASSIS.medium;
}
