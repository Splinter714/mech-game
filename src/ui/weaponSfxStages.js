// #177: the weapon domain's default stage list, split out of weaponSfxPanel.js into its own
// Phaser-free module so it (and, by extension, the generalized `stages` shape every domain
// descriptor uses — see src/audio/sfxDomains.js) can be imported by plain unit tests without
// dragging in Phaser (which requires browser globals at import time). weaponSfxPanel.js
// re-exports this unchanged for existing callers.
export const WEAPON_STAGES = [
  ['fire', 'FIRE (trigger pull)'],
  ['trajectory', 'TRAJECTORY (in flight)'],
  ['impact', 'IMPACT (on landing)'],
];

// #191: pure planning for the "▶ test fire" button's stage sequence, given the CURRENT
// target's own `stages` list (WEAPON_STAGES by default, or whatever a non-weapon domain's
// setTarget()/setWeapon() supplied — see src/audio/sfxDomains.js). Before this, _testFire()
// ignored `stages` entirely and hardcoded 'fire'/'trajectory'/'impact' as the three stage
// names to preview — harmless for a real weapon (whose stages ARE that triple), but for a
// non-weapon UI cue (#177/#178, whose only stage is `play`) it meant pressing "test fire" on,
// say, the "Equip Weapon" UI sound played `_playStage('fire')`, which routes through
// WeaponSfxPanel's weapon-shaped branch (`Audio.fire({ id: this.weaponId })`) with
// `weaponId` set to the UI id `'equip'` — an id getSfxParams()/WEAPONS don't recognize, so it
// silently fell back to a generic procedural WEAPON sound instead of ever touching the UI
// sound's own override/bake/procedural def (the reported bug). Building the plan from the
// target's OWN stage keys fixes this generically for any domain:
//  - a weapon-shaped target (its stages include 'fire') keeps today's "fire now, trajectory a
//    beat later, impact after that" cadence — but only for stages it ACTUALLY has (so an
//    explosion category's lone `fire` stage still just plays `fire`, unchanged from before).
//  - anything else (no 'fire' stage at all — every non-weapon domain entry) just plays each of
//    its own registered stages once, immediately — e.g. the UI domain's single `play` stage.
export function testFirePlan(stages, trajectoryDelayMs, impactDelayMs = 300) {
  const keys = stages.map(([key]) => key);
  if (keys.includes('fire')) {
    const plan = [{ stage: 'fire', delay: 0 }];
    if (keys.includes('trajectory')) plan.push({ stage: 'trajectory', delay: trajectoryDelayMs });
    if (keys.includes('impact')) plan.push({ stage: 'impact', delay: impactDelayMs });
    return plan;
  }
  return keys.map((stage) => ({ stage, delay: 0 }));
}
