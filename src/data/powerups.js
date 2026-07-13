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
//  - Stacking is ONE-PER-TYPE: several different types can be active at once (each with its
//    own countdown); picking up a duplicate of an active type just refreshes that type's time.
//  - Armor Patch is INSTANT (no timer) — it applies its repair on pickup and never enters the
//    active set.
//  - Shield (#187) is a THIRD kind, alongside timed buffs and instants: a damage-POOL buff.
//    It doesn't expire on a timer and isn't instant either — it stays active until a
//    cumulative damage total is absorbed. It never enters `active`/`buffModifiers`; the arena
//    mixin tracks its remaining pool in a separate `shieldPool` number, and a duplicate pickup
//    ADDS to that pool (mirroring how a duplicate timed buff refreshes remaining time). See
//    `absorbShieldDamage` below for the pure math.

// ── The powerup catalog (owner: tune) ───────────────────────────────────────────────────
// Each entry: id, label (HUD), color (collectible + HUD), weight (relative drop odds), and
// `duration` in seconds for timed buffs (Armor Patch is instant → no duration). The buff's
// MAGNITUDE lives on the entry too (a named field per effect) so tuning is a data edit.
export const POWERUPS = {
  // 1) Pause ammo consumption for ALL weapons (effectively unlimited ammo) for the duration.
  overcharge: {
    id: 'overcharge', label: 'OVERCHARGE', color: 0xffd56b, weight: 1,
    duration: 10, effect: 'freeAmmo',
  },
  // 2) Halved weapon cycle times (doubled rate of fire) for the duration.
  overdrive: {
    id: 'overdrive', label: 'OVERDRIVE', color: 0xe2533a, weight: 1,
    duration: 9, effect: 'fireRate', cycleMult: 0.5,
  },
  // 3) Movement-speed boost for the duration. #187 (owner design pass): used to also boost
  //    turret slew (`slewMult`), but instant turret turning (#154) made a slew-rate buff
  //    meaningless — trimmed to speed-only.
  overclock: {
    id: 'overclock', label: 'OVERCLOCK', color: 0x7bd17b, weight: 1,
    duration: 10, effect: 'overclock', moveMult: 1.35,
  },
  // 4) INSTANT whole-mech proportional armor repair (no timer). Restores a fraction of EACH
  //    damaged location's MISSING armor, so every hurt location gets some back scaled to what
  //    it's missing. `repairFrac` is that fraction.
  armorPatch: {
    id: 'armorPatch', label: 'ARMOR PATCH', color: 0x8ad0ff, weight: 1.2,
    instant: true, effect: 'armorPatch', repairFrac: 0.5,
  },
  // 5) #187: full damage absorption up to a fixed CUMULATIVE total — NOT time-based (distinct
  //    from the timed-buff model above, and distinct from the equipment `bubbleShield` ability,
  //    which is duration-based). `shieldCap` is the starting absorb pool in damage points. Picked
  //    by looking at src/data/weapons.js `damage` fields: single-shot weapons land ~2-34 per hit
  //    (the heaviest, a projectile launcher, hits for 34), so 60 absorbs a bit under two of the
  //    hardest single hits, or several ticks of a stream weapon — "1-2 solid exchanges, not a
  //    full fight" per the owner's brief. Starting value, tune via playtest like the rest.
  shield: {
    id: 'shield', label: 'SHIELD', color: 0x5ec8e0, weight: 1,
    effect: 'shield', shieldCap: 60,
  },
};

// Drop tuning. #90 (playtest 2026-07-10): the drop chance used to be a flat `DROP_CHANCE`
// roll regardless of what died — a drone and a heavy sniper mech had identical odds. Now it
// SCALES with the killed enemy's toughness, using `maxHp` as the difficulty signal (both
// `Mech` and the non-mech `HpBody` expose a uniform `.maxHp`, so this needs no per-kind
// branching at the call site — see combat.js `_damageEnemyAt`).
//
// Bounds picked from the actual roster's max-hp spread: the weakest real enemy IN-TREE today
// is a drone (hp 14) and the toughest is a base heavy-chassis mech (maxHp 400 — see Mech.js
// `maxHp`; dropped from 616 when #128 removed head/cockpit/centerTorso from the tracked
// damage locations). #97 (infantry, proposed maxHp 6) would be weaker still, but is not
// implemented as of this pass — when it lands, drop DROP_HP_FLOOR to 6 so infantry becomes
// the true floor point instead of quietly landing at MIN_DROP_CHANCE alongside the drone.
//
// #106 (playtest 2026-07-10, follow-up to #90): "small enemies still give WAAAAAAAAAAY too
// many powerups for how easy they are to kill" — even the old 35% floor read as a coin-flip-
// adjacent rate for a kill that's basically free. MIN_DROP_CHANCE comes down hard, to 5%, so
// the weakest kills feel like an occasional bonus, not a norm.
//
// A plain linear lerp can't hit that low a floor without also gutting the middle of the curve:
// widening the span from 0.6 (old 0.35→0.95) to 0.9 (new 0.05→0.95) would have dragged EVERY
// non-ceiling tier down with it — including the medium mech, the most common kill, whose ~0.75
// "typical kill feels unchanged" sanity check (#90) was the whole point of scaling by toughness
// in the first place. Instead the curve is bent concave — `t ** DROP_CURVE_EXP` (exponent < 1)
// in place of plain `t` — which still passes through exactly MIN at the floor and MAX at the
// ceiling (0**k = 0, 1**k = 1 for any k), but bows the middle of the curve up relative to a
// straight line. Net effect: weak/moderate kills (drone/heli/turret/tank) drop noticeably less
// than before, while medium/heavy — the "normal" difficulty range — land close to where #90
// put them. DROP_CURVE_EXP was originally 0.6, solved for dropChanceForMaxHp(416) ≈ 0.756
// against a maxHp ceiling of 616.
//
// #128 dropped the heavy mech's real maxHp to 400 (head/cockpit/centerTorso left the tracked
// damage locations), shrinking DROP_HP_CEIL to match — which on its own compresses the curve
// and pushes every non-ceiling tier UP (e.g. the turret, at a fixed 90 hp, moved from 0.389
// under the old ceiling to over the 0.35 "should read as rare" line). Re-solved
// DROP_CURVE_EXP = 0.7 against the new floor/ceiling to restore both anchors: the medium mech
// (now maxHp 270) back near ~0.75, and the turret back comfortably under 0.35.
//
// Resulting curve across the current roster (drone/heli/turret/tank/light/medium/heavy):
//   0.05 → 0.28 → 0.34 → 0.51 → 0.53 → 0.73 → 0.95
// vs. the old linear curve's 0.35 → 0.41 → 0.43 → 0.50 → 0.60 → 0.75 → 0.95 — trivial kills
// down sharply, "normal" kills roughly where they were. Flagging for playtest per #106.
export const MIN_DROP_CHANCE = 0.05;   // weakest kill (drone, maxHp ~14) — was 0.35
export const MAX_DROP_CHANCE = 0.95;   // toughest kill (heavy mech, maxHp ~400) — unchanged
const DROP_HP_FLOOR = 14;              // maxHp at/below which a kill gets MIN_DROP_CHANCE
const DROP_HP_CEIL = 400;              // maxHp at/above which a kill gets MAX_DROP_CHANCE
                                        // (#128: heavy mech's real maxHp, was 616 before head/
                                        // cockpit/centerTorso dropped out of tracked damage)
const DROP_CURVE_EXP = 0.7;            // <1 ⇒ concave: bows the mid-curve up so medium/heavy
                                        // stay close to #90's values even with a much lower floor
                                        // (re-solved for the #128 floor/ceiling, was 0.6)

// Kept for anything still importing the old flat constant (none in-tree after #90, but
// harmless to leave as a documented "typical" reference point).
export const DROP_CHANCE = 0.75;

// Difficulty-scaled powerup drop chance for a kill whose max hit points was `maxHp`. Pure —
// no enemy-kind branching, no Phaser — so it's unit-testable independent of the scene. Clamps
// outside the floor/ceil, then bends the 0..1 progress through a concave curve (see comment
// above) before lerping between MIN/MAX_DROP_CHANCE.
export function dropChanceForMaxHp(maxHp) {
  const hp = Math.max(0, maxHp || 0);
  const span = DROP_HP_CEIL - DROP_HP_FLOOR;
  const t = span > 0 ? Math.min(1, Math.max(0, (hp - DROP_HP_FLOOR) / span)) : 1;
  const curved = Math.pow(t, DROP_CURVE_EXP);
  return MIN_DROP_CHANCE + curved * (MAX_DROP_CHANCE - MIN_DROP_CHANCE);
}

// Ordered id list (stable) — used by the weighted pick and by any UI that wants a fixed order.
export const POWERUP_IDS = Object.keys(POWERUPS);

// Weighted random pick of a powerup id. `rng` is a 0..1 source (defaults to Math.random) so
// the pick is deterministic under test. Returns a POWERUPS id.
export function pickPowerupType(rng = Math.random) {
  const total = POWERUP_IDS.reduce((a, id) => a + (POWERUPS[id].weight || 0), 0);
  let roll = rng() * total;
  for (const id of POWERUP_IDS) {
    roll -= POWERUPS[id].weight || 0;
    if (roll < 0) return id;
  }
  return POWERUP_IDS[POWERUP_IDS.length - 1];
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

// ── Buff overlay math ────────────────────────────────────────────────────────────────────
// Collapse the ACTIVE set of timed buffs into the plain multiplier/flag object the arena's
// firing/movement code reads each frame. `active` is a map: type id → remaining ms (only
// positive-remaining entries should be present; the arena prunes expired ones). Shield is
// NOT part of this — it's a damage-pool buff, tracked/applied separately (see
// `absorbShieldDamage` below and the arena mixin's parallel `shieldPool` tracking). The
// returned shape is the single contract between this data layer and the scene:
//   freeAmmo  — true ⇒ don't spend ammo (Overcharge)
//   cycleMult — multiplier on weapon cycle time / fire interval (Overdrive; <1 = faster)
//   moveMult  — multiplier on movement max speed (Overclock)
// Everything defaults to the identity (no buff) so callers can multiply unconditionally.
export function buffModifiers(active) {
  const mods = {
    freeAmmo: false,
    cycleMult: 1,
    moveMult: 1,
  };
  for (const id of Object.keys(active || {})) {
    if (!(active[id] > 0)) continue;
    const p = POWERUPS[id];
    if (!p) continue;
    switch (p.effect) {
      case 'freeAmmo': mods.freeAmmo = true; break;
      case 'fireRate': mods.cycleMult *= p.cycleMult ?? 1; break;
      case 'overclock': mods.moveMult *= p.moveMult ?? 1; break;
      default: break;
    }
  }
  return mods;
}

// ── Shield damage-pool math ──────────────────────────────────────────────────────────────
// Shield (#187) is NOT a timed buff — it's a damage-pool buff: incoming damage is fully
// absorbed (zero armor/structure loss) until a cumulative total (the pool) is exhausted, at
// which point the shield breaks and any excess in that same hit passes through normally.
// Pure — no Phaser, no live Mech — so it's unit-tested in isolation. `pool` is the remaining
// absorb capacity (>0 while the shield is active); `damage` is one hit's raw amount. Returns:
//   absorbed  — how much of this hit the shield blocked (<= pool, <= damage)
//   overflow  — how much passes through to armor/structure (damage - absorbed)
//   remaining — pool left after this hit; 0 means the shield just broke
export function absorbShieldDamage(pool, damage) {
  const p = Math.max(0, pool || 0);
  const d = Math.max(0, damage || 0);
  const absorbed = Math.min(p, d);
  return { absorbed, overflow: d - absorbed, remaining: p - absorbed };
}

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
