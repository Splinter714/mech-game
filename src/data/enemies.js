// Enemy mech definitions — data, not code (mirrors WEAPONS / CHASSIS). The arena builds a
// fresh Mech from one of these configs on spawn, so the scene layer never hardcodes an
// enemy's chassis or weapons. **Add an enemy = one entry here.**
//
// #44: enemy variety now feeds the tactical AI. The AI reads each mech's weapons' optimum
// range to pick a ROLE (brawler presses in, sniper kites, skirmisher flanks mid-range), so
// giving enemies distinct loadouts makes them read as behaving differently — not one orbit.
export const ENEMIES = {
  // Mid-range flanker: an autocannon (opt 220) + cluster salvo (opt 220). The original
  // Raider — a skirmisher that fights at a middling standoff and flanks.
  raider: {
    chassisId: 'light',
    name: 'Raider',
    mounts: { rightArm: ['autocannon'], leftTorso: ['clusterRocket'] },
  },

  // Brawler: short/mid-range weapons on a fast light chassis, so it wants to CLOSE and stay
  // in the player's face. Reads as aggressive.
  // #96: flamethrower (opt 90) was shelved per Jackson's weapon curation pass, so this mount
  // swaps to machineGun/Repeater (opt 180) — still a close/mid-range direct-fire weapon that
  // keeps the pairing with shotgun reading as an aggressive, get-in-your-face brawler.
  skirmisher: {
    chassisId: 'light',
    name: 'Stalker',
    mounts: { rightArm: ['shotgun'], leftArm: ['machineGun'] },
  },

  // Sniper: long-range weapons on a slow heavy chassis, so it KITES — holds distance,
  // backpedals when the player closes, uses cover.
  // #96: railLance (opt 400) and napalm (opt 500) were both shelved per Jackson's weapon
  // curation pass. Swapped to beamLaser (opt 500, max 640 — the longest-range keeper, and
  // still hitscan so it reads as a precise sniping weapon) and clusterRocket (opt 660, max
  // 960 — the other long-range keeper), preserving the "holds distance and kites" read.
  sniper: {
    chassisId: 'heavy',
    name: 'Warden',
    mounts: { rightArm: ['beamLaser'], leftTorso: ['clusterRocket'] },
  },

  // Artillery / bombardier: EVERY weapon is indirect-fire — both mounts lob an arcing shell
  // (path 'arcing'), so neither needs line-of-sight to hit. The AI detects "all weapons
  // indirect" and treats hugging cover as this mech's PRIMARY posture: it camps behind a wall
  // and bombards over it, only shifting to a fresh cover spot, essentially never exposing
  // itself. On a heavy chassis (slow, tanky) it reads as an entrenched siege unit. Keep BOTH
  // weapons indirect (arcing/homing) or it loses its camp-cover behaviour.
  // #96 CONFLICT: plasmaCannon and napalm (both arcing) were shelved per Jackson's weapon
  // curation pass, and NONE of the 6 kept weapons are indirect (arcing/homing) — so this
  // mech's whole "camp behind cover and bombard" design can no longer be preserved with an
  // active weapon. Swapped to the two longest-range keepers (beamLaser opt 500/max 640,
  // clusterRocket opt 660/max 960) so it still reads as a long-range unit, but isIndirectWeapon
  // will now be false for both mounts, so the AI will fall back to its normal (non-camping)
  // posture instead of hugging cover. Flagging this clearly rather than silently — an
  // artillery-specific indirect weapon may need to be added to the keep-list, or this enemy's
  // "camp cover" behaviour may need its own follow-up once Jackson weighs in.
  artillery: {
    chassisId: 'heavy',
    name: 'Mortarhead',
    mounts: { rightTorso: ['beamLaser'], leftTorso: ['clusterRocket'] },
  },
};

// Spawn rotation for the debug "add enemy" control (#39) and the arena's mixed opener, so
// consecutive spawns cycle through roles instead of stacking identical orbits. Mixes the mech
// loadouts with the #68 non-mech KINDS (turret / tank / drone 'swarm' / helicopter — the ids
// live in data/enemyKinds.js; 'swarm' expands into several drones) plus the #89 'turretNest'
// (expands into a small cluster of turrets — see TURRET_CLUSTER_SIZE), so pressing N cycles
// through the whole bestiary. The starting enemy is index 0 (the Raider), keeping the first
// deploy stable.
// #97: 'infantryMob' is appended to the rotation so the debug spawn-more control cycles through
// it too (expands into INFANTRY_MOB_SIZE troopers — data/enemyKinds.js — mirroring 'swarm'/
// 'turretNest').
export const ENEMY_ROTATION = [
  'raider', 'tank', 'skirmisher', 'helicopter', 'sniper', 'turretNest', 'artillery', 'swarm',
  'infantryMob',
];

// The default opening squad (#44 / #68 / #75 / #89): a mix of mechs and non-mech units so the
// arena shows off the whole bestiary from the first frames. #89 rebalances this toward the
// playtest ask "mechs less common, more helicopters/tanks, turrets in clusters" — non-mech units
// are now the clear MAJORITY (6 of 8 entries) and mechs a minority (raider + sniper). Index 0
// stays a mech (Raider) so the smoke test's mech-specific per-part damage assertions remain
// meaningful. Order is the spawn order; the arena drops each just off-screen and they move in
// per their AI (turrets just sit and guard).
// #97: 'infantryMob' appended — the opening squad now shows off the new ground-swarm kind
// alongside the drone swarm/turret nest. Profiled with the rest of the opening squad concurrent
// (see #97 report) before landing on INFANTRY_MOB_SIZE; dial the mob size back if a future
// profile run shows this combination doesn't hold ~60fps.
export const DEFAULT_SQUAD = [
  'raider', 'helicopter', 'tank', 'turretNest', 'helicopter', 'tank', 'swarm', 'sniper', 'infantryMob',
];
