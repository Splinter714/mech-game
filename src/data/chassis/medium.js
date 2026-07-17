// Medium chassis (~55t): the balanced workhorse. Middling speed, turn, and turret
// traverse with a noticeably weightier step than a light.
export const MEDIUM_CONFIG = {
  id: 'medium',
  name: 'Trooper',
  weightClass: 'medium',
  baseArmor: 64,
  baseHp: 36,
  art: { bodyLen: 38, bodyWid: 30, accent: 0xe8a13a },
  movement: {
    // #3 MechWarrior-feel pass. The workhorse: noticeably more ponderous than a light —
    // slower to spool up, longer coast, lazier turn + turret, a heavier planted step.
    // See light.js for what each knob does. Momentum gap (accel vs decel) is wider than a
    // light's, so a medium "leans into" starts and stops more.
    // #159: maxSpeed bumped from 98 → 195 (×135/68 ≈ 1.9853 — same uniform scale factor as
    // light.js/heavy.js, so medium keeps landing between the two at its old relative spacing).
    accel: 210, decel: 140, maxSpeed: 195, turnRate: 1.55,
    // #86: restored from 2.0 back to 2.9 (the #3 feel-follow-up value) — playtest read the
    // 2.0 slew as "choppy" aiming; profiling showed steady 60fps (see profile-aim-idle.mjs),
    // so it was the slew rate lagging a fast aim change, not a frame-rate/update-frequency bug.
    turretSlew: 2.9, turretArcDeg: 110,
    stepInterval: 340, stepBob: 2.7, footShake: 2.0,
  },
};
