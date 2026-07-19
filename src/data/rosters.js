// Garage roster config. The persisted "garage" is a set of saved mech builds; for
// Milestone 1 it's a single slot. Mirrors the horse game's per-species roster
// registry so adding more saved-build slots (or a separate enemy roster) is a data
// entry, not new loader code. Default builds are plain Mech.toJSON()-shaped data.

import { Mech } from './Mech.js';

// The single editable build slot for now.
export const ACTIVE_MECH_KEY = 'mech1';

export const ROSTERS = {
  mech: {
    storageKey: 'mech-game-mechs-v1',
    registryKey: 'allMechs',
    Model: Mech,
    // #248: the light/heavy chassis options are disabled for now (owner: "just roll with
    // the medium one and disable the switcher") — force every mech, including pre-existing
    // saves that picked light/heavy before this change, onto medium. This is a UI-level
    // restriction: the light/heavy chassis data (chassis/light.js, chassis/heavy.js) is
    // untouched, so removing this one-line migrate hook fully re-enables them later.
    // #299: the target is now 'mediumPlayer' — the player's own medium-class stat block
    // (chassis/mediumPlayer.js, 200/300/100) rather than the enemy medium the Warden uses.
    migrate: (data) => ({ ...data, chassisId: 'mediumPlayer' }),
    defaultRoster: () => ({
      [ACTIVE_MECH_KEY]: {
        chassisId: 'mediumPlayer',
        name: 'Trooper-01',
        mounts: {
          rightArm: ['autocannon'],
          leftArm: ['pulseLaser'],
          leftTorso: ['clusterRocket'],
          rightTorso: ['machineGun'],   // #188: centerTorso is no longer mountable — Sprint
                                         // (L3/Space) is a hardcoded built-in now, not an item.
        },
      },
    }),
  },
};
