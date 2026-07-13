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
//   muzzlePart which entry in `parts` a shot actually spawns from (#109) — the gun/barrel/nose,
//              not the unit's centre. Falls back to the first `parts` entry if omitted.
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
//              #91, then again per #145's follow-up): turret 0.42 (down from 0.55, itself way
//              down from 1.15 — it now spawns in tight clusters, see TURRET_CLUSTER_SIZE, so a
//              nest of tiny sentries reads right instead of one big one), tank 0.48 (down from
//              0.6 per #91 — "tanks smaller"), drone 0.52 (down from 0.62 per #91 — "drones
//              slightly smaller again"), helicopter 0.75 (down from 1.0).

export const ENEMY_KINDS = {
  // 1) TURRET / emplacement — static objective defender. No locomotion. #94 (playtest: "turrets
  //    should have INSANE range and not be LOS, they should do some kind of artillery shit"):
  //    reworked from a short-range direct-fire autocannon sentry into a long-range artillery
  //    emplacement — it lobs an arcing siege shell that never needs line-of-sight (arcing rounds
  //    skip wall collision entirely, see scenes/arena/projectiles.js) at a fireRange far beyond
  //    any other enemy's engagement envelope in the game. Tough, rooted, can't chase — but you
  //    can't just hide from it either; you have to hunt it down or leave its enormous range.
  //    Per-shot damage/cadence are tuned down from the old autocannon numbers (see siegeShell in
  //    data/weapons.js) since turrets now spawn in clusters (TURRET_CLUSTER_SIZE, currently 4 —
  //    bumped up from 3 per #145's follow-up, alongside a further scale shrink, so the nest reads
  //    as more/smaller sentries) with guaranteed uptime (no LOS to break) — several of the old
  //    autocannon's 16-dmg/1.1s cadence firing constantly and unavoidably would be brutal;
  //    siegeShell's 10 dmg (with range falloff further softening it near max range) on a slower
  //    2.6s cadence keeps a nest a real but survivable threat to actively deal with rather than an
  //    instant unavoidable shred. #145-followup: went from 3→4 turrets without raising per-shot
  //    damage/cadence, so a nest's total DPS rises ~33% — worth another playtest pass to confirm
  //    a 4-turret nest doesn't tip into "unavoidable shred" territory; if it does, softening
  //    siegeShell's damage or cadence a touch (rather than the turret count) is the likely lever.
  turret: {
    name: 'Sentry Turret',
    kind: 'turret',
    hp: 90,
    parts: {
      base: { x: 0, y: 6, w: 26, h: 16 },
      gun: { x: 0, y: -8, w: 12, h: 20 },
    },
    muzzlePart: 'gun',
    weaponId: 'siegeShell',
    fireRange: 2400,       // #94: INSANE — well beyond the next-longest engagement range in the
                           // game (streakPod max 1540 / swarmRack max 1750) so a turret nest
                           // threatens from far outside normal combat distance.
    fireEveryMs: 2600,     // #94: slowed from 1100 — a deliberate artillery cadence, and offsets
                           // the fact this now always has a shot (no LOS to break) in a nest of
                           // TURRET_CLUSTER_SIZE turrets (4 as of #145's follow-up, was 3).
    flying: false,
    move: { maxSpeed: 0, accel: 0, turnRate: 0, turretSlew: 2.6 },
    art: 'turret',
    behavior: 'turret',
    themeColor: 0xd66a3a,
    scale: 0.42,           // #145-followup: shrunk further (was 0.55) — playtest feedback
                           // "turrets are too large" alongside bumping TURRET_CLUSTER_SIZE up
                           // to 4, so a nest of even smaller sentries reads busy rather than
                           // just big. #89: originally shrunk way down from 1.15 since turrets
                           // spawn in tight clusters (see TURRET_CLUSTER_SIZE / 'turretNest').
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
    muzzlePart: 'barrel',
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
    muzzlePart: 'body',
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
    muzzlePart: 'cockpit',   // nose-mounted gun — cockpit is the most-forward part
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

  // 5) QUADRUPED — "Broodwalker" (#130). A slow, tanky four-legged ground unit with a
  //    turreted main gun (same independent hull-vs-turret decoupling as tank, reusing
  //    tankBehavior's movement pattern via quadrupedBehavior) PLUS a periodic deploy
  //    mechanic: while alive and AWARE it acts as a mobile "nest," dropping a drone or
  //    infantry trooper near itself every so often (see quadrupedBehavior in
  //    enemyBehaviors.js) up to a lifetime cap, rather than a cluster spawning everything
  //    up front like turretNest/infantryMob. A support/objective unit — tougher than a
  //    tank but well under a full mech's pool — so it reads as worth focusing down before
  //    its spawns pile up, not a one-shot kill.
  quadruped: {
    name: 'Broodwalker',
    kind: 'quadruped',
    hp: 260,                // #130 (owner: tune): tougher than tank's 160, but well under a
                             // heavy mech's ~616-hp pool (sniper/artillery's 'heavy' chassis) —
                             // a real but beatable objective target, not a brick wall.
    parts: {
      hull: { x: 0, y: 2, w: 34, h: 30 },
      turret: { x: 0, y: -8, w: 20, h: 18 },
      barrel: { x: 0, y: -22, w: 6, h: 20 },
    },
    muzzlePart: 'barrel',
    weaponId: 'autocannon',
    fireRange: 380,
    fireEveryMs: 1700,       // a touch slower cadence than tank's 1500 — bulkier support gun
    standoff: 320,           // px it wants to hold from the player
    flying: false,
    // #130 (owner: tune): "comparable to or slower than tank" — tank's maxSpeed is 52, this is
    // noticeably slower/heavier so it reads as a lumbering quadruped rather than a light tank.
    // #152 (round-2 playtest): "body turn rate too fast" — turnRate dropped hard from 1.1 to
    // 0.35 (under a third, and well below even the heavy player chassis's already-ponderous 1.0
    // turnRate — see chassis/heavy.js) so the BODY struggles to reorient like a lumbering heavy
    // machine. turretSlew is explicitly left at 2.0, UNCHANGED — the gun must keep tracking
    // responsively (aimAndFire in enemyBehaviors.js slews the turret completely independently of
    // the body's own turnRate) even while the hull turns slowly.
    // stepInterval drives the walk-cycle frame swap (see legFrames below / enemies.js
    // _updateVehicle) — a slow, heavy cadence (well above the heavy player chassis's 460ms —
    // see chassis/heavy.js) so it lurches rather than trots.
    move: { maxSpeed: 38, accel: 90, turnRate: 0.35, turretSlew: 2.0, stepInterval: 720 },
    // #152: how many walk-cycle hull frames this kind's art builds (src/art/vehicles/quadruped.js
    // QUADRUPED_LEG_FRAMES) — presence of this field is what tells the arena (enemies.js
    // _makeVehicleView/_updateVehicle) to animate `<key>_hull_0..N` instead of using one static
    // `<key>_hull` texture, mirroring the player mech's own multi-frame stompy gait.
    legFrames: 4,
    // #147 (playtest follow-up to #130: "should deploy SWARMS of quadcopters and infantry" —
    // the old 1-unit-per-8s-capped-at-5 trickle didn't read as a swarm at all). Now every 4s
    // while alive+aware it drops a whole BATCH of drones at once (quadrupedBehavior), up to a
    // much higher deployCap (24, in the same ballpark as the drone SWARM_SIZE(18)/
    // INFANTRY_MOB_SIZE(28) below) so a full fight reads as genuinely swarm-dangerous without
    // spawning literally unbounded units and tanking arena performance.
    // #152 (round-2 playtest): "deploy batch minimum 5" — bumped the floor from 3 to 5 (every
    // burst is now a real swarm, never a small 3-unit trickle); max nudged up in step to 8 so
    // there's still batch-size VARIETY above the new floor, not a flat constant every time.
    // "deploy drones only" — quadrupedBehavior's QUADRUPED_DEPLOY_KINDS now excludes infantry
    // (flag-disabled there, not deleted), so every deployed unit here is a drone regardless of
    // this data's own batch sizing.
    deployEveryMs: 4000,
    deployBatchMin: 5,
    deployBatchMax: 8,
    deployCap: 24,
    art: 'quadruped',
    behavior: 'quadruped',
    themeColor: 0x8a4fc9,    // distinct violet accent — reads as a different "danger" bit
                             // from tank's orange / turret's orange / drone's yellow / etc.
    // #147: playtest said the #130 0.6 (already "bigger footprint than tank's 0.48") still read
    // "way too small" for a tougher-than-tank objective unit — bumped to 1.0 (on par with a full
    // player mech's effective on-screen scale, ARENA_MECH_SCALE × 1), a clearly obvious jump.
    scale: 1.0,
  },

  // 6) INFANTRY — one trooper of a GROUND swarm (#97). The weakest unit in the game by a wide
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
    muzzlePart: 'body',
    weaponId: 'machineGun',   // cheap, short-range, already-mounted ballistic — fits a trooper
    fireRange: 200,
    fireEveryMs: 700,
    flying: false,           // ground troop — walks, collides with terrain and the player
    move: { maxSpeed: 48, accel: 260, turnRate: 5, turretSlew: 6 },  // #104: slowed noticeably
                                                                     // from 85 (playtest: "should
                                                                     // be slower") — a lumbering
                                                                     // mob you can outrun/outdrive,
                                                                     // not a fast-closing swarm.
    // #151 (playtest: "infantry swarms hanging out in the water"): a passable river/channel is
    // meant for mechs/tanks to wade through, but a tiny trooper parking in it reads badly. This
    // only affects idle-wander GOAL PICKING (scenes/arena/enemies.js `_idleMoveIntent`) — a
    // trooper directly chasing/fleeing across a river when AWARE is unaffected (that's driven by
    // direct-line movement toward the player, not a chosen destination) and can still physically
    // cross passable water if forced to. Tank/quadruped are bulkier and read fine wading, so this
    // is infantry-only, not a generic "small ground unit" flag — see #151 report.
    avoidWater: true,
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
// small and sensible so it reads as an emplacement, not a wall of guns. #145-followup (playtest
// 2026-07-12: "could we try 2 or 4 at a time instead of 3?" — owner left the pick open): bumped
// 3 → 4, paired with a further scale shrink on the `turret` kind above, so the nest reads as
// "more, smaller" sentries rather than fewer, bigger ones. Easy to retune — just change this
// constant (see the turretClusterHexes/_spawnTurretCluster call sites, which are fully
// parameterized by count, not hardcoded to 3 or 4).
export const TURRET_CLUSTER_SIZE = 4;

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
