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
//   • #559: direct-hit damage now folds in the three delivery mechanisms whose damage the bare
//     `damage × count` formula used to miss entirely — see `effectiveDamagePerPull` below (DoT
//     ticks, a travelling AoE cloud's linger damage, and a chargeable weapon's realistic average
//     charge multiplier). Napalm's `groundFire` ground-patch DOT is NOT one of these (still
//     direct-hit only) — it wasn't in scope for #559 and stays a documented undercount, same as
//     plasma splash's impact radius (already direct-hit, just wide).
//   • Gravity Well's near-zero `damage` is intentional (a hazard/pull weapon, not a damage
//     weapon) and stays near-zero here too — there's no damage-shaped equivalent for "pulls
//     enemies into a kill zone," so its low DPS figure is expected, not a bug.
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

// #559 — a chargeable weapon's REALISTIC average damage multiplier. The un-modified `damage`
// field prices every shot at a theoretical 1.0x, but a chargeable weapon (Charge Lance) never
// actually fires at 1.0x — every real shot lands somewhere on its `minDamageMult`..`maxDamageMult`
// curve (0.5x tapped, 2.5x held to full). Averaging the two endpoints is the same "assume the
// realistic middle of the range" approach the rest of this file already takes for burst/sustained
// (a mid-mag average), not the un-fired theoretical floor.
function chargeDamageMult(weapon) {
  const c = weapon?.delivery?.chargeable;
  if (!c) return 1;
  return ((c.minDamageMult ?? 1) + (c.maxDamageMult ?? 1)) / 2;
}

// #559 — extra per-pull damage from a DoT effect (Plasma Coater's burn) that a direct-hit-only
// formula misses entirely. `dot.tickDamage` fires every `tickInterval`s for `dot.duration`s once a
// hit lands, so one landed hit's FULL DoT payout is `tickDamage × (duration / tickInterval)`. A
// repeat hit only refreshes (no stacking, see plasmaCoater's comment in weapons.js), so this counts
// one full payout per landed hit — exactly matching "each pull that connects lands one DoT".
function dotDamagePerHit(weapon) {
  const dot = weapon?.delivery?.dot;
  if (!dot) return 0;
  const ticks = (dot.duration ?? 0) / (dot.tickInterval || 1);
  return (dot.tickDamage ?? 0) * ticks;
}

// #559 — expected extra damage from a travelling AoE cloud (Caustic Lobber's corrosive tendrils):
// its own `dps` ticked over an ASSUMED linger time near a target, not the round's full flight —
// most of a travelAoe round's flight isn't spent hovering over an enemy. This is a stat-sheet
// estimate, tunable in one place, matching the "assume the realistic middle" approach above.
const EXPECTED_TRAVEL_AOE_LINGER_S = 2;
function travelAoeDamagePerPull(weapon) {
  const aoe = weapon?.delivery?.travelAoe;
  if (!aoe) return 0;
  return (aoe.dps ?? 0) * EXPECTED_TRAVEL_AOE_LINGER_S;
}

// #559 — the "effective DPS" figure: `damagePerPull`, but priced at a chargeable weapon's
// realistic average multiplier and with DoT/travelAoe payouts folded in as extra damage per landed
// pull. This is what `burstDps`/`sustainedDps` actually use — `damagePerPull` itself stays the
// plain direct-hit number (still meaningful on its own, e.g. "how hard does one hit land").
export function effectiveDamagePerPull(weapon) {
  const count = weapon?.delivery?.count ?? 1;
  const directHit = (weapon?.damage ?? 0) * chargeDamageMult(weapon) * count;
  return directHit + dotDamagePerHit(weapon) + travelAoeDamagePerPull(weapon);
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
// #559: priced off `effectiveDamagePerPull`, not the bare direct-hit `damagePerPull` — see header.
export function burstDps(weapon) {
  const iv = pullIntervalMs(weapon);
  if (!iv) return 0;
  return effectiveDamagePerPull(weapon) / (iv / 1000);
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
  return (pulls * effectiveDamagePerPull(weapon)) / (cycleMs / 1000);
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

// ── #451: what the AMMO READOUT counts ───────────────────────────────────────────────────────
//
// Jackson: "missile ammo/reload should be the projectile count, not just the 'shot' count" —
// confirmed as TOTAL PROJECTILES REMAINING: a 4-round magazine firing 5 missiles per pull reads
// as 20 and drops by 5 each time the trigger comes back.
//
// The magazine itself is untouched — this is purely how it is COUNTED for the player. A round
// buys `delivery.count` emitted things, except on an `ammoPerShot` volley weapon (Plasma Arc)
// where each emitted bolt already costs its own round, so there a round buys exactly one. Dividing
// by `roundsPerPull` expresses both cases as one number and is why this lives here, next to the
// rule it shares, rather than in the HUD.
//
// Written generically off `delivery.count` rather than against any weapon id, so every
// multi-projectile weapon (Scatter Gun's pellets, Streak Pod's stream, Cluster Salvo) counts the
// same way and a single-shot weapon's readout is byte-identical to what it always was (count 1
// ⇒ a ratio of 1).
export function projectilesPerRound(weapon) {
  const count = Math.max(1, weapon?.delivery?.count ?? 1);
  return count / roundsPerPull(weapon);
}

// The player-facing magazine readout for a live weapon slot: how many PROJECTILES are left, out of
// how many a full magazine holds, plus the fill fraction the tile's ammo bar draws. `ammo` is the
// slot's live round count (data/Mech.js `weapons()`), which may be fractional (#235 Overdrive) —
// hence the floor: a magazine that can no longer afford a whole pull must not advertise one.
// Returns null for an unlimited weapon (melee), which has no magazine to report.
export function magazineReadout(weapon, ammo) {
  if (ammo == null || weapon?.ammoMax == null) return null;
  const per = projectilesPerRound(weapon);
  return {
    per,
    left: Math.floor(Math.max(0, ammo) * per),
    max: Math.round(weapon.ammoMax * per),
    frac: weapon.ammoMax > 0 ? Math.max(0, Math.min(1, ammo / weapon.ammoMax)) : 0,
  };
}

// The whole catalog's theory table, keyed by id — handy for a stat sheet.
export function allWeaponTheory() {
  const out = {};
  for (const id of Object.keys(WEAPONS)) out[id] = weaponTheory(id);
  return out;
}
