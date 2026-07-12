// Light chassis (~35t): nimble and twitchy. High speed, fast turn, wide+fast turret
// traverse, quick light footfalls — the scout/skirmisher feel.
export const LIGHT_CONFIG = {
  id: 'light',
  name: 'Scout',
  weightClass: 'light',
  baseArmor: 40,       // center-torso armor baseline; other parts scale from it
  baseStructure: 24,
  // Insectoid recon silhouette (#24): a tiny head thrust well FORWARD on a tall sensor
  // mast, long thin arms reaching forward, a slim torso flanked by swept-back vanes, and a
  // wide splayed light-footed stance — nothing like the upright trooper or the squat bruiser.
  art: {
    bodyLen: 30, bodyWid: 22, accent: 0x49c2e8,
    shape: { head: 0.78, torso: 0.9, sideTorso: 0.9, armW: 0.62, armH: 1.45, armSpread: 0.8, legW: 0.62, legH: 1.42, legSpread: 1.02, legDrop: 1.08, headDy: -0.03, armDy: -0.04 },
    decor: [{ kind: 'mast', side: -1 }, { kind: 'vane', side: -1 }, { kind: 'vane', side: 1 }],
  },
  movement: {
    // #3 MechWarrior-feel pass. Even a light mech is a walking tank: it takes a beat to
    // wind up to speed and coasts a bit when you let off. It's still the nimble one — the
    // fastest, quickest-turning, snappiest turret and lightest step of the three.
    // accel   px/s² spent winding UP to the throttle target (start-up snappiness).
    // decel   px/s² spent bleeding speed when you ease off / reverse. LOWER than accel =
    //         the mech carries momentum and coasts to a stop instead of braking instantly.
    // #159: maxSpeed bumped from 135 → 268 (×135/68 ≈ 1.9853, the same scale factor applied
    // to all three chassis so heavy lands exactly on light's OLD 135 while every chassis
    // keeps its old relative ordering/spacing — see heavy.js/medium.js for the same factor).
    accel: 340, decel: 240, maxSpeed: 268, turnRate: 2.3,
    // #86: the #3 feel follow-up dialled this down to 3.0 (from 4.2) for a weightier swing,
    // but playtest (2026-07-10) read it as "choppy/laggy aiming" — profiling ruled out FPS/
    // frame-pacing as the cause (steady 60fps, <1ms dt jitter; see scripts/profile-aim-idle.mjs),
    // so the slew rate itself was simply too slow to track a fast aim change. Restored to 4.2 —
    // still the snappiest of the three, just no longer sluggish enough to read as a bug.
    turretSlew: 4.2, turretArcDeg: 130,
    // stepInterval ms between footfalls at full speed; stepBob px of body lurch per step;
    // footShake px of step-synced camera kick (0 = none). Light = quick, shallow, gentle.
    stepInterval: 250, stepBob: 1.6, footShake: 0.9,
  },
};
