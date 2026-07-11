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
//              fallback. Tuned per-kind so each vehicle reads at the right heft (playtest #75,
//              shrunk further per #89's composition/sizing pass, then nudged down again per
//              #91): turret 0.55 (way down from 1.15 — it now spawns in tight clusters, see
//              TURRET_CLUSTER_SIZE, so a nest of tiny sentries reads right instead of one big
//              one), tank 0.48 (down from 0.6 per #91 — "tanks smaller"), drone 0.52 (down from
//              0.62 per #91 — "drones slightly smaller again"), helicopter 0.75 (down from 1.0).

export const ENEMY_KINDS = {
  // 1) TURRET / emplacement — static objective defender. No locomotion. #94 (playtest: "turrets
  //    should have INSANE range and not be LOS, they should do some kind of artillery shit"):
  //    reworked from a short-range direct-fire autocannon sentry into a long-range artillery
  //    emplacement — it lobs an arcing siege shell that never needs line-of-sight (arcing rounds
  //    skip wall collision entirely, see scenes/arena/projectiles.js) at a fireRange far beyond
  //    any other enemy's engagement envelope in the game. Tough, rooted, can't chase — but you
  //    can't just hide from it either; you have to hunt it down or leave its enormous range.
  //    Per-shot damage/cadence are tuned down from the old autocannon numbers (see siegeShell in
  //    data/weapons.js) since turrets now spawn in clusters of 3 (TURRET_CLUSTER_SIZE) with
  //    guaranteed uptime (no LOS to break) — three of the old autocannon's 16-dmg/1.1s cadence
  //    firing constantly and unavoidably would be brutal; siegeShell's 10 dmg (with range
  //    falloff further softening it near max range) on a slower 2.6s cadence keeps a nest a real
  //    but survivable threat to actively deal with rather than an instant unavoidable shred.
  turret: {
    name: 'Sentry Turret',
    kind: 'turret',
    hp: 90,
    parts: {
      base: { x: 0, y: 6, w: 26, h: 16 },
      gun: { x: 0, y: -8, w: 12, h: 20 },
    },
    weaponId: 'siegeShell',
    fireRange: 2400,       // #94: INSANE — well beyond the next-longest engagement range in the
                           // game (streakPod max 1540 / swarmRack max 1750) so a turret nest
                           // threatens from far outside normal combat distance.
    fireEveryMs: 2600,     // #94: slowed from 1100 — a deliberate artillery cadence, and offsets
                           // the fact this now always has a shot (no LOS to break) in a 3-turret nest.
    flying: false,
    move: { maxSpeed: 0, accel: 0, turnRate: 0, turretSlew: 2.6 },
    art: 'turret',
    behavior: 'turret',
    themeColor: 0xd66a3a,
    scale: 0.55,           // #89: shrunk way down — turrets now spawn in tight clusters
                           // (see TURRET_CLUSTER_SIZE / 'turretNest'), so a nest of small
                           // sentries reads better than one big emplacement.
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
    move: { maxSpeed: 52, accel: 120, turnRate: 1.4, turretSlew: 2.2 },   // #91: slowed further
                                                                          // (was 78) — reads as
                                                                          // noticeably heavier/
                                                                          // slower ("tanks slower").
    art: 'tank',
    behavior: 'tank',
    themeColor: 0xc65a34,
    scale: 0.48,           // #91: shrunk further (was 0.6) — "tanks smaller".
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
    swarmRadius: 200,       // px orbit radius the drone tries to hold around the player (#93: nudged out from 150 — playtest felt too close)
    flying: true,           // hovers — ignores ground cover, draws a small shadow
    move: { maxSpeed: 150, accel: 420, turnRate: 6, turretSlew: 9 },
    art: 'drone',
    behavior: 'drone',
    themeColor: 0xe0b13a,
    scale: 0.52,           // #91: nudged down further (was 0.62) — "drones slightly smaller
                           // again", now that the swarm (SWARM_SIZE below) reads even fuller.
  },

  // 4) HELICOPTER / VTOL — fast flyer. Ignores ground cover entirely (flies over walls, forest,
  //    water). Runs strafing passes across the player's front and loses fire, then peels off
  //    and comes around again — harder to hit because it never sits still. Elevated (big shadow).
  //    #95: streakPod (homing) was shelved pending a lock/tracking rework, so this mount swaps
  //    to machineGun — a direct-fire stream that reads as the gunship raking the ground with
  //    cannon fire on each pass, no guidance/lock dependency.
  helicopter: {
    name: 'Gunship',
    kind: 'helicopter',
    hp: 70,
    parts: {
      fuselage: { x: 0, y: 2, w: 14, h: 30 },
      cockpit: { x: 0, y: -12, w: 12, h: 12 },
      tail: { x: 0, y: 18, w: 6, h: 14 },
    },
    weaponId: 'machineGun',
    fireRange: 460,
    fireEveryMs: 1900,
    strafeRange: 320,       // px offset of the pass line from the player
    flying: true,
    move: { maxSpeed: 210, accel: 260, turnRate: 3.2, turretSlew: 4 },
    art: 'helicopter',
    behavior: 'helicopter',
    themeColor: 0xcf4d4d,
    scale: 0.75,           // #89: shrunk further (was 1.0) — more gunships spawn now, so each
                           // one reads smaller and the sky feels busier rather than crowded-big.
  },

  // 5) INFANTRY — one trooper of a GROUND swarm (#97). The weakest unit in the game by a wide
  //    margin: barely any hp, a single small part, a weak short-range popgun. Individually
  //    meaningless — it threatens purely through the size of the mob it spawns in (see
  //    INFANTRY_MOB_SIZE below, deliberately bigger than the drone SWARM_SIZE so a mob reads as
  //    an overwhelming crowd, not just "a few more enemies"). Ground unit (flying: false), unlike
  //    the drone it otherwise mirrors in spirit — advances/mills on foot, blocked by terrain like
  //    a mech, and subject to #92 player-ground-collision (see groundEnemyRadius: its footprint
  //    scales by `scale` same as every other vehicle, so at 0.38 each trooper's own collision
  //    circle is tiny — a mob reads as a crowd you push through, not a solid wall; see the #97
  //    report for the full reasoning).
  infantry: {
    name: 'Trooper',
    kind: 'infantry',
    hp: 6,                 // weaker than drone's 14 — dies in one or two hits from almost anything
    parts: {
      body: { x: 0, y: 0, w: 8, h: 12 },
    },
    weaponId: 'machineGun',   // cheap, short-range, already-mounted ballistic — fits a trooper
    fireRange: 200,
    fireEveryMs: 700,
    flying: false,           // ground troop — walks, collides with terrain and the player
    move: { maxSpeed: 48, accel: 260, turnRate: 5, turretSlew: 6 },  // #104: slowed noticeably
                                                                     // from 85 (playtest: "should
                                                                     // be slower") — a lumbering
                                                                     // mob you can outrun/outdrive,
                                                                     // not a fast-closing swarm.
    art: 'infantry',
    behavior: 'infantry',
    themeColor: 0x8fae4a,
    scale: 0.38,            // noticeably smaller than drone's 0.52 (#97 ask: "smaller than drones")
  },
};

// A non-mech spawn ships several drones as one "swarm" unit so the pack reads as numbers. The
// arena expands a 'swarm' request into this many drones. #89: drastically increased (was 5) per
// playtest feedback ("waaaaaay more of them at once") — this is exactly the concentrated-unit
// load the #71/#76 performance fixes (per-enemy view/texture teardown, throttled impact FX) were
// built to hold up under; profiled at 18 concurrent drones (see #89 report) with headroom to
// spare, so this is picked as a strong "way more" without measurably hurting frame rate.
export const SWARM_SIZE = 18;

// A 'turretNest' spawn expands into this many turrets dropped close together in a tight, fixed
// formation (#89 — "a few of them should spawn together"). Turrets are stationary (maxSpeed 0),
// so unlike the drone swarm's loose orbiting cloud, the nest is a small static cluster — picked
// small and sensible so it reads as an emplacement, not a wall of guns.
export const TURRET_CLUSTER_SIZE = 3;

// An 'infantryMob' spawn expands into this many infantry dropped in a loose cluster (#97 —
// "let's add infantry in large volumes, smaller than drones"). Deliberately bigger than the
// drone SWARM_SIZE (18) so a mob reads as an overwhelming crowd rather than just "more of the
// same"; profiled (see #97 report) alongside the #71/#76 concentrated-load perf work before
// landing on this number — dial back if a future profile run shows it doesn't hold ~60fps.
export const INFANTRY_MOB_SIZE = 28;

// Is a type id a non-mech kind? (Anything not in this table is a mech loadout.)
export function isEnemyKind(typeId) {
  return Object.prototype.hasOwnProperty.call(ENEMY_KINDS, typeId);
}

export const ENEMY_KIND_IDS = Object.keys(ENEMY_KINDS);
