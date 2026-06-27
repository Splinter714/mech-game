// Light chassis (~35t): nimble and twitchy. High speed, fast turn, wide+fast turret
// traverse, quick light footfalls — the scout/skirmisher feel.
export const LIGHT_CONFIG = {
  id: 'light',
  name: 'Scout',
  weightClass: 'light',
  baseArmor: 40,       // center-torso armor baseline; other parts scale from it
  baseStructure: 24,
  // Spindly skirmisher silhouette (#24): small head, narrow torso, thin long limbs, a
  // wide light-footed stance.
  art: {
    bodyLen: 30, bodyWid: 22, accent: 0x49c2e8,
    shape: { head: 0.85, torso: 0.82, sideTorso: 0.8, armW: 0.68, armH: 1.18, armSpread: 1.12, legW: 0.66, legH: 1.22, legSpread: 1.18, legDrop: 1.05 },
  },
  movement: {
    accel: 600, maxSpeed: 180, turnRate: 2.6,
    turretSlew: 4.5, turretArcDeg: 130,
    stepInterval: 260, stepBob: 1.5,
  },
};
