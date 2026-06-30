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
    defaultRoster: () => ({
      [ACTIVE_MECH_KEY]: {
        chassisId: 'medium',
        name: 'Trooper-01',
        mounts: {
          rightArm: ['autocannon'],
          leftArm: ['pulseLaser'],
          leftTorso: ['clusterRocket'],
          rightTorso: ['machineGun'],
          centerTorso: ['jumpJet'],   // the ability slot — fills out a deployable default build
        },
      },
    }),
  },
};
