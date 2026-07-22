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
  // #438: player-only leg proportions — SKINNIER (legW down from the 1.0 baseline) and
  // WIDER-SET (legSpread up), so the stance reads more planted without going spindly.
  // Deliberately just these two shape knobs: legH/legDrop (leg length/vertical drop) and
  // the walk-cycle timing (drawHull's `shift`/stepInterval) are untouched — the animation
  // speed/smoothness half of #438 is separate scope (overlaps #435, not done here). Only the
  // player's chassis gets this override; the enemy Warden still rides plain MEDIUM_CONFIG's
  // art (no shape override = DEFAULT_SHAPE), so its legs are unaffected.
  art: { ...MEDIUM_CONFIG.art, shape: { legW: 0.72, legSpread: 1.4 } },
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
  movement: { ...MEDIUM_CONFIG.movement, stepInterval: 250 },
};
