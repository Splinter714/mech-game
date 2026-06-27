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
//   fireRate  shots per second for a `stream` weapon (machine gun)
//   splash    blast radius in px (plasma/explosive)
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
  return { ...def, delivery: { ...DELIVERY_DEFAULTS, ...def.delivery } };
}

export const WEAPONS = {
  mediumLaser: w({
    id: 'mediumLaser', name: 'Pulse Beam', category: 'energy',
    damage: 12, range: { min: 0, opt: 180, max: 320 },
    ammoMax: 8, ammoRegen: 1.4, slots: 1, cycleTime: 900,
    delivery: { hit: 'hitscan', pattern: 'single' },
  }),
  plasmaCannon: w({
    id: 'plasmaCannon', name: 'Plasma Arc', category: 'energy',
    damage: 18, range: { min: 0, opt: 160, max: 300 },
    ammoMax: 4, ammoRegen: 0.5, slots: 2, cycleTime: 1600,
    delivery: { hit: 'projectile', path: 'arcing', velocity: 260, pattern: 'single', splash: 40 },
  }),
  autocannon: w({
    id: 'autocannon', name: 'Slug Driver', category: 'ballistic',
    damage: 16, range: { min: 0, opt: 200, max: 360 },
    ammoMax: 12, ammoRegen: 1.0, slots: 2, cycleTime: 1100,
    delivery: { hit: 'projectile', path: 'straight', velocity: 620, pattern: 'single' },
  }),
  machineGun: w({
    id: 'machineGun', name: 'Repeater', category: 'ballistic',
    damage: 2, range: { min: 0, opt: 80, max: 140 },
    ammoMax: 80, ammoRegen: 14, slots: 1, cycleTime: 0,
    delivery: { hit: 'projectile', path: 'straight', velocity: 520, pattern: 'stream', fireRate: 12 },
  }),
  shotgun: w({
    id: 'shotgun', name: 'Scatter Gun', category: 'ballistic',
    damage: 3, range: { min: 0, opt: 90, max: 160 },
    ammoMax: 8, ammoRegen: 0.8, slots: 2, cycleTime: 1200,
    delivery: { hit: 'projectile', path: 'straight', velocity: 480, pattern: 'spread', spreadCount: 8, spreadAngle: 24 },
  }),
  lrm: w({
    id: 'lrm', name: 'Seeker Rack', category: 'missile',
    damage: 4, range: { min: 80, opt: 300, max: 500 },
    ammoMax: 12, ammoRegen: 1.2, slots: 2, cycleTime: 1400,
    delivery: { hit: 'projectile', guidance: 'homing', pattern: 'spread', spreadCount: 6, velocity: 300 },
  }),
  srm: w({
    id: 'srm', name: 'Rocket Pod', category: 'missile',
    damage: 5, range: { min: 0, opt: 140, max: 240 },
    ammoMax: 10, ammoRegen: 1.2, slots: 1, cycleTime: 1100,
    delivery: { hit: 'projectile', guidance: 'dumbfire', pattern: 'spread', spreadCount: 4, velocity: 340, spreadAngle: 14 },
  }),
  hatchet: w({
    id: 'hatchet', name: 'Cleaver', category: 'melee',
    damage: 22, range: { min: 0, opt: 0, max: 32 },
    ammoMax: null, ammoRegen: 0, slots: 2, cycleTime: 1300,
    delivery: { hit: 'contact', pattern: 'single' },
  }),

  // ── Energy variants (#20): same category, very different cadence/feel ──
  pulseLaser: w({   // rapid, forgiving, light per-hit
    id: 'pulseLaser', name: 'Pulse Laser', category: 'energy',
    damage: 5, range: { min: 0, opt: 150, max: 260 },
    ammoMax: 24, ammoRegen: 3.2, slots: 1, cycleTime: 180,
    delivery: { hit: 'hitscan', pattern: 'single' },
  }),
  beamLaser: w({    // hold for a near-continuous beam; drains fast
    id: 'beamLaser', name: 'Beam Laser', category: 'energy',
    damage: 2, range: { min: 0, opt: 200, max: 340 },
    ammoMax: 100, ammoRegen: 16, slots: 2, cycleTime: 0,
    delivery: { hit: 'hitscan', pattern: 'stream', fireRate: 18 },
  }),
  railLance: w({    // slow, long-range, heavy single hit
    id: 'railLance', name: 'Rail Lance', category: 'energy',
    damage: 34, range: { min: 120, opt: 400, max: 640 },
    ammoMax: 3, ammoRegen: 0.4, slots: 2, cycleTime: 2200,
    delivery: { hit: 'hitscan', pattern: 'single' },
  }),

  // ── Sustained-cone + incendiary (#21, #22) ──
  flamethrower: w({ // short-range spray of slow flame; chews up anything close
    id: 'flamethrower', name: 'Flamethrower', category: 'energy',
    damage: 2, range: { min: 0, opt: 55, max: 100 },
    ammoMax: 150, ammoRegen: 22, slots: 2, cycleTime: 100,
    delivery: { hit: 'projectile', pattern: 'spread', spreadCount: 3, spreadAngle: 24, velocity: 165, kind: 'flame', splash: 6 },
  }),
  napalm: w({       // lobbed canister that bursts into a burning ground patch
    id: 'napalm', name: 'Napalm Lobber', category: 'ballistic',
    damage: 6, range: { min: 50, opt: 170, max: 280 },
    ammoMax: 6, ammoRegen: 0.7, slots: 2, cycleTime: 1500,
    delivery: { hit: 'projectile', path: 'arcing', velocity: 230, splash: 30, kind: 'fire', groundFire: { radius: 46, dps: 8, duration: 4 } },
  }),
};

export const WEAPON_IDS = Object.keys(WEAPONS);

export function getWeapon(id) {
  return WEAPONS[id];
}
