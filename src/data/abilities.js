// Ability catalog (#506) — mountable non-weapon items for the ABILITY_SLOTS (Y/X). Mirrors
// weapons.js's one-registry-entry-per-item shape: each entry supplies the cooldown/duration
// tuning data/abilityState.js's generic state machine consumes, plus an `effect` kind string
// the arena dispatches on (scenes/arena/abilities.js) — no per-ability special-casing lives in
// the state machine, the input plumbing, or (eventually) the HUD.
//
// Dash used to be a hardcoded L3/Space built-in every mech always had (data/dash.js, #261);
// #506 makes it the first mountable ability instead, so it's now a build choice like any
// weapon — a mech with no ability mounted has no burst mobility at all. Default rosters
// (rosters.js) equip it so existing builds don't silently lose mobility.

// Speed multiplier during the dash burst. Meaningfully higher than Sprint's 1.5x
// (SPRINT_SPEED_MULT, data/sprint.js) so a dash reads as a distinct, punchier tool — 3.0x sits
// at the top of the original 2.5-3x "decisive burst, not a teleport" band.
export const DASH_SPEED_MULT = 3.0;

// Burst duration, in seconds. Short enough to read as a snap of momentum: at a medium chassis'
// 195px/s base speed this covers 195 * 3.0 * 0.25 ≈ 146px (~3 hexes, HEX_SIZE=48) in one press.
export const DASH_BURST_DURATION = 0.25;

// Cooldown, in seconds — long enough to be a deliberate tactical choice, short enough to matter
// again within a single engagement.
export const DASH_COOLDOWN = 4;

// #498 (owner playtest, "no good... both / the whole thing reads as nothing" — neither the
// movement nor the landing blast registered). Two independent fixes:
//  1. The burst itself was actually SHORTER than Dash's own (2.2x/0.2s ≈ 86px at medium
//     chassis base speed vs Dash's 3.0x/0.25s ≈ 146px) despite being framed as the bigger,
//     more decisive "jump" of the two — it read as a weak dash, not a jump. Bumped clearly past
//     Dash's own distance (3.2x/0.3s ≈ 187px at the same base speed) so covering ground here
//     unmistakably reads as a bigger leap.
//  2. The blast radius/damage were well under Shield Burst's (#490 — 90/30) despite Jump Blast
//     costing real repositioning risk to land, so a "worse Shield Burst" is exactly how it read.
//     Bumped to sit slightly ABOVE Shield Burst's numbers, and (scenes/arena/abilities.js) it
//     now plays a radius-sized shockwave burst + camera shake on both the launch and the
//     landing (`_aoeBlastFx`, combat.js) instead of relying on incidental per-target impact
//     circles that only show up if something happened to be standing in the blast.
// PLAYTEST DIAL — every value below is tunable, not locked.
export const JUMP_BLAST_SPEED_MULT = 3.2;
export const JUMP_BLAST_BURST_DURATION = 0.3;
export const JUMP_BLAST_RADIUS = 85;
export const JUMP_BLAST_DAMAGE = 32;

// #494/#546: Anti-Missile Defense used to be a passive core-slot pick (data/coreItems.js, since
// removed) — always-on while equipped, gating a single-target scan on a flat per-shot cooldown
// (`range: 220, cooldown: 2.5`). Jackson: "change it to some kind of active ability in that system
// instead of passive" — it's now a normal mountable ability with the same cooldown/duration shape
// every other entry here uses. On activation it becomes active for `duration` seconds, during
// which it destroys EVERY incoming enemy round that comes within `range` each frame (a limited
// burst window, not an always-on single-target gate), then goes on `cooldown`. `range` is an
// extra field beyond the usual cooldown/duration pair — see arena/abilities.js's `antiMissile`
// effect for the actual scan/destroy logic (data/interceptor.js's `nearestInterceptTarget` is
// still the reusable target-selection primitive underneath it). Starting numbers, Jackson's own
// to retune live, not locked.

// #628 — THE 4-SECOND CAP. Jackson: "decrease cooldowns for all abilities significantly" ->
// asked how much -> "all cut to 4 seconds at most". So every entry below is `min(previous, 4)`:
// cloak 5, jumpBlast 6, shieldBurst 8, smokeScreen 12, antiMissile 13, droneLauncher 15 and
// empTrap 18 all come down to 4; Dash was already at DASH_COOLDOWN (4) and is unchanged. The cap
// is a flat rule, not seven independently-tuned numbers — anything that needs to breathe again
// after playtest moves on its own, but the starting point for all of them is the same 4.
//
// TWO CONSEQUENCES, both raised with him BEFORE he confirmed the cap, both deliberate — they are
// noted here (and at the two entries themselves) so a later reader doesn't file them as bugs:
//   1. empTrap's 18 was the LONGEST cooldown in the game on purpose (#621) — the counterweight
//      for a full move+fire stun that can catch up to 5 enemies in one scatter. At 4s a stun is
//      nearly always available, which makes this the likeliest of the set to want walking back.
//   2. droneLauncher (duration 12) and smokeScreen (duration 6) now have cooldowns SHORTER than
//      their own durations. Nothing stacks — `canActivate` (data/abilityState.js) also gates on
//      `!state.active`, so a second press mid-window is the same no-op it always was — but the
//      practical effect is that both are re-summonable the INSTANT they expire, with no gap.
export const ABILITIES = {
  dash: {
    name: 'Dash',
    effect: 'dash',
    cooldown: DASH_COOLDOWN,
    duration: DASH_BURST_DURATION,
    speedMult: DASH_SPEED_MULT,
  },
  // #490: non-aimed AoE damage around the mech, on activation. No movement component — just a
  // burst radius/damage pair the 'shieldBurst' effect (scenes/arena/abilities.js) applies at the
  // player's own position the instant it triggers.
  shieldBurst: {
    name: 'Shield Burst',
    effect: 'shieldBurst',
    cooldown: 4,      // #628: was 8 — the flat 4s cap.
    duration: 0.15,   // just long enough to read as a beat, not a real "burst window"
    radius: 90,
    damage: 30,
  },
  // #498: a quick movement burst (like Dash, its own speedMult) that blasts AoE damage at the
  // ARRIVAL point rather than the launch point — the 'jumpBlast' effect fires the blast on the
  // burst's active→inactive transition, by which point the player has actually moved there.
  jumpBlast: {
    name: 'Jump Blast',
    effect: 'jumpBlast',
    cooldown: 4,      // #628: was 6 — the flat 4s cap.
    duration: JUMP_BLAST_BURST_DURATION,
    speedMult: JUMP_BLAST_SPEED_MULT,
    radius: JUMP_BLAST_RADIUS,
    damage: JUMP_BLAST_DAMAGE,
  },
  // #497: summons a lightweight friendly drone that orbits the player and auto-fires at nearby
  // enemies for the ability's `duration`, then despawns. `duration` doubles as the drone's
  // lifespan on the SAME abilityState burst window every other ability uses — no new state
  // machine needed.
  //
  // #628 CORRECTED A STALE CLAIM HERE. This comment used to read "`cooldown` > `duration` so
  // there's a real gap after it expires before a fresh one can be summoned" — true at 15/12, and
  // FALSE now that the cap put the cooldown at 4 against a 12s duration. What is still true is the
  // part that was only ever the parenthetical: re-pressing mid-flight is a no-op, because
  // `canActivate` gates on `!state.active` as well as on the cooldown. So nothing stacks and a
  // squad is never doubled — but the cooldown is long spent by the time the squad expires, so a
  // fresh one is available the instant the old one despawns. That is the intended #628 behaviour,
  // not an oversight.
  droneLauncher: {
    name: 'Drone Launcher',
    effect: 'droneLauncher',
    cooldown: 4,      // #628: was 15 — the flat 4s cap; deliberately shorter than `duration`.
    duration: 12,
  },
  // #500: personal stealth — visually fades the mech to a grey wireframe, blocks the same
  // per-enemy firing-lane raycast Smoke Screen does (scenes/arena/stealth.js — so even an
  // already-engaged enemy loses its lane), and suppresses noise-aggro (data/awareness.js's
  // NOISE_AGGRO_RANGE) at its wearer's position.
  //
  // Playtest follow-up (Jackson, 2026-08-01): "make cloak last until you fire a weapon instead of
  // lasting a finite amount of time" / "make cloak have a shorter cooldown". So the fixed 4s
  // window is gone entirely and there is no upper cap — `duration: null` is what
  // data/abilityState.js reads as "hold indefinitely" — and `breaksOnFire` declares what ends it:
  // any of the four weapon triggers actually putting a shot out (an ABILITY does not break it).
  // The cooldown clock starts at that BREAK rather than at activation, or a long sneak would come
  // back off cooldown before it had even ended. Both fields are read generically — the state
  // machine and the arena's fire path know about `duration: null`/`breaksOnFire`, not about Cloak.
  cloak: {
    name: 'Cloak',
    effect: 'cloak',
    cooldown: 4,      // #628: was 5 — the flat 4s cap.
    duration: null,
    breaksOnFire: true,
  },
  // #507: a stationary area version of the same "suppress noise-aggro" mechanic Cloak grants
  // personally — drop it and reposition while it covers the spot. Protects ANY live player
  // standing in it (co-op cover), not just whoever cast it. Its lifetime rides the SAME
  // abilityState burst window as Drone Launcher's summon (`duration` = how long the cloud
  // lingers), spawned/despawned on the activate/deactivate edges.
  //
  // #628: like Drone Launcher above, its cooldown is now SHORTER than its own `duration` — a
  // fresh cloud can go down the moment the last one dissipates. Deliberate; `canActivate`'s
  // `!state.active` gate is what still stops two clouds existing at once.
  smokeScreen: {
    name: 'Smoke Screen',
    effect: 'smokeScreen',
    cooldown: 4,      // #628: was 12 — the flat 4s cap; deliberately shorter than `duration`.
    duration: 6,
    // 2026-08-04 playtest (Jackson: "the thickness is great now, can we also make it a much larger
    // area?"). 100 -> 180: 1.8x the radius, 3.24x the covered area, ~7.5 hexes across.
    //
    // Safe to change alone, and worth knowing WHY: every dimension in `smokePuffLayout`
    // (art/smokePuff.js) is a FRACTION of the cloud radius — cluster size, sub-blob size, scatter
    // distance, haze size — and cluster centres scatter by uniform AREA (sqrt(random)), not uniform
    // radius. So the whole cloud scales as one piece: same relative density, same thickness, no
    // extra objects drawn. It costs nothing in frame time and does not undo the density pass.
    //
    // It DOES make the ability stronger: `radius` is also the LOS-blocking radius that
    // `smokeBlocksPoint` (arena/stealth.js) tests against, so this is 3.24x the actual cover, not
    // just 3.24x the visual. One number if that turns out to be too much.
    radius: 180,
  },
  antiMissile: {
    name: 'Anti-Missile Defense',
    effect: 'antiMissile',
    cooldown: 4,      // #628: was 13 — the flat 4s cap.
    duration: 3.5,
    range: 220,
  },
  // #621: replaces the shelved Gravity Well + Proximity Mines weapons — Jackson: "combine the two
  // - make it like traps that place around the player, no friendly-activation, but when it
  // activates it does crowd control (kinda like the gravity thing) rather than mine damage, maybe
  // it's an electric burst that disables things temporarily or something." Single-cast + cooldown
  // (no magazine, no SCRAP unlock, same as every other ability) — one press scatters `trapCount`
  // stationary trap hazards directly around the player's own position (no aim, no travel/arc
  // phase; scenes/arena/abilities.js's `empTrap` effect pushes them straight into `scene.hazards`,
  // skipping the projectile pipeline entirely since there's nothing to fly). Each trap reuses
  // Proximity Mines' old `hazard: { kind: 'mine', ... }` arm/trigger/team-exemption pipeline
  // (scenes/arena/projectiles.js `_updateHazards`) — armDelay/life numbers carried over from that
  // weapon's own tuning — but its `disable` field makes the on-trigger branch apply a FULL STUN
  // (can't move, can't fire) instead of `damageInRadius` damage.
  //
  // `duration: 0.15` is just the shared "instant activation beat" every non-movement ability uses
  // (mirrors Shield Burst) — the traps themselves outlive that beat on their own `life` timer, same
  // as a planted mine/field hazard always has.
  //
  // PLAYTEST DIAL, first to tune: `disableDuration` (2.5s) x `cooldown`. This is the strongest of
  // the three CC options Jackson was offered (full stun vs. movement-only vs. firing-only) — a
  // scatter of 5 traps can plausibly stun several enemies at once, which is why #621 gave it the
  // longest cooldown in the game (18s, against a then-next-highest of Drone Launcher's 15s) so one
  // trap-scatter couldn't trivialize a pack of enemies. `trapCount` (5) mirrors Proximity Mines'
  // old scatter; the scatter-radius band (50-100px around the player) and hazard radius/armDelay/
  // life (55/0.3/7) mirror that weapon's own numbers, just re-centered on the player.
  //
  // #628 REMOVED THAT COUNTERWEIGHT, knowingly. The flat 4s cap applies here like everywhere else,
  // so the game's deliberately-longest cooldown is now the same as everything else's and a full
  // stun is nearly always available. Jackson was told this before confirming the cap and confirmed
  // it anyway — so it is intended, NOT an oversight of #621's balance reasoning. Of the seven
  // abilities the cap touched, this is the one most likely to need walking back after playtest;
  // if it does, this entry's `cooldown` is the dial (the 18 above is the number it came from).
  empTrap: {
    name: 'EMP Trap',
    effect: 'empTrap',
    cooldown: 4,      // #628: was 18 — the flat 4s cap. See the note above before retuning.
    duration: 0.15,
    trapCount: 5,
    scatterRadiusMin: 50,
    scatterRadiusMax: 100,
    hazardRadius: 55,
    armDelay: 0.3,
    life: 7,
    disableDuration: 2.5,
  },
};

// #618: the type/bucket label shown under each ability's name in the garage catalog (mirrors
// how CATEGORIES[weapon.category].label labels a weapon's card) — was previously hardcoded to
// the flat string 'Ability' for every entry. Co-located here with ABILITIES, same pattern
// categories.js uses for weapons.
export const ABILITY_TYPES = {
  dash: 'Mobility',
  jumpBlast: 'Mobility',
  shieldBurst: 'Offense',
  droneLauncher: 'Offense',
  cloak: 'Defense',
  smokeScreen: 'Defense',
  antiMissile: 'Defense',
  // #621: a judgment call — it neutralizes a threat (crowd control) rather than dealing damage,
  // same reasoning as Cloak/Smoke Screen/Anti-Missile above, so it's grouped with them rather than
  // with the damage-dealing Offense pair (Shield Burst/Drone Launcher). Flagged in the report in
  // case Offense reads better to Jackson.
  empTrap: 'Defense',
};

export function getAbility(id) {
  return ABILITIES[id];
}

export function isAbility(id) {
  return id in ABILITIES;
}
