// #240 — the boss chassis. A siege colossus roughly 10x the player's medium mech on screen
// (see data/boss.js BOSS_SCALE, which owns the DISPLAY multiple; this file owns its stats and
// locomotion feel). Deliberately NOT reachable from the garage — the chassis switcher is
// disabled (#248 forces every player mech onto 'mediumPlayer'), and nothing adds this id to a
// player-facing list, so it exists purely as the boss's stat block.
//
// Stats: baseArmor/baseHp are expanded per-location by chassis/index.js's FACTORS, so a side
// torso ends up at ~0.85x and an arm ~0.6x of these. Picked so each ARM is a real minute-long
// grind and each SIDE TORSO is noticeably tougher than an arm — that ordering is what makes
// "strip the reachable limbs first, then grind a torso" the natural line of play, and it means
// the torso→arm destroy cascade (anatomy.js DESTROY_CASCADE) has already been made moot by the
// time a torso falls, so no limb's weapon is ever taken away for free.
//
// Movement: a SLOW SIEGE PLATFORM, not a chaser (Jackson's explicit direction). maxSpeed is a
// crawl — under a fifth of the slowest existing enemy mech chassis — and turnRate is glacial, so
// it dominates by reach and firepower while the player circles it. turretSlew is deliberately
// NOT slow (the guns still track you) and turretArcDeg is a full 180 so it can bring weapons to
// bear all the way around its own front without the hull ever catching up.
export const COLOSSUS_CONFIG = {
  id: 'colossus',
  name: 'Colossus',
  weightClass: 'colossus',
  // #299: converted from the old per-location baseArmor/baseHp (420/260) to whole-chassis
  // totals. These are the EXACT sums the old baselines expanded to, so the boss's stat block
  // is unchanged by the balance pass — it was not part of #299's table.
  totalArmor: 1218,
  totalHp: 754,
  art: { bodyLen: 44, bodyWid: 38, accent: 0xd63a3a },
  movement: {
    accel: 40, decel: 30, maxSpeed: 26, turnRate: 0.22,
    turretSlew: 1.15, turretArcDeg: 180,
    stepInterval: 1100, stepBob: 4.0, footShake: 6.0,
  },
};
