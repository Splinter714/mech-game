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
//   fireRate  shots per second for a `stream` weapon (machine gun / streak missiles)
//   burst     { count, interval } — one trigger pull fires `count` rapid sub-shots
//             `interval` ms apart (the energy pulse laser's multi-pulse)
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
  flamethrower: w({ // short-range spray of slow flame; chews up anything close
    id: 'flamethrower', name: 'Flamethrower', category: 'energy',
    damage: 2, range: { min: 0, opt: 55, max: 100 },
    ammoMax: 150, ammoRegen: 22, slots: 2, cycleTime: 100,
    // spreadJitter (#46): randomizes each particle's angle/timing so the stream reads as a
    // chaotic gout of fire, not a clean repeating pulse of evenly-fanned shots.
    delivery: { hit: 'projectile', pattern: 'spread', spreadCount: 6, spreadAngle: 12, spreadJitter: 20, velocity: 165, kind: 'flame', splash: 6 },
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
    delivery: { hit: 'projectile', path: 'straight', velocity: 900, pattern: 'stream', fireRate: 18, kind: 'bullet', scale: 0.75 },
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
    damage: 4, range: { min: 80, opt: 300, max: 500 },
    ammoMax: 12, ammoRegen: 1.2, slots: 2, cycleTime: 1600,
    // wobble: 'jostle' — chaotic random-phase jiggle that settles on final approach (#49).
    delivery: { hit: 'projectile', guidance: 'homing', pattern: 'spread', spreadCount: 6, spreadAngle: 44, velocity: 300, wobble: 'jostle' },
  }),
  streakPod: w({    // fires seekers one-at-a-time in a rapid stream; each homes in
    id: 'streakPod', name: 'Streak Pod', category: 'missile',
    damage: 5, range: { min: 60, opt: 260, max: 440 },
    ammoMax: 16, ammoRegen: 1.6, slots: 2, cycleTime: 0,
    // wobble: 'weave' — smooth deliberate sine weave, no decay (#50).
    delivery: { hit: 'projectile', guidance: 'homing', pattern: 'stream', fireRate: 6, velocity: 440, wobble: 'weave' },
  }),
  clusterRocket: w({ // dumbfire clump that stays tight — no spread, no guidance
    id: 'clusterRocket', name: 'Cluster Salvo', category: 'missile',
    damage: 5, range: { min: 0, opt: 220, max: 320 },
    ammoMax: 10, ammoRegen: 1.2, slots: 1, cycleTime: 1100,
    delivery: { hit: 'projectile', guidance: 'dumbfire', pattern: 'spread', spreadCount: 5, cluster: true, velocity: 380 },
  }),
};

export const WEAPON_IDS = Object.keys(WEAPONS);

export function getWeapon(id) {
  return WEAPONS[id];
}
