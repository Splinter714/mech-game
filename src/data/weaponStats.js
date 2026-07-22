// #423 — Weapon DPS helpers: the "Theoretical" stat-sheet numbers, and the SINGLE SOURCE
// OF TRUTH shared between the garage stat sheet and the post-run telemetry (runStats.js).
//
// The game's firing model (scenes/arena/firing.js) consumes exactly ONE magazine round per
// TRIGGER PULL, regardless of how many projectiles that pull emits — a shotgun's 7 pellets, a
// swarm rack's 6 missiles, and a lone slug all cost one round. So DPS is reasoned per trigger
// pull, not per emitted projectile:
//
//   damagePerPull = damage × (delivery.count || 1)   — every emitted thing does `damage`, and
//                     the w() shorthand in weapons.js already divides a burst's totalDamage by
//                     count, so this one formula matches the DPS comment on EVERY weapon
//                     (pulse/beam/machineGun/shotgun/swarmRack/streakPod all check out).
//   pullIntervalMs = the real cadence _fireInterval uses (firing.js): 1000/fireRate for a
//                     `stream` weapon, else max(120, cycleTime). This is the canonical per-pull
//                     period — for stream weapons it is NOT cycleTime (which is 0 for them).
//
// SIMPLIFICATIONS (documented on purpose, matching the weapons.js DPS-comment convention):
//   • "Theoretical" assumes every emitted projectile connects (the stat-sheet ideal).
//   • Splash / groundFire DOT (napalm's burn, plasma splash) is NOT counted — these figures are
//     direct-hit DPS only, exactly as the per-weapon DPS comments in weapons.js are written.
//   • Buff/powerup cadence mults (cycleMult, barrage count-doubling) are NOT applied — these are
//     the un-modified base stat-sheet numbers.

import { RELOAD_SECONDS } from './Mech.js';
import { WEAPONS, getWeapon } from './weapons.js';

export const RELOAD_MS = RELOAD_SECONDS * 1000;

// Damage emitted by one trigger pull (one magazine round). See header.
export function damagePerPull(weapon) {
  const count = weapon?.delivery?.count ?? 1;
  return (weapon?.damage ?? 0) * count;
}

// ms between trigger pulls — the canonical cadence, mirroring firing.js `_fireInterval`
// with identity (un-buffed) mods.
export function pullIntervalMs(weapon) {
  const d = weapon?.delivery ?? {};
  if (d.pattern === 'stream' && d.fireRate > 0) return 1000 / d.fireRate;
  return Math.max(120, weapon?.cycleTime ?? 0);
}

// #434: magazine rounds spent per trigger pull. Normally ONE (the whole model above), but a
// `delivery.ammoPerShot` volley weapon (Plasma Arc) spends one round PER EMITTED BOLT — i.e.
// `count` per pull — so a 30-round mag is 6 volleys, not 30 pulls. Only sustainedDps (which
// counts pulls-per-mag) cares; burstDps is per-pull and is unchanged.
export function roundsPerPull(weapon) {
  return weapon?.delivery?.ammoPerShot ? Math.max(1, weapon?.delivery?.count ?? 1) : 1;
}

// Burst DPS — output while dumping a magazine, reload ignored.
export function burstDps(weapon) {
  const iv = pullIntervalMs(weapon);
  if (!iv) return 0;
  return damagePerPull(weapon) / (iv / 1000);
}

// Sustained DPS — averaged over the full mag → empty → reload → full cycle.
// ammoMax === null (unlimited, e.g. melee) never reloads, so Sustained === Burst.
export function sustainedDps(weapon) {
  const mag = weapon?.ammoMax;
  if (mag == null) return burstDps(weapon);
  const iv = pullIntervalMs(weapon);
  // #434: a mag empties in `mag / roundsPerPull` pulls, not `mag` — a per-bolt-ammo volley burns
  // its magazine `count`× faster, so it reaches the reload beat sooner.
  const pulls = mag / roundsPerPull(weapon);
  const cycleMs = pulls * iv + RELOAD_MS;
  if (!cycleMs) return 0;
  return (pulls * damagePerPull(weapon)) / (cycleMs / 1000);
}

// Full theoretical stat block for one weapon (id or resolved entry).
export function weaponTheory(weaponOrId) {
  const w = typeof weaponOrId === 'string' ? getWeapon(weaponOrId) : weaponOrId;
  if (!w) return null;
  return {
    id: w.id,
    name: w.name,
    category: w.category,
    damagePerPull: damagePerPull(w),
    pullIntervalMs: pullIntervalMs(w),
    ammoMax: w.ammoMax,
    reloadMs: w.ammoMax == null ? 0 : RELOAD_MS,
    burstDps: burstDps(w),
    sustainedDps: sustainedDps(w),
  };
}

// The whole catalog's theory table, keyed by id — handy for a stat sheet.
export function allWeaponTheory() {
  const out = {};
  for (const id of Object.keys(WEAPONS)) out[id] = weaponTheory(id);
  return out;
}
