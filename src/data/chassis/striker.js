// Striker chassis (~45t): a fast, lightly-armored harasser — quicker and twitchier than
// the medium Trooper, with snappy turret tracking, trading armor for speed and agility.
export const STRIKER_CONFIG = {
  id: 'striker',
  name: 'Striker',
  weightClass: 'medium',
  baseArmor: 50,
  baseStructure: 30,
  art: { bodyLen: 34, bodyWid: 26, accent: 0x49e88f },
  movement: {
    accel: 540, maxSpeed: 162, turnRate: 2.4,
    turretSlew: 4.0, turretArcDeg: 140,
    stepInterval: 300, stepBob: 2.0,
  },
};
