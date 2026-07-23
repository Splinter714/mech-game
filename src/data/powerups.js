// Timed combat powerups (#60). Killing an enemy (later: facilities / world resources) can
// drop a world-space collectible that grants a TEMPORARY combat buff. This file is the pure,
// data-driven core: the powerup table (types + durations/magnitudes/weights, all tunable in
// one place), the weighted pick, the buff-overlay math (how N simultaneously-active buffs
// combine into the multipliers/flags the arena reads), and the proportional armor-repair calc.
// No Phaser — the arena mixin (scenes/arena/powerups.js) owns the collectible sprites,
// collision, and countdown; this file is fully unit-tested (powerups.test.js).
//
// Design rules baked in here:
//  - Buffs are an OVERLAY on top of the live Mech, never a mutation of the model, so they
//    expire cleanly. `buffModifiers(active)` collapses the set of active types into a plain
//    object the firing/movement code multiplies against.
//  - Stacking is ONE-PER-TYPE and DURATION-ONLY (#339): several different types can be active
//    at once (each with its own countdown); picking up a duplicate of an ALREADY-ACTIVE type
//    ADDS its full duration to that type's remaining time, capped (see `stackedRemainingMs`).
//    MAGNITUDE never compounds — a second Overdrive is the same fire-rate multiplier for
//    LONGER, not a faster one. That asymmetry is deliberate and load-bearing: #326 removed
//    every dock reinforcement cap and #328 made the Broodhauler an infinite drone source, so
//    there are far more farmable kills than when these were tuned. Magnitude stacking could
//    trivialise fights (a x4 Barrage, a x0.125 Overdrive cycle); duration stacking cannot —
//    the ceiling on how strong you get is unchanged, only how long you stay there moves.
//  - #409: FREE AMMO is NO LONGER a universal rule. #381 gave every active powerup free ammo for a
//    10s window; now that reload is a real mechanic (#402: a drained mag locks out then snaps full),
//    that blanket window was removed. Free ammo (and no-reload) is granted by ONE dedicated pickup —
//    INFINITE FIRE (`effect: 'infiniteFire'`) — and nothing else. `buffModifiers` sets both flags
//    only for that type.
//  - #409 consequence: Shield and Armor Patch lose their timed window entirely — they carry NO
//    `duration`, so `durationMs` is 0, they never enter the scene's `active` set, and they show no
//    HUD-buff countdown. Both are now purely INSTANT.
//  - Armor Patch's repair is INSTANT (applied on pickup, `instant: true`).
//  - Shield (#381, reworked from #246/#271) grants an expendable TEMPORARY pool on the mech's own
//    NATIVE shield layer (Mech.shield / HpBody.shield — data/shield.js) via Mech.grantTempShield:
//    damage spends it first and it never regenerates. #417: sequential Shield pickups now ADD their
//    full pool ON TOP of the current temp shield, UNCAPPED (grantTempShield sums instead of maxing).
//    The temp pool lives on the mech, not the scene overlay, and persists until spent by damage.

// #106: the drop-chance bounds are derived from the LIVE enemy roster (see `dropBounds` below).
// #301: that derivation now lives in data/rosterBounds.js, shared with the death-explosion tiers.
import { rosterToughnessBounds, liveToughnessBounds } from './rosterBounds.js';

// ── The powerup catalog (owner: tune) ───────────────────────────────────────────────────
// Each entry: id, label (HUD), color (collectible + HUD), weight (relative drop odds), and
// `duration` in seconds for timed buffs (Armor Patch is instant → no duration). The buff's
// MAGNITUDE lives on the entry too (a named field per effect) so tuning is a data edit.
export const POWERUPS = {
  // 1) Halved weapon cycle times (doubled rate of fire) for the duration.
  overdrive: {
    id: 'overdrive', label: 'OVERDRIVE', color: 0xe2533a, weight: 1,
    duration: 10, effect: 'fireRate', cycleMult: 0.5,
  },
  // 3) #189: redesigned on top of the Sprint mechanic (#188) — instead of a flat movement/
  //    slew multiplier, Overclock now force-activates Sprint (fuel-free) for its whole
  //    duration. No numeric magnitude fields: the "how much faster" question is answered by
  //    Sprint's own SPRINT_SPEED_MULT (src/data/sprint.js), not a separate multiplier here.
  //    See `buffModifiers` below (`overclockActive`) and the arena mixin's `_handleSprint`
  //    (scenes/arena/firing.js) for how the force/handoff state machine works.
  overclock: {
    id: 'overclock', label: 'OVERCLOCK', color: 0x7bd17b, weight: 1,
    duration: 10, effect: 'overclock',
  },
  // 4) INSTANT whole-mech proportional armor repair (no timer). Restores a fraction of EACH
  //    damaged location's MISSING armor, so every hurt location gets some back scaled to what
  //    it's missing. `repairFrac` is that fraction.
  //    #315: NOT a random drop any more. `weight: 0` takes it out of `pickPowerupType`'s pool
  //    entirely (see POWERUP_POOL_IDS below) — it used to carry the HIGHEST weight of any
  //    powerup (1.2 of 5.2, ~23% of every drop), making repair a constant trickle from ordinary
  //    kills. It is now awarded GUARANTEED, exactly one per base, when the player destroys that
  //    base's objective hex (scenes/arena/bases.js `_onTerrainCollapsed`). Still INSTANT.
  //    Colour is the palette's only ACHROMATIC entry (#315): every hue was already spoken for
  //    (gold/red-orange/green/cyan/violet) and the old light blue 0x8ad0ff sat right next to
  //    Shield's 0x5ec8e0. A gunmetal silver reads as bare armour plating and can't be mistaken
  //    for any coloured pickup. Deliberately NOT pure white — arctic snow ground is 0xd9e6ef
  //    and a white beacon washes out on it; this keeps enough grey to stay legible on snow and
  //    pale desert sand while still reading bright against every dark biome.
  //    #409: PURELY INSTANT again — the #381 free-ammo window was removed, so this carries no
  //    `duration` and never enters the scene's active-buff set. `isInstant` routes the repair;
  //    `durationMs` is 0.
  armorPatch: {
    id: 'armorPatch', label: 'ARMOR PATCH', color: 0x9fa8b2, weight: 0,
    objectiveOnly: true, instant: true, effect: 'armorPatch', repairFrac: 0.5,
  },
  // 4) #381 (reworked from #246/#271's capacity+regen multiplier): a TEMPORARY shield pool, the
  //    D&D temp-HP concept. On pickup the base shield is filled AND `tempPool` points of expendable
  //    shield are granted ON TOP of the base max — the bar and the in-world glow visibly GROW to
  //    show the larger total (base 100 + 150 temp = a 250 total). That temporary portion is spent
  //    FIRST by incoming damage and NEVER regenerates: once it is gone it is gone, and normal regen
  //    still only refills the base pool up to base max. The temp pool PERSISTS UNTIL SPENT by
  //    damage. #409: this is PURELY INSTANT now — the #381 free-ammo window was removed, so the
  //    entry carries NO `duration` and never enters the scene's active-buff set (no HUD timer). The
  //    shell just sits there until something chews through it. This deliberately sits OUTSIDE #380's
  //    regen path (25/sec, 3000ms pause) — the pool never recharges and never lifts the regen
  //    ceiling. #417: sequential pickups ADD `tempPool` ON TOP, UNCAPPED (grantTempShield sums), so
  //    stacking Shields grows the shell without limit. `tempPool` 150 is a big, clearly-felt shell
  //    (2.5x the 100 base total) without a single pickup being invincible; tune by play.
  shield: {
    id: 'shield', label: 'SHIELD', color: 0x5ec8e0, weight: 1,
    instant: true, effect: 'shield', tempPool: 150,
  },
  // 6) #409: INFINITE FIRE — the sole free-ammo pickup (replacing #381's universal window). For its
  //    duration, weapons cost NO ammo AND never reload: `buffModifiers` sets both `freeAmmo` (firing
  //    skips consumeAmmo) and `noReload` (the firing code ignores the reload gate), so a held trigger
  //    just dumps. CYAN/TEAL 0x28e0d8 — the only non-gold, clearly-cyan entry, distinct from Shield's
  //    lighter 0x5ec8e0 and the silver Armor Patch. Timed + stackable like the other buffs (weight 1,
  //    10s). No magnitude fields — the effect is purely the two flags.
  infiniteFire: {
    id: 'infiniteFire', label: 'INFINITE FIRE', color: 0x28e0d8, weight: 1,
    duration: 10, effect: 'infiniteFire',
  },
  // 5) #137: doubles how many things every weapon fires PER TRIGGER PULL — deliberately the
  //    complement to Overdrive, which multiplies how OFTEN it fires. Because #137 unified the
  //    old spreadCount/streams/burst.count fields into one `delivery.count`, `countMult` is a
  //    single multiplier that every delivery pattern honours through its own existing
  //    expansion (delivery.js `emissionCount`/`planEmissions`): a Scatter Gun throws 14 pellets
  //    instead of 7, a Repeater runs 4 tracer lanes instead of 2, a Streak Pod unloads 12
  //    missiles instead of 6, a Plasma Lance puts out 2 bolt streams instead of 1. Visually the
  //    loudest of the six, which is the point — it should read instantly without a HUD glance.
  //    Ammo is spent once per trigger pull (not per emitted shot), so this is straight bonus
  //    output for its duration; 10s / weight 1 keeps it in line with the other timed buffs.
  barrage: {
    id: 'barrage', label: 'BARRAGE', color: 0xc06be0, weight: 1,
    duration: 10, effect: 'shotCount', countMult: 2,
  },
};

// #409: FREE AMMO is a dedicated pickup again. #381 made every active powerup grant free ammo for a
// uniform 10s window; that blanket rule was removed once reload became a real mechanic (#402). Now
// INFINITE FIRE is the ONE type whose effect turns on free ammo — and, on top of that, no-reload —
// via `buffModifiers`. Every other type contributes only its own effect (faster fire, more shots,
// force-sprint) or is purely instant (temp shield, armor repair) with no scene-overlay entry.

// ── Drop tuning (#90 → #106) ─────────────────────────────────────────────────────────────
// A kill's powerup odds SCALE with how tough the thing you killed was. Two knobs decide the
// shape: the roster-derived floor/ceiling (which kill counts as "trivial" and which as "the
// hardest thing in the game") and the curve exponent between them.
//
// TOUGHNESS, not `maxHp` (#106). The difficulty signal is `body.toughness` — structure + armor
// + shield — exposed identically by `Mech` and the non-mech `HpBody`, so there's still no
// per-kind branching at the call site (combat.js `_damageEnemyAt`). This replaced `.maxHp`,
// which meant different things per body type: Mech summed armor+structure while HpBody
// returned only its hp pool, so vehicles' armor/shields were invisible to the curve (a tank
// rated 160 instead of its real 200; the gunship's 30-point shield and the Broodhauler's
// 60 armor + 50 shield counted for nothing) — vehicles were systematically under-rated.
//
// DERIVED BOUNDS (#106). `DROP_HP_FLOOR`/`DROP_HP_CEIL` used to be hand-set constants (14 and
// 400) and drifted out of sync with the roster every single time enemy stats moved — #128
// forced a manual re-solve of the exponent, and infantry (toughness 6) shipped without the
// floor ever being lowered to match. They're now COMPUTED from the live roster: the min and
// max toughness across every mech enemy (data/enemies.js) and every vehicle kind
// (data/enemyKinds.js). Retuning enemy health, or adding/removing a unit, needs NO edit here —
// the endpoints move on their own. Today that derives to floor 6 (infantry) and ceiling 500
// (the heavy mech on the heavy chassis).
//
// CURVE (#106): CONVEX, exponent 1.5. The previous 0.7 exponent was CONCAVE — it bowed the
// middle of the curve UP, roughly +10 percentage points across the mid-range versus a straight
// line, which is exactly the "weak/easy enemies pay out way too often" complaint this issue
// opened with. 1.5 bows the middle DOWN instead: trivial kills stay near the floor much longer
// and the payout only really climbs once you're fighting things that fight back. Both endpoints
// are unaffected by the exponent (0**k = 0, 1**k = 1), so the floor is still MIN_DROP_CHANCE
// and the toughest kill in the game is still MAX_DROP_CHANCE.
//
// Resulting curve across today's roster, post-#299 (toughness → chance):
//   infantry 3 → 5%      drone 3 → 5%        turret 50 → 8%     helicopter 50 → 8%
//   tank 80 → 10%        carrier 150 → 19% light mech 200 → 27%
//   medium mech 350 → 58% heavy mech 500 → 95%
// #299 changed none of this file — every figure above moved purely because the derived bounds
// did. Chaff (vehicles) now sits low on the curve and mech kills carry the drops.
// These numbers are DERIVED, not hand-solved — they're what the formula produces for the
// current roster, and they'll shift on their own when the roster does.
//
// CRUSH KILLS (#106) bypass the curve entirely — see CRUSH_KILL_DROP_CHANCE below.
//
// Historical note: #90 replaced a flat `DROP_CHANCE` roll (a drone and a heavy mech had
// identical odds) with this toughness-scaled curve. #128's chassis change forced a manual
// re-solve of the exponent, and #106's review found the hand-set bounds had drifted again —
// which is why the bounds are derived from the roster now instead of typed in.
export const MIN_DROP_CHANCE = 0.05;   // the weakest kill in the game (today: infantry)
export const MAX_DROP_CHANCE = 0.95;   // the toughest kill in the game (today: heavy mech)
const DROP_CURVE_EXP = 1.5;            // >1 ⇒ CONVEX: bows the mid-curve DOWN, so easy kills
                                        // stay near the floor (#106; was 0.7, i.e. concave)

// #106: a CRUSH/stomp kill (driving over a tank or a trooper — world.js `_crushGroundEnemyAt`,
// scoped by `isSmallUnit`) ignores the toughness curve entirely and always rolls this flat,
// deliberately tiny chance. Jackson: "what feels odd about tanks is they are stompable, which
// works immediately regardless of their relatively higher HP. maybe we should set extremely low
// drop rates for any stomp kills, regardless of the enemy." A stomp costs the player nothing —
// no ammo, no exposure, no time — so it shouldn't pay out like a fought kill; a stomped tank
// (toughness 200, 33% if fought) and a stomped trooper (toughness 6) now roll exactly the same.
export const CRUSH_KILL_DROP_CHANCE = 0.03;

// Kept for anything still importing the old flat constant (none in-tree after #90, but
// harmless to leave as a documented "typical" reference point).
export const DROP_CHANCE = 0.75;

// Floor/ceiling for the drop curve, DERIVED from a roster rather than hardcoded (#106): the
// least- and most-tough units that exist. #301 moved the derivation itself into
// data/rosterBounds.js, since the death-explosion size/sound tiers needed exactly the same
// numbers and a second near-copy would just be a fresh source of drift — these two names stay
// as the drop path's vocabulary for it. Still parameterized/pure so tests can prove the
// endpoints track the roster by passing a stubbed one.
export const dropBoundsForRoster = rosterToughnessBounds;
export const dropBounds = liveToughnessBounds;

// Difficulty-scaled powerup drop chance for a kill of the given `toughness` (structure + armor
// + shield — `body.toughness`). Pure — no enemy-kind branching, no Phaser — so it's unit-
// testable independent of the scene. Clamps outside the derived floor/ceiling, then bends the
// 0..1 progress through the convex curve (see the block comment above) before lerping between
// MIN/MAX_DROP_CHANCE. `bounds` is injectable for tests.
export function dropChanceForToughness(toughness, bounds = dropBounds()) {
  const hp = Math.max(0, toughness || 0);
  const span = bounds.ceil - bounds.floor;
  const t = span > 0 ? Math.min(1, Math.max(0, (hp - bounds.floor) / span)) : 1;
  const curved = Math.pow(t, DROP_CURVE_EXP);
  return MIN_DROP_CHANCE + curved * (MAX_DROP_CHANCE - MIN_DROP_CHANCE);
}

// The one entry point the kill path uses (scenes/arena/powerups.js `_maybeDropPowerup`):
// a crush/stomp kill always gets the flat low chance; anything else runs the curve.
export function dropChanceForKill(toughness, isCrush = false) {
  return isCrush ? CRUSH_KILL_DROP_CHANCE : dropChanceForToughness(toughness);
}

// Ordered id list (stable) — used by the weighted pick and by any UI that wants a fixed order.
export const POWERUP_IDS = Object.keys(POWERUPS);

// #400: the ordered list of COLOURS for the center-torso status spot, given the set of
// currently-active powerup ids (the keys of the arena's `activePowerups` overlay). Ordered by
// the POWERUPS declaration order — NOT pickup order — so the sectioning is stable frame to
// frame (a spot that reshuffles its sections every time a buff expires would read as noise).
// Unknown ids are skipped. Empty in → empty out (the arena renders that as the "no powerup"
// black). Pure so it can be unit-tested and reused by the mech-art status-spot renderer.
export function powerupSpotColors(activeIds) {
  const set = new Set(activeIds || []);
  return POWERUP_IDS.filter((id) => set.has(id)).map((id) => POWERUPS[id].color);
}

// #315: the subset of ids that can come out of a RANDOM drop — everything with a positive
// weight. An entry with `weight: 0` (today only `armorPatch`, which is awarded exclusively for
// destroying a base objective) is excluded from the pool outright rather than merely being
// improbable, so the zero-weight case can never leak through the loop's fallback below.
export const POWERUP_POOL_IDS = POWERUP_IDS.filter((id) => (POWERUPS[id].weight || 0) > 0);

// Weighted random pick of a powerup id. `rng` is a 0..1 source (defaults to Math.random) so
// the pick is deterministic under test. Returns a POWERUPS id from POWERUP_POOL_IDS.
export function pickPowerupType(rng = Math.random) {
  const total = POWERUP_POOL_IDS.reduce((a, id) => a + (POWERUPS[id].weight || 0), 0);
  let roll = rng() * total;
  for (const id of POWERUP_POOL_IDS) {
    roll -= POWERUPS[id].weight || 0;
    if (roll < 0) return id;
  }
  return POWERUP_POOL_IDS[POWERUP_POOL_IDS.length - 1];
}

// Is this type an instant (no-timer) powerup?
export function isInstant(id) {
  return !!POWERUPS[id]?.instant;
}

// Duration (ms) a timed buff of this type stays active. 0 for instant/unknown.
export function durationMs(id) {
  const p = POWERUPS[id];
  return p && p.duration ? p.duration * 1000 : 0;
}

// ── Duration stacking (#339) ─────────────────────────────────────────────────────────────
// How many times a powerup's OWN base duration it may accumulate to. 3 means a 9-second
// Overdrive tops out at 27 seconds of continuous uptime no matter how many more you grab
// while it's live; a 12-second Shield tops out at 36.
//
// This is the playtest dial for #339 — Jackson explicitly left the cap to the builder and
// expects to tune it. Picked at 3 because it is generous enough that stacking is obviously
// worth doing (two pickups is a real, felt reward; the third still lands) while keeping a
// hard ceiling on how long one lucky drop streak can hold a buff up. Uncapped, the post-#326/
// #328 infinite kill supply could in principle hold Barrage or free ammo on permanently,
// which is the same "trivialise the fight" failure that duration-only stacking exists to
// avoid — just reached by a slower road. Raise it for a more power-fantasy feel, lower it
// toward 1 to get back to the old pure-refresh behaviour.
export const MAX_STACK_MULT = 3;

// The cap, in ms, on a given type's accumulated remaining time. 0 for instant/unknown types.
export function maxStackedMs(id) {
  return durationMs(id) * MAX_STACK_MULT;
}

// THE stacking rule (#339), shared by every timed-buff path so there is exactly one policy:
// picking up `id` while `remainingMs` of it is still on the clock ADDS a fresh full duration
// on top, clamped to `maxStackedMs`. A fresh pickup (remaining 0 or absent) is just its own
// duration. Magnitude is untouched — this returns a TIME, never a strength. Pure; the caller
// (scene mixin / Mech shield boost) stores the result.
//
// Note the clamp is applied to the SUM rather than refusing the pickup: grabbing a duplicate
// at 25s of a 27s-capped Overdrive still nudges you to the cap instead of doing nothing, so a
// pickup never feels wasted. It can never REDUCE the remaining time either — if somehow
// already above the cap, the existing value is kept.
export function stackedRemainingMs(id, remainingMs = 0) {
  const add = durationMs(id);
  if (!add) return 0;
  const cur = Math.max(0, remainingMs || 0);
  return Math.max(cur, Math.min(cur + add, maxStackedMs(id)));
}

// ── Buff overlay math ────────────────────────────────────────────────────────────────────
// Collapse the ACTIVE set of timed buffs into the plain multiplier/flag object the arena's
// firing/movement/turret code reads each frame. `active` is a map: type id → remaining ms
// (only positive-remaining entries should be present; the arena prunes expired ones). #409: only
// TIMED types appear here — Shield and Armor Patch are instant now (no `duration`) and never enter
// `active`, so they don't show up. The returned shape is the single contract with the scene:
//   freeAmmo        — true ⇒ don't spend ammo. #409: granted ONLY by INFINITE FIRE (not every
//                     powerup as in #381).
//   noReload        — true ⇒ ignore the reload gate (INFINITE FIRE): a slot fires even mid-reload
//                     or dry, so a held trigger dumps. Firing (firing.js) treats an online weapon
//                     as ready while this is set.
//   cycleMult       — multiplier on weapon cycle time / fire interval (Overdrive; <1 = faster)
//   countMult       — multiplier on delivery.count, i.e. how many things one trigger pull
//                     emits (Barrage, #137; >1 = more at once). Consumed in firing.js, which
//                     hands it to planEmissions so every pattern fans/lanes/bursts wider.
//   overclockActive — true ⇒ Overclock is live (#189): the arena's Sprint handling
//                     (scenes/arena/firing.js `_handleSprint`) forces Sprint on, fuel-free,
//                     for as long as this stays true. No magnitude here — Sprint's own
//                     SPRINT_SPEED_MULT (data/sprint.js) supplies the actual speed boost.
// Everything defaults to the identity (no buff) so callers can multiply/branch unconditionally.
export function buffModifiers(active) {
  const mods = {
    freeAmmo: false,
    noReload: false,
    cycleMult: 1,
    countMult: 1,
    overclockActive: false,
  };
  for (const id of Object.keys(active || {})) {
    if (!(active[id] > 0)) continue;
    const p = POWERUPS[id];
    if (!p) continue;
    switch (p.effect) {
      case 'fireRate': mods.cycleMult *= p.cycleMult ?? 1; break;
      case 'shotCount': mods.countMult *= p.countMult ?? 1; break;
      case 'overclock': mods.overclockActive = true; break;
      // #409: the ONLY free-ammo source — and it also suppresses the reload gate.
      case 'infiniteFire': mods.freeAmmo = true; mods.noReload = true; break;
      default: break;
    }
  }
  return mods;
}

// #246: the old fixed damage-pool shield math (`absorbShieldDamage`) moved to data/shield.js
// as `damageShield`/`tickShield`/etc. — the shield is now a real regenerating layer living on
// the Mech/HpBody itself (see that file), not a powerup-only one-shot pool computed here.

// ── Instant Armor Patch: whole-mech proportional repair ──────────────────────────────────
// Compute how much armor to restore to each location: `frac` of that location's MISSING
// armor (maxArmor - armor), for every location that has lost armor. Pure — takes a plain
// snapshot of parts (loc → { armor, maxArmor }) and returns loc → amount-to-add (>0 only for
// damaged locations). The Mech model applies it (Mech.repairArmor); split out so the math is
// unit-tested without a live mech.
export function armorRepairPlan(parts, frac) {
  const plan = {};
  for (const loc of Object.keys(parts || {})) {
    const p = parts[loc];
    if (!p) continue;
    const missing = (p.maxArmor ?? 0) - (p.armor ?? 0);
    if (missing > 0) plan[loc] = missing * frac;
  }
  return plan;
}
