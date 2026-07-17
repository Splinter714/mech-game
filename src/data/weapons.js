// Weapon catalog. Each weapon = a Category (Axis 1, loadout economy) + a `delivery`
// profile (Axis 2, the composable behavior fields that define *feel*). The same short
// category list yields wildly different weapons — a hitscan laser, an arcing plasma
// lob, a rapid machine-gun stream, a shotgun cone, a homing missile volley.
//
// delivery fields:
//   hit       'hitscan' | 'projectile' | 'contact'
//   velocity  projectile speed in px/s (heavier shells = slower); projectile only
//   path      'straight' | 'arcing'    (arcing = lobbed, not a straight line)
//   guidance  'dumbfire' | 'lockon' | 'homing' | null
//   pattern   'single' | 'spread' | 'stream'
//   spreadCount / spreadAngle   pellets/missiles per shot + cone width (deg)
//   spreadJitter  degrees — randomizes each spread shot's angle (and adds a small random
//             emission stagger) instead of an evenly-spaced, perfectly repeating fan; for
//             weapons that should feel chaotic shot-to-shot (the flamethrower)
//   cluster   spread rounds fly as a tight parallel clump (no fan) — dumbfire cluster
//   fireRate  shots per second for a `stream` weapon (machine gun / beam laser)
//   sprayCount { min, max } — a `stream` weapon's cadence tick launches a random handful
//             of jittered particles at once (min..max) instead of exactly one, for a
//             dense/wide continuous gout without changing the ammo cost per tick (the
//             flamethrower)
//   burst     { count, interval } — one trigger pull fires `count` rapid sub-shots
//             `interval` ms apart. For a hitscan, that's `count` light pulses (pulse
//             laser); for a projectile, `count` travelling rounds (streak pod)
//   wobble    'jostle' | 'weave' — cosmetic lateral wiggle on a homing round's flight path
//   weakSeek  #213: a DELIBERATELY WEAK per-projectile tracking bias — distinct from
//             `guidance: 'homing'` (a real lock-on that steers hard at a maintained target
//             lock). A weakSeek round has no lock at all: each frame it independently finds
//             whatever living enemy is nearest to ITS OWN current position and nudges its
//             heading a small amount that way (data/delivery.js `stepWeakSeek`/
//             `WEAK_SEEK_TURN_RATE`). Reads as "this bolt has a mind of its own, a little" —
//             not a mini-missile. Currently only Plasma Lance.
//   sustained a `stream` hitscan held as ONE continuous beam, not a flicker (beam laser)
//   #243 optional fine-tuning fields (each defaults to the shared constant in delivery.js —
//   set only to deviate from it):
//     spreadJitterDelay  ms — max random emission stagger of a jittered spread (default 35)
//     speedJitterFrac    ±fraction of velocity a jittered particle's speed varies (default 0.18)
//     burstStaggerDeg    ° alternating angular stagger between weave-burst sub-shots (default 0.3)
//     homingTurnRadius   px — the turn radius a homing round corners within (default 64)
//     weakSeekTurnRate   rad/s — a weakSeek round's steering-bias strength (default 0.8)
//     weakSeekRadius     px — how far a weakSeek round "notices" targets (default 260)
//   splash    blast radius in px (plasma/explosive)
//   groundFire { radius, dps, duration } — leaves a burning patch on impact (napalm)
//   kind      explicit projectile art: 'flame' | 'fire' | 'bullet' | 'rail' | …
//
// shared fields: damage (per shot/pellet), range {min, opt, max}, slots, cycleTime
// (ms between trigger pulls).
//
// Ammo: every weapon carries its own self-contained magazine — there are no separate
// ammo bins or heat sinks. `ammoMax` is the magazine size and `ammoRegen` is how many
// rounds it refills per second (energy = battery recharge, ballistic = autoloader), so
// ammo is the only firing constraint and it tops back up over time. `ammoMax: null`
// means unlimited (melee).
//
// Display names are generic sci-fi, deliberately *not* franchise jargon; the ids stay
// stable so saved builds keep resolving.

const DELIVERY_DEFAULTS = {
  hit: 'projectile', velocity: 500, path: 'straight', guidance: null,
  pattern: 'single', spreadCount: 1, spreadAngle: 0, fireRate: 0, splash: 0,
};

function w(def) {
  const d = { ...DELIVERY_DEFAULTS, ...def.delivery };
  // Burst shorthand: wubOn + wubOff → interval; totalDamage / count → per-wub damage.
  if (d.burst) {
    if (d.burst.wubOn != null) d.burst = { ...d.burst, interval: d.burst.wubOn + d.burst.wubOff };
  }
  const damage = def.totalDamage != null
    ? def.totalDamage / (d.burst?.count ?? 1)
    : def.damage;
  return { ...def, damage, delivery: d };
}

export const WEAPONS = {
  // ── ENERGY ── five distinct feels: bursty pulses, a held beam, a sniper lance, an
  // arcing plasma lob, and a close-range flame cone. No ammo (battery recharge). ──
  pulseLaser: w({   // every trigger pull = a rapid burst of light beam pulses
    id: 'pulseLaser', name: 'Pulse Laser', category: 'energy',
    totalDamage: 16, range: { min: 0, opt: 340, max: 600 },
    ammoMax: 24, ammoRegen: 3.0, slots: 1, cycleTime: 3000,
    delivery: { hit: 'hitscan', pattern: 'single', burst: { count: 5, wubOn: 25, wubOff: 50 } },
  }),
  beamLaser: w({    // hold for ONE continuous beam locked on target; drains fast
    id: 'beamLaser', name: 'Beam Laser', category: 'energy',
    damage: 2, range: { min: 0, opt: 500, max: 640 },
    ammoMax: 120, ammoRegen: 18, slots: 2, cycleTime: 0,
    delivery: { hit: 'hitscan', pattern: 'stream', fireRate: 20, sustained: true },
  }),
  plasmaLance: w({  // #117: heavier, punchier travelling energy bolt — a real projectile
    // weapon (kind explicitly 'plasma'), NOT a hitscan beam. Formalizes the look that used to
    // happen accidentally: before #117's fix, enemy mechs mounting beamLaser (a hitscan/
    // sustained-beam weapon) fired it through the same unconditional `_spawnProjectile` path
    // every enemy weapon went through, so it fell back to a slow travelling plasma bolt instead
    // of an instant beam. Jackson played it and liked that accidental look, so rather than
    // "fixing" beamLaser to render as a proper beam for enemies, this is its own deliberately-
    // tuned weapon (damage/velocity/range/cadence NOT inherited from beamLaser's numbers).
    // #118: made player-mountable, tuned as a single heavy bolt (cycleTime 900, pattern
    // 'single'), ~1.1 shots/sec.
    // #125: playtest correction — the "accidental" look Jackson actually liked wasn't just the
    // travelling-bolt art, it was beamLaser's own cadence leaking through: beamLaser is
    // `{ hit: 'hitscan', pattern: 'stream', fireRate: 20, sustained: true }`, ticking ~20/sec
    // while held, and pre-#117 every one of those ticks spawned its own bolt. #118's single-shot
    // 900ms cadence was ~18x slower than that and read as "much less cool." Reworked to a genuine
    // `hit: 'projectile'` STREAM — same delivery shape as Repeater/machineGun (`pattern:
    // 'stream'` + `fireRate`), just single-lane instead of twin — so it now fires individual
    // travelling plasma bolts at fireRate: 20, matching beamLaser's original misrouted cadence.
    // velocity/range/kind ('plasma') are the weapon's visual identity and are UNCHANGED from
    // #118 — only cadence and the numbers that have to move with it (damage, ammo) changed.
    // Rebalance math: a ~18x cadence jump can't keep 20-damage hits (that'd be ~400 dps), so
    // damage came down to 2/bolt — mirroring beamLaser's own per-tick damage (also 2), since
    // both are now "many small hits at 20/sec" weapons. Ammo had to be redesigned from scratch
    // for a stream instead of a single shot: ammoRegen (10/s) is deliberately HALF of fireRate
    // (20/s), so — unlike #118's original retune note about the AI's ammoRegen accidentally
    // outpacing its fire rate and giving de facto unlimited ammo — holding the trigger always
    // drains the magazine net 10 ammo/s. ammoMax: 60 gives a real ~6s full-rate burst (60 /
    // (20-10)) before the mag empties and fire throttles down to whatever the 10/s regen can
    // support; steady-state that's damage(2) × regen(10) = 20 sustained dps — same ballpark as
    // #118's original ~20 sustained dps target, so Plasma Lance keeps its spot above Autocannon
    // (~14.6 dps) and Scatter Gun (~16.8 dps) but well below Beam Laser's (~36+ dps) flagship
    // tier, while the initial burst (damage × fireRate = 40 raw dps) reads as a genuinely punchy
    // rapid stream, not a trickle. Full recharge from empty takes ~6s (60 / 10), symmetric with
    // the burst window. cycleTime is unused for a stream pattern (see _fireInterval in
    // firing.js), left at 0 like every other stream weapon (beamLaser/machineGun/flamethrower).
    // The enemy sniper/artillery fire loop (src/scenes/arena/enemies.js) already drives cadence
    // generically off `_fireInterval`, which already branches on `pattern === 'stream'` — no
    // enemy-side code changes were needed for this to work as an enemy-fired projectile stream.
    id: 'plasmaLance', name: 'Plasma Lance', category: 'energy',
    damage: 2, range: { min: 0, opt: 460, max: 620 },
    ammoMax: 60, ammoRegen: 10, slots: 2, cycleTime: 0,
    // #213: very light per-bolt tracking bias (Halo Needler-style) — see `weakSeek` above.
    // NOT `guidance: 'homing'` — these bolts never lock on and never gate firing on a lock
    // (targetlock.js only checks `guidance === 'homing'`).
    // #219: playtest tuning pass — velocity nudged down slightly (620 -> 580, ~6%) and
    // WEAK_SEEK_TURN_RATE (see delivery.js) nudged up so the seek reads a bit more.
    // #220: a small spreadJitter (2°) so the single-lane bolt stream sputters a little off
    // its perfectly straight line instead of every bolt tracking the exact same trajectory.
    // This is a single-lane stream (no sprayCount/streams/cluster/spread), so in
    // delivery.js's planEmissions() this hits the "single continuously-streamed shot"
    // branch (n === 1, jitterRad truthy) — each bolt still gets exactly ONE shot per
    // cadence tick, just with its own small random angleOffset. Deliberately much smaller
    // than Flamethrower's 9° spray-cone jitter — this should read as a subtle sputter/
    // wobble on one bolt, not a fan; start conservative and go bigger only on playtest ask.
    // #223: playtest verdict was angle wobble only, no speed variance — `jitterSpeed: false`
    // opts this weapon out of makeProjectile()'s paired speed-jitter branch (delivery.js),
    // so every bolt still launches at the exact tuned 580 (#219) with zero velocity spread.
    delivery: { hit: 'projectile', path: 'straight', velocity: 580, pattern: 'stream', fireRate: 20, kind: 'plasma', weakSeek: true, spreadJitter: 2, jitterSpeed: false },
  }),
  railLance: w({    // railgun sniper: slow charge, one heavy long-range lance
    id: 'railLance', name: 'Rail Lance', category: 'energy',
    damage: 34, range: { min: 120, opt: 400, max: 640 },
    ammoMax: 3, ammoRegen: 0.4, slots: 2, cycleTime: 2200,
    delivery: { hit: 'hitscan', pattern: 'single', kind: 'rail' },
  }),
  plasmaCannon: w({ // arcing energy bolt with splash; lobs over cover
    id: 'plasmaCannon', name: 'Plasma Arc', category: 'energy',
    damage: 18, range: { min: 0, opt: 480, max: 820 },
    ammoMax: 4, ammoRegen: 0.5, slots: 2, cycleTime: 1600,
    // #252 playtest follow-up: "lobbed weapons should actually seek, not just fly to the spot
    // targeted when the shot was initiated." NOT `guidance: 'homing'` — that would flip
    // canFireWeapon's no-lock-no-fire gate on (targetlock.js only special-cases
    // guidance === 'homing'), and this round is explicitly meant to keep firing unconditionally,
    // lock or no lock, exactly like before. `tracksLock` is a separate opt-in (firing.js
    // _spawnProjectile): the round still dumb-fires ballistically with no lock, but if the
    // player DOES have one when the trigger's pulled, it steers live at the lock's target as it
    // moves (the same arcing-homing-blend machinery Swarm Rack/Streak Pod already use — descent-
    // phase-only steering, see arcHomingBlend). `homingTurnRadius` is deliberately wide (vs. the
    // missile family's default 64px) so the turn rate lands near the engine's HOMING_TURN_MIN
    // floor (3.2 rad/s) rather than up near HOMING_TURN_MAX (9.0) like Swarm Rack/Streak Pod —
    // this should read as a heavy lobbed shell nudging itself onto a moving target, not a
    // missile snapping onto it.
    delivery: { hit: 'projectile', path: 'arcing', velocity: 320, pattern: 'single', splash: 40, tracksLock: true, homingTurnRadius: 140 },
  }),
  flamethrower: w({ // close-mid gout of flame, held as one continuous stream
    id: 'flamethrower', name: 'Flamethrower', category: 'energy',
    // #256 playtest rebalance: damage 2 -> 0.65 (revised target, see below). Flamethrower's
    // DPS is fireRate(18) x sprayCount-average(3, from {min:2,max:4}) x damage, so
    // 18*3*2 = 108 dps originally — a ~40%+ overshoot over Repeater's 72 dps (18 x
    // streams(2) x damage(2)). A first pass dropped damage to 1.5 (81 dps), but the
    // corrected target is ~35 dps — well below Repeater, not a near-miss of it — so damage
    // came down further to 0.65: 18*3*0.65 = 35.1 dps.
    damage: 0.65, range: { min: 0, opt: 338, max: 600 },
    ammoMax: 150, ammoRegen: 22, slots: 2, cycleTime: 0,
    // pattern: 'stream' + fireRate (continuous rework, #46): a cadence tick every ~55ms,
    // each popping a random 2-4 particles (sprayCount) instead of exactly one, so held
    // fire reads as one dense, unbroken gout rather than a thin single-file tracer or a
    // series of pulses. fireRate sits below ammoRegen (18 < 22) so holding the trigger
    // never runs the magazine dry. spreadJitter is narrower than the original pulsed
    // version (9° vs 20°) for a tighter cone, and still randomizes each particle's angle
    // (and makeProjectile's speed) so the stream looks chaotic, not laser-straight.
    // range/velocity pushed out (#52): the flame reaches further (max 160, opt 90 at the
    // time) while velocity 230 keeps it a punchy close-mid gout — the round dies at
    // range.max+40, so the speed is bumped in step so particles actually reach the new
    // max before expiring instead of crawling out and fizzling short.
    // #135: range extended further still (opt 90/max 160 → opt 338/max 600) to bring every
    // weapon's max range up to at least 600. This meaningfully changes flamethrower's
    // close-range identity (a short gout of flame) more than the other weapons touched by
    // #135 — applied per explicit instruction, but flagged as worth a follow-up
    // conversation about whether flamethrower should have been an exception.
    delivery: { hit: 'projectile', pattern: 'stream', fireRate: 18, sprayCount: { min: 2, max: 4 }, spreadJitter: 9, velocity: 230, kind: 'flame', splash: 6 },
  }),

  // ── BALLISTIC ── solid rounds, burn ammo. A single heavy shell, a bullet stream, a
  // tight fast pellet burst, and a lobbed incendiary that paints the ground. ──
  autocannon: w({   // one heavy, very fast direct-fire shell — punchy single hits
    id: 'autocannon', name: 'Autocannon', category: 'ballistic',
    damage: 16, range: { min: 0, opt: 347, max: 600 },
    ammoMax: 12, ammoRegen: 1.0, slots: 2, cycleTime: 1100,
    delivery: { hit: 'projectile', path: 'straight', velocity: 760, pattern: 'single', kind: 'slug' },
  }),
  machineGun: w({   // sustained stream of small fast tracer rounds
    id: 'machineGun', name: 'Repeater', category: 'ballistic',
    // #256 playtest round 2: damage 2 -> 1.667 to bring DPS down from 72 to ~60.
    // DPS = damage x streams(2) x fireRate(18): 2*2*18 = 72 -> 1.667*2*18 = 60.
    damage: 1.667, range: { min: 0, opt: 338, max: 600 },
    ammoMax: 80, ammoRegen: 14, slots: 1, cycleTime: 0,
    // streams: 2 — each cadence tick fires 2 rounds in parallel lanes (streamSpacing px
    // apart, straddling the aim line), reading as twin tracer streams, not a fan. Bump to
    // `streams: 3` for a triple stream (widen streamSpacing to taste if the lanes crowd).
    delivery: { hit: 'projectile', path: 'straight', velocity: 900, pattern: 'stream', fireRate: 18, streams: 2, streamSpacing: 5, kind: 'bullet', scale: 0.75 },
  }),
  shotgun: w({      // tight, very fast pellet burst — a shotgun, not a wide scatter
    id: 'shotgun', name: 'Scatter Gun', category: 'ballistic',
    damage: 3, range: { min: 0, opt: 338, max: 600 },
    ammoMax: 8, ammoRegen: 0.8, slots: 2, cycleTime: 1200,
    // #101 correction: an earlier pass jittered each pellet's LAUNCH angle for an "organic"
    // feel, but the owner wants the fan itself perfectly even/deterministic every trigger
    // pull — no spreadJitter. Instead the pellets get Cluster Salvo's actual mechanism
    // (#51): independent per-projectile FLIGHT wobble (`wobble: 'sway'`, see wobbleKind() /
    // stepProjectile in delivery.js) — each pellet rolls its own random wobblePhase, so it
    // sways along its own fixed launch line during flight even though the fan angles stay
    // fixed. Amplitude/frequency are scaled down for a pellet's much shorter flight (max
    // range 320px @ 980px/s ≈ a third of Cluster Salvo's flight time): half the lateral
    // amplitude, double the frequency, so the wobble still reads as a visible sway rather
    // than a flat line over that short a flight.
    delivery: { hit: 'projectile', path: 'straight', velocity: 980, pattern: 'spread', spreadCount: 7, spreadAngle: 7, kind: 'bullet', wobble: 'sway', wobbleAmplitude: 2.5, wobbleFrequency: 14 },
  }),
  napalm: w({       // lobbed canister that bursts into a burning ground patch
    id: 'napalm', name: 'Napalm Lobber', category: 'ballistic',
    damage: 6, range: { min: 50, opt: 500, max: 780 },
    ammoMax: 6, ammoRegen: 0.7, slots: 2, cycleTime: 1500,
    // #252 playtest follow-up — see plasmaCannon's comment above for the full rationale:
    // `tracksLock: true`, not `guidance: 'homing'`, so this still fires unconditionally with no
    // lock (canFireWeapon is untouched), but steers at the lock's live target through the
    // descent when the player does have one, same arcing-homing-blend as Swarm Rack/Streak Pod.
    // `homingTurnRadius` widened the same way so it turns in lazily near the 3.2 rad/s floor,
    // not the missile family's near-9 rad/s ceiling.
    delivery: { hit: 'projectile', path: 'arcing', velocity: 300, splash: 30, kind: 'fire', groundFire: { radius: 46, dps: 8, duration: 4 }, tracksLock: true, homingTurnRadius: 140 },
  }),
  // #244: siegeShell (the #94 sentry-turret artillery round) was deleted from this registry —
  // it was mechanically identical to napalm (both arcing projectile + splash + groundFire
  // lobbed rounds), differing only in tuning numbers. The turret now mounts napalm with a
  // `weaponOverride` carrying the full artillery tuning (damage 10 / range 300-2400 / velocity
  // 550 / etc.) — see ENEMY_KINDS.turret in data/enemyKinds.js, which also inherited #94's
  // telegraphed-lob design commentary.

  // ── MISSILE ── three guidance archetypes: an all-at-once homing swarm, a rapid
  // stream of seekers, and a tight dumbfire cluster that flies straight as a clump. ──
  swarmRack: w({    // whole salvo launches at once, fans wide, then homes to the target
    id: 'swarmRack', name: 'Swarm Rack', category: 'missile',
    // #77 tuning follow-up: range 3.5x'd (80/300/500 → 280/1050/1750, min/opt/max shape kept
    // intact) per playtest feedback that missile range felt way too short. `velocity` is scaled
    // by the SAME factor so the constant-apex lob flight time (opt/velocity, firing.js
    // _spawnProjectile) stays unchanged — only the distance covered per second grows, not how
    // long a shot hangs in the air.
    // #256 playtest rebalance: damage 4 -> 8. DPS = spreadCount(6) x damage / cycleTime(1.6s),
    // so 6*4/1.6 = 15 dps pre-rebalance -> 6*8/1.6 = 30 dps, meaningfully above the old
    // ~15-23 missile band but still under Flamethrower (81) and Repeater (72) since the
    // homing guidance is itself a strong utility advantage over straight DPS.
    // #256 playtest round 2: damage 8 -> 10.667 to land at ~40 dps (6*10.667/1.6 = 40).
    damage: 10.667, range: { min: 280, opt: 1050, max: 1750 },
    ammoMax: 12, ammoRegen: 1.2, slots: 2, cycleTime: 1600,
    // wobble: 'jostle' — chaotic random-phase jiggle, constant all the way to impact (#49).
    // path: 'arcing' (#57) — lofts up then down like a real missile leaving the tube, so the
    // salvo can clear cover; guidance blends in during descent (see projectiles.js).
    delivery: { hit: 'projectile', guidance: 'homing', pattern: 'spread', spreadCount: 6, spreadAngle: 44, velocity: 1050, wobble: 'jostle', path: 'arcing' },
  }),
  streakPod: w({    // one press unloads a quick staggered stream of seekers, then cools down
    id: 'streakPod', name: 'Streak Pod', category: 'missile',
    // #77 tuning follow-up: range 3.5x'd (60/260/440 → 210/910/1540); velocity scaled by the
    // same 3.5x (see swarmRack comment above) to hold flight time constant.
    // #256 playtest rebalance: damage 5 -> 9. One trigger pull dumps the whole 6-missile
    // burst over cycleTime(1.8s): 5*6/1.8 = 16.7 dps pre-rebalance -> 9*6/1.8 = 30 dps.
    // #256 playtest round 2: damage 9 -> 12 to land at ~40 dps (12*6/1.8 = 40).
    damage: 12, range: { min: 210, opt: 910, max: 1540 },
    ammoMax: 4, ammoRegen: 0.45, slots: 2, cycleTime: 1800,
    // wobble: 'weave' — smooth deliberate sine weave, no decay (#50). burst (#50): a single
    // trigger pull fires the whole 6-missile stream in rapid succession, not held-to-fire.
    // path: 'arcing' (#57) — same loft-over-cover treatment as Swarm Rack.
    delivery: { hit: 'projectile', guidance: 'homing', velocity: 1540, wobble: 'weave', burst: { count: 6, interval: 70 }, path: 'arcing' },
  }),
  clusterRocket: w({ // dumbfire clump that stays tight — no spread, no guidance
    id: 'clusterRocket', name: 'Cluster Salvo', category: 'missile',
    // #77 tuning follow-up: range 3x'd (0/220/320 → 0/660/960, kept at the low end of the 3-4x
    // band since this one's a tight-clump dumbfire weapon, not a seeker); velocity scaled by the
    // same 3x so its (straight, non-arcing) travel time to max range doesn't balloon.
    // #256 playtest rebalance: damage 5 -> 7. DPS = spreadCount(5) x damage / cycleTime(1.1s),
    // so 5*5/1.1 = 22.7 dps pre-rebalance -> 5*7/1.1 = 31.8 dps, landing this dumbfire
    // cluster in the same ~30 dps missile band as its two homing siblings above.
    // #256 playtest round 2: damage 7 -> 8.8 to land at ~40 dps (5*8.8/1.1 = 40).
    damage: 8.8, range: { min: 0, opt: 660, max: 960 },
    ammoMax: 10, ammoRegen: 1.2, slots: 1, cycleTime: 1100,
    // scale 0.8 — slightly smaller rockets, and clusterSpacing 3.5 pulls the clump tighter (#51
    // playtest): a denser, more compact salvo rather than a loose spread.
    delivery: { hit: 'projectile', guidance: 'dumbfire', pattern: 'spread', spreadCount: 5, cluster: true, clusterSpacing: 3.5, velocity: 1140, scale: 0.8 },
  }),
};

// Shelve list — weapon ids listed here stay fully intact in WEAPONS above (data, art, sfx,
// enemy mounts) but are excluded from the player-facing catalog (WEAPON_IDS, and anything
// derived from it: garage/weapon-lab lists, shop). Enemy kinds are unaffected either way —
// enemyKinds.js/enemies.js resolve weapons directly via getWeapon()/resolveWeapon(), not the
// filtered WEAPON_IDS list. To shelve a weapon, add its id here; to re-enable it, delete the
// id — nothing else needs to change.
// History: #94/#95/#96 shelved everything off Jackson's 2026-07-10 curated keep-list
// (swarmRack/streakPod pending a lock/tracking rework, railLance/plasmaCannon/flamethrower/
// napalm not on the keep-list, siegeShell enemy-only); #118 graduated plasmaLance back off.
// #244 emptied the list entirely: every remaining weapon is player-mountable again
// (siegeShell no longer exists — consolidated into napalm via the turret's weaponOverride).
export const SHELVED_WEAPON_IDS = [];

export const WEAPON_IDS = Object.keys(WEAPONS).filter((id) => !SHELVED_WEAPON_IDS.includes(id));

export function getWeapon(id) {
  return WEAPONS[id];
}

// #243 (absorbing #242's design): resolve a weapon for a specific OWNER — the shared base
// WEAPONS entry with an optional partial `override` merged on top. This is how a non-player
// unit mounts "the Repeater, but weaker" without forking a whole near-duplicate WEAPONS entry
// that would drift from the base over time: the base stays the single source of truth and the
// override is only the delta (see ENEMY_KINDS.helicopter's `weaponOverride` for the live
// example — its single-lane Repeater delta).
//
// Merge semantics (deliberately simple — a data tool, not a deep-merge library):
//   • top-level fields shallow-merge (override wins): damage, cycleTime, ammoMax, range, …
//   • the nested `delivery` object ALSO shallow-merges (field by field), so an override can
//     retune just `fireRate` without restating the weapon's whole delivery profile;
//   • every other nested object (range, burst, sprayCount, groundFire…) is replaced WHOLESALE
//     when overridden — restate all of its fields;
//   • override values are FINAL values on the already-normalized weapon — the `w()` shorthand
//     (totalDamage, burst wubOn/wubOff) is not re-run;
//   • the returned object is fresh — the base WEAPONS entry (and its delivery) is never mutated;
//   • no/empty override returns the base entry itself (the common case stays allocation-free).
// `id` is intentionally left at the base weapon's id unless explicitly overridden, so per-id
// systems (SFX params/bakes, fire-cue throttling, impact sounds) treat an overridden mount as
// the same weapon it sounds and looks like.
export function resolveWeapon(baseId, override = null) {
  const base = WEAPONS[baseId];
  if (!base || !override) return base;
  const merged = { ...base, ...override };
  if (override.delivery) merged.delivery = { ...base.delivery, ...override.delivery };
  return merged;
}

// #120: the weapon catalog's card preview (src/ui/weaponCardList.js) draws each weapon's live
// shot/beam scaled relative to the farthest-reaching weapon players actually see in the
// catalog, so a short-range weapon visibly travels less of the card than a long-range one
// instead of every card just maxing out its own pixel width. Pulled out here (pure, unit-
// testable) rather than left inline in the Phaser-only UI file. Defaults to WEAPON_IDS (the
// player-facing, non-shelved set both GarageScene and WeaponLabScene actually render as
// cards) so a shelved weapon's huge range doesn't flatten the visible spread among weapons
// nobody's looking at side by side. (#244: this only ever sees BASE registry entries — an
// enemy kind's `weaponOverride` range, like the turret's 2400px artillery napalm, never
// leaks into the catalog; napalm's card scales by its base 780 max / 500 opt.)
export function catalogMaxRange(ids = WEAPON_IDS) {
  return Math.max(0, ...ids.map((id) => {
    const r = WEAPONS[id]?.range;
    return r?.opt || r?.max || 0;
  }));
}

// Fraction (0-1, floored at minFrac so even the shortest-range weapon stays visible) of the
// catalog's farthest range this weapon's own opt/max range represents.
export function previewRangeFrac(weapon, catalogMax, minFrac = 0.15) {
  const r = weapon?.range;
  const opt = r?.opt || r?.max || 0;
  if (!catalogMax) return 1;
  return Math.max(minFrac, opt / catalogMax);
}
