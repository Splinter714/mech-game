// Garage roster config. The persisted "garage" is a set of saved mech builds; for
// Milestone 1 it's a single slot. Mirrors the horse game's per-species roster
// registry so adding more saved-build slots (or a separate enemy roster) is a data
// entry, not new loader code. Default builds are plain Mech.toJSON()-shaped data.

import { Mech } from './Mech.js';
import { PLAYER_CHASSIS_IDS } from './chassis/index.js';

// #586: the two side locations were renamed `leftTorso`/`rightTorso` → `leftShoulder`/
// `rightShoulder` (owner: "change the left and right torsos to left and right shoulders").
// Every persisted mech is keyed BY LOCATION, so without this an existing save would come back
// with two empty weapon slots — Mech's constructor only reads MOUNT_LOCATIONS/LOCATIONS, so the
// stale keys would simply never be looked at and the weapons in them would silently vanish.
// Applies to BOTH location-keyed sub-objects `Mech.toJSON` writes: `mounts` (item-id arrays) and
// `damage` ({ armor, hp } per part). `abilityMounts` is keyed by ability slot, not location, so
// it's untouched. Old key wins only if the new one isn't already there, so this is a no-op on a
// save that's already been through it (and `load()` re-saves in the new shape immediately).
const RENAMED_LOCATIONS = { leftTorso: 'leftShoulder', rightTorso: 'rightShoulder' };

function renameLocationKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  let changed = false;
  const out = { ...obj };
  for (const [from, to] of Object.entries(RENAMED_LOCATIONS)) {
    if (!(from in out)) continue;
    if (!(to in out)) out[to] = out[from];
    delete out[from];
    changed = true;
  }
  return changed ? out : obj;
}

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

// #387: players 3 & 4. The cap rose to four; these two slots back the mid-sortie drop-ins so a
// player pressing START on pad 3 or 4 gets a real, complete mech rather than a copy of player 1.
// Same chassis (every mech is forced to 'mediumPlayer' by the migrate hook anyway), each a
// complete opening kit. The garage still only pre-builds mech1/mech2; these come from drop-in
// until #388 makes 3/4 pre-buildable.
export const PLAYER3_MECH_KEY = 'mech3';
export const PLAYER4_MECH_KEY = 'mech4';

export const ROSTERS = {
  mech: {
    storageKey: 'mech-game-mechs-v1',
    registryKey: 'allMechs',
    Model: Mech,
    // #248: the light/heavy chassis options are disabled for now (owner: "just roll with
    // the medium one and disable the switcher") — force every mech, including pre-existing
    // saves that picked light/heavy before this change, onto medium. This is a UI-level
    // restriction: the light/heavy chassis data (chassis/enemy/light.js, chassis/enemy/heavy.js) is
    // untouched, so removing this one-line migrate hook fully re-enables them later.
    // #299: the target is now 'mediumPlayer' — the player's own medium-class stat block
    // (chassis/player/mediumPlayer.js, 200/300/100) rather than the enemy medium the Warden uses.
    // #529: the Mech Lab's chassis-select tab lets a player pick one of PLAYER_CHASSIS_IDS
    // (mediumPlayer/strikerPlayer/colossusPlayer — cosmetic-only variants, identical stats) —
    // that choice must now SURVIVE a save/load round-trip instead of being force-reset every
    // load. Only a chassisId that ISN'T one of those three (an old light/heavy/medium/enemy pick
    // from before #248, or a stale/unknown value) still gets force-migrated onto mediumPlayer.
    // #586: …and rewrite the renamed side-location keys (see RENAMED_LOCATIONS above). `load()`
    // spreads a saved sub-object over the default WHOLESALE, so a pre-#586 save's `mounts` arrives
    // here still carrying `leftTorso`/`rightTorso` and would lose both shoulder weapons without
    // this. The re-save `load()` does straight afterwards persists the new shape.
    migrate: (data) => ({
      ...data,
      chassisId: PLAYER_CHASSIS_IDS.includes(data.chassisId) ? data.chassisId : 'mediumPlayer',
      mounts: renameLocationKeys(data.mounts),
      damage: renameLocationKeys(data.damage),
    }),
    defaultRoster: () => ({
      [ACTIVE_MECH_KEY]: {
        chassisId: 'mediumPlayer',
        name: 'Trooper-01',
        mounts: {
          rightArm: ['autocannon'],
          leftArm: ['pulseLaser'],
          leftShoulder: ['clusterRocket'],
          rightShoulder: ['machineGun'],   // #188: centerTorso is no longer mountable.
        },
        // Dash is a mountable ability rather than a hardcoded built-in — every default build
        // equips it (on Y) so existing mobility isn't silently lost until a player rebuilds.
        // #506 originally also defaulted Shield Burst/Jump Blast onto the diamond's B/A corners;
        // those two ability slots are gone (down to just Y/X, see anatomy.js), so the default
        // kit now only carries two mounted abilities — Dash and Drone Launcher (X, unchanged).
        abilityMounts: { abilityY: 'dash', abilityX: 'droneLauncher' },
      },
      // #349: player 2's slot. Same chassis (every mech is locked to 'mediumPlayer' by the
      // migrate hook above anyway), a different but equally complete opening kit.
      [PLAYER2_MECH_KEY]: {
        chassisId: 'mediumPlayer',
        name: 'Trooper-02',
        mounts: {
          rightArm: ['pulseLaser'],
          leftArm: ['autocannon'],
          leftShoulder: ['machineGun'],
          rightShoulder: ['clusterRocket'],
        },
        abilityMounts: { abilityY: 'dash', abilityX: 'droneLauncher' },
      },
      // #387: players 3 & 4. Each a complete, deployable default so a drop-in with an untouched
      // slot gets a real mech. Loadouts vary the opening kit so four machines read as distinct on
      // the field; every slot is 'mediumPlayer' like the others.
      [PLAYER3_MECH_KEY]: {
        chassisId: 'mediumPlayer',
        name: 'Trooper-03',
        mounts: {
          rightArm: ['machineGun'],
          leftArm: ['clusterRocket'],
          leftShoulder: ['autocannon'],
          rightShoulder: ['pulseLaser'],
        },
        abilityMounts: { abilityY: 'dash', abilityX: 'droneLauncher' },
      },
      [PLAYER4_MECH_KEY]: {
        chassisId: 'mediumPlayer',
        name: 'Trooper-04',
        mounts: {
          rightArm: ['clusterRocket'],
          leftArm: ['machineGun'],
          leftShoulder: ['pulseLaser'],
          rightShoulder: ['autocannon'],
        },
        abilityMounts: { abilityY: 'dash', abilityX: 'droneLauncher' },
      },
    }),
  },
};
