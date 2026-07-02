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
    // #3 MechWarrior-feel pass. The workhorse: noticeably more ponderous than a light —
    // slower to spool up, longer coast, lazier turn + turret, a heavier planted step.
    // See light.js for what each knob does. Momentum gap (accel vs decel) is wider than a
    // light's, so a medium "leans into" starts and stops more.
    accel: 210, decel: 140, maxSpeed: 98, turnRate: 1.55,
    // #3 feel follow-up: torso-twist rate slowed (was 2.9) for a heavier, more deliberate swing.
    turretSlew: 2.0, turretArcDeg: 110,
    stepInterval: 340, stepBob: 2.7, footShake: 2.0,
  },
};
