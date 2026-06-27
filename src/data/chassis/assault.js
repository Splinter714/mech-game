// Assault chassis (~90t): the immovable object. Crawls and turns slowly, slow turret
// tracking, ground-quaking footfalls — but enormous armor. The "stand and bombard" mech.
export const ASSAULT_CONFIG = {
  id: 'assault',
  name: 'Colossus',
  weightClass: 'assault',
  baseArmor: 120,
  baseStructure: 64,
  art: { bodyLen: 52, bodyWid: 44, accent: 0x9a6ad6 },
  movement: {
    accel: 200, maxSpeed: 72, turnRate: 1.0,
    turretSlew: 1.8, turretArcDeg: 90,
    stepInterval: 520, stepBob: 4.5,
  },
};
