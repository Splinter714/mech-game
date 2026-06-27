// Light chassis (~35t): nimble and twitchy. High speed, fast turn, wide+fast turret
// traverse, quick light footfalls — the scout/skirmisher feel.
export const LIGHT_CONFIG = {
  id: 'light',
  name: 'Scout',
  weightClass: 'light',
  baseArmor: 40,       // center-torso armor baseline; other parts scale from it
  baseStructure: 24,
  slots: { head: 1, centerTorso: 2, leftTorso: 2, rightTorso: 2, leftArm: 2, rightArm: 2, leftLeg: 2, rightLeg: 2 },
  art: { bodyLen: 30, bodyWid: 22, accent: 0x49c2e8 },
  movement: {
    accel: 600, maxSpeed: 180, turnRate: 2.6,
    turretSlew: 4.5, turretArcDeg: 130,
    stepInterval: 260, stepBob: 1.5,
  },
};
