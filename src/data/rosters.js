// Garage roster config. The persisted "garage" is a set of saved mech builds; for
// Milestone 1 it's a single slot. Mirrors the horse game's per-species roster
// registry so adding more saved-build slots (or a separate enemy roster) is a data
// entry, not new loader code. Default builds are plain Mech.toJSON()-shaped data.

import { Mech } from './Mech.js';

// Player 1's build slot. Still THE slot as far as every single-player path is concerned —
// #349 added exactly one more ('mech2', player 2's persistent build in local co-op), it did not
// introduce a general roster picker. The two keys, indexed by player, live in
// data/coopGarage.js (PLAYER_MECH_KEYS); this constant stays the name single-player code uses.
export const ACTIVE_MECH_KEY = 'mech1';

// #349: player 2's build slot. Persists between sessions exactly like player 1's, so a regular
// co-op partner keeps their mech. It ships with its OWN complete default loadout rather than a
// copy of player 1's, so a first-ever co-op deploy puts two visibly different machines on the
// field and player 2 is never stuck behind an incomplete build.
export const PLAYER2_MECH_KEY = 'mech2';

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
      // #349: player 2's slot. Same chassis (every mech is locked to 'mediumPlayer' by the
      // migrate hook above anyway), a different but equally complete opening kit.
      [PLAYER2_MECH_KEY]: {
        chassisId: 'mediumPlayer',
        name: 'Trooper-02',
        mounts: {
          rightArm: ['pulseLaser'],
          leftArm: ['autocannon'],
          leftTorso: ['machineGun'],
          rightTorso: ['clusterRocket'],
        },
      },
    }),
  },
};
