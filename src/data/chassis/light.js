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
    // #45: speeds reduced ~25% from the original 180/600 (owner: tune to taste).
    accel: 450, maxSpeed: 135, turnRate: 2.6,
    turretSlew: 4.5, turretArcDeg: 130,
    stepInterval: 260, stepBob: 1.5,
  },
};
