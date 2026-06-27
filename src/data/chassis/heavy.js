// Heavy chassis (~75t): the big stompy bruiser. Slow to accelerate and turn, a
// narrow+slow turret traverse (you must turn the whole mech to track flankers), and a
// ground-shaking gait. Carries far more armor and slots.
export const HEAVY_CONFIG = {
  id: 'heavy',
  name: 'Bulwark',
  weightClass: 'heavy',
  baseArmor: 96,
  baseStructure: 52,
  art: { bodyLen: 46, bodyWid: 38, accent: 0xe2533a },
  movement: {
    accel: 280, maxSpeed: 90, turnRate: 1.3,
    turretSlew: 2.2, turretArcDeg: 95,
    stepInterval: 440, stepBob: 3.5,
  },
};
