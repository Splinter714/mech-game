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
    cooldown: 8,
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
    cooldown: 6,
    duration: 0.2,
    speedMult: 2.2,
    radius: 70,
    damage: 25,
  },
  // #497: summons a lightweight friendly drone that orbits the player and auto-fires at nearby
  // enemies for the ability's `duration`, then despawns. `duration` doubles as the drone's
  // lifespan on the SAME abilityState burst window every other ability uses — no new state
  // machine needed. `cooldown` > `duration` so there's a real gap after it expires before a
  // fresh one can be summoned (re-pressing mid-flight is a no-op like every other ability, since
  // `canActivate` also gates on `!state.active`).
  droneLauncher: {
    name: 'Drone Launcher',
    effect: 'droneLauncher',
    cooldown: 15,
    duration: 12,
  },
  // #500: a brief personal stealth window — visually fades the mech and suppresses noise-aggro
  // from its own shots (data/awareness.js's NOISE_AGGRO_RANGE) for `duration`, so a dormant
  // enemy nearby doesn't get woken by the sound of firing while cloaked. Does NOT hide the
  // player from an enemy that's already engaged/aware — this is "go quiet," not true invisibility.
  cloak: {
    name: 'Cloak',
    effect: 'cloak',
    cooldown: 14,
    duration: 4,
  },
  // #507: a stationary area version of the same "suppress noise-aggro" mechanic Cloak grants
  // personally — drop it and reposition while it covers the spot. Protects ANY live player
  // standing in it (co-op cover), not just whoever cast it. Its lifetime rides the SAME
  // abilityState burst window as Drone Launcher's summon (`duration` = how long the cloud
  // lingers), spawned/despawned on the activate/deactivate edges.
  smokeScreen: {
    name: 'Smoke Screen',
    effect: 'smokeScreen',
    cooldown: 12,
    duration: 6,
    radius: 100,
  },
};

export function getAbility(id) {
  return ABILITIES[id];
}

export function isAbility(id) {
  return id in ABILITIES;
}
