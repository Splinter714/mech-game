// Medium chassis (~55t): the balanced workhorse. Middling speed, turn, and turret
// traverse with a noticeably weightier step than a light.
export const MEDIUM_CONFIG = {
  id: 'medium',
  name: 'Trooper',
  weightClass: 'medium',
  baseArmor: 64,
  baseStructure: 36,
  art: { bodyLen: 38, bodyWid: 30, accent: 0xe8a13a },
  movement: {
    // #45: speeds reduced ~25% from the original 130/420 (owner: tune to taste).
    accel: 315, maxSpeed: 98, turnRate: 1.9,
    turretSlew: 3.2, turretArcDeg: 110,
    stepInterval: 340, stepBob: 2.5,
  },
};
