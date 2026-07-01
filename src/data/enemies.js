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

  // Brawler: short-range weapons (shotgun opt 180, flamethrower opt 90) on a fast light
  // chassis, so it wants to CLOSE and stay in the player's face. Reads as aggressive.
  skirmisher: {
    chassisId: 'light',
    name: 'Stalker',
    mounts: { rightArm: ['shotgun'], leftArm: ['flamethrower'] },
  },

  // Sniper: long-range weapons (rail lance opt 400, napalm lobber opt 500) on a slow heavy
  // chassis, so it KITES — holds distance, backpedals when the player closes, uses cover.
  sniper: {
    chassisId: 'heavy',
    name: 'Warden',
    mounts: { rightArm: ['railLance'], leftTorso: ['napalm'] },
  },

  // Artillery / bombardier: EVERY weapon is indirect-fire — swarmRack is homing (guidance
  // 'homing') and napalm is a lobbed arc (path 'arcing'), so neither needs line-of-sight to
  // hit. The AI detects "all weapons indirect" and treats hugging cover as this mech's PRIMARY
  // posture: it camps behind a wall and bombards over it, only shifting to a fresh cover spot,
  // essentially never exposing itself. On a heavy chassis (slow, tanky) it reads as an
  // entrenched siege unit. Keep BOTH weapons indirect or it loses its camp-cover behaviour.
  artillery: {
    chassisId: 'heavy',
    name: 'Mortarhead',
    mounts: { rightTorso: ['swarmRack'], leftTorso: ['napalm'] },
  },
};

// Spawn rotation for the debug "add enemy" control (#39) and the arena's mixed opener, so
// consecutive spawns cycle through roles instead of stacking identical orbits. The starting
// enemy is index 0 (the Raider), keeping the first-deploy experience stable.
export const ENEMY_ROTATION = ['raider', 'skirmisher', 'sniper', 'artillery'];

// The default opening squad (#44 follow-up): one of each type so the arena shows off all four
// behaviours from the first frame — brawler, skirmisher, sniper, and the cover-camping
// bombardier. Order is the spawn order; the arena drops them off-screen and they walk in.
export const DEFAULT_SQUAD = ['skirmisher', 'raider', 'sniper', 'artillery'];
