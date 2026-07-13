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
