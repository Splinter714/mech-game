// Medium chassis (~55t): the balanced workhorse. Middling speed, turn, and turret
// traverse with a noticeably weightier step than a light.
export const MEDIUM_CONFIG = {
  id: 'medium',
  name: 'Trooper',
  weightClass: 'medium',
  baseArmor: 64,
  baseStructure: 36,
  slots: { head: 1, centerTorso: 3, leftTorso: 3, rightTorso: 3, leftArm: 3, rightArm: 3, leftLeg: 2, rightLeg: 2 },
  art: { bodyLen: 38, bodyWid: 30, accent: 0xe8a13a },
  movement: {
    accel: 420, maxSpeed: 130, turnRate: 1.9,
    turretSlew: 3.2, turretArcDeg: 110,
    stepInterval: 340, stepBob: 2.5,
  },
};
