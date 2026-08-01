// The PLAYER's medium chassis (#299).
//
// Why this exists: #248 locks the player to the medium weight class, and the Warden (the enemy
// sniper, data/enemies.js) also rides medium — but the #299 balance pass gives them deliberately
// DIFFERENT stat blocks (player 1400 hp / 2100 armor / 100 shield; enemy medium
// 150/150/50 = 350). One shared config can't express both, so the two had to separate.
//
// Why a chassis variant rather than an override at the point the player mech is built: the
// player's Mech is constructed in several places that all have to agree — the garage preview,
// the saved-roster round-trip (data/rosters.js / save.js), and the arena — and the HUD reads
// per-location max armor/HP straight off the built mech. Patching stats after construction in
// ArenaScene would make the garage show one mech and the arena field a tougher one. Putting it in
// the registry keeps the codebase's standing rule intact ("adding a chassis is one config + one
// entry, no model changes") and every consumer sees one consistent mech.
//
// This file USED to be `{ ...MEDIUM_CONFIG, id, totals, art, movement }` — everything it didn't
// override was the enemy medium's, spread in so the two "could never drift". Live-chat ask
// (2026-07-31): "can we actually split out the enemy chassis as separate code to be tweaked
// separately from the player chassis code?" — drift is now the POINT, so the spread is gone and
// every value below is a literal this file owns. The inherited ones (the name, weightClass
// 'medium', art bodyLen/bodyWid, turretSlew/stepBob/footShake) were copied verbatim off
// enemy/medium.js at the time of the split, so behaviour is byte-identical — but from here on,
// editing enemy/medium.js has ZERO effect on the player, and vice versa.
//
// The player's shield is configured separately at deploy time (ArenaScene, `data/Mech.js`'s
// `PLAYER_SHIELD_CONFIG`) — that's the unconditional 100 in 200/300/100. #496 briefly made it an
// equip choice through a since-removed core-slot system; Jackson's follow-up call put it back as
// a fixed baseline every player mech always gets.

export const MEDIUM_PLAYER_CONFIG = {
  id: 'mediumPlayer',
  // #598: 'Trooper' is now the PLAYER's name alone. The enemy medium used to carry it too (a live
  // duplicate that only stayed invisible because enemies surfaced under the ENEMIES table's
  // separate 'Medium Mech'); enemy/medium.js is now plainly 'Medium Mech', so this is unambiguous.
  name: 'Trooper',
  weightClass: 'medium',
  // The player's REAL durability, stated honestly in one place (#324).
  //
  // #299 set these to 300 armor / 200 hp, but ArenaScene then applied a player-only
  // `boostHealth(7)` at deploy (from #64), so the number everyone balanced against — 600 total —
  // was never the number in play. The multiplier is now folded in: 2100 + 1400 = 3500, exactly
  // what boostHealth(7) produced, and boostHealth is gone. Behaviour is unchanged; the point of
  // #324 was to make the figure visible, not to move it.
  //
  // So: the player is ~7x the toughest enemy (the artillery mech's 500). That is the status quo,
  // now legible. This is the one dial to turn if it should be otherwise — a deliberate decision
  // to make with the honest number in view, which was impossible while it lived in a scene.
  // Plus the unconditional 100-point shield, always applied at deploy.
  totalArmor: 2100,
  totalHp: 1400,
  // Body size is the enemy medium's original figures (bodyLen 38 / bodyWid 30), copied at the
  // 2026-07-31 split rather than spread — the player's Trooper and the enemy medium merely happen
  // to share them now, and either may move alone.
  //
  // #587: the `accent: 0xe8a13a` that used to sit alongside them is GONE — nothing ever read it.
  // A chassis' `art` block is pure GEOMETRY now; the mech's one identity colour is the player's
  // own (data/players.js PLAYER_COLORS, or their garage pick per #487), resolved by
  // `playerMechArt()` and handed to `themeFor` as the rim accent.
  //
  // #438: player-only leg proportions. First pass went SKINNIER (legW 1.0 → 0.72) and
  // WIDER-SET (legSpread 1.0 → 1.4); the playtest kept the wide stance but asked for the legs
  // "a bit thicker again, and longer forward also".
  //
  //   legSpread 1.4  — UNCHANGED, the wide set is the part that landed.
  //   legW      0.90 — most of the width back (was 0.72), so they read as load-bearing struts
  //                    rather than sticks, without undoing the first pass entirely.
  //   legH      1.5  — the leg BOX is 50% longer front/back (#482 follow-up: 1.30 → 1.5).
  //   legDrop   0.45 — #482 redefined legDrop as the leg's front/back OFFSET from the centre-torso
  //                    centre (mechArt.mechLayout: y = −0.05·L + 0.20·L·legDrop). 0 sits the legs
  //                    DEAD-CENTRE on the torso; this #482 follow-up nudges them toward the REAR
  //                    (0 → 0.45) — about half the old rearward offset (≈ legDrop 0.9 in the new
  //                    form, ~0.18·L behind centre), so the legs trail slightly without the full
  //                    pre-#482 asymmetry the owner flagged.
  //
  // A partial `shape`: the fields left out fall back to mechArt.js's DEFAULT_SHAPE, same as the
  // enemy Warden (which declares no `shape` at all → the old legDrop 1 = +0.15·L).
  art: {
    bodyLen: 38, bodyWid: 30,
    shape: { legW: 0.90, legSpread: 1.4, legH: 1.5, legDrop: 0.45 },
  },
  // #403: quicker step cadence for the player. `_stepGait` (scenes/arena/locomotion.js) ties
  // cadence to speed already — it advances the walk frames by `speed / maxSpeed` and plants a
  // foot every `stepInterval` ms at full throttle. But the medium stepInterval this file used to
  // inherit (340) was tuned before #159 nearly DOUBLED maxSpeed (98 → 195), so at the mech's
  // then-current top speed the footfalls landed too far apart and the walk read as a glide. #399
  // (full speed in every direction) widened that gap further. Pulling the interval down to 250
  // put a footfall roughly every half-second at top speed — noticeably quicker, still tied to
  // speed so a crawl still steps slowly. Weight is carried by stepBob/footShake/footstep audio,
  // which were left at the medium's figures. Player-only, and now structurally so: the enemy
  // Warden's chassis lives in enemy/medium.js and shares nothing with this.
  //
  // #438 (playtest follow-up): "play the animation slightly faster" — 250 → 215, about 14%
  // quicker. This one number sets the WHOLE gait clock, not just the footfalls: the cycle is
  // `stepInterval × CYCLE_BEATS` (locomotion.js), and the baked leg frame, the body bob and the
  // hip wobble all read off that same phase, so they speed up together and stay in lockstep. A
  // deliberately small step — the brief was "slightly", and the heavy bounding feel from #435
  // lives on this dial too.
  //
  // #501 re-experiment: much slower player top speed/turn, paired with locomotion.js's
  // INSTANT_TURNING/INSTANT_VELOCITY flipped back off (arena/locomotion.js) so the rate-limited
  // "twist slew" turning and accel/decel ramp are both back in play instead of the instant-snap
  // feel. Roughly half the enemy medium's speed/accel (195/210) and ~60% of its turnRate (1.55)
  // — a first pass to playtest against, not a locked balance number.
  //
  // turretSlew/stepBob/footShake are the medium's original values, copied at the split.
  movement: {
    accel: 130, decel: 90, maxSpeed: 100, turnRate: 0.9,
    turretSlew: 2.9,
    stepInterval: 215, stepBob: 2.7, footShake: 2.0,
  },
};

// #501: live A/B toggle (D-pad down, arena/locomotion.js) between the re-experiment above and
// the exact pre-#501 feel, so the owner can compare in play without a redeploy. These four
// numbers are what this chassis' `movement.maxSpeed`/`accel`/`decel`/`turnRate` were before the
// experiment overrode them — i.e. the enemy medium's figures, which the player's chassis still
// inherited at the time. They're written out as literals rather than read off enemy/medium.js so
// the 2026-07-31 enemy/player split holds here too: retuning the Warden must not silently move
// the player's A/B reference point out from under this comparison. Only the 4 fields the
// experiment touches; turret slew, step cadence, etc. are unaffected by the toggle either way.
export const LEGACY_MOVEMENT_OVERRIDE = {
  maxSpeed: 195, accel: 210, decel: 140, turnRate: 1.55,
};
