// Non-mech enemy KINDS — data, not code (mirrors ENEMIES / WEAPONS / CHASSIS). Each entry
// fully describes a non-mech unit: its health, its damageable part layout (design coords, so
// procedural art + the arena's nearest-part hit-mapping line up), the weapon it fires (a real
// id from data/weapons.js, so no weapon-id literal ever leaks into scenes/arena/*), how fast
// and how it moves, whether it flies (ignores ground cover), and which registered ART builder
// and AI BEHAVIOR it uses. **Add a non-mech enemy = one entry here** — the arena builds it from
// this the same way it builds a Mech from ENEMIES.
//
// The `kind: 'mech'` default is implicit (absent from this table): an enemy with no `kind`
// stays a Mech and every existing enemy behaves UNCHANGED. Only the four entries below opt into
// the HpBody + per-kind art/behavior path.
//
// Fields:
//   name       display name (floats on spawn / used by feedback text).
//   hp         single-pool hit points (HpBody).
//   parts      { locId: {x,y,w,h} } damageable layout in mech-local design coords (−y forward).
//   weaponId   which WEAPONS entry this unit fires (its delivery drives the projectile).
//   fireRange  px at which it opens fire (falls back to the weapon's own max).
//   fireEveryMs cadence between shots (ms) — simple, per-kind, independent of the mech pipeline.
//   flying     true ⇒ ignores walls/forest/water (flies over) AND draws a drop shadow (elevated).
//   move       { maxSpeed, accel, turnRate, turretSlew } px/s + rad/s locomotion tuning.
//   art        key into the vehicle-art registry (src/art/vehicles/) — builds this unit's textures.
//   behavior   key into the AI-behavior registry (scenes/arena/enemyBehaviors.js) — its update fn.
//   themeColor accent colour for its procedural art (the kind's "danger" glow on a WHITE body).
//   scale      on-screen sprite size as a MULTIPLE of the arena mech scale (data-driven per #75;
//              the arena multiplies ARENA_MECH_SCALE by this). Absent ⇒ the old global 1.15×
//              fallback. Tuned per-kind so each vehicle reads at the right heft (playtest #75):
//              turret 1.15 (unchanged), tank 0.82 (was too big), drone 0.72 (was too big),
//              helicopter 1.0 (nudged down from 1.15).

export const ENEMY_KINDS = {
  // 1) TURRET / emplacement — static objective defender. No locomotion; a squat armoured base
  //    with a rotating gun that tracks and fires at the player. Tough but rooted: it guards
  //    ground and can't chase. Direct-fire autocannon.
  turret: {
    name: 'Sentry Turret',
    kind: 'turret',
    hp: 90,
    parts: {
      base: { x: 0, y: 6, w: 26, h: 16 },
      gun: { x: 0, y: -8, w: 12, h: 20 },
    },
    weaponId: 'autocannon',
    fireRange: 380,
    fireEveryMs: 1100,
    flying: false,
    move: { maxSpeed: 0, accel: 0, turnRate: 0, turretSlew: 2.6 },
    art: 'turret',
    behavior: 'turret',
    themeColor: 0xd66a3a,
    scale: 1.15,           // #75: emplacement reads fine at the old size — left as-is.
  },

  // 2) TANK — ground armour. Slow, heavy, tough frontal facing; a turreted main gun (direct
  //    fire). No jumping/flying — blocked by cover/water like a mech. Grinds toward a firing
  //    standoff and holds, hull facing the player.
  tank: {
    name: 'Battle Tank',
    kind: 'tank',
    hp: 160,
    parts: {
      hull: { x: 0, y: 7, w: 30, h: 26 },
      turret: { x: 0, y: -4, w: 18, h: 16 },
      barrel: { x: 0, y: -16, w: 6, h: 16 },
    },
    weaponId: 'autocannon',
    fireRange: 420,
    fireEveryMs: 1500,
    standoff: 300,          // px it wants to hold from the player
    flying: false,
    move: { maxSpeed: 78, accel: 120, turnRate: 1.4, turretSlew: 2.2 },
    art: 'tank',
    behavior: 'tank',
    themeColor: 0xc65a34,
    scale: 0.82,           // #75: was noticeably too big — shrunk to read as a compact tank.
  },

  // 3) DRONE — one unit of an infantry/drone SWARM. Cheap, small, fast, individually weak; a
  //    light rapid weapon. Spawned in numbers (see DEFAULT_SWARM) and swarms the player with a
  //    loose, jittery orbit so the pack reads as a cloud, not a firing line.
  drone: {
    name: 'Recon Drone',
    kind: 'drone',
    hp: 14,
    parts: {
      body: { x: 0, y: 0, w: 12, h: 12 },
    },
    weaponId: 'machineGun',
    fireRange: 240,
    fireEveryMs: 260,
    swarmRadius: 150,       // px orbit radius the drone tries to hold around the player
    flying: true,           // hovers — ignores ground cover, draws a small shadow
    move: { maxSpeed: 150, accel: 420, turnRate: 6, turretSlew: 9 },
    art: 'drone',
    behavior: 'drone',
    themeColor: 0xe0b13a,
    scale: 0.72,           // #75: was too big for a cheap swarm unit — shrunk so a pack reads as a cloud.
  },

  // 4) HELICOPTER / VTOL — fast flyer. Ignores ground cover entirely (flies over walls, forest,
  //    water). Runs strafing passes across the player's front and looses missiles, then peels off
  //    and comes around again — harder to hit because it never sits still. Elevated (big shadow).
  helicopter: {
    name: 'Gunship',
    kind: 'helicopter',
    hp: 70,
    parts: {
      fuselage: { x: 0, y: 2, w: 14, h: 30 },
      cockpit: { x: 0, y: -12, w: 12, h: 12 },
      tail: { x: 0, y: 18, w: 6, h: 14 },
    },
    weaponId: 'streakPod',
    fireRange: 460,
    fireEveryMs: 1900,
    strafeRange: 320,       // px offset of the pass line from the player
    flying: true,
    move: { maxSpeed: 210, accel: 260, turnRate: 3.2, turretSlew: 4 },
    art: 'helicopter',
    behavior: 'helicopter',
    themeColor: 0xcf4d4d,
    scale: 1.0,            // #75: slightly too big — nudged down a touch from the 1.15 global.
  },
};

// A non-mech spawn ships several drones as one "swarm" unit so the pack reads as numbers. The
// arena expands a 'swarm' request into this many drones.
export const SWARM_SIZE = 5;

// Is a type id a non-mech kind? (Anything not in this table is a mech loadout.)
export function isEnemyKind(typeId) {
  return Object.prototype.hasOwnProperty.call(ENEMY_KINDS, typeId);
}

export const ENEMY_KIND_IDS = Object.keys(ENEMY_KINDS);
