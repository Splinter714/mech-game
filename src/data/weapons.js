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
//   count     #137: the ONE canonical "how many things one trigger pull emits" (default 1),
//             replacing the old pattern-specific spreadCount / streams / burst.count /
//             sprayCount fields. Each pattern expands the same number its own way:
//             spread → a fan of `count` pellets across `spreadAngle`; stream → `count`
//             parallel lanes (`streamSpacing` apart) or, if the weapon jitters, `count`
//             randomly-angled particles per cadence tick; burst → `count` sequential
//             sub-shots `burst.interval` ms apart. Because it's one field, the Barrage
//             powerup can double it for every weapon at once (delivery.js `emissionCount`).
//   spreadAngle   cone width (deg) a `spread` weapon's fan is spread across
//   spreadJitter  degrees — randomizes each spread shot's angle (and adds a small random
//             emission stagger) instead of an evenly-spaced, perfectly repeating fan; for
//             weapons that should feel chaotic shot-to-shot (the flamethrower)
//   scatterJitter fraction (0..1) — Proximity Mines polish pass: randomizes an ARCING spread
//             shot's own LANDING DISTANCE by up to this fraction either way (delivery.js
//             `scatterMaxDist`). Distinct from spreadJitter above (launch angle only) — every
//             arcing spread weapon before this sent every fanned shot the exact same travel
//             budget. 0/undefined (every other weapon) is a no-op.
//   cluster   spread rounds fly as a tight parallel clump (no fan) — dumbfire cluster
//   fireRate  shots per second for a `stream` weapon (machine gun / beam laser)
//   burst     { interval } — marks the weapon as a BURST and sets the ms gap between its
//             sub-shots; how many there are is the shared `count` above. For a hitscan
//             that's `count` light pulses (pulse laser); for a projectile, `count`
//             travelling rounds (streak pod). `wubOn`/`wubOff` are a shorthand for
//             `interval` (see `w()` below)
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
//   splash    blast radius in px (plasma/explosive). 2026-07-31: a landed hit carrying `splash`
//             now does a REAL multi-target blast, not just an impact-FX/hit-tolerance radius — see
//             projectiles.js `_splashDamageAt` (data/aoe.js `damageInRadius`, the same primitive
//             `fuse` below already used). Every other splash-carrying weapon in this table
//             (plasmaCannon, napalm) picks up real splash damage for the first time as a side
//             effect of this fix — see that function's header comment for the balance callout.
//   groundFire { radius, dps, duration } — leaves a burning patch on impact (napalm)
//   travelAoe { radius, dps, tickMs? } — #492: the round damages everything in radius
//             CONTINUOUSLY WHILE IN FLIGHT (not just on impact/landing, unlike groundFire
//             above which only starts once the round detonates) — a slow-moving hazard cloud
//             riding the projectile itself. tickMs defaults to 250.
//   force     { radius, strength, sign, tickMs? } — #491/#499: the round pushes (sign > 0) or
//             pulls (sign < 0) every living enemy within radius, continuously while in flight,
//             the same tick cadence as travelAoe (data/force.js `computeImpulse`). tickMs
//             defaults to 250; `strength` is px/s of displacement at the very center, falling
//             off linearly to 0 at the edge of `radius`.
//   dot       { kind?, duration, tickDamage, tickInterval? } — #489: ON HIT, applies/refreshes a
//             status effect (data/statusEffects.js) at the location the hit resolved to —
//             periodic damage that outlasts the shot itself. Mech-kind targets only (no
//             HpBody/vehicle-kind support yet). `kind` defaults to 'plasmaBurn'.
//   fuse      { mode: 'time' | 'proximity', time?, radius? } — #488: detonates the round
//             independent of its normal hit/landing resolution — 'time' after `time` seconds
//             of flight regardless of whether it hit anything, 'proximity' the instant it comes
//             within `radius` of a living valid target. Either way the detonation is a REAL
//             multi-target blast (data/aoe.js `damageInRadius` over `splash`), not the normal
//             single-target hit-tolerance splash.
//   chargeable { minTime, maxTime, minDamageMult?, maxDamageMult? } — #493: PLAYER-ONLY (enemy
//             fire never holds a trigger). Bypasses the normal auto-repeat cooldown model —
//             holding the fire button accumulates charge up to `maxTime` seconds (auto-firing
//             the instant it caps out); releasing before `minTime` fires nothing at all and
//             wastes the charge. Damage scales linearly between `minDamageMult` (at `minTime`,
//             default 1) and `maxDamageMult` (at `maxTime`, default 1). See scenes/arena/
//             firing.js `_handleChargeFire`/`_releaseCharge`.
//             `ammoCost` (#627, optional, default 0): magazine rounds spent UP FRONT the instant
//             a hold begins, on top of the usual one round the released shot itself costs. Only
//             Charge Beam sets it — Charge Lance leaves it unset and is unchanged.
//   beam      { damage, fireRate, sfxId? } — #627: the THIRD charge state. A `chargeable` weapon
//             that also declares this doesn't just sit at full charge — once `chargeable.maxTime`
//             is reached and the trigger is STILL down, the slot spins up a sustained hitscan beam
//             that ticks `damage` at `fireRate`/sec (one magazine round per tick) for as long as
//             the hold lasts; the eventual release still fires the charged shot on top. Composing
//             `chargeable` + `sustained` as data does NOT work (they are mutually exclusive code
//             branches — see firing.js `_handleFiring`), which is why this is its own field with
//             its own state machine (`_tickChargeBeam`). `sfxId` names the weapon whose held/loop
//             voice the beam phase borrows (audio/sfxParams.js `HELD_WEAPONS`).
//   kind      explicit projectile art: 'flame' | 'fire' | 'bullet' | 'rail' | …
//
// shared fields: damage (per shot/pellet), range {min, opt, max}, cycleTime
// (ms between trigger pulls).
//
// Ammo: every weapon carries its own self-contained magazine — there are no separate
// ammo bins or heat sinks. `ammoMax` is the magazine size, and it is the ONLY firing
// constraint. `ammoMax: null` means unlimited — no weapon currently in the table uses
// this, but the null path is live and must stay unlimited.
//
// #402 — RELOAD IS THE ONLY REFILL PATH (owner decision). The old continuous `ammoRegen`
// between-shots trickle is GONE from the player model: ammo no longer drifts back up while you
// hold or ease off the trigger. A magazine only refills by RELOADING — a fixed 2s lockout
// (Mech.RELOAD_SECONDS) that ends with a FULL magazine, started AUTOMATICALLY when a mag hits 0 or
// MANUALLY on R3/F. `ammoMax: null` weapons are exempt (they never run dry or reload).
//
// BALANCE IS PURELY MAGAZINE SIZE. With no trickle, a held trigger's burst-before-reload is exactly
// `ammoMax ÷ consumption-per-second`. Consumption is ONE ROUND PER TRIGGER PULL — NOT per emitted
// shot: `delivery.count` (a shotgun's 7 pellets, a swarm rack's 6 missiles) costs the same single
// round as a lone slug (see fireWeapon in scenes/arena/firing.js). So the consumption rate is purely
// the fire interval (`_fireInterval`): `fireRate`/s for a stream pattern, `1000 / max(120,
// cycleTime)`/s for everything else. Each weapon's `ammoMax` below is tuned to `≈ burst-seconds ×
// consumption-per-second` for a sensible pre-reload burst (the ~6s intent from the old #372/#376/#377
// economy, kept as a rough anchor — most weapons land ~6s, with a few weapon-specific exceptions
// carried over: napalm ~7.5s, streakPod ~7.2s, plasmaCannon ~8s, swarmRack ~15s). That is why a
// 20/s stream carries a ~120-round magazine while a 1.1s-cycle autocannon carries 5.
//
// (Historical: #372 introduced a ~6s continuous-fire limit via a below-consumption `ammoRegen`
// trickle; #376/#377 widened the missiles' magazines and swarmRack's recovery. #402 removed the
// trickle entirely, so those regen numbers are gone and the magazines below were re-derived so the
// burst windows land in the same ballpark without any passive refill.)
//
// SUSTAINED vs BURST DPS: the `DPS = …` figures in each weapon's comment below are WHILE-FIRING DPS
// and remain correct as written — they govern the burst. There is no separate lower "sustained"
// figure now: a weapon fires its burst, reloads for 2s, and repeats, so its long-grind DPS is the
// while-firing DPS scaled by burst / (burst + 1s). Don't "correct" the DPS comments.
//
// Display names are generic sci-fi, deliberately *not* franchise jargon; the ids stay
// stable so saved builds keep resolving.

import { CATEGORY_IDS } from './categories.js';

// #631: `spreadAngle` is deliberately NOT defaulted here any more. It used to default to 0, and
// every consumer read it as `d.spreadAngle || DEFAULT_SPREAD_DEG` — so "0" and "unset" were the
// same thing and both meant the 16° house fan. Now that a weapon can genuinely want NO fan
// (swarmRack/newMissiles separate laterally instead), the two have to be tellable apart:
// `spreadAngle: 0` means exactly zero degrees, and OMITTING it still gets DEFAULT_SPREAD_DEG.
const DELIVERY_DEFAULTS = {
  hit: 'projectile', velocity: 500, path: 'straight', guidance: null,
  pattern: 'single', count: 1, fireRate: 0, splash: 0,
};

function w(def) {
  const d = { ...DELIVERY_DEFAULTS, ...def.delivery };
  // Burst shorthand: wubOn + wubOff → interval; totalDamage / count → per-sub-shot damage.
  // (#137: `count` is now the shared top-level delivery field, not `burst.count` — `burst`
  // keeps only its TIMING fields.)
  if (d.burst) {
    if (d.burst.wubOn != null) d.burst = { ...d.burst, interval: d.burst.wubOn + d.burst.wubOff };
  }
  const damage = def.totalDamage != null
    ? def.totalDamage / (d.burst ? Math.max(1, d.count ?? 1) : 1)
    : def.damage;
  return { ...def, damage, delivery: d };
}

export const WEAPONS = {
  // ── ENERGY ── five distinct feels: bursty pulses, a held beam, a sniper lance, an
  // arcing plasma lob, and a close-range flame cone. No ammo (battery recharge). ──
  pulseLaser: w({   // every trigger pull = a rapid burst of light beam pulses
    id: 'pulseLaser', name: 'Pulse Laser', category: 'energy',
    // #259 DPS-squish: totalDamage 16 -> 66 to bring raw DPS up from ~5.33 to the ~22 band.
    // #408: cycleTime 3000 -> 1800 (under the 2s reload so the mag empties and reload creates real
    // downtime), holding DPS by scaling totalDamage 66 -> 39.6 (= 66 × 1800/3000). Still a slow,
    // punchy pulse burst — not a machine gun. DPS = totalDamage / cycleTime(s): 66/3 = 22.0 dps ->
    // 39.6/1.8 = 22.0 dps (unchanged).
    // 24-SUSTAINED FLOOR: totalDamage 39.6 -> 60 to lift sustained (over the mag->reload cycle,
    // RELOAD 2s) from 16.1 to 24.3 dps. Burst DPS = totalDamage / cycleTime(s): 60/1.8 = 33.3.
    totalDamage: 60, range: { min: 0, opt: 340, max: 600 },
    ammoMax: 3, cycleTime: 1800,   // #408: ~5.4s burst (3 pulls × 1.8s), then 2s reload
    delivery: { hit: 'hitscan', pattern: 'single', count: 5, burst: { wubOn: 25, wubOff: 50 } },
  }),
  beamLaser: w({    // hold for ONE continuous beam locked on target; drains fast
    id: 'beamLaser', name: 'Beam Laser', category: 'energy',
    // #259 DPS-squish: damage 2 -> 1.5 to bring raw DPS down from 40 to the ~30 band.
    // 24-SUSTAINED FLOOR: damage 1.5 -> 1.6 to lift sustained (mag->reload cycle, RELOAD 2s) from
    // 22.5 to 24.0 dps. Burst DPS = damage x fireRate: 1.6*20 = 32.0 dps.
    damage: 1.6, range: { min: 0, opt: 500, max: 640 },
    ammoMax: 120, cycleTime: 0,   // #402: ~6.0s burst (120 rounds ÷ 20/s), then 2s reload
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
    // both are now "many small hits at 20/sec" weapons. #402: with the trickle gone, the magazine
    // alone sets the burst — ammoMax: 120 at 20/s is a straight ~6.0s of held fire before the mag
    // empties and the 2s reload beat kicks in (this weapon was the ~6s template; #372's old 60/10
    // regen economy that hit the same window is retired).
    // cycleTime is unused for a stream pattern (see _fireInterval in firing.js), left at 0 like
    // every other stream weapon (beamLaser/machineGun/flamethrower).
    // #259 DPS-squish: damage 2 -> 1.5 (in step with beamLaser, still mirrored 1:1) to bring raw
    // DPS down from 40 to the ~30 band: damage x fireRate = 2*20 = 40 dps -> 1.5*20 = 30 dps.
    // 24-SUSTAINED FLOOR: damage 1.5 -> 1.6 (still mirroring beamLaser 1:1) to lift sustained
    // (mag->reload cycle, RELOAD 2s) from 22.5 to 24.0 dps. Burst DPS = 1.6*20 = 32.0 dps.
    // The enemy sniper/artillery fire loop (src/scenes/arena/enemies.js) already drives cadence
    // generically off `_fireInterval`, which already branches on `pattern === 'stream'` — no
    // enemy-side code changes were needed for this to work as an enemy-fired projectile stream.
    id: 'plasmaLance', name: 'Plasma Lance', category: 'plasma',  // #618: energy -> plasma
    damage: 1.6, range: { min: 0, opt: 460, max: 620 },
    ammoMax: 120, cycleTime: 0,   // #402: ~6.0s burst (120 ÷ 20/s), then 2s reload
    // #213: very light per-bolt tracking bias (Halo Needler-style) — see `weakSeek` above.
    // NOT `guidance: 'homing'` — these bolts never lock on and never gate firing on a lock
    // (targetlock.js only checks `guidance === 'homing'`).
    // #219: playtest tuning pass — velocity nudged down slightly (620 -> 580, ~6%) and
    // WEAK_SEEK_TURN_RATE (see delivery.js) nudged up so the seek reads a bit more.
    // #220: a small spreadJitter (2°) so the single-lane bolt stream sputters a little off
    // its perfectly straight line instead of every bolt tracking the exact same trajectory.
    // This is a single-lane stream (count 1, no cluster/spread), so in delivery.js's
    // planEmissions() this hits the jittered-stream branch with count 1 — each bolt
    // still gets exactly ONE shot per
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
    // #259 DPS-squish: damage 34 -> 52.8 to bring raw DPS up from ~15.45 to the ~24 band.
    // #408: cycleTime 2200 -> 1650 (under the 2s reload so the mag empties and reload creates real
    // downtime), holding DPS by scaling damage 52.8 -> 39.6 (= 52.8 × 1650/2200). Still a slow,
    // heavy sniper lance — not a machine gun. DPS = damage / cycleTime(s): 52.8/2.2 = 24.0 dps ->
    // 39.6/1.65 = 24.0 dps (unchanged).
    // 24-SUSTAINED FLOOR: damage 39.6 -> 52 to lift SUSTAINED (over the 4-round mag -> 2s reload
    // cycle) from 18.4 to 24.2 dps. Burst DPS = damage / cycleTime(s): 52/1.65 = 31.5.
    damage: 52, range: { min: 120, opt: 400, max: 640 },
    ammoMax: 4, cycleTime: 1650,   // #408: ~6.6s burst (4 pulls × 1.65s), then 2s reload
    delivery: { hit: 'hitscan', pattern: 'single', kind: 'rail' },
  }),
  chargeLance: w({   // #493: hold to charge, release to fire — Rail Lance's flavor text has
    // always described a "slow charge," but mechanically it was just a normal cooldown-gated
    // single shot; this is the weapon that actually does it, as its own separate entry rather
    // than reworking railLance's tuned numbers/enemy mounts.
    // At minTime (0.4s, a quick tap-and-release once past the floor): 30 x 0.5 = 15 damage.
    // At maxTime (1.6s, held to full): 30 x 2.5 = 75 damage — a genuine commitment payoff.
    // Playtest correction (2026-07-25): a charge that hit maxTime USED to auto-fire the instant
    // it capped out — Jackson: "should fire on release, not fire after a duration." Charge now
    // simply HOLDS at maxTime once reached (no damage lost by holding past it) and only actually
    // fires on the real button release, same as any charge below the cap. `maxSpreadDeg`: the
    // shot's accuracy is judged at release — how much the aim angle DRIFTED while charging is
    // scaled into an angular jitter on the actual shot (steady aim the whole hold = a pinpoint
    // beam; jerking the reticle around while charging = a wide, inaccurate shot). See firing.js
    // `_handleChargeFire`/`_releaseCharge`. A charging hold also now telegraphs as a growing arc
    // that thickens into a full beam by maxTime (firing.js `_updateChargeVisuals`).
    // #537 playtest ask: "charge lance should pierce enemies, meaning it hits whichever
    // enemies are in the area of the shot at time of release." `pierce: true` (firing.js
    // `_fireHitscan`) makes this the one hitscan weapon that damages EVERY living target along
    // its beam (up to the same wall-clamped reach every hitscan shot already respects), not
    // just the nearest — a wall/cover still stops it, it just doesn't stop at the first body.
    // Each pierced enemy takes the same full charge-scaled damage (not divided across targets):
    // it's a single continuous lance, not a shared pool, and "everyone in the line eats the
    // full hit" is the more legible payoff for the charge commitment than a per-target split.
    id: 'chargeLance', name: 'Charge Lance', category: 'energy',
    // 2026-08-01 playtest (Jackson: "the whole thing should be shorter range anyway" / "make
    // their ranges the same, and both 30% shorter"). Charge Lance was 460/680 and Charge Beam
    // 460/640; both are now the SAME 322/448 — 30% off the shared 460/640 baseline. For a
    // hitscan weapon `max` is the real reach (what `_fireHitscan` traces to, and since today
    // what the charge telegraph draws); `opt` only advises enemy standoff and catalog-card
    // preview scaling, so it carries no hard limit here.
    damage: 30, range: { min: 0, opt: 322, max: 448 },
    ammoMax: 4, cycleTime: 1600,   // #402: ~6.4s burst (4 pulls × 1.6s) if tapped at minTime every time
    delivery: {
      hit: 'hitscan', pattern: 'single', kind: 'rail', pierce: true,
      chargeable: { minTime: 0.4, maxTime: 1.6, minDamageMult: 0.5, maxDamageMult: 2.5, maxSpreadDeg: 22 },
    },
  }),
  chargeBeam: w({   // #627: Charge Lance's charge-up and Beam Laser's sustained beam in ONE gun.
    // Jackson, 2026-08-01: "combining beam laser and charge laser into a single weapon type, but
    // make it as a new one for now, don't get rid of those" — so this is a THIRD entry and neither
    // parent's numbers are touched. Three phases off one trigger:
    //   1. HOLD          — charges exactly like Charge Lance (same 0.4/1.6s curve, same cone
    //                      telegraph narrowing to the middle, same drift-into-spread accuracy rule).
    //   2. STILL HELD AT FULL — a sustained piercing beam spins up and ticks for as long as the
    //                      trigger is down (`delivery.beam`, below).
    //   3. RELEASE       — fires the lance at whatever charge was reached. ALWAYS, at any charge
    //                      level (Jackson: "holding keeps beam going, but releasing then fires the
    //                      lance shot") — so a release BELOW full charge is exactly Charge Lance's
    //                      behaviour today, beam phase never entered.
    //
    // ONE SHARED AMMO POOL, and the interesting consequence is deliberate (do not smooth it away):
    // the mag is beam-sized (120), a hold spends `chargeable.ammoCost` (24) up front, and the beam
    // then drains 1 round per tick at 20/s. Charge + beam to the bottom = 24 + 96 = the whole
    // magazine in ~4.8s of beam — and a mag drained to 0 auto-reloads, which means the gun is dry
    // when the trigger finally comes up and NO LANCE FIRES. Beam longer, or stop short and keep the
    // finisher: that trade is the weapon.
    //
    // Balance vs. its two parents (it must be an alternative, not a strict upgrade):
    //   • vs. Charge Lance — lance base damage 24 vs. 30 (12 tapped / 60 at full, vs. 15 / 75), and
    //     a charge costs 25 rounds of a 120 mag vs. 1 of 4, so pure tap-and-release gets ~4 shots
    //     per mag either way but each one hits ~20% softer. You pay for the beam option up front.
    //   • vs. Beam Laser — beam phase is 1.2 x 20/s = 24 dps vs. Beam Laser's 32, and it costs a
    //     1.6s spin-up before a single tick lands. What you get back is `pierce` (the beam rakes
    //     EVERY body in the line, where Beam Laser stops at the first) and the lance finisher.
    // Every one of those is a starting number, tuned in play.
    //
    // `kind: 'rail'` + `pierce: true` are Charge Lance's lance identity, kept for BOTH phases —
    // it's one emitter, so the beam rakes the line exactly as the lance does.
    // Note for the stat sheet: weaponStats.js prices this off the lance alone (its per-pull model
    // has no concept of a beam phase), so its listed ~22 sustained dps undercounts a beam-heavy
    // hold. That also means enemy-loadout budgeting (data/enemyLoadout.js, medium pool via
    // opt 460) sees the lance-only figure — correct as it happens, since an enemy never holds a
    // trigger and fires this as a plain 24-damage hitscan lance on `cycleTime`.
    id: 'chargeBeam', name: 'Charge Beam', category: 'energy',
    // 2026-08-01 playtest (Jackson: "the whole thing should be shorter range anyway" / "make
    // their ranges the same, and both 30% shorter"). Charge Lance was 460/680 and Charge Beam
    // 460/640; both are now the SAME 322/448 — 30% off the shared 460/640 baseline. For a
    // hitscan weapon `max` is the real reach (what `_fireHitscan` traces to, and since today
    // what the charge telegraph draws); `opt` only advises enemy standoff and catalog-card
    // preview scaling, so it carries no hard limit here.
    damage: 24, range: { min: 0, opt: 322, max: 448 },
    ammoMax: 120, cycleTime: 1600,
    delivery: {
      hit: 'hitscan', pattern: 'single', kind: 'rail', pierce: true,
      chargeable: { minTime: 0.4, maxTime: 1.6, minDamageMult: 0.5, maxDamageMult: 2.5, maxSpreadDeg: 22, ammoCost: 24 },
      // The beam phase borrows Beam Laser's held-loop voice rather than growing a second sound
      // entry for one weapon id — `chargeBeam`'s own `fire` cue (audio/sfxParams.js) is the LANCE
      // release, which needs to be a one-shot zap, not a hum.
      beam: { damage: 1.2, fireRate: 20, sfxId: 'beamLaser' },
    },
  }),
  plasmaCannon: w({ // arcing energy bolt with splash; lobs over cover — now a saturating VOLLEY (#434)
    id: 'plasmaCannon', name: 'Plasma Arc', category: 'plasma',  // #618: energy -> plasma
    // #259 DPS-squish: damage 18 -> 32 to bring raw DPS up from 11.25 to the ~20 band.
    // #434 VOLLEY REWORK: one trigger pull now fires a rippling 5-bolt volley (delivery.count 5 +
    // burst stagger) that SATURATES a small area, and EACH bolt spends 1 round (delivery.ammoPerShot)
    // — so the single-shot economy is gone. Per-bolt damage 32 -> 24: kept MEANINGFUL (a full volley
    // is 5 × 24 = 120 damage, ~3.75× the old 32 single shot — a real power increase, NOT the current
    // damage divided across five). Cadence 1600 -> 2400ms to keep the theoretical peak sane.
    // Peak DPS (all 5 bolts landing on one target) = 5 × 24 / 2.4 = 50.0 dps — a deliberate buff over
    // the old 20.0, justified because the bolts SCATTER (area denial, not single-point) and the shot
    // arcs, so realistic single-target DPS sits back down near the ~25 band; the payoff is against
    // clustered enemies. Magazine 5 -> 30 = 6 volleys (30 ÷ 5 bolts/pull) before the reload beat.
    damage: 24, range: { min: 0, opt: 480, max: 820 },
    // #602: 30 -> 15. The audit corrected a bad premise (this was read as "30 shots / 72 seconds",
    // but `ammoPerShot` means each pull spends 5 of them), so the real figure was 6 volleys /
    // 14.4s. Still the outlier: every other discrete weapon empties in 5.4-7.5s, and swarmRack's
    // deliberate 15.4s was the only longer one. 15 = 3 volleys / 7.2s, squarely in that band.
    // Knock-on, accepted: ammoMax feeds weaponStats.sustainedDps -> enemyLoadout's budget, so this
    // re-prices Plasma Arc slightly in the medium and heavy pools (sustained ~44 -> ~39).
    ammoMax: 15, cycleTime: 2400,   // 3 volleys (15 ÷ 5 bolts/pull), ~7.2s burst, then reload
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
    // #252 playtest follow-up round 2: "the lob seeking should turn SOONER, it feels
    // last-minute." The missile family (Swarm Rack/Streak Pod) engages its seeker at the
    // shared ASCENT_END (40% of flight, curving in over the back 35%) — inherited wholesale
    // when this weapon opted into the same arcHomingBlend machinery, but on a lobbed shell it
    // read as flying dumb through basically the whole ascent and only correcting right before
    // impact. `homingBlendStart` overrides just the engagement point for THIS weapon (see
    // delivery.js's `blendStart`/arcHomingBlend) without touching the missile family's already-
    // played timing: 0.15 starts the curve-in well before apex (full tracking by the 50% mark,
    // i.e. around apex, instead of by 75%) — noticeably earlier without being an instant
    // hard-turn off the muzzle, which would look wrong for a heavy lobbed round.
    // #376: velocity 320 -> 400 and homingBlendStart 0.15 -> 0, for the same reasons spelled
    // out on napalm above — `velocity` is now the bolt's literal speed at every range rather
    // than its speed at optimal only, and the seeker is live from launch. homingTurnRadius
    // stays 140 so it still reads as a heavy lobbed bolt, not a snapping missile.
    // #434 VOLLEY: `count: 5` + `burst.interval` turns one pull into 5 staggered bolts (the
    // projectile-burst branch of planEmissions), rippling out ~70ms apart rather than a single lob.
    // `ammoPerShot` makes each bolt spend one round and TRUNCATES the volley to whatever the mag can
    // afford (firing.js fireWeapon) — so a pull that can't cover all 5 fires only what it has, then
    // the emptied mag reloads. `burstScatter` fans each bolt a random angle across `spreadAngle`
    // (13°) so they don't stack on one point, and `salvoSpread` + `salvoNoConverge` give each bolt a
    // PERSISTENT lateral aim offset (up to 46px) that does NOT converge — the scatter survives the
    // lock-tracking seeker (which would otherwise home all 5 onto one pixel), landing them across a
    // small swath around the tracked target. Arc + splash + tracksLock identity all kept.
    delivery: { hit: 'projectile', path: 'arcing', velocity: 400, pattern: 'single', splash: 40, tracksLock: true, homingTurnRadius: 140, homingBlendStart: 0, count: 5, burst: { interval: 70 }, ammoPerShot: true, burstScatter: true, spreadAngle: 13, salvoSpread: 46, salvoNoConverge: true },
  }),
  flamethrower: w({ // close-mid gout of flame, held as one continuous stream
    id: 'flamethrower', name: 'Flamethrower', category: 'fire',  // #618: energy -> fire
    // #256 playtest rebalance: damage 2 -> 0.65 (revised target, see below). Flamethrower's
    // DPS is fireRate(18) x count(3) x damage, so
    // 18*3*2 = 108 dps originally — a ~40%+ overshoot over Repeater's 72 dps (18 x
    // count(2) x damage(2)). A first pass dropped damage to 1.5 (81 dps), but the
    // corrected target is ~35 dps — well below Repeater, not a near-miss of it — so damage
    // came down further to 0.65: 18*3*0.65 = 35.1 dps.
    // #259 DPS-squish: damage 0.65 -> 0.5185 to bring raw DPS down from 35.1 to the ~28 band.
    // 24-SUSTAINED FLOOR: damage 0.5185 -> 0.6 to lift SUSTAINED (mag->reload cycle, RELOAD 2s)
    // from 21.0 to 24.3 dps. Burst DPS = fireRate(18) x count(3) x damage: 18*3*0.6 = 32.4 dps.
    // #137: `count` was a random {min:2,max:4} spray range (average 3) before the delivery
    // fields were unified; it's now a FIXED 3 — the same average, so this DPS math holds
    // exactly instead of only on average, and damage is unchanged. The gout's chaos comes
    // entirely from spreadJitter (9°) + makeProjectile's per-particle speed variance now
    // rather than partly from count variance, which reads the same in motion at 18 ticks/sec.
    damage: 0.6, range: { min: 0, opt: 338, max: 600 },
    ammoMax: 108, cycleTime: 0,   // #402: ~6.0s burst (108 ÷ 18/s), then 2s reload
    // pattern: 'stream' + fireRate (continuous rework, #46): a cadence tick every ~55ms,
    // each popping 3 particles (count) instead of exactly one, so held
    // fire reads as one dense, unbroken gout rather than a thin single-file tracer or a
    // series of pulses. #402: the magazine alone bounds the gout — 108 rounds at 18/s is ~6.0s of
    // held flame, then the 2s reload beat (this replaces #372's old 54/9 below-consumption trickle,
    // which itself had replaced an "effectively unlimited" ammoRegen-above-fireRate economy).
    // spreadJitter is narrower than the original pulsed
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
    // #583: `projectileColor` here is the flame's own hot orange (`0xff7a18`, the outer tongue in
    // art/projectiles/flame.js). It does NOT repaint the flame — flame.js keeps drawing its own
    // multi-tone gradient, which is the point of that art. What it does is feed the mount-neon
    // derivation (`neonForWeapon`, art/mounts/index.js), so the gun on the mech stops glowing
    // energy-category CYAN while spraying orange fire. Audited and raised as the one remaining
    // mount/projectile colour mismatch; owner chose to make the mount match the flame.
    // #618: now that flamethrower's own `category` is `fire` (color 0xff7a18, this exact hex),
    // this override is redundant with the category default — left in place rather than risking
    // the actual rendered colour.
    delivery: { hit: 'projectile', pattern: 'stream', fireRate: 18, count: 3, spreadJitter: 9, velocity: 230, kind: 'flame', splash: 6, projectileColor: 0xff7a18 },
  }),
  plasmaCoater: w({   // #489: heavier bolt that COATS the enemy — most of its damage is the burn,
    // not the hit. Deliberately NOT a stream/burst weapon (unlike plasmaLance) — a repeat hit only
    // REFRESHES the burn (owner decision, no stacking), so a rapid-fire cadence would make the DoT
    // nearly pointless to land twice; this fires slowly enough that landing a second hit to refresh
    // the burn before it expires is a real, deliberate choice.
    // Direct-hit DPS (per blob) = damage / cycleTime(s): 14/1.4 = 10.0 dps — low on purpose. The
    // burn adds 5 dps for 4s per landed hit (up to 20 bonus damage), refreshed rather than stacked
    // on a second hit within that window.
    // Playtest follow-up (2026-07-25): the DoT itself was already real (Mech.tickStatusEffects
    // routes every tick through applyDamage) — what was missing was any visible sign it was
    // happening. #489 gave a coated unit a floating green pulse; 2026-07-31 replaced that with a
    // proper per-part purple "coating" outline (scenes/arena/shieldOutline.js's `updateDotOutline`,
    // reusing the shield glow's own duplicate-sprite technique) — see `_drawStatusEffects`.
    // 2026-07-31 LOB REWORK (live chat ask): "a lob of maybe 3 blobs" — reworked from a single
    // straight-line bolt into a 3-blob arcing lob, fired as a simultaneous fixed fan
    // (`pattern: 'spread'`). Several same-day iterations (series-fire, a fixed triangle landing
    // pattern via a `burst`+`burstFan` combo) were tried and playtested, then explicitly walked
    // back ("nevermind on plasma coater triangle, let's just do a three blob arc like you had a
    // long time ago") — back to this original simple spread. `burstFan`/`distOffset` stay in
    // delivery.js as general infrastructure in case a future weapon wants that shape; this one
    // just doesn't use them any more. Each blob still carries the weapon's full per-bolt
    // damage/dot — landing more than one blob on the same target is a real escalation over the
    // old single-bolt weapon; tune live. Also gained `splash` (see data/delivery.js's field doc,
    // and the general splash damage fix landed the same day in projectiles.js
    // `_splashDamageAt`) so a blob that lands near — not just ON — an enemy still catches it, dot
    // included. `projectileColor`: a purple-themed round (matching the DoT coating's own violet,
    // shieldOutline.js's PLASMA_COAT_COLOR) instead of the shared 'energy' category cyan every
    // other energy weapon uses — see makeProjectile's opt-in override, data/delivery.js.
    id: 'plasmaCoater', name: 'Plasma Coater', category: 'plasma',  // #618: energy -> plasma
    damage: 14, range: { min: 0, opt: 380, max: 560 },
    ammoMax: 4, cycleTime: 1400,   // #402: ~5.6s burst (4 pulls × 1.4s), then 2s reload
    delivery: {
      hit: 'projectile', path: 'arcing', velocity: 460, kind: 'plasma', arcBump: 0.9,
      // No spreadJitter: playtest ask was "the spread/arc should be consistent, not
      // randomized" -- 3 shots at a fixed 24° fan, same 3 angles every pull.
      pattern: 'spread', count: 3, spreadAngle: 24,
      // #618: this is now the exact same hex as the `plasma` category's own default color
      // (both trace back to PLASMA_COAT_COLOR) — the override is redundant with the category
      // default, but left in place rather than risk the actual rendered colour.
      projectileColor: 0xa04dff,
      splash: 40,
      dot: { kind: 'plasmaBurn', duration: 4, tickDamage: 5, tickInterval: 1 },
    },
  }),

  // ── BALLISTIC ── solid rounds, burn ammo. A single heavy shell, a bullet stream, a
  // tight fast pellet burst, and a lobbed incendiary that paints the ground. ──
  autocannon: w({   // one heavy, very fast direct-fire shell — punchy single hits
    id: 'autocannon', name: 'Autocannon', category: 'ballistic',
    // #259 DPS-squish: damage 16 -> 24.2 to bring raw DPS up from ~14.55 to the ~22 band.
    // 24-SUSTAINED FLOOR: damage 24.2 -> 36 to lift SUSTAINED (over the 5-round mag -> 2s reload
    // cycle) from 16.1 to 24.0 dps. Burst DPS = damage / cycleTime(s): 36/1.1 = 32.7.
    damage: 36, range: { min: 0, opt: 347, max: 600 },
    ammoMax: 5, cycleTime: 1100,   // #402: ~5.5s burst (5 pulls × 1.1s), then 2s reload
    delivery: { hit: 'projectile', path: 'straight', velocity: 760, pattern: 'single', kind: 'slug' },
  }),
  machineGun: w({   // sustained stream of small fast tracer rounds
    id: 'machineGun', name: 'Repeater', category: 'ballistic',
    // #256 playtest round 2: damage 2 -> 1.667 to bring DPS down from 72 to ~60.
    // DPS = damage x count(2) x fireRate(18): 2*2*18 = 72 -> 1.667*2*18 = 60.
    // #259 DPS-squish: damage 1.667 -> 0.889 to bring raw DPS down from ~60 to the ~32 band.
    // DPS = damage x count(2) x fireRate(18): 1.667*2*18 = 60.01 -> 0.889*2*18 = 32.0 dps.
    damage: 0.889, range: { min: 0, opt: 338, max: 600 },
    ammoMax: 108, cycleTime: 0,   // #402: ~6.0s burst (108 ÷ 18/s), then 2s reload
    // count: 2 — each cadence tick fires 2 rounds in parallel lanes (streamSpacing px
    // apart, straddling the aim line), reading as twin tracer streams, not a fan. Bump to
    // `count: 3` for a triple stream (widen streamSpacing to taste if the lanes crowd).
    delivery: { hit: 'projectile', path: 'straight', velocity: 900, pattern: 'stream', fireRate: 18, count: 2, streamSpacing: 5, kind: 'bullet', scale: 0.75 },
  }),
  shotgun: w({      // tight, very fast pellet burst — a shotgun, not a wide scatter
    id: 'shotgun', name: 'Scatter Gun', category: 'ballistic',
    // #259 DPS-squish: damage 3 -> 4.457 to bring raw DPS up from 17.5 to the ~26 band.
    // 24-SUSTAINED FLOOR: damage 4.457 -> 5.5 (per pellet) to lift SUSTAINED (over the 5-round
    // mag -> 2s reload cycle) from 19.5 to 24.1 dps. Burst DPS = damage x count(7) / cycleTime(s):
    // 5.5*7/1.2 = 32.1.
    damage: 5.5, range: { min: 0, opt: 338, max: 600 },
    ammoMax: 5, cycleTime: 1200,   // #402: ~6.0s burst (5 pulls × 1.2s), then 2s reload
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
    delivery: { hit: 'projectile', path: 'straight', velocity: 980, pattern: 'spread', count: 7, spreadAngle: 7, kind: 'bullet', wobble: 'sway', wobbleAmplitude: 2.5, wobbleFrequency: 14 },
  }),
  napalm: w({       // lobbed canister that bursts into a burning ground patch
    id: 'napalm', name: 'Napalm Lobber', category: 'fire',  // #618: ballistic -> fire
    // #259 DPS-squish: damage 6 -> 27 to bring the DIRECT-HIT raw DPS up from 4.0 to the ~18
    // band. DPS = damage / cycleTime(s): 6/1.5 = 4.0 dps -> 27/1.5 = 18.0 dps. This is
    // direct-hit only, same as the original 4.0 figure — the groundFire DOT (radius/dps/
    // duration below) stays a separate bonus, untouched by this retune, per the #259 audit's
    // explicit call-out that napalm's low headline DPS undercounted its splash/burn utility.
    // 24-SUSTAINED FLOOR: damage 27 -> 46 to lift the DIRECT-HIT SUSTAINED (over the 5-round mag
    // -> 2s reload cycle) from 14.2 to 24.2 dps. Still direct-hit only: the groundFire DOT + splash
    // are NOT counted here, so napalm's REAL sustained output exceeds 24 once the burn is added.
    // Burst DPS = damage / cycleTime(s): 46/1.5 = 30.7 (direct hit).
    damage: 46, range: { min: 50, opt: 500, max: 780 },
    ammoMax: 5, cycleTime: 1500,   // #402: ~7.5s burst (5 pulls × 1.5s), then 2s reload
    // #252 playtest follow-up — see plasmaCannon's comment above for the full rationale:
    // `tracksLock: true`, not `guidance: 'homing'`, so this still fires unconditionally with no
    // lock (canFireWeapon is untouched), but steers at the lock's live target through the
    // descent when the player does have one, same arcing-homing-blend as Swarm Rack/Streak Pod.
    // `homingTurnRadius` widened the same way so it turns in lazily near the 3.2 rad/s floor,
    // not the missile family's near-9 rad/s ceiling.
    // #252 playtest follow-up round 2 — see plasmaCannon's comment above for the full
    // rationale: `homingBlendStart: 0.15` engages the seeker much earlier than the missile
    // family's shared 0.4 default (full tracking by the ~50% mark, near apex, instead of 75%),
    // so it reads as correcting well before the last stretch rather than last-minute.
    // #376: velocity 300 -> 380 and homingBlendStart 0.15 -> 0. Under the new constant-
    // horizontal-speed rule (firing.js) `velocity` is now the shell's literal speed at every
    // range; 300 was its speed at OPTIMAL range only, with a max-range shot previously flying
    // ~470. 380 is roughly that old mid-band, so a long lob doesn't crawl now that it no
    // longer speeds up with distance. It stays far below the missile family's 1000 — this is
    // still a heavy, slow, visibly-lobbed canister. The seeker now steers from launch like
    // the missiles do, but homingTurnRadius stays a lazy 140 so it corrects gradually across
    // the whole flight rather than snapping — the "heavy shell nudging itself on" read.
    delivery: { hit: 'projectile', path: 'arcing', velocity: 380, splash: 30, kind: 'fire', groundFire: { radius: 46, dps: 8, duration: 4 }, tracksLock: true, homingTurnRadius: 140, homingBlendStart: 0 },
  }),
  // #244: siegeShell (the #94 sentry-turret artillery round) was deleted from this registry —
  // it was mechanically identical to napalm (both arcing projectile + splash + groundFire
  // lobbed rounds), differing only in tuning numbers. Its tuning survived for a while as the
  // sentry turret kind's `weaponOverride` on napalm; #469 deleted that kind, so nothing mounts
  // the artillery numbers any more and napalm is purely the player's own lobber.
  causticLobber: w({   // #492: a slow-drifting canister that vents a corrosive cloud the WHOLE
    // way there, not just on impact — distinct from napalm, whose burn only starts once the
    // round lands. A modest direct-hit component (below) plus travelAoe's continuous tick is
    // most of its real output, so it rewards holding it over a crowd rather than a clean hit.
    // Direct-hit DPS = damage / cycleTime(s): 18/1.8 = 10.0 — deliberately the lowest headline
    // number in the ballistic row; travelAoe's 12 dps over however long it lingers over a target
    // is where this weapon's damage actually comes from.
    // Playtest follow-up (2026-07-25): "should be larger, should be slower, and should give
    // visuals striking out at the enemies it's damaging as it travels." Bumped up a size class
    // (`delivery.scale`) and slowed further (160 -> 100), and every travelAoe tick now draws a
    // brief bolt from the canister to each enemy it just damaged (scenes/arena/projectiles.js
    // `_tickTravelAoe`) so the "corrosive cloud reaching out and zapping things" reads visually,
    // not just in the damage log.
    // Playtest follow-up #2 (2026-07-25): "make the damaging tendril range larger, and make the
    // projectile itself not hit enemies, only hit cover." The canister used to also detonate a
    // direct hit + splash the instant it drifted within HIT_RADIUS of an enemy, on top of the
    // travelAoe tick — `ignoresEnemyHit` removes that so the canister drifts THROUGH a crowd,
    // dragging its (now much wider) tendril reach across everyone in range the whole way, and
    // stops for nothing but a wall/soft cover or its own max range.
    // Playtest follow-up #3 (2026-07-25, #492): tuning + reskin.
    //   * velocity 100 -> 130 (+30%) — "slightly faster" so the toss doesn't crawl quite so long
    //     before its cloud starts reaching enemies; still by far the slowest round in the
    //     catalog (everything else sits at 300+) since the whole point is a lingering cloud.
    //   * range.opt 380 -> 700, range.max 560 -> 900 — "much longer range." Puts it clearly past
    //     napalm (500/780), its closest lobbed-AoE sibling, without reaching into missile
    //     territory (swarmRack/streakPod opt 900-1050+).
    //   * `kind: 'shadow'` (was `'fire'`, napalm's shared steel-drum art) — its own reskin: a
    //     dark, swirling shadow-magic purple orb (art/projectiles/shadow.js) instead of a fuel
    //     canister, so it no longer looks like a smaller napalm round.
    //   * the damage tendril (`_drawAoeTendril`, scenes/arena/projectiles.js) is drawn thicker —
    //     tuned there since it's shared drawing code, not a per-weapon field.
    // Playtest follow-up #4 (2026-07-26, #492): "tendrils should also be purple and should have
    // more range and be more spooky tendrilly." travelAoe.radius 130 -> 175 (+35%, still below
    // the force-field radii at 190/210) so the tendrils reach visibly farther; the tendril
    // recolor lives in `_drawAoeTendril` itself (scenes/arena/projectiles.js) since it's shared
    // drawing code, not a per-weapon field. Follow-up #5 reverted that same function's SHAPE
    // back to a simple jagged line (kept the purple, dropped the sinuous-strand treatment) —
    // range here is unaffected.
    id: 'causticLobber', name: 'Caustic Lobber', category: 'plasma',  // #618: ballistic -> plasma
    damage: 18, range: { min: 40, opt: 700, max: 900 },
    ammoMax: 3, cycleTime: 1800,   // #402: ~5.4s burst (3 pulls × 1.8s), then 2s reload
    delivery: {
      hit: 'projectile', path: 'straight', velocity: 130,   // deliberately slow — the "cloud" has to linger to matter
      splash: 30, kind: 'shadow', scale: 1.6, ignoresEnemyHit: true,
      // #582: the round's REAL colour, declared as data. `shadow` art (like `fire` and `flame`)
      // hardcodes its own palette and ignores the colour it's passed, so `p.color` was still the
      // ballistic row's orange — which is what every downstream consumer of "what colour is this
      // round" then used: an orange impact blast under a purple orb, an orange damage flash, and
      // an orange mount glow on a gun that fires violet. Two of those were already patched by
      // hardcoding the violet a second and third time (`_drawAoeTendril`'s GLOW/CORE consts, the
      // orb's own art). This is the one number they should all have been reading. 0xb060e0 is the
      // orb's bright eye — shadow.js's own "the one hot spot the orb reads by."
      // #618: category is now `plasma` (0xa04dff), the same violet family as this override —
      // but 0xb060e0 is its own distinct shade (shadow.js's tuned eye colour, not the category
      // default), so this is NOT redundant the way plasmaCoater's exact-match override is;
      // left as-is.
      projectileColor: 0xb060e0,
      // #538: capped at 15 tendrils (individual connecting hits) so a round parked over a
      // crowd can't tick indefinitely — only a tick that actually connects spends the budget,
      // an empty tick is free. See `_tickTravelAoe`/`maxTendrils` in projectiles.js.
      travelAoe: { radius: 175, dps: 14, maxTendrils: 15 },
    },
  }),
  timedCharge: w({   // #488: reworked from a timed mid-air detonation into an actual MINEFIELD
    // tool per playtest feedback — "more like a lobbed thing that places a proximity mine upon
    // landing." One pull tosses a tight scatter of 5 charges a SHORT, FIXED distance in front of
    // you (range does not extend with a locked target — this is a close-range area-denial toss,
    // not a long-range shot), each one landing and arming as its own stationary proximity mine
    // (data/aoe.js's blast math, but triggered by an enemy walking near it later rather than on
    // impact — see scenes/arena/projectiles.js `_plantHazard`/`_updateHazards`). Lets you blanket
    // a doorway/chokepoint with 5 mines in one pull rather than placing one at a time.
    // Polish pass: renamed 'Timed Charge' -> 'Proximity Mines' — the id (and every save/roster
    // reference to it) stays `timedCharge` on purpose, only the player-facing name changes, so
    // it actually reads as a mine rather than a grenade.
    id: 'timedCharge', name: 'Proximity Mines', category: 'ballistic',
    damage: 30, range: { min: 0, opt: 150, max: 190 },   // short + absolute: aim only steers direction, not distance
    ammoMax: 4, cycleTime: 1600,   // #402: ~6.4s burst (4 pulls × 1.6s), then 2s reload
    delivery: {
      hit: 'projectile', path: 'arcing', velocity: 300, kind: 'plasma',
      pattern: 'spread', count: 5, spreadAngle: 55,
      // Polish pass: a noticeably taller lob (arcBump 1.3 vs the shared ARC_LOFT_BUMP of 0.6 —
      // see delivery.js) so the toss visibly arcs like a thrown mine instead of a flat dart.
      arcBump: 1.3,
      // Polish pass: `spreadJitter` (the existing "randomize a fan's launch angle" field, #46/
      // #220) so the 5 mines' angular spacing isn't a perfectly even fan every pull.
      spreadJitter: 18,
      // Polish pass: `scatterJitter` (delivery.js `scatterMaxDist`) randomizes each mine's own
      // landing DISTANCE by up to ±35% — spreadJitter above only varies launch angle, and no
      // weapon before this needed per-shot distance variance, so the 5 mines used to land in a
      // perfectly even ring. Now they scatter at varied radii too.
      scatterJitter: 0.35,
      hazard: { kind: 'mine', radius: 55, damage: 30, armDelay: 0.3, life: 7 },
    },
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
    // #256 playtest rebalance: damage 4 -> 8. DPS = count(6) x damage / cycleTime(1.6s),
    // so 6*4/1.6 = 15 dps pre-rebalance -> 6*8/1.6 = 30 dps, meaningfully above the old
    // ~15-23 missile band but still under Flamethrower (81) and Repeater (72) since the
    // homing guidance is itself a strong utility advantage over straight DPS.
    // #256 playtest round 2: damage 8 -> 10.667 to land at ~40 dps (6*10.667/1.6 = 40).
    // #259 DPS-squish: damage 10.667 -> 6.933 to bring raw DPS down from ~40 to the ~26 band.
    // DPS = count(6) x damage / cycleTime(s): 6*10.667/1.6 = 40.0 -> 6*6.933/1.6 = 26.0.
    damage: 6.933, range: { min: 280, opt: 1050, max: 1750 },
    // #377 feel pass (Swarm Rack ONLY — no other missile touched):
    //   * cycleTime 1600 -> 1100. "I want to be able to fire them more often." ~45% more
    //     trigger pulls per second; while-firing DPS rides up with it (6 x 6.933 / 1.1 =
    //     ~37.8 vs ~26.0). That is a real buff, deliberately accepted — Jackson is tuning
    //     this weapon by feel, and every number here is a playtest dial.
    //   * a DELIBERATELY BIG magazine ("increase magazine size"): 14 rounds at the 1.1s cycle is
    //     ~15.4s of continuous fire before the 2s reload — far past the ~6s other weapons hold.
    //     #402 carries that intent forward (it used to be ammoMax 8 + a fast 0.45/s regen; with
    //     the trickle gone the magazine alone is sized to keep the ~15s burst). The per-weapon
    //     burst-length exception in weapons.test.js is widened for swarmRack alone.
    ammoMax: 14, cycleTime: 1100,   // #402: ~15.4s burst (14 pulls × 1.1s), then 2s reload (swarmRack's deliberate big mag, #377)
    // wobble: 'jostle' — chaotic random-phase jiggle, constant all the way to impact (#49).
    // path: 'arcing' (#57) — lofts up then down like a real missile leaving the tube, so the
    // salvo can clear cover.
    // #376 playtest pass, three changes here:
    //   * spreadAngle 44 -> 14. "Not fan out so silly" — the salvo now leaves the rack as a
    //     loose clump much closer to Cluster Salvo's tight character, with the 'jostle'
    //     wobble left fully intact so it still warbles on the way in.
    //   * velocity 1050 -> 1000. Under #376's constant-horizontal-speed rule (firing.js) this
    //     IS the round's real speed at every range, so it is now directly comparable to
    //     Cluster Salvo's 1140 and sits deliberately just below it, as asked. The old 1050
    //     was NOT a real speed: #77 picked it by scaling velocity 3.5x alongside range purely
    //     to hold the (now-removed) constant flight time, so it has been re-derived, not nudged.
    //     SUPERSEDED BY #377 (velocity is now 500): that "just below Cluster Salvo" alignment
    //     no longer holds for Swarm Rack and is not meant to — see the #377 note below. It
    //     still holds for the other missiles, which #377 did not touch.
    //   * homingBlendStart 0 — the seeker is live from the muzzle instead of waking up at the
    //     shared 0.4 (past apex) default. That engagement point, NOT the turn rate, is what
    //     made tracking feel weak: at 1000 px/s the round's steering rate already pins to the
    //     engine's HOMING_TURN_MAX ceiling (9.0 rad/s) with the default 64px radius, so
    //     tightening homingTurnRadius here would be a literal no-op and is deliberately not
    //     done. The 0.35 blend span is untouched, so authority still ramps in smoothly over
    //     the first third of flight rather than snapping on at the muzzle.
    // #377, two more changes in the delivery block:
    //   * velocity 1000 -> 500. "The flight speed feels waaaay too fast, maybe 2x what it
    //     should be." This DELIBERATELY breaks #376's "all missiles sit just under Cluster
    //     Salvo's 1140" alignment for this one weapon — he is tuning by feel now, and that
    //     comment has been annotated rather than left asserting an alignment that is gone.
    //     Steering is unaffected in character: at 500 px/s the derived turn rate (speed /
    //     64px radius = 7.8 rad/s) is just under the engine's 9.0 rad/s ceiling instead of
    //     pinned to it, so the round still corners inside the same 64px radius.
    //   * arcProfile: 'steepDrop' — the loft easing (data/delivery.js arcLoft; fake height, a
    //     sprite-scale pulse only). Jackson: "less parabolic, more like they rise quickly,
    //     then travel, then come falling down on the enemy abruptly towards the end." The
    //     profile name describes that shape; it is deliberately not named after a weapon
    //     type. The default 'lob' parabola is untouched for napalm/plasmaCannon/streakPod.
    //     The seeker ramp is unaffected and does not desync: homingBlendStart 0 + the 0.35
    //     span means steering is fully live by t=0.35 — inside the flat cruise, well before
    //     the terminal dive at t=0.80 — so the round is done correcting when it drops.
    // #377 follow-up: salvoSpread 48. "Can we keep slight separation of the individual
    // missiles warbling until last minute they converge on the target?" With
    // homingBlendStart 0 all six rounds resolved onto one aim point almost immediately and
    // the salvo read as a single line — the fan and the jostle wobble were being erased by
    // the seeker, not by anything wrong with the fan. Each round now steers at a point up to
    // 48px to the side of the true target (which side, and how far, follows its own position
    // in the salvo — its INDEX since #631, its place in the launch fan before that — so the
    // salvo holds its shape), and that offset decays to zero across
    // t=0.80 -> 0.93 — the same beat as the steep terminal drop, with flight left to settle so
    // all six still connect. Tracking authority itself is UNTOUCHED: he said tracking feels
    // good, so the rounds steer just as hard as before, only at slightly different points.
    // #377 follow-up 2, three deltas — "make the projectiles slower, make the wobble slower,
    // and the in-flight spread slightly less". Everything else in this weapon is confirmed
    // good and untouched (the steepDrop arc, cycle, magazine, regen, tracking, converge).
    //   * velocity 500 -> 320. The SECOND cut this issue (it was 1000). Swarm Rack is now a
    //     deliberate crawl next to Streak Pod (1000) and Cluster Salvo (1140) — that
    //     divergence is the point, not an oversight: this weapon is being made its own thing.
    //   * wobbleFrequency 6.5, overriding the shared JOSTLE_FREQUENCY of 11 (~40% lazier
    //     side-to-side). Set as a per-weapon override rather than by editing the shared
    //     constant, so 'jostle' stays available unchanged to anything that adopts it later.
    //     Rate only — amplitude is untouched at the shared 5px, and the two are genuinely
    //     independent in stepProjectile (offset = sin(t * frequency) * amplitude), so this
    //     changes how FAST it warbles, not how wide.
    //     Note the wobble clock is REAL TIME, not distance — so slowing the round does not
    //     slow the warble on its own; it just packs more wiggles into the same path. Halving
    //     speed alone would have made the flight look MORE shimmery, not less. Together, the
    //     two changes land at ~309px of travel per wobble cycle (was ~285px), so the wiggle
    //     stays about the same shape along the flight path while the real-time rate drops
    //     ~41% — lazier to watch, not stretched into a slack noodle.
    //   * salvoSpread 48 -> 40. "Slightly less" — the outermost pair now sit ~80px apart
    //     rather than ~96px. Still clearly separated; every other part of the offset
    //     behaviour is deliberately unchanged.
    // Plus a fourth, asked for right after: convergence now triggers on REMAINING DISTANCE
    // to the target (320px -> fully converged by 130px) instead of on a fraction of flight.
    // Jackson: "it should not be a fraction, it should be a fixed distance from the target."
    // See SALVO_CONVERGE_START_PX in delivery.js — a fraction made the salvo start tightening
    // further out on a long lob than a short one, so the same weapon read differently
    // depending on range.
    // #377 feel follow-up 3 — "overall better, but still needs some fine tuning: slightly
    // faster, and a more obvious arc." Two dials nudged, nothing else touched:
    //   * velocity 320 -> 400. A gentle +25% — still a deliberate crawl next to Streak Pod
    //     (1000) and Cluster Salvo (1140), just no longer quite so sluggish. (It was 500, then
    //     320, earlier this issue; this is a small nudge back up, not a return toward those.)
    //   * arcBump 1.05 (overriding the shared ARC_LOFT_BUMP of 0.6 — see delivery.js). The
    //     steepDrop loft already popped to full height; this makes that pop READ, growing the
    //     apex sprite ~1.75x baseline instead of ~1.6x, so the up-then-drop lob is clearly
    //     visible. Rise/cruise/fall SHAPE (arcProfile 'steepDrop') is unchanged — only how tall
    //     the fake height renders. Other arcing weapons keep the subtle 0.6 default.
    // #631 (2026-08-02) — THE FAN IS OFF ON PURPOSE. Jackson: "for swarm rack, turn off the
    // spread angle, keep only the salvo spread." `spreadAngle` 14 -> 0; `salvoSpread` stays 40,
    // untouched. This is NOT a lost tuning value or an accidental regression — the 44 -> 14 pass
    // above and the 48 -> 40 pass are both still history, and 14 was the last fan width before it
    // was deliberately zeroed. All six missiles now LAUNCH on the same heading and get every bit
    // of their separation from the lateral aim offset instead: they leave the rack as a parallel
    // column, splay to their own aim points up to 40px either side of the target (the outermost
    // pair ~80px apart, exactly the width the 48 -> 40 pass dialled in), then converge late and
    // connect as before. Everything else — velocity, jostle, arc, converge window — is untouched.
    // Only possible since #631 decoupled `salvoSpread` from `spreadAngle`; before it, a 0° fan
    // zeroed the lateral offsets too and the salvo collapsed into a single line.
    delivery: { hit: 'projectile', guidance: 'homing', pattern: 'spread', count: 6, spreadAngle: 0, velocity: 400, wobble: 'jostle', wobbleFrequency: 6.5, path: 'arcing', homingBlendStart: 0, arcProfile: 'steepDrop', arcBump: 1.05, salvoSpread: 40 },
  }),
  streakPod: w({    // one press unloads a quick staggered stream of seekers, then cools down
    id: 'streakPod', name: 'Streak Pod', category: 'missile',
    // #77 tuning follow-up: range 3.5x'd (60/260/440 → 210/910/1540); velocity scaled by the
    // same 3.5x (see swarmRack comment above) to hold flight time constant.
    // #256 playtest rebalance: damage 5 -> 9. One trigger pull dumps the whole 6-missile
    // burst over cycleTime(1.8s): 5*6/1.8 = 16.7 dps pre-rebalance -> 9*6/1.8 = 30 dps.
    // #256 playtest round 2: damage 9 -> 12 to land at ~40 dps (12*6/1.8 = 40).
    // #259 DPS-squish: damage 12 -> 7.8 to bring raw DPS down from 40 to the ~26 band.
    // 24-SUSTAINED FLOOR: damage 7.8 -> 9.3 to lift SUSTAINED (over the 4-round mag -> 2s reload
    // cycle) from 20.3 to 24.3 dps. Burst DPS = count(6) x damage / cycleTime(s): 9.3*6/1.8 = 31.0.
    damage: 9.3, range: { min: 210, opt: 910, max: 1540 },
    ammoMax: 4, cycleTime: 1800,   // #402: ~7.2s burst (4 pulls × 1.8s), then 2s reload
    // wobble: 'weave' — smooth deliberate sine weave, no decay (#50). burst (#50): a single
    // trigger pull fires the whole 6-missile stream in rapid succession, not held-to-fire.
    // path: 'arcing' (#57) — same loft-over-cover treatment as Swarm Rack.
    // #376: velocity 1540 -> 1000, matching Swarm Rack and sitting just under Cluster Salvo's
    // 1140 — every missile now flies at one identical horizontal speed regardless of range
    // (the old 1540 was #77's 3.5x range-scaled number, chosen for the removed constant-flight-
    // time rule). Seeker tuning matches Swarm Rack: live from launch (homingBlendStart 0),
    // same smooth 0.35 ramp-in, turn rate left at the engine ceiling it already pins to.
    delivery: { hit: 'projectile', guidance: 'homing', velocity: 1000, wobble: 'weave', count: 6, burst: { interval: 70 }, path: 'arcing', homingBlendStart: 0 },
  }),
  // TEMPORARY SANDBOX WEAPON (2026-08-01). Jackson: "make a new one just called new missiles or
  // something temporary so I can work on something; I want something somewhere between swarm rack
  // and streak pod; between as far as projectile speed, but also kinda burst+spread, but less of a
  // spread out burst." A scratch entry for him to tune live — rename/retire it freely, nothing
  // else in the codebase depends on it.
  //
  // The two parents sit at opposite corners of the missile design space:
  //   swarmRack — SPREAD (all 6 at once in a 14° fan, salvoSpread 40), SLOW (velocity 400)
  //   streakPod — BURST (6 staggered 70ms apart, no fan at all), FAST (velocity 1000)
  // Follow-up (same conversation): "no actual fan, more like they're separated horizontally but
  // not by fanning." That's `salvoSpread` — a per-round LATERAL offset in px — rather than
  // `spreadAngle`, the angular fan. And 2026-08-02: "make the burst for new missiles much
  // tighter, one after the other much closer in time, almost overlapping one another."
  //
  // WHAT IT LOOKS LIKE NOW. All six leave the tubes inside ~100ms — one per frame at 60fps,
  // which is as tight as a staggered burst can get before rounds start sharing a frame and the
  // ripple collapses into a single simultaneous pop. They leave on essentially the same heading
  // (`spreadAngle: 0`; the only angular offset left is the ±0.3° alternating weave stagger every
  // 'weave' burst weapon gets, which is cosmetic), then splay out sideways as each one steers to
  // its own aim point 6/18/30px off-centre either way — a 60px-wide WALL of missiles rather than
  // a fan or a ripple. Convergence is deliberately left ON (no `salvoNoConverge`): the offsets
  // decay to zero late in flight so all six still HIT, which is what a homing missile should do.
  // Add `salvoNoConverge: true` if you'd rather they stay apart and saturate an area instead.
  //
  // (#631 is what made `spreadAngle: 0` possible. The lateral offset used to be derived FROM the
  // launch fan, so a salvo with no fan had no lateral separation either, and this entry carried a
  // token 2° fan purely to give each round a position to index against. That coupling is gone —
  // `salvoSpread` now reads each round's index in the volley — so the fan is off for real.)
  //
  // No bespoke mount art on purpose: with no `WEAPON_MOUNT_ART` entry it falls back to the
  // generic `missile` category mount, which HAS its own `BARREL_SPECS` entry — so the drawn art
  // and the muzzle-tip shots spawn from stay in agreement (no #233/#584 drift), which a bespoke
  // mount without a matching spec would have broken.
  newMissiles: w({
    id: 'newMissiles', name: 'New Missiles', category: 'missile',
    damage: 8,                                        // between 6.933 and 9.3
    range: { min: 245, opt: 980, max: 1650 },         // midpoint of 280/1050/1750 and 210/910/1540
    ammoMax: 9, cycleTime: 1450,                      // between 14/1100 and 4/1800 — ~13.1s burst
    delivery: {
      hit: 'projectile', guidance: 'homing', path: 'arcing', homingBlendStart: 0,
      velocity: 700,                                  // squarely between 400 and 1000
      count: 6,                                       // both parents fire 6
      burst: { interval: 20 },                        // "almost overlapping" — ~1 round per frame
      spreadAngle: 0,                                 // NO fan at all (#631 decoupled the two)
      salvoSpread: 30,                                // the separation, all of it: lateral px
      burstShuffle: true,                             // don't sweep left→right; re-roll the launch order each pull
      wobble: 'weave',                                // streakPod's tighter weave, not the jostle
      arcProfile: 'steepDrop', arcBump: 1.05,         // swarmRack's hard terminal plunge (his ask)
    },
  }),
  clusterRocket: w({ // dumbfire clump that stays tight — no spread, no guidance
    id: 'clusterRocket', name: 'Cluster Salvo', category: 'missile',
    // #77 tuning follow-up: range 3x'd (0/220/320 → 0/660/960, kept at the low end of the 3-4x
    // band since this one's a tight-clump dumbfire weapon, not a seeker); velocity scaled by the
    // same 3x so its (straight, non-arcing) travel time to max range doesn't balloon.
    // #256 playtest rebalance: damage 5 -> 7. DPS = count(5) x damage / cycleTime(1.1s),
    // so 5*5/1.1 = 22.7 dps pre-rebalance -> 5*7/1.1 = 31.8 dps, landing this dumbfire
    // cluster in the same ~30 dps missile band as its two homing siblings above.
    // #256 playtest round 2: damage 7 -> 8.8 to land at ~40 dps (5*8.8/1.1 = 40).
    // #259 DPS-squish: damage 8.8 -> 6.16 to bring raw DPS down from 40 to the ~28 band.
    // 24-SUSTAINED FLOOR: damage 6.16 -> 6.9 (per rocket) to lift SUSTAINED (over the 6-round mag
    // -> 2s reload cycle) from 21.5 to 24.1 dps. Burst DPS = count(5) x damage / cycleTime(s):
    // 6.9*5/1.1 = 31.4.
    damage: 6.9, range: { min: 0, opt: 660, max: 960 },
    // velocity (1140) is untouched: it's the straight-flying reference every other missile was
    // pulled just below.
    ammoMax: 6, cycleTime: 1100,   // #402: ~6.6s burst (6 pulls × 1.1s), then 2s reload
    // scale 0.8 — slightly smaller rockets, and clusterSpacing 3.5 pulls the clump tighter (#51
    // playtest): a denser, more compact salvo rather than a loose spread.
    delivery: { hit: 'projectile', guidance: 'dumbfire', pattern: 'spread', count: 5, cluster: true, clusterSpacing: 3.5, velocity: 1140, scale: 0.8 },
  }),

  // ── SUPPORT ── crowd control rather than raw damage — the `support` category (no ammo,
  // battery recharge like energy) had no occupant until these two. Both a slow-moving projectile
  // whose real payload is `delivery.force` (data/force.js), continuous for as long as it's in
  // flight near a target, same architecture as Caustic Lobber's travelAoe (#492). ──
  gravityWell: w({    // #491: reworked into a PLANTED crowd-control zone per playtest feedback —
    // "let's make it a lot that then plants in place and sustains swirly dark purple pull orb for
    // a while, like crowd control for a bit." Now a lobbed charge that lands and stays, sustaining
    // a continuous pull field (swirling dark-purple orb visual, scenes/arena/projectiles.js
    // `_drawHazard`) for a real duration rather than only pulling while airborne on its way past.
    // Playtest follow-up (2026-07-25): "stronger pull but smaller visual area, so the visual is
    // more where enemies end up, not the full range of the pull" plus "smoother, not jerky", plus
    // "always a consistent lob distance that doesn't hit enemies directly but does hit cover."
    // Four changes, all in `delivery`/the field hazard below:
    //   * `force.strength` 220 -> 330 and pull `radius` 150 -> 210 — a stronger, farther-reaching
    //     tug (scenes/arena/projectiles.js `_updateHazards`'s field branch).
    //   * `visualRadius` 65 — the drawn orb (`_drawHazard`) is now well inside the real pull
    //     radius, reading as the landing zone the crowd gets dragged INTO rather than the whole
    //     area the field can grab from.
    //   * the field's own pull tick no longer chunks into a 250ms lump (visibly jerky); it now
    //     applies every frame at the real frame `dt`, same net pull, smooth drift.
    //   * `fixedRange` + `hitsCoverWhileArcing`: the lob no longer shortens to land near whatever's
    //     locked (always flies its own `range.opt`), and — despite still being an arcing lob — now
    //     stops on a wall/destructible hex instead of lobbing clean over it.
    // Playtest follow-up #2 (2026-07-25, #491): "should detonate/begin on hit" — the round used to
    // carry `ignoresEnemyHit`, so it never resolved a hit on an enemy at all and only ever planted
    // after flying its full `fixedRange` distance (or fizzling on a wall, with no field at all).
    // Dropped that flag: the round now runs the normal nearest-enemy hit test (projectiles.js) like
    // any other dumbfire lob, and since it still carries `hazard`, closing within HIT_RADIUS of an
    // enemy plants the field right there instead of resolving a direct hit — the pull now begins ON
    // CONTACT. It still also plants at `range.opt` if it never gets close to anyone, so a miss still
    // lands a zone rather than vanishing.
    id: 'gravityWell', name: 'Gravity Well', category: 'support',
    // Direct-hit damage is inert on this weapon (a hazard-carrying round always plants instead of
    // resolving a normal hit, projectiles.js) — kept at a nominal floor only for weapon-card math.
    damage: 6, range: { min: 40, opt: 380, max: 520 },
    ammoMax: 3, cycleTime: 2000,   // #402: ~6.0s burst (3 pulls × 2s), then 2s reload
    delivery: {
      hit: 'projectile', path: 'arcing', velocity: 300, kind: 'plasma',
      fixedRange: true, hitsCoverWhileArcing: true,
      hazard: { kind: 'field', radius: 210, visualRadius: 65, life: 5, force: { strength: 330, sign: -1 } },
    },
  }),
  repulsorPulse: w({   // #499: reworked from a slow travelling orb into an instant FRONT-FACING
    // WAVE per playtest feedback ("more like a front-facing wave maybe?") — no round to land near
    // an enemy at all; the instant the trigger's pulled, everything caught in a forward cone off
    // the muzzle gets shoved (data/force.js's push/pull math, applied once instead of ticked over
    // a flight) — see scenes/arena/firing.js `_fireWave`. Always REPELS.
    id: 'repulsorPulse', name: 'Repulsor Pulse', category: 'support',
    damage: 10, range: { min: 0, opt: 190, max: 190 },
    ammoMax: 4, cycleTime: 1500,   // #402: ~6.0s burst (4 pulls × 1.5s), then 2s reload
    delivery: {
      wave: true, kind: 'plasma',
      force: { radius: 190, strength: 320, sign: 1, coneDeg: 110 },
    },
  }),

  // ── LIGHTNING (#622) ── two genuinely new mechanics: a hitscan bolt that CHAINS between
  // multiple enemies, and a lobbed pair of hazards that LINK and pulse damage along the
  // connection. Jackson: "chain lightning, maybe some lobbable pylons that link and pulse for
  // a bit or something" — both pitched with the real feasibility tradeoff before he confirmed. ──
  chainBolt: w({   // hitscan bolt: hits the nearest enemy in your aim, then jumps to the
    // nearest OTHER live enemy within `chain.jumpRange` of the last hit point (excluding
    // enemies already hit this shot), up to `chain.maxJumps`, damage falling off each jump.
    // See scenes/arena/firing.js `_fireHitscan`'s chain branch (calls `_fireChainBolt`) for the
    // hop resolution and data/delivery.js `nearestChainTarget` for the pure nearest-candidate pick.
    // Damage: pitched meaningfully higher than a comparable single-target hitscan sniper (Rail
    // Lance, 52 damage/shot, same single-pattern hitscan structure and a similar 1650ms cadence)
    // so a Chain Bolt that only connects with ONE enemy (no second target in jumpRange) doesn't
    // read as strictly worse than just mounting Rail Lance — 60 vs Rail Lance's 52 is a real,
    // if modest, edge on a single target, with the chain entirely upside beyond that: a 3-target
    // chain (falloff 0.7) deals 60 + 42 + 29.4 = 131.4 total, spread across three separate
    // enemies rather than stacked on one.
    id: 'chainBolt', name: 'Chain Bolt', category: 'lightning',
    damage: 60, range: { min: 0, opt: 380, max: 600 },
    ammoMax: 4, cycleTime: 1650,   // mirrors Rail Lance's single-shot hitscan cadence
    delivery: {
      hit: 'hitscan', pattern: 'single',
      chain: { maxJumps: 3, jumpRange: 300, falloff: 0.7 },
    },
  }),
  linkPylons: w({   // #626: TESLA PYLONS — one lobbed tower per trigger pull.
    // Jackson (#626): "link pylons should instead be pylons that zap proximity enemies instead
    // of linking, like a tesla coil tower thing" + "let's maybe do 1 pylon per shot instead of 5
    // at a time, and let's keep total damage per tick consistent and just spread it among the
    // available targets."
    // Once landed and armed, each pylon acts ALONE — no links, no web, no group. Every
    // `pulseInterval` it zaps every live non-flying enemy inside its own `radius`, splitting
    // `pulseDamage` EVENLY among them: one enemy eats the whole budget, five eat a fifth each,
    // nobody in range means no zap that tick. A tower therefore can't out-damage its own budget
    // however many enemies crowd it — but towers placed over time each carry a budget of their
    // own, so overlapping several on the same ground is the intended way to scale this up. See
    // scenes/arena/projectiles.js `_updatePylons`/`_plantHazard`.
    // (#622/#623/#624's whole linking subsystem — the per-volley mesh, then the field-wide
    // bounded-degree link graph, its cap/max-link-range constants and its connecting lines — is
    // deleted, along with the 5-pylon staggered volley that fed it: `count`/`burst.interval`/
    // `burstScatter`/`spreadAngle`/`salvoSpread`/`salvoNoConverge`/`ammoPerShot` are all gone.
    // The arc/lob feel and the 350/450 range are kept exactly as the #623 playtest pass tuned
    // them — they still read right for placing a single tower at mid range.)
    // Ammo: one pull = one tower = one round, so no `ammoPerShot` and no volley multiplier —
    // ammoMax 15 -> 5. cycleTime 2000 -> 1500ms so the magazine's towers actually COEXIST:
    // 5 pulls x 1500ms = 7.5s to empty (plants at t=0/1.5/3.0/4.5/6.0), and with the hazard's
    // 6s `life` + 0.3s `armDelay` the first tower is still standing as the fifth lands — all
    // five overlap for a beat at the top of the magazine, which is the whole point of stacking
    // budgets. Then the mag empties and the automatic RELOAD_SECONDS (2s) reload kicks in.
    id: 'linkPylons', name: 'Tesla Pylons', category: 'lightning',
    // NOTE the id stays `linkPylons` while the display name changes: weapon ids are persisted in
    // saved builds (data/rosters.js), so renaming one breaks any save with it mounted. Exact same
    // precedent as `timedCharge` displaying as "Proximity Mines" — see that entry's comment.
    // Direct-hit damage is inert on this weapon (a hazard-carrying round always plants instead
    // of resolving a normal hit, projectiles.js) — kept at a nominal floor only for weapon-card
    // math, same convention as Gravity Well.
    damage: 8, range: { min: 0, opt: 350, max: 450 },
    ammoMax: 5, cycleTime: 1500,   // 5 towers/mag, 7.5s burst, then reload
    delivery: {
      hit: 'projectile', path: 'arcing', velocity: 300, kind: 'plasma',
      fixedRange: true, arcBump: 1.3,
      // #626: `pulseDamage` is now a per-tick TOTAL split among everything in `radius`, not a
      // per-target amount, so it's retuned up from the old 8. The old 8 was charged to EACH enemy
      // touching a web that typically caught a few at once, so 24 keeps a crowded tower roughly
      // where the web sat while making one tower vs one enemy meaningfully real (24 per 0.5s =
      // 48 dps concentrated, for a stationary trap the enemy has to stand inside). This is the
      // weapon's main balance dial — first number, Jackson's to retune live.
      // #626 playtest follow-up (Jackson: "increase tesla pylon range"). radius 70 -> 150. The 70
      // was inherited from the LINKING era, where it measured against a connecting SEGMENT that
      // could span up to 220px — a long capture corridor. As a plain circle around a single tower
      // it was only ~2x a mech's own 32px hit radius, so enemies walked past untouched. 150 gives
      // one tower a real footprint to defend without approaching the old web's reach.
      hazard: { kind: 'pylon', radius: 150, pulseDamage: 24, pulseInterval: 0.5, armDelay: 0.3, life: 6 },
    },
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
// #499: Jackson, playtest — "repulsor pulse is dumb, turn it off." Shelved rather than
// deleted: its WEAPONS entry (data/art/sfx) stays fully intact, it's just unreachable from
// the garage catalog/shop — the exact mechanism this list exists for.
// #618: "rail lance sucks; get rid of it, but keep its weapon mount art and use that art for
// the beam laser." Same mechanism, same reason to shelve rather than delete: `enemyKinds.js`'s
// wall-turret kind sets `weaponId: 'railLance'` and resolves it directly via getWeapon()/
// resolveWeapon(), bypassing WEAPON_IDS entirely — that encounter is untouched by this list.
// #621: "move gravity well and proximity mines to abilities" — revised mid-discussion to a single
// new ability, EMP Trap (data/abilities.js), that replaces both. Both `gravityWell` and
// `timedCharge` are shelved rather than deleted: their WEAPONS entries (data/art/sfx) stay fully
// intact — no enemy references either id directly (checked — zero hits in enemyKinds.js) — but an
// existing save could still have either mounted/unlocked, so shelving is the safe move, same
// mechanism already used twice above.
export const SHELVED_WEAPON_IDS = ['repulsorPulse', 'railLance', 'gravityWell', 'timedCharge'];

export const WEAPON_IDS = Object.keys(WEAPONS).filter((id) => !SHELVED_WEAPON_IDS.includes(id));

// Jackson, 2026-08-01: "sort weapons by type (laser vs plasma, etc)". WEAPON_IDS is declaration
// order, which used to roughly double as category order (weapons were written category-block by
// category-block) — #618 broke that assumption by reassigning several weapons (causticLobber,
// plasmaCannon, plasmaLance, flamethrower, napalm) to new categories WITHOUT moving their file
// position, so declaration order and true category no longer agree. This is what both catalog
// UIs (Garage, Weapon Lab) should actually render in: WEAPON_IDS grouped by CATEGORY_IDS' own
// object-key order (categories.js), stable-sorted so weapons within a category keep their
// existing relative order. Reordering CATEGORIES reorders the catalog for free.
export const CATALOG_WEAPON_IDS = [...WEAPON_IDS].sort(
  (a, b) => CATEGORY_IDS.indexOf(WEAPONS[a]?.category) - CATEGORY_IDS.indexOf(WEAPONS[b]?.category)
);

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
//   • every other nested object (range, burst, groundFire…) is replaced WHOLESALE
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
// Jackson, 2026-08-01 ("the weapon preview cards don't seem to be allowing the full range of
// the weapons to be displayed, like they're squished"): the catalog's range spread is bimodal
// — most weapons sit at opt 150-700, but two long-range outliers (opt 910, 1050) set
// `catalogMax`, so a linear fraction left a typical mid-range weapon filling under half its
// card. sqrt COMPRESSES that spread (his pick over dropping relative scaling entirely, or just
// raising the floor): it pulls the middle of the distribution up toward 1 much more than it
// pulls the top down, since sqrt(x) > x for every x in (0,1) and the gap shrinks as x -> 1. The
// two outliers still reach ~0.93-1.0 (nearly unchanged) while a 500-range weapon goes from
// ~0.48 to ~0.69 and a 190-range weapon from ~0.18 to ~0.43 — the #120 goal (farthest weapon
// fills the stage, others draw shorter) survives, it's just no longer a straight line.
export function previewRangeFrac(weapon, catalogMax, minFrac = 0.15) {
  const r = weapon?.range;
  const opt = r?.opt || r?.max || 0;
  if (!catalogMax) return 1;
  return Math.max(minFrac, Math.sqrt(opt / catalogMax));
}
