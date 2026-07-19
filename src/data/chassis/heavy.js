// Heavy chassis (~75t): the big stompy bruiser. Slow to accelerate and turn, a
// narrow+slow turret traverse (you must turn the whole mech to track flankers), and a
// ground-shaking gait. Carries far more armor and slots.
export const HEAVY_CONFIG = {
  id: 'heavy',
  name: 'Bulwark',
  weightClass: 'heavy',
  // #299 balance pass (owner-set totals): 200 structure / 225 armor / 75 shield = 500 total.
  totalArmor: 225,
  totalHp: 200,
  // Blocky bruiser silhouette (#24): a small head sunk BACK between huge shoulder
  // pauldrons, arms hung low/forward in a siege stance, broad torso, thick stubby limbs,
  // a narrow planted stance, with rear exhaust stacks — the immovable object.
  art: {
    bodyLen: 46, bodyWid: 38, accent: 0xe2533a,
    shape: { head: 1.08, torso: 1.18, sideTorso: 1.2, armW: 1.32, armH: 0.8, armSpread: 0.88, legW: 1.45, legH: 0.8, legSpread: 0.86, legDrop: 0.95, headDy: 0.04, armDy: 0.07 },
    decor: [{ kind: 'pauldron', side: -1 }, { kind: 'pauldron', side: 1 }, { kind: 'stack', side: -1 }, { kind: 'stack', side: 1 }],
  },
  movement: {
    // #3 MechWarrior-feel pass. The immovable object: it takes real time to get moving and
    // a long slow coast to stop, the whole chassis pivots slowly, the turret crawls (you
    // often have to turn the body to track a flanker), and each footfall lands like a pile
    // driver. Deliberately the most ponderous — but NOT unresponsive: it still answers the
    // stick, it just answers heavily. See light.js for what each knob does. Widest
    // accel↔decel gap = the most momentum-heavy start-up and coast of the three.
    // #159: maxSpeed bumped from 68 → 135 — exactly light's OLD (pre-#159) maxSpeed, per the
    // owner's ask ("biggest mech should increase to current smallest mech"). That's a ×135/68
    // ≈ 1.9853 scale factor, applied uniformly to light/medium too (see those files) so the
    // whole lineup keeps its old relative ordering/spacing at the new, faster range.
    accel: 120, decel: 80, maxSpeed: 135, turnRate: 1.0,
    // #86: restored from 1.3 back to 1.9 (the #3 feel-follow-up value) — playtest read the
    // 1.3 slew as "choppy/laggy" aiming; profiling showed a steady 60fps with sub-ms dt
    // jitter (profile-aim-idle.mjs), so the lag was the slew rate itself, not frame rate.
    // Still the weightiest of the three — you lean on turning the whole body to track a
    // flanker — just no longer so slow it reads as broken.
    turretSlew: 1.9, turretArcDeg: 95,
    stepInterval: 460, stepBob: 3.8, footShake: 4.0,
  },
};
