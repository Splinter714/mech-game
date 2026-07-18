// Enemy mech definitions — data, not code (mirrors WEAPONS / CHASSIS). The arena builds a
// fresh Mech from one of these configs on spawn, so the scene layer never hardcodes an
// enemy's chassis or weapons. **Add an enemy = one entry here.**
//
// #44: enemy variety now feeds the tactical AI. The AI reads each mech's weapons' optimum
// range to pick a ROLE (brawler presses in, sniper kites, skirmisher flanks mid-range), so
// giving enemies distinct loadouts makes them read as behaving differently — not one orbit.
export const ENEMIES = {
  // Mid-range flanker: an autocannon (opt 347, was 220 before #135's range-floor pass) +
  // cluster salvo (opt 660). The original Raider — a skirmisher that fights at a middling
  // standoff and flanks.
  raider: {
    chassisId: 'light',
    name: 'Raider',
    mounts: { rightArm: ['autocannon'], leftTorso: ['clusterRocket'] },
  },

  // Brawler: short/mid-range weapons on a fast light chassis, so it wants to CLOSE and stay
  // in the player's face. Reads as aggressive.
  // #96: flamethrower (opt 90) was shelved per Jackson's weapon curation pass, so this mount
  // swaps to machineGun/Repeater — still a close/mid-range direct-fire weapon that keeps the
  // pairing with shotgun reading as an aggressive, get-in-your-face brawler.
  // #135: machineGun/shotgun opt both moved from 180 to 338 (range-floor pass, every weapon's
  // max brought to >=600) — this pushes the brawler's standoff distance out further than
  // before; still reads as close/mid-range relative to the sniper/artillery loadouts below,
  // but worth an eye during playtest if "brawler" no longer feels like it's pressing in enough.
  skirmisher: {
    chassisId: 'light',
    name: 'Stalker',
    mounts: { rightArm: ['shotgun'], leftArm: ['machineGun'] },
  },

  // Sniper: long-range weapons on a slow heavy chassis, so it KITES — holds distance,
  // backpedals when the player closes, uses cover.
  // #96: railLance (opt 400) and napalm (opt 500) were both shelved per Jackson's weapon
  // curation pass. Swapped to beamLaser (opt 500, max 640 — the longest-range keeper) and
  // clusterRocket (opt 660, max 960 — the other long-range keeper), preserving the "holds
  // distance and kites" read.
  // #117: beamLaser swapped to plasmaLance (opt 460/max 620) — Jackson liked the pre-#117
  // accidental look of an enemy "beamLaser" actually firing as a travelling plasma bolt (a bug:
  // enemies never routed hitscan weapons through the beam-fire path at all), so that look is now
  // formalized as its own real projectile weapon rather than "fixed" to an instant beam. See
  // plasmaLance's definition in data/weapons.js for the full story.
  sniper: {
    chassisId: 'heavy',
    name: 'Warden',
    mounts: { rightArm: ['plasmaLance'], leftTorso: ['clusterRocket'] },
  },

  // Artillery / bombardier: EVERY weapon is indirect-fire — both mounts lob an arcing shell
  // (path 'arcing'), so neither needs line-of-sight to hit. The AI detects "all weapons
  // indirect" and treats hugging cover as this mech's PRIMARY posture: it camps behind a wall
  // and bombards over it, only shifting to a fresh cover spot, essentially never exposing
  // itself. On a heavy chassis (slow, tanky) it reads as an entrenched siege unit. Keep BOTH
  // weapons indirect (arcing/homing) or it loses its camp-cover behaviour.
  // #272: #244 emptied SHELVED_WEAPON_IDS (see weapons.js), un-shelving plasmaCannon and napalm
  // — both still real, live, arcing (indirect) weapons — so the #96 stopgap that had artillery
  // reusing the sniper's direct-fire plasmaLance/clusterRocket loadout (and, as a side effect,
  // made isAllIndirect false and killed the camp-cover AI posture) is no longer needed. Restored
  // to its own distinct siege loadout: plasmaCannon (arcing splash energy lob, opt 480/max 820)
  // + napalm (arcing splash + burning ground patch, opt 500/max 780) — both indirect, both
  // long-range, and thematically an entrenched bombardier that lobs shells and burning canisters
  // over cover rather than trading direct shots like the sniper. This restores isAllIndirect ===
  // true for artillery, so the tactical AI's cover-camping posture actually triggers again.
  artillery: {
    chassisId: 'heavy',
    name: 'Mortarhead',
    mounts: { rightTorso: ['plasmaCannon'], leftTorso: ['napalm'] },
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
// #239 (temporary): 'infantryMob' pulled back OUT of this rotation while Jackson plans a redesign
// of the kind — see enemyKinds.js's infantryMob/infantry definitions, which are left completely
// intact (art + behavior untouched too), so restoring it here is a one-line add, not an
// archaeology project.
// #234: 'quadruped' (the Broodwalker) was fully built — art/behavior/weapon/260hp, plus its own
// periodic drone-drop mechanic — but was never added here or to DEFAULT_SQUAD, so it had no path
// into a normal run except one rare slot in run.js's LATE_POOL (reachable only in late-stage
// squad draws). That's why Jackson had seen it, but rarely, per his playtest note ("those enemies
// that spawn drones are so cool but I barely ever see them"). Appended once here — same tier as
// turretNest/artillery/swarm/infantryMob, not doubled up like tank/helicopter — so the debug
// spawn-more control (keydown-N / dpad-up) cycles through it too. This list is consumed by index
// (`ENEMY_ROTATION[this._enemySeq % ENEMY_ROTATION.length]`, scenes/arena/enemies.js), i.e. a
// straight round-robin cycle, NOT a weighted random draw — every id gets exactly 1-in-N of the
// cycle regardless of position, so "how often" is controlled purely by how many times an id is
// repeated in the array (see tank/helicopter's double entries elsewhere in this file's spirit),
// not by where it sits.
export const ENEMY_ROTATION = [
  'raider', 'tank', 'skirmisher', 'helicopter', 'sniper', 'turretNest', 'artillery', 'swarm',
  'quadruped',
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
// #239 (temporary): 'infantryMob' pulled back OUT of the opening squad while Jackson plans a
// redesign of the kind — see the matching #239 note on ENEMY_ROTATION above. enemyKinds.js's
// definition/art/behavior are untouched, so re-adding it here later is a one-line change.
// #234: 'quadruped' (the Broodwalker) is deliberately NOT added here. Per its own comments
// (data/enemyKinds.js), it's framed as "tougher than a tank but well under a full mech's pool" —
// a rarer, tougher escalation unit, not an opener. It got its real fix in ENEMY_ROTATION above
// (regular-but-not-common cadence across a run) and its existing rare LATE_POOL slot
// (data/run.js); every opening squad seeing it would overexpose a unit meant to read as a
// mid/late-run surprise.
export const DEFAULT_SQUAD = [
  'raider', 'helicopter', 'tank', 'turretNest', 'helicopter', 'tank', 'swarm', 'sniper',
];
