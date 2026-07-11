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
//   sustained a `stream` hitscan held as ONE continuous beam, not a flicker (beam laser)
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
    totalDamage: 16, range: { min: 0, opt: 170, max: 300 },
    ammoMax: 24, ammoRegen: 3.0, slots: 1, cycleTime: 3000,
    delivery: { hit: 'hitscan', pattern: 'single', burst: { count: 5, wubOn: 25, wubOff: 50 } },
  }),
  beamLaser: w({    // hold for ONE continuous beam locked on target; drains fast
    id: 'beamLaser', name: 'Beam Laser', category: 'energy',
    damage: 2, range: { min: 0, opt: 500, max: 640 },
    ammoMax: 120, ammoRegen: 18, slots: 2, cycleTime: 0,
    delivery: { hit: 'hitscan', pattern: 'stream', fireRate: 20, sustained: true },
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
    delivery: { hit: 'projectile', path: 'arcing', velocity: 320, pattern: 'single', splash: 40 },
  }),
  flamethrower: w({ // close-mid gout of flame, held as one continuous stream
    id: 'flamethrower', name: 'Flamethrower', category: 'energy',
    damage: 2, range: { min: 0, opt: 90, max: 160 },
    ammoMax: 150, ammoRegen: 22, slots: 2, cycleTime: 0,
    // pattern: 'stream' + fireRate (continuous rework, #46): a cadence tick every ~55ms,
    // each popping a random 2-4 particles (sprayCount) instead of exactly one, so held
    // fire reads as one dense, unbroken gout rather than a thin single-file tracer or a
    // series of pulses. fireRate sits below ammoRegen (18 < 22) so holding the trigger
    // never runs the magazine dry. spreadJitter is narrower than the original pulsed
    // version (9° vs 20°) for a tighter cone, and still randomizes each particle's angle
    // (and makeProjectile's speed) so the stream looks chaotic, not laser-straight.
    // range/velocity pushed out (#52): the flame reaches further (max 160, opt 90) while
    // velocity 230 keeps it a punchy close-mid gout — the round dies at range.max+40, so
    // the speed is bumped in step so particles actually reach the new max before expiring
    // instead of crawling out and fizzling short.
    delivery: { hit: 'projectile', pattern: 'stream', fireRate: 18, sprayCount: { min: 2, max: 4 }, spreadJitter: 9, velocity: 230, kind: 'flame', splash: 6 },
  }),

  // ── BALLISTIC ── solid rounds, burn ammo. A single heavy shell, a bullet stream, a
  // tight fast pellet burst, and a lobbed incendiary that paints the ground. ──
  autocannon: w({   // one heavy, very fast direct-fire shell — punchy single hits
    id: 'autocannon', name: 'Autocannon', category: 'ballistic',
    damage: 16, range: { min: 0, opt: 220, max: 380 },
    ammoMax: 12, ammoRegen: 1.0, slots: 2, cycleTime: 1100,
    delivery: { hit: 'projectile', path: 'straight', velocity: 760, pattern: 'single', kind: 'slug' },
  }),
  machineGun: w({   // sustained stream of small fast tracer rounds
    id: 'machineGun', name: 'Repeater', category: 'ballistic',
    damage: 2, range: { min: 0, opt: 180, max: 320 },
    ammoMax: 80, ammoRegen: 14, slots: 1, cycleTime: 0,
    // streams: 2 — each cadence tick fires 2 rounds in parallel lanes (streamSpacing px
    // apart, straddling the aim line), reading as twin tracer streams, not a fan. Bump to
    // `streams: 3` for a triple stream (widen streamSpacing to taste if the lanes crowd).
    delivery: { hit: 'projectile', path: 'straight', velocity: 900, pattern: 'stream', fireRate: 18, streams: 2, streamSpacing: 5, kind: 'bullet', scale: 0.75 },
  }),
  shotgun: w({      // tight, very fast pellet burst — a shotgun, not a wide scatter
    id: 'shotgun', name: 'Scatter Gun', category: 'ballistic',
    damage: 3, range: { min: 0, opt: 180, max: 320 },
    ammoMax: 8, ammoRegen: 0.8, slots: 2, cycleTime: 1200,
    delivery: { hit: 'projectile', path: 'straight', velocity: 980, pattern: 'spread', spreadCount: 7, spreadAngle: 7, kind: 'bullet' },
  }),
  napalm: w({       // lobbed canister that bursts into a burning ground patch
    id: 'napalm', name: 'Napalm Lobber', category: 'ballistic',
    damage: 6, range: { min: 50, opt: 500, max: 780 },
    ammoMax: 6, ammoRegen: 0.7, slots: 2, cycleTime: 1500,
    delivery: { hit: 'projectile', path: 'arcing', velocity: 300, splash: 30, kind: 'fire', groundFire: { radius: 46, dps: 8, duration: 4 } },
  }),

  // ── MISSILE ── three guidance archetypes: an all-at-once homing swarm, a rapid
  // stream of seekers, and a tight dumbfire cluster that flies straight as a clump. ──
  swarmRack: w({    // whole salvo launches at once, fans wide, then homes to the target
    id: 'swarmRack', name: 'Swarm Rack', category: 'missile',
    // #77 tuning follow-up: range 3.5x'd (80/300/500 → 280/1050/1750, min/opt/max shape kept
    // intact) per playtest feedback that missile range felt way too short. `velocity` is scaled
    // by the SAME factor so the constant-apex lob flight time (opt/velocity, firing.js
    // _spawnProjectile) stays unchanged — only the distance covered per second grows, not how
    // long a shot hangs in the air.
    damage: 4, range: { min: 280, opt: 1050, max: 1750 },
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
    damage: 5, range: { min: 210, opt: 910, max: 1540 },
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
    damage: 5, range: { min: 0, opt: 660, max: 960 },
    ammoMax: 10, ammoRegen: 1.2, slots: 1, cycleTime: 1100,
    // scale 0.8 — slightly smaller rockets, and clusterSpacing 3.5 pulls the clump tighter (#51
    // playtest): a denser, more compact salvo rather than a loose spread.
    delivery: { hit: 'projectile', guidance: 'dumbfire', pattern: 'spread', spreadCount: 5, cluster: true, clusterSpacing: 3.5, velocity: 1140, scale: 0.8 },
  }),
};

// #95/#96: temporary shelve list — pared down to Jackson's curated keep-list (2026-07-10
// weapon curation pass, #96): Beam Laser + Repeater (great, unchanged) and Pulse Laser,
// Cluster Salvo, Autocannon, Scattergun (decent, kept active pending a future tuning pass).
// Everything else is shelved, including the #95 homing/tracking pair (swarmRack/streakPod,
// pending a lock/tracking rework) plus railLance/plasmaCannon/flamethrower/napalm (#96 — not
// on the keep-list). Their WEAPONS entries above stay fully intact (data, art, sfx, etc.) —
// only the player-facing catalog (WEAPON_IDS, and anything derived from it: garage/weapon-lab
// lists, shop) excludes them. To re-enable a weapon, just delete its id from this array —
// nothing else needs to change.
export const SHELVED_WEAPON_IDS = ['swarmRack', 'streakPod', 'railLance', 'plasmaCannon', 'flamethrower', 'napalm'];

export const WEAPON_IDS = Object.keys(WEAPONS).filter((id) => !SHELVED_WEAPON_IDS.includes(id));

export function getWeapon(id) {
  return WEAPONS[id];
}
