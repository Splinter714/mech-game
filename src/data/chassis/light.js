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
    shape: { head: 0.68, torso: 0.72, sideTorso: 0.66, armW: 0.58, armH: 1.42, armSpread: 1.24, legW: 0.58, legH: 1.4, legSpread: 1.4, legDrop: 1.14, headDy: -0.12, armDy: -0.12 },
    decor: [{ kind: 'mast', side: -1 }, { kind: 'vane', side: -1 }, { kind: 'vane', side: 1 }],
  },
  movement: {
    accel: 600, maxSpeed: 180, turnRate: 2.6,
    turretSlew: 4.5, turretArcDeg: 130,
    stepInterval: 260, stepBob: 1.5,
  },
};
