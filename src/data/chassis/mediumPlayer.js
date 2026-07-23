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
// Everything except the stat totals is MEDIUM_CONFIG verbatim (movement feel, art, name, weight
// class), spread in so the two can never drift apart on the things that are meant to match. Only
// `id` and the totals differ. The player's shield is configured separately at deploy time
// (PLAYER_SHIELD in scenes/ArenaScene.js) — that's the 100 in 200/300/100.
import { MEDIUM_CONFIG } from './medium.js';

export const MEDIUM_PLAYER_CONFIG = {
  ...MEDIUM_CONFIG,
  id: 'mediumPlayer',
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
  // Plus the 100-point shield configured at deploy (PLAYER_SHIELD in scenes/ArenaScene.js).
  totalArmor: 2100,
  totalHp: 1400,
  // #438: player-only leg proportions. First pass went SKINNIER (legW 1.0 → 0.72) and
  // WIDER-SET (legSpread 1.0 → 1.4); the playtest kept the wide stance but asked for the legs
  // "a bit thicker again, and longer forward also".
  //
  //   legSpread 1.4  — UNCHANGED, the wide set is the part that landed.
  //   legW      0.90 — most of the width back (was 0.72), so they read as load-bearing struts
  //                    rather than sticks, without undoing the first pass entirely.
  //   legH      1.30 — the leg BOX is 30% longer...
  //   legDrop   0.86 — ...and its centre rides FORWARD (legDrop scales the leg's +y offset, and
  //                    -y is forward), so nearly all of that extra length is spent out in FRONT
  //                    rather than trailing behind. Front edge = L*(0.15*legDrop − 0.16*legH):
  //                    −0.4 → −3.0 design units, i.e. ~2.6 forward, against ~1.0 added at the
  //                    heel. The outboard half of each leg sits outside the centre torso's
  //                    footprint, so that reach is actually visible from directly overhead
  //                    instead of disappearing under the chest plate.
  //
  // Only the player's chassis gets this override; the enemy Warden still rides plain
  // MEDIUM_CONFIG's art (no shape override = DEFAULT_SHAPE), so its legs are unaffected.
  art: { ...MEDIUM_CONFIG.art, shape: { legW: 0.90, legSpread: 1.4, legH: 1.30, legDrop: 0.86 } },
  // #403: quicker step cadence for the player. `_stepGait` (scenes/arena/locomotion.js) ties
  // cadence to speed already — it advances the walk frames by `speed / maxSpeed` and plants a
  // foot every `stepInterval` ms at full throttle. But the shared MEDIUM stepInterval (340) was
  // tuned before #159 nearly DOUBLED maxSpeed (98 → 195), so at the mech's current top speed the
  // footfalls now land too far apart and the walk reads as a glide. #399 (full speed in every
  // direction) widens that gap further. Pulling the interval down to 250 puts a footfall roughly
  // every half-second at top speed — noticeably quicker, still tied to speed so a crawl still
  // steps slowly. Weight is carried by stepBob/footShake/footstep audio (all inherited,
  // untouched), so the step is faster without going floaty. Player-only: overriding here (not in
  // medium.js) leaves the enemy Warden's medium chassis alone.
  //
  // #438 (playtest follow-up): "play the animation slightly faster" — 250 → 215, about 14%
  // quicker. This one number sets the WHOLE gait clock, not just the footfalls: the cycle is
  // `stepInterval × CYCLE_BEATS` (locomotion.js), and the baked leg frame, the body bob and the
  // hip wobble all read off that same phase, so they speed up together and stay in lockstep. A
  // deliberately small step — the brief was "slightly", and the heavy bounding feel from #435
  // lives on this dial too.
  movement: { ...MEDIUM_CONFIG.movement, stepInterval: 215 },
};
